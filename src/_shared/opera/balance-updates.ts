/**
 * Opera balance-update primitives — keep aggregate balances in sync
 * with transaction-level postings.
 *
 * Faithful ports of:
 *   - update_nbank_balance  → updateNbankBalance()
 *   - _get_nacnt_type       → getNacntType()
 *   - update_nacnt_balance  → updateNacntBalance() (with nsubt/ntype/nhist)
 *
 * Per CLAUDE.md "complete data updates": every ntran INSERT MUST be
 * accompanied by an updateNacntBalance() call (also handles nhist
 * automatically). Every cashbook-affecting post MUST call
 * updateNbankBalance(). Skipping these causes control-account
 * mismatches and audit failures.
 *
 * Always called WITHIN an open MSSQL transaction. ROWLOCK on writes,
 * NOLOCK on the type lookup.
 */
import type { Knex } from 'knex';

// ---------------------------------------------------------------------
// updateNbankBalance — nbank.nk_curbal += amount (in pence)
// ---------------------------------------------------------------------

/**
 * Update nbank.nk_curbal after posting cashbook transactions.
 *
 * @param amountPounds positive = receipt (increases balance),
 *                     negative = payment (decreases balance).
 *                     Stored in pence internally.
 *
 * Throws when the bank account isn't found in nbank — caller is in a
 * transaction and the throw forces a rollback rather than commit
 * with an out-of-sync bank balance.
 *
 * Implementation note: uses Knex's query builder `.update()` which
 * returns the actual rowsAffected as a number on every Knex driver
 * (mssql/tedious, sqlite, foxpro etc.). Using `trx.raw(UPDATE ...)`
 * here would silently return 0 on MSSQL because tedious doesn't
 * surface rowsAffected for raw statements — that bit us before.
 */
export async function updateNbankBalance(
  trx: Knex,
  bankAccount: string,
  amountPounds: number,
): Promise<void> {
  const amountPence = Math.round(amountPounds * 100);
  const rows = await trx('nbank')
    .whereRaw('RTRIM(nk_acnt) = ?', [bankAccount])
    .update({
      nk_curbal: trx.raw('ISNULL(nk_curbal, 0) + ?', [amountPence]),
      datemodified: trx.raw('GETDATE()'),
    });
  if (Number(rows) === 0) {
    throw new Error(
      `nbank balance update failed: bank account '${bankAccount}' not found ` +
        `in nbank. Attempted to adjust by ${amountPence} pence ` +
        `(£${amountPounds.toFixed(2)}). Transaction will be rolled back to ` +
        `prevent balance drift.`,
    );
  }
}

// ---------------------------------------------------------------------
// getNacntType — cached na_type / na_subt lookup
// ---------------------------------------------------------------------

export interface NacntType {
  na_type: string;
  na_subt: string;
}

// WeakMap so the cache is per-trx and dies when the trx does.
const nacntTypeCache = new WeakMap<Knex, Map<string, NacntType>>();

export async function getNacntType(
  trx: Knex,
  account: string,
): Promise<NacntType | null> {
  const key = (account ?? '').trim();
  let cache = nacntTypeCache.get(trx);
  if (!cache) {
    cache = new Map();
    nacntTypeCache.set(trx, cache);
  }
  if (cache.has(key)) return cache.get(key)!;

  const rows = (await trx.raw(
    `SELECT na_type, na_subt FROM nacnt WITH (NOLOCK)
     WHERE RTRIM(na_acnt) = ?`,
    [key],
  )) as unknown as Array<{ na_type: string | null; na_subt: string | null }>;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const t: NacntType = {
    na_type: (rows[0]?.na_type ?? '').toString(),
    na_subt: (rows[0]?.na_subt ?? '').toString(),
  };
  cache.set(key, t);
  return t;
}

// ---------------------------------------------------------------------
// updateNacntBalance — full nacnt + nhist + nsubt + ntype update
// ---------------------------------------------------------------------

const VALID_PERIODS = (() => {
  const s = new Set<number>();
  for (let i = 1; i <= 24; i++) s.add(i);
  return s;
})();

export interface UpdateNacntBalanceOptions {
  /** Posting period (1..24). Outside that range is silently skipped
   *  (matches Python's `logger.warning + return`). */
  period: number;
  /** Financial year — required for nhist write (passed through). */
  year: number;
}

/**
 * Update nacnt + nhist + nsubt + ntype after posting an ntran row.
 *
 * Sign convention:
 *   value > 0  → DEBIT  (na_ptddr/na_ytddr += value)
 *   value < 0  → CREDIT (na_ptdcr/na_ytdcr += abs(value))
 *   period column (na_balc01..24) ALWAYS += value (signed net)
 *
 * Throws when nacnt update affects 0 rows — that means the account
 * isn't in nacnt, which would silently leak balance drift.
 *
 * NB: the nhist write follows Opera's convention of storing nh_ptdcr
 * as a NEGATIVE number (vs nacnt's positive magnitudes). Don't
 * "correct" that — Opera's reports rely on the negative sign.
 *
 * Caller is responsible for being inside a transaction.
 */
export async function updateNacntBalance(
  trx: Knex,
  account: string,
  value: number,
  opts: UpdateNacntBalanceOptions,
): Promise<void> {
  const period = Number(opts.period);
  const year = Number(opts.year);
  if (!VALID_PERIODS.has(period)) return; // skip — same as Python warning+return

  const account_ = (account ?? '').trim();
  const periodCol = `na_balc${period.toString().padStart(2, '0')}`;
  const v = Number(value);
  const absV = Math.abs(v);

  // 1. Update nacnt — query-builder form so rowsAffected is real
  // across every Knex driver (mssql, sqlite, foxpro etc).
  const nacntUpdate: Record<string, Knex.Raw> = {
    [periodCol]: trx.raw(`ISNULL(${periodCol}, 0) + ?`, [v]),
    datemodified: trx.raw('GETDATE()'),
  };
  if (v >= 0) {
    nacntUpdate.na_ptddr = trx.raw('ISNULL(na_ptddr, 0) + ?', [v]);
    nacntUpdate.na_ytddr = trx.raw('ISNULL(na_ytddr, 0) + ?', [v]);
  } else {
    nacntUpdate.na_ptdcr = trx.raw('ISNULL(na_ptdcr, 0) + ?', [absV]);
    nacntUpdate.na_ytdcr = trx.raw('ISNULL(na_ytdcr, 0) + ?', [absV]);
  }
  const rows = await trx('nacnt')
    .whereRaw('RTRIM(na_acnt) = ?', [account_])
    .update(nacntUpdate);
  if (Number(rows) === 0) {
    throw new Error(
      `nacnt update affected 0 rows for account ${account_} - ` +
        'account may not exist in nacnt table',
    );
  }

  // 2. Update nhist
  await updateNhist(trx, account_, v, period, year);

  // 3. Update nsubt + ntype
  await updateNsubtNtype(trx, account_, v);
}

async function updateNhist(
  trx: Knex,
  account: string,
  value: number,
  period: number,
  year: number,
): Promise<void> {
  const typeInfo = await getNacntType(trx, account);
  if (!typeInfo) return; // matches Python's warning + return — non-fatal

  const costCentre = '    ';
  const findRows = (await trx.raw(
    `SELECT TOP 1 id FROM nhist WITH (UPDLOCK, ROWLOCK)
     WHERE RTRIM(nh_nacnt) = ?
       AND nh_ntype = ?
       AND nh_nsubt = ?
       AND nh_ncntr = ?
       AND nh_year = ?
       AND nh_period = ?`,
    [account, typeInfo.na_type, typeInfo.na_subt, costCentre, year, period],
  )) as unknown as Array<{ id: number | null }>;
  const id = Array.isArray(findRows) && findRows[0] ? Number(findRows[0].id) : null;

  if (id !== null && Number.isFinite(id)) {
    if (value >= 0) {
      await trx.raw(
        `UPDATE nhist WITH (ROWLOCK)
         SET nh_bal = ISNULL(nh_bal, 0) + ?,
             nh_ptddr = ISNULL(nh_ptddr, 0) + ?,
             datemodified = GETDATE()
         WHERE id = ?`,
        [value, value, id],
      );
    } else {
      // ptdcr stored as NEGATIVE (Opera convention)
      await trx.raw(
        `UPDATE nhist WITH (ROWLOCK)
         SET nh_bal = ISNULL(nh_bal, 0) + ?,
             nh_ptdcr = ISNULL(nh_ptdcr, 0) + ?,
             datemodified = GETDATE()
         WHERE id = ?`,
        [value, value, id],
      );
    }
  } else {
    // No row — INSERT new one. Caller's transaction handles the id
    // allocation via getNextId (imported in posting code, not here,
    // to avoid circular reference between balance-updates and
    // id-allocation).
    const { getNextId } = await import('./id-allocation.js');
    const newId = await getNextId(trx, 'nhist');
    const ptddr = value >= 0 ? value : 0;
    const ptdcr = value >= 0 ? 0 : value; // negative
    const accountPadded = account.padEnd(8, ' ');
    await trx.raw(
      `INSERT INTO nhist (
         id,
         nh_rectype, nh_ntype, nh_nsubt, nh_nacnt, nh_ncntr,
         nh_job, nh_project, nh_year, nh_period,
         nh_bal, nh_budg, nh_rbudg, nh_ptddr, nh_ptdcr, nh_fbal,
         datecreated, datemodified, state
       ) VALUES (
         ?,
         1, ?, ?, ?, ?,
         '        ', '        ', ?, ?,
         ?, 0, 0, ?, ?, 0,
         GETDATE(), GETDATE(), 1
       )`,
      [
        newId,
        typeInfo.na_type,
        typeInfo.na_subt,
        accountPadded,
        costCentre,
        year,
        period,
        value,
        ptddr,
        ptdcr,
      ],
    );
  }
}

// ---------------------------------------------------------------------
// insertNjmemo — journal memo for a nominal-ledger posting
// ---------------------------------------------------------------------

/**
 * Insert a journal memo record into njmemo for a nominal ledger posting.
 *
 * Faithful port of `_insert_njmemo` (opera_sql_import.py:709-741).
 * Opera creates an njmemo record for each journal number when posting
 * to the nominal ledger. nj_memo uses a sentinel pattern with chr(255)
 * surrounds; nj_txtrep holds the human-readable description (truncated
 * to 60 chars).
 *
 * Allocates the njmemo id via getNextId('njmemo').
 */
export async function insertNjmemo(
  trx: Knex,
  journalNumber: number,
  description: string,
): Promise<void> {
  const { getNextId } = await import('./id-allocation.js');
  const id = await getNextId(trx, 'njmemo');
  // chr(255) sentinel surrounds — JS stores it as the same code point.
  const sentinel = String.fromCharCode(255);
  const memoTag = `${sentinel}<<JOURNAL_DATA_ONLY>>${sentinel}`;
  const safeDesc = (description ?? '').slice(0, 60);

  await trx.raw(
    `INSERT INTO njmemo (
       id, nj_journal, nj_memo, nj_image, nj_txtrep, nj_binrep,
       datecreated, datemodified, state
     ) VALUES (
       ?, ?, ?, '', ?, 0, GETDATE(), GETDATE(), 1
     )`,
    [id, journalNumber, memoTag, safeDesc],
  );
}

async function updateNsubtNtype(
  trx: Knex,
  account: string,
  value: number,
): Promise<void> {
  const typeInfo = await getNacntType(trx, account);
  if (!typeInfo) return; // matches Python warning + return

  // nsubt
  await trx.raw(
    `UPDATE nsubt WITH (ROWLOCK)
     SET ns_balance = ISNULL(ns_balance, 0) + ?,
         datemodified = GETDATE()
     WHERE ns_subt = ? AND ns_type = ?`,
    [value, typeInfo.na_subt, typeInfo.na_type],
  );

  // ntype
  await trx.raw(
    `UPDATE ntype WITH (ROWLOCK)
     SET nt_bal = ISNULL(nt_bal, 0) + ?,
         datemodified = GETDATE()
     WHERE nt_type = ?`,
    [value, typeInfo.na_type],
  );
}

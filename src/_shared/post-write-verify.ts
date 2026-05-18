/**
 * Post-write verification helpers.
 *
 * Two-phase verification of a multi-table Opera posting:
 *
 *   (A) `assert*` helpers run INSIDE the trx that just did the
 *       INSERTs. Most use `WITH (NOLOCK)` so they take no shared
 *       locks (within our own session, NOLOCK still reads our own
 *       uncommitted inserts — see SQL Server isolation semantics).
 *       A mismatch throws `PostingVerificationError`, which the
 *       caller rethrows — Knex's transaction wrapper rolls the
 *       INSERTs back, so no half-posted row ever lands.
 *
 *   (C) `verifyAentryCommitted` runs AFTER the trx commits. It
 *       grabs a fresh pool connection and re-reads the aentry +
 *       atran row by primary key with NOLOCK. If 0 rows or wrong
 *       values are returned, the post-commit visibility check has
 *       failed — caller surfaces a hard operator-action error
 *       ("posted but verification could not confirm — check
 *       Opera manually before re-running").
 *
 * Lock surface: zero new locks. NOLOCK is used throughout
 * EXCEPT in `assertAentryAtran`, which had its NOLOCK hints
 * dropped for sqlite-test compatibility (perf-only — the function
 * reads only our own session's inserts within the same trx, which
 * default isolation handles fine). The other helpers still use
 * NOLOCK specifically so concurrent Opera UI activity is never
 * blocked by our verification step. Concurrency safety for the
 * actual writes is handled elsewhere — `incrementAtypeEntry`
 * serialises the entry-number allocator with UPDLOCK+ROWLOCK on
 * atype, and balance updates use UPDLOCK+ROWLOCK with additive
 * UPDATE.
 */
import type { Knex } from 'knex';

export class PostingVerificationError extends Error {
  readonly entryNumber: string | null;
  readonly phase: 'in-trx' | 'post-commit';
  constructor(
    message: string,
    opts: { entryNumber: string | null; phase: 'in-trx' | 'post-commit' },
  ) {
    super(message);
    this.name = 'PostingVerificationError';
    this.entryNumber = opts.entryNumber;
    this.phase = opts.phase;
  }
}

function isPlainErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------
// In-trx assertions (Phase A)
// ---------------------------------------------------------------------

/**
 * Assert that the matching aentry + atran rows exist for an entry
 * number on a bank, and that the cashbook-side values match what
 * we wrote.
 *
 * Joins by `ae_entry = at_entry AND ae_acnt = at_acnt` — the
 * cashbook primary key. Mismatch on count, value, or fingerprint
 * throws.
 *
 * For single-line postings (default), expects exactly 1 atran row
 * and validates atran.at_value individually. For multi-line entries
 * (e.g. recurring with N detail lines), pass expectedAtranCount = N
 * and the helper validates that:
 *   - Row count matches expectedAtranCount
 *   - Sum of atran.at_value across all rows equals expectedSignedPence
 *   - All rows have uniform at_type and at_pstdate (Opera requirement)
 */
export async function assertAentryAtran(
  trx: Knex,
  opts: {
    entryNumber: string;
    bankAccount: string;
    expectedSignedPence: number;
    expectedAtType: number;
    expectedDate: string;
    expectedReferPrefix?: string; // first 20 chars of fingerprint
    /**
     * Number of atran rows expected for this entry. Default 1 = current
     * single-line behaviour. Multi-line callers pass `lines.length`.
     */
    expectedAtranCount?: number;
  },
): Promise<void> {
  const expectedCount = opts.expectedAtranCount ?? 1;
  let rows: Array<{
    ae_value: number | null;
    at_value: number | null;
    at_pstdate: string | Date | null;
    at_type: number | null;
    at_refer: string | null;
  }>;
  try {
    rows = (await trx.raw(
      `SELECT
         a.ae_value AS ae_value,
         t.at_value AS at_value,
         t.at_pstdate AS at_pstdate,
         t.at_type AS at_type,
         RTRIM(t.at_refer) AS at_refer
       FROM aentry a
       JOIN atran t
         ON t.at_entry = a.ae_entry AND t.at_acnt = a.ae_acnt
       WHERE RTRIM(a.ae_entry) = ?
         AND RTRIM(a.ae_acnt) = ?`,
      [opts.entryNumber, opts.bankAccount],
    )) as unknown as Array<{
      ae_value: number | null;
      at_value: number | null;
      at_pstdate: string | Date | null;
      at_type: number | null;
      at_refer: string | null;
    }>;
  } catch (err) {
    throw new PostingVerificationError(
      `aentry+atran in-trx verify query failed for ${opts.entryNumber}: ${isPlainErr(err)}`,
      { entryNumber: opts.entryNumber, phase: 'in-trx' },
    );
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new PostingVerificationError(
      `aentry+atran missing after INSERT (entry=${opts.entryNumber}, bank=${opts.bankAccount}) — possible silent trigger discard`,
      { entryNumber: opts.entryNumber, phase: 'in-trx' },
    );
  }
  if (rows.length !== expectedCount) {
    throw new PostingVerificationError(
      `aentry+atran count mismatch for ${opts.entryNumber}: got ${rows.length}, expected ${expectedCount}`,
      { entryNumber: opts.entryNumber, phase: 'in-trx' },
    );
  }

  const ae = Number(rows[0]!.ae_value ?? NaN);
  if (!Number.isFinite(ae) || ae !== opts.expectedSignedPence) {
    throw new PostingVerificationError(
      `aentry.ae_value mismatch for ${opts.entryNumber}: stored=${ae} expected=${opts.expectedSignedPence}`,
      { entryNumber: opts.entryNumber, phase: 'in-trx' },
    );
  }

  // For multi-line: sum atran.at_value must equal expectedSignedPence.
  // For single-line: that reduces to the row's at_value.
  const atSum = rows.reduce((acc, r) => acc + Number(r.at_value ?? 0), 0);
  if (atSum !== opts.expectedSignedPence) {
    throw new PostingVerificationError(
      `Σatran.at_value mismatch for ${opts.entryNumber}: stored=${atSum} expected=${opts.expectedSignedPence}`,
      { entryNumber: opts.entryNumber, phase: 'in-trx' },
    );
  }

  for (const r of rows) {
    if (Number(r.at_type) !== opts.expectedAtType) {
      throw new PostingVerificationError(
        `atran.at_type mismatch for ${opts.entryNumber}: stored=${r.at_type} expected=${opts.expectedAtType}`,
        { entryNumber: opts.entryNumber, phase: 'in-trx' },
      );
    }
    const storedDate =
      r.at_pstdate instanceof Date
        ? r.at_pstdate.toISOString().slice(0, 10)
        : typeof r.at_pstdate === 'string'
          ? r.at_pstdate.slice(0, 10)
          : null;
    if (storedDate !== opts.expectedDate) {
      throw new PostingVerificationError(
        `atran.at_pstdate mismatch for ${opts.entryNumber}: stored=${storedDate} expected=${opts.expectedDate}`,
        { entryNumber: opts.entryNumber, phase: 'in-trx' },
      );
    }
  }

  if (
    opts.expectedReferPrefix &&
    (rows[0]!.at_refer ?? '').trim() !== opts.expectedReferPrefix.trim()
  ) {
    throw new PostingVerificationError(
      `atran.at_refer mismatch for ${opts.entryNumber}: stored="${rows[0]!.at_refer}" expected="${opts.expectedReferPrefix}"`,
      { entryNumber: opts.entryNumber, phase: 'in-trx' },
    );
  }
}

/**
 * Assert that exactly one ledger row (stran for sales, ptran for
 * purchases) was written for the entry, and the value matches.
 *
 * stran/ptran use `<table>_entry` + `<table>_cbtype` to link back
 * to aentry/atran.
 */
export async function assertLedgerRow(
  trx: Knex,
  opts: {
    ledger: 'sales' | 'purchase';
    entryNumber: string;
    cbtype: string;
    account: string;
    expectedValuePounds: number;
  },
): Promise<void> {
  const table = opts.ledger === 'sales' ? 'stran' : 'ptran';
  const valueCol = opts.ledger === 'sales' ? 'st_trvalue' : 'pt_trvalue';
  const entryCol = opts.ledger === 'sales' ? 'st_entry' : 'pt_entry';
  const cbCol = opts.ledger === 'sales' ? 'st_cbtype' : 'pt_cbtype';
  const acctCol = opts.ledger === 'sales' ? 'st_account' : 'pt_account';

  let rows: Array<{ v: number | null }>;
  try {
    rows = (await trx.raw(
      `SELECT ${valueCol} AS v FROM ${table} WITH (NOLOCK)
       WHERE RTRIM(${entryCol}) = ?
         AND RTRIM(${cbCol}) = ?
         AND RTRIM(${acctCol}) = ?`,
      [opts.entryNumber, opts.cbtype, opts.account],
    )) as unknown as Array<{ v: number | null }>;
  } catch (err) {
    throw new PostingVerificationError(
      `${table} in-trx verify query failed for ${opts.entryNumber}: ${isPlainErr(err)}`,
      { entryNumber: opts.entryNumber, phase: 'in-trx' },
    );
  }

  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new PostingVerificationError(
      `${table} row count mismatch for entry=${opts.entryNumber}, acct=${opts.account}: got ${rows?.length ?? 0}, expected 1`,
      { entryNumber: opts.entryNumber, phase: 'in-trx' },
    );
  }
  const stored = Number(rows[0]!.v ?? NaN);
  // Pounds tolerance: 0.5p to absorb float storage rounding.
  if (
    !Number.isFinite(stored) ||
    Math.abs(stored - opts.expectedValuePounds) > 0.005
  ) {
    throw new PostingVerificationError(
      `${table}.${valueCol} mismatch for ${opts.entryNumber}: stored=${stored} expected=${opts.expectedValuePounds}`,
      { entryNumber: opts.entryNumber, phase: 'in-trx' },
    );
  }
}

/**
 * Assert that a debit/credit pair was written and sums to zero,
 * looking up by the shared unique id we generated for the posting.
 *
 * Used for ntran (general-ledger journal pair) and anoml (transfer
 * file pair). Both should always have count=expectedCount AND
 * sum-of-value=0.
 */
export async function assertBalancedPair(
  trx: Knex,
  opts: {
    table: 'ntran' | 'anoml';
    journal: number;
    expectedCount: number;
    entryNumber: string; // for error messages
  },
): Promise<void> {
  // Legacy allocates a DISTINCT unique ID per leg (audit 2026-05-14,
  // opera_sql_import.py:2253). So we can't key the count by the
  // per-row unique — we use `nt_jrnl` / `ax_jrnl`, which IS shared
  // across the pair (one journal per posting via insertNjmemo).
  const jrnlCol = opts.table === 'ntran' ? 'nt_jrnl' : 'ax_jrnl';
  const valueCol = opts.table === 'ntran' ? 'nt_value' : 'ax_value';

  let rows: Array<{ cnt: number | null; total: number | null }>;
  try {
    rows = (await trx.raw(
      `SELECT COUNT(*) AS cnt, SUM(${valueCol}) AS total
       FROM ${opts.table} WITH (NOLOCK)
       WHERE ${jrnlCol} = ?`,
      [opts.journal],
    )) as unknown as Array<{ cnt: number | null; total: number | null }>;
  } catch (err) {
    throw new PostingVerificationError(
      `${opts.table} in-trx verify query failed for ${opts.entryNumber}: ${isPlainErr(err)}`,
      { entryNumber: opts.entryNumber, phase: 'in-trx' },
    );
  }
  const cnt = Number(rows?.[0]?.cnt ?? 0);
  const total = Number(rows?.[0]?.total ?? NaN);
  if (cnt !== opts.expectedCount) {
    throw new PostingVerificationError(
      `${opts.table} pair count mismatch for ${opts.entryNumber}: got ${cnt}, expected ${opts.expectedCount} (jrnl=${opts.journal})`,
      { entryNumber: opts.entryNumber, phase: 'in-trx' },
    );
  }
  if (!Number.isFinite(total) || Math.abs(total) > 0.005) {
    throw new PostingVerificationError(
      `${opts.table} pair does not balance for ${opts.entryNumber}: sum=${total} (jrnl=${opts.journal})`,
      { entryNumber: opts.entryNumber, phase: 'in-trx' },
    );
  }
}

// ---------------------------------------------------------------------
// Post-commit verification (Phase C)
// ---------------------------------------------------------------------

/**
 * After the trx commits, re-read the aentry row from a fresh pool
 * connection (separate session) to confirm the COMMIT was visible
 * outside our trx. If the row is missing or its value differs from
 * what we sent, the post-commit visibility check has failed — the
 * caller must surface a hard operator-action error rather than
 * silently retrying.
 *
 * Uses NOLOCK + a short LOCK_TIMEOUT as belt-and-braces. NOLOCK
 * shouldn't acquire locks anyway; the timeout caps any pathological
 * case where it tries.
 */
export async function verifyAentryCommitted(
  operaDb: Knex,
  opts: {
    entryNumber: string;
    bankAccount: string;
    expectedSignedPence: number;
  },
): Promise<{ verified: true } | { verified: false; reason: string }> {
  try {
    // Set a small lock timeout for safety. If somehow the read does
    // try to acquire a lock, we'd rather fail-loud than hang.
    await operaDb.raw('SET LOCK_TIMEOUT 1000');
    const rows = (await operaDb.raw(
      `SELECT TOP 1
         a.ae_value AS ae_value,
         t.at_value AS at_value,
         RTRIM(a.ae_acnt) AS acnt
       FROM aentry a WITH (NOLOCK)
       JOIN atran t WITH (NOLOCK)
         ON t.at_entry = a.ae_entry AND t.at_acnt = a.ae_acnt
       WHERE RTRIM(a.ae_entry) = ?
         AND RTRIM(a.ae_acnt) = ?`,
      [opts.entryNumber, opts.bankAccount],
    )) as unknown as Array<{
      ae_value: number | null;
      at_value: number | null;
      acnt: string | null;
    }>;
    if (!Array.isArray(rows) || rows.length === 0) {
      return {
        verified: false,
        reason: `aentry+atran not visible from fresh session (entry=${opts.entryNumber}, bank=${opts.bankAccount})`,
      };
    }
    const r = rows[0]!;
    const ae = Number(r.ae_value ?? NaN);
    const at = Number(r.at_value ?? NaN);
    if (!Number.isFinite(ae) || ae !== opts.expectedSignedPence) {
      return {
        verified: false,
        reason: `aentry.ae_value mismatch in post-commit read: stored=${ae} expected=${opts.expectedSignedPence}`,
      };
    }
    if (!Number.isFinite(at) || at !== opts.expectedSignedPence) {
      return {
        verified: false,
        reason: `atran.at_value mismatch in post-commit read: stored=${at} expected=${opts.expectedSignedPence}`,
      };
    }
    return { verified: true };
  } catch (err) {
    return {
      verified: false,
      reason: `post-commit verify query failed: ${isPlainErr(err)}`,
    };
  }
}

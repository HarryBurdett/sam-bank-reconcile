/**
 * Bank-alias lookup + save for matcher use.
 *
 * Faithful behavioural port of `BankAliasManager.lookup_alias` and
 * `BankAliasManager.save_alias` (sql_rag/bank_aliases.py:271-510)
 * plus the repeat-entry alias helpers (907-1042).
 *
 * Storage difference: legacy uses a per-company SQLite at
 * `data/<company>/bank_reconcile/bank_aliases.db`. SAM stores the
 * same rows in the per-app DB (`ctx.db.app`) under tables
 * `bank_import_aliases` and `repeat_entry_aliases` (see migration
 * `001_initial_schema.ts`). Column names differ:
 *
 *   legacy.bank_name      ↔ sam.payee_pattern
 *   legacy.ledger_type    ↔ sam.match_type      ('C'/'S' ↔ 'customer'/'supplier')
 *   legacy.account_code   ↔ sam.opera_account
 *   legacy.match_score    ↔ sam.confidence
 *   legacy.use_count      ↔ sam.match_count
 *   legacy.bank_code      ↔ sam.bank_code       (same)
 *
 * Lookup precedence: bank-scoped row preferred, falls back to global
 * (empty bank_code) row — same as legacy audit 2026-05-05 F16.
 *
 * Driver-agnostic: uses Knex's `.update()` / `.insert()` builders so
 * rowsAffected is real on mssql + sqlite + foxpro. No backend-specific
 * SQL.
 */
import type { Knex } from 'knex';

export type LedgerType = 'C' | 'S';

function ledgerToMatchType(ledger: LedgerType): 'customer' | 'supplier' {
  return ledger === 'C' ? 'customer' : 'supplier';
}

export interface AliasLookupResult {
  account: string;
  matchType: 'customer' | 'supplier';
  confidence: number;
}

/**
 * Look up an alias for a (payee, ledger) pair, preferring a bank-scoped
 * row over a global one. Returns null when no row matches.
 */
export async function lookupAlias(
  appDb: Knex | null,
  payeeName: string,
  ledger: LedgerType,
  bankCode: string,
): Promise<AliasLookupResult | null> {
  if (!appDb) return null;
  const name = (payeeName ?? '').trim();
  if (!name) return null;
  const matchType = ledgerToMatchType(ledger);
  const code = (bankCode ?? '').trim();
  try {
    // Bank-scoped first.
    if (code) {
      const scoped = (await appDb('bank_import_aliases')
        .select('opera_account', 'confidence', 'match_type')
        .whereRaw('UPPER(payee_pattern) = ?', [name.toUpperCase()])
        .andWhere('match_type', matchType)
        .andWhere('bank_code', code)
        .first()) as
        | { opera_account: string; confidence: number; match_type: string }
        | undefined;
      if (scoped?.opera_account) {
        return {
          account: scoped.opera_account.trim(),
          matchType: scoped.match_type as 'customer' | 'supplier',
          confidence: Number(scoped.confidence ?? 1),
        };
      }
    }
    // Global (empty bank_code) fallback.
    const global = (await appDb('bank_import_aliases')
      .select('opera_account', 'confidence', 'match_type')
      .whereRaw('UPPER(payee_pattern) = ?', [name.toUpperCase()])
      .andWhere('match_type', matchType)
      .andWhere(function emptyBankCode(this: Knex.QueryBuilder) {
        this.whereNull('bank_code').orWhere('bank_code', '');
      })
      .first()) as
      | { opera_account: string; confidence: number; match_type: string }
      | undefined;
    if (global?.opera_account) {
      return {
        account: global.opera_account.trim(),
        matchType: global.match_type as 'customer' | 'supplier',
        confidence: Number(global.confidence ?? 1),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Save (insert-or-update) an alias. Matches legacy `save_alias` upsert
 * semantics: per-bank if `bankCode` non-empty, else global.
 */
export async function saveAlias(
  appDb: Knex | null,
  opts: {
    payeeName: string;
    ledger: LedgerType;
    operaAccount: string;
    matchScore: number;
    accountName?: string | null;
    bankCode?: string | null;
    direction?: 'receipt' | 'payment' | 'either';
  },
): Promise<boolean> {
  if (!appDb) return false;
  const name = (opts.payeeName ?? '').trim();
  const account = (opts.operaAccount ?? '').trim();
  if (!name || !account) return false;
  const matchType = ledgerToMatchType(opts.ledger);
  const bankCode = (opts.bankCode ?? '').trim();
  const confidence = Math.min(1, Math.max(0, Number(opts.matchScore || 0)));
  const direction = opts.direction ?? 'either';

  try {
    const existing = (await appDb('bank_import_aliases')
      .select('id', 'match_count')
      .whereRaw('UPPER(payee_pattern) = ?', [name.toUpperCase()])
      .andWhere('match_type', matchType)
      .andWhere(function scope(this: Knex.QueryBuilder) {
        if (bankCode) {
          this.where('bank_code', bankCode);
        } else {
          this.whereNull('bank_code').orWhere('bank_code', '');
        }
      })
      .first()) as { id: number; match_count: number | null } | undefined;

    const nowIso = new Date().toISOString();
    if (existing?.id) {
      const updated = Number(
        await appDb('bank_import_aliases')
          .where({ id: existing.id })
          .update({
            opera_account: account,
            confidence,
            direction,
            match_count: Number(existing.match_count ?? 0) + 1,
            updated_at: nowIso,
          }),
      );
      return updated > 0;
    }
    await appDb('bank_import_aliases').insert({
      bank_code: bankCode,
      payee_pattern: name,
      match_type: matchType,
      opera_account: account,
      confidence,
      direction,
      match_count: 1,
      created_at: nowIso,
      updated_at: nowIso,
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
// Repeat-entry alias (matcher Stage 0)
// ---------------------------------------------------------------------

export interface RepeatEntryAliasRow {
  entry_ref: string;
  /** opera_repeat_ref column in SAM corresponds to entry_ref. */
  bank_code: string;
}

export async function lookupRepeatEntryAlias(
  appDb: Knex | null,
  memoPattern: string,
  bankCode: string,
): Promise<RepeatEntryAliasRow | null> {
  if (!appDb) return null;
  const pattern = (memoPattern ?? '').trim();
  if (!pattern) return null;
  try {
    const row = (await appDb('repeat_entry_aliases')
      .select('opera_repeat_ref', 'bank_code')
      .whereRaw('UPPER(memo_pattern) = ?', [pattern.toUpperCase()])
      .andWhere('bank_code', bankCode)
      .first()) as
      | { opera_repeat_ref: string; bank_code: string }
      | undefined;
    if (!row?.opera_repeat_ref) return null;
    return {
      entry_ref: row.opera_repeat_ref.trim(),
      bank_code: row.bank_code.trim(),
    };
  } catch {
    return null;
  }
}

export async function saveRepeatEntryAlias(
  appDb: Knex | null,
  memoPattern: string,
  bankCode: string,
  operaRepeatRef: string,
): Promise<boolean> {
  if (!appDb) return false;
  const pattern = (memoPattern ?? '').trim();
  const ref = (operaRepeatRef ?? '').trim();
  if (!pattern || !ref) return false;
  try {
    const existing = (await appDb('repeat_entry_aliases')
      .select('id')
      .whereRaw('UPPER(memo_pattern) = ?', [pattern.toUpperCase()])
      .andWhere('bank_code', bankCode)
      .first()) as { id: number } | undefined;
    if (existing?.id) {
      await appDb('repeat_entry_aliases')
        .where({ id: existing.id })
        .update({ opera_repeat_ref: ref });
      return true;
    }
    await appDb('repeat_entry_aliases').insert({
      bank_code: bankCode,
      memo_pattern: pattern,
      opera_repeat_ref: ref,
      created_at: new Date().toISOString(),
    });
    return true;
  } catch {
    return false;
  }
}

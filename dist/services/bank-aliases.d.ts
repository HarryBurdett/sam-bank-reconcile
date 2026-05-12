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
export interface AliasLookupResult {
    account: string;
    matchType: 'customer' | 'supplier';
    confidence: number;
}
/**
 * Look up an alias for a (payee, ledger) pair, preferring a bank-scoped
 * row over a global one. Returns null when no row matches.
 */
export declare function lookupAlias(appDb: Knex | null, payeeName: string, ledger: LedgerType, bankCode: string): Promise<AliasLookupResult | null>;
/**
 * Save (insert-or-update) an alias. Matches legacy `save_alias` upsert
 * semantics: per-bank if `bankCode` non-empty, else global.
 */
export declare function saveAlias(appDb: Knex | null, opts: {
    payeeName: string;
    ledger: LedgerType;
    operaAccount: string;
    matchScore: number;
    accountName?: string | null;
    bankCode?: string | null;
    direction?: 'receipt' | 'payment' | 'either';
}): Promise<boolean>;
export interface RepeatEntryAliasRow {
    entry_ref: string;
    /** opera_repeat_ref column in SAM corresponds to entry_ref. */
    bank_code: string;
}
export declare function lookupRepeatEntryAlias(appDb: Knex | null, memoPattern: string, bankCode: string): Promise<RepeatEntryAliasRow | null>;
export declare function saveRepeatEntryAlias(appDb: Knex | null, memoPattern: string, bankCode: string, operaRepeatRef: string): Promise<boolean>;
//# sourceMappingURL=bank-aliases.d.ts.map
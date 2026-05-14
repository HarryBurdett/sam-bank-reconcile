/**
 * Bank-import pattern learner.
 *
 * Faithful port of `BankPatternLearner.learn_pattern` +
 * `normalize_description` (sql_rag/bank_patterns.py:126, 187).
 *
 * Each time the operator commits an override during a bank-statement
 * import (e.g. matching "DD VODAFONE PLC 2024-04-15" → account
 * "VODA001"), this writes/updates a row in `bank_import_patterns`
 * keyed by the normalised description. Subsequent imports with the
 * same normalised description can be auto-matched without re-asking
 * the operator. UPSERT semantics: existing row → increment times_used
 * and refresh last_used; new row → INSERT.
 *
 * Storage: per-app SQLite `bank_import_patterns` table (migration
 * 014 extends the SAM-original schema with the legacy columns).
 *
 * Wired from import-from-pdf.ts after a successful posting batch
 * (faithful port of routes.py:4584-4606).
 */
import type { Knex } from 'knex';
/**
 * Normalise a bank description for matching. Strips common bank
 * prefixes (DD/BACS/FP/...), reference numbers, dates, and company-
 * suffixes. Faithful port of bank_patterns.py:126.
 */
export declare function normalizeDescription(description: string | null | undefined): string;
export interface LearnPatternInput {
    companyCode: string;
    description: string;
    transactionType: string;
    accountCode: string;
    accountName?: string | null;
    ledgerType: string;
    vatCode?: string | null;
    nominalCode?: string | null;
    netAmount?: number | null;
}
/**
 * Learn or refresh a pattern. Returns true on success, false on
 * failure (e.g. empty normalised description). Failures are logged
 * but never thrown so the import flow isn't blocked by a learner
 * hiccup — matches legacy bank_patterns.py:252-256.
 */
export declare function learnPattern(appDb: Knex, input: LearnPatternInput): Promise<boolean>;
//# sourceMappingURL=bank-pattern-learner.d.ts.map
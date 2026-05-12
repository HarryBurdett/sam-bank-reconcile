/**
 * Alias correction learning — record operator corrections to bank-name
 * → Opera-account matching, and store negative examples to avoid
 * future false positives.
 *
 * Faithful port of `BankAliasManager.record_correction` and
 * `_save_negative_example` (sql_rag/bank_aliases.py:728-813), plus
 * the wrapping endpoint `record_correction`
 * (apps/bank_reconcile/api/routes.py:2845-2895).
 *
 * On a successful correction:
 *   1. INSERT a row in `alias_corrections` for audit.
 *   2. Save (or upsert) the correct mapping as an alias with max
 *      confidence (1.0) in `bank_import_aliases`.
 *   3. INSERT (or IGNORE on conflict) a negative example in
 *      `negative_aliases` so the matcher knows NOT to match
 *      bank_name to wrong_account again.
 *
 * Wrap step 1+2+3 in a single transaction so a failure in step 3
 * doesn't leave a half-recorded correction.
 */
import type { Knex } from 'knex';
export type LedgerType = 'S' | 'C';
export interface RecordCorrectionInput {
    bank_name: string;
    wrong_account: string;
    correct_account: string;
    ledger_type: string;
    account_name?: string | null;
    corrected_by?: string;
}
export interface RecordCorrectionResponse {
    success: boolean;
    message?: string;
    error?: string;
}
export declare function recordCorrection(appDb: Knex, input: RecordCorrectionInput): Promise<RecordCorrectionResponse>;
export declare function isNegativeMatch(appDb: Knex, bankName: string, account: string): Promise<boolean>;
export interface ListCorrectionsOptions {
    bankName?: string | null;
    correctAccount?: string | null;
    limit?: number;
}
export interface CorrectionEntry {
    id: number;
    bank_name: string;
    wrong_account: string;
    correct_account: string;
    ledger_type: LedgerType;
    corrected_by: string;
    created_at: string;
}
export interface ListCorrectionsResponse {
    success: boolean;
    entries: CorrectionEntry[];
    count: number;
    error?: string;
}
export declare function listCorrections(appDb: Knex, opts?: ListCorrectionsOptions): Promise<ListCorrectionsResponse>;
//# sourceMappingURL=alias-corrections.d.ts.map
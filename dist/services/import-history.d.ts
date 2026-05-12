/**
 * Bank-import history listing + deletion.
 *
 * Faithful port of:
 *   - get_bank_statement_import_history
 *     (apps/bank_reconcile/api/routes.py:9967-9997)
 *   - delete_bank_statement_import_record (10104-10131)
 *   - clear_bank_statement_import_history (10137-10165)
 *   - get_bank_statement_email_import_history_legacy (10171-10192)
 *
 * Reads from the per-app `bank_statement_imports` table populated by
 * the import flows (migrations 001 + 003 + 009). Filters: bank_code,
 * date range, target_system (default opera_se).
 */
import type { Knex } from 'knex';
export interface BankStatementImportRow {
    id: number;
    bank_code: string;
    filename: string | null;
    statement_date: string | null;
    opening_balance: number | null;
    closing_balance: number | null;
    source: string | null;
    source_ref: string | null;
    imported_by: string | null;
    imported_at: string;
    is_reconciled: boolean;
    reconciled_count: number;
    reconciled_at: string | null;
    target_system: string;
    transactions_imported: number;
    total_receipts: number;
    total_payments: number;
    account_number: string | null;
    sort_code: string | null;
    period_start: string | null;
    period_end: string | null;
    reconciled_by: string | null;
}
export interface ListImportHistoryOptions {
    bankCode?: string | null;
    fromDate?: string | null;
    toDate?: string | null;
    limit?: number;
    /** Filter by target_system (default 'opera_se' to match Python). */
    targetSystem?: string | null;
}
export interface ListImportHistoryResponse {
    success: boolean;
    imports: BankStatementImportRow[];
    count: number;
    error?: string;
}
export declare function listImportHistory(appDb: Knex, opts?: ListImportHistoryOptions): Promise<ListImportHistoryResponse>;
export interface DeleteImportRecordResponse {
    success: boolean;
    message?: string;
    error?: string;
}
export declare function deleteImportRecord(appDb: Knex, recordId: number): Promise<DeleteImportRecordResponse>;
export interface ClearImportHistoryOptions {
    bankCode?: string | null;
    fromDate?: string | null;
    toDate?: string | null;
}
export interface ClearImportHistoryResponse {
    success: boolean;
    deleted_count?: number;
    message?: string;
    error?: string;
}
export declare function clearImportHistory(appDb: Knex, opts?: ClearImportHistoryOptions): Promise<ClearImportHistoryResponse>;
//# sourceMappingURL=import-history.d.ts.map
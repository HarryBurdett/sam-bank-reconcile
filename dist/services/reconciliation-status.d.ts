/**
 * Bank reconciliation status + unreconciled entries.
 *
 * Faithful port of:
 *   OperaSQLImport.get_unreconciled_entries
 *   OperaSQLImport.get_reconciliation_status
 *
 * Both used by the GET /api/reconcile/bank/:bank_code/* endpoints.
 * Read-only against Opera SQL with NOLOCK.
 */
import type { Knex } from 'knex';
export interface UnreconciledEntry {
    ae_entry: string;
    value_pounds: number;
    ae_lstdate: string;
    ae_cbtype: string;
    ae_entref: string;
    ae_comment: string;
    ae_complet: number;
    is_complete: boolean;
}
export interface UnreconciledEntriesResponse {
    success: boolean;
    bank_code: string;
    count: number;
    entries: UnreconciledEntry[];
    error?: string;
}
export declare function getUnreconciledEntries(operaDb: Knex, bankCode: string, includeIncomplete?: boolean): Promise<UnreconciledEntriesResponse>;
export interface StaleReconciledStatement {
    import_id: number;
    filename: string | null;
    statement_date: string | null;
    closing_balance: number;
}
export interface ReconciliationStatus {
    success: boolean;
    bank_account?: string;
    reconciled_balance?: number;
    current_balance?: number;
    unreconciled_difference?: number;
    unreconciled_count?: number;
    unreconciled_total?: number;
    last_rec_line?: number;
    last_stmt_no?: number | null;
    last_stmt_date?: string | null;
    last_rec_date?: string | null;
    rec_cfwd_balance?: number;
    reconciliation_in_progress?: boolean;
    reconciliation_in_progress_message?: string | null;
    partial_entries?: number;
    sequential_gating?: boolean;
    sequential_gating_self?: boolean;
    opera_divergence_detected?: boolean;
    opera_divergence_message?: string | null;
    stale_reconciled_statements?: StaleReconciledStatement[];
    error?: string;
}
export declare function getReconciliationStatus(operaDb: Knex, bankCode: string, appDb?: Knex | null, currentFilename?: string | null): Promise<ReconciliationStatus>;
export interface OperaDivergenceRecoveryResult {
    success: boolean;
    cleared: number;
    cleared_imports?: StaleReconciledStatement[];
    error?: string;
}
/**
 * Find the SAM-reconciled statement whose closing balance matches
 * Opera's current `nk_recbal` (the anchor), then mark every statement
 * reconciled AFTER it as un-reconciled. This handles the legitimate
 * Opera-restore case without false positives from the natural
 * up-and-down movement of the reconciled balance between statements.
 *
 * Refuses to act if no anchor matches — that's the corner case the
 * user flagged where Opera could coincidentally land on a value SAM
 * never saw. In that case the caller is told to investigate manually.
 *
 * Returns the rows that were cleared so the caller can list them in
 * the UI.
 */
export declare function recoverFromOperaDivergence(operaDb: Knex, appDb: Knex, bankCode: string): Promise<OperaDivergenceRecoveryResult>;
//# sourceMappingURL=reconciliation-status.d.ts.map
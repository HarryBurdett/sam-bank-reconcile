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
    /** 'restore' — Opera's reconciled balance is LOWER than SAM's
     *  most-recent reconciled closing (Opera DB likely restored).
     *  'extra'   — Opera's reconciled balance is HIGHER (someone
     *  reconciled outside SAM, or a SAM-imported statement got
     *  posted to Opera but its `is_reconciled` flag never set).
     *  null      — no divergence detected. */
    opera_divergence_direction?: 'restore' | 'extra' | null;
    stale_reconciled_statements?: StaleReconciledStatement[];
    error?: string;
}
export declare function getReconciliationStatus(operaDb: Knex, bankCode: string, appDb?: Knex | null, currentFilename?: string | null): Promise<ReconciliationStatus>;
export interface OperaDivergenceRecoveryResult {
    success: boolean;
    cleared: number;
    cleared_imports?: StaleReconciledStatement[];
    /** Set when the recovery took the "extra" direction path: number
     *  of unreconciled SAM statements that got promoted to
     *  is_reconciled=1 because their closing matched Opera's
     *  current nk_recbal. */
    promoted?: number;
    promoted_imports?: StaleReconciledStatement[];
    /** Recovery direction actually applied. */
    direction?: 'restore' | 'extra' | 'none';
    error?: string;
}
/**
 * Bidirectional Opera-divergence recovery.
 *
 * Two scenarios, both handled symmetrically:
 *
 *   restore (SAM ahead of Opera) — Opera's nk_recbal is LOWER than
 *     SAM's most-recent reconciled closing. Likely Opera DB
 *     restored from backup. Find the SAM "anchor" statement whose
 *     closing == nk_recbal and mark every statement reconciled
 *     AFTER it as un-reconciled.
 *
 *   extra (Opera ahead of SAM) — Opera's nk_recbal is HIGHER than
 *     SAM's most-recent reconciled closing. Either someone
 *     reconciled in Opera Cashbook outside SAM, or (the common
 *     case) a SAM reconcile workflow completed but failed to
 *     flip is_reconciled=1 on the import row (silent UPDATE
 *     failure or missing import_id at the FE). Find SAM
 *     unreconciled statements whose closing chains forward to
 *     Opera's nk_recbal, promote them to is_reconciled=1.
 *
 * Both directions refuse to act when there's no safe match
 * (returns success=true, cleared=0 + a diagnostic message),
 * so the operator can investigate the corner cases manually.
 */
export declare function recoverFromOperaDivergence(operaDb: Knex, appDb: Knex, bankCode: string, opts?: {
    user?: string;
}): Promise<OperaDivergenceRecoveryResult>;
//# sourceMappingURL=reconciliation-status.d.ts.map
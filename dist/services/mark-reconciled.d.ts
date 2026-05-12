/**
 * Mark cashbook entries as reconciled (full or partial).
 *
 * Faithful port of `OperaSQLImport.mark_entries_reconciled`
 * (sql_rag/opera_sql_import.py:7758-8095) + the wrapping endpoint
 * `mark_entries_reconciled` (apps/bank_reconcile/api/routes.py:897-975).
 *
 * Replicates Opera's Bank Reconciliation routine:
 *   - Updates aentry records with rec batch number, statement line,
 *     ae_recbal running balance
 *   - Updates nbank master with new reconciled balance + statement
 *     tracking fields
 *
 * Modes:
 *   - Full reconciliation (partial=false): updates ae_reclnum +
 *     ae_statln + ae_frstat + ae_tostat + ae_recbal + ae_tmpstat=0
 *     and advances nk_recbal
 *   - Partial reconciliation (partial=true): only sets ae_tmpstat
 *     (Opera's "in-progress" sentinel), leaves nk_recbal unchanged
 *     so the next statement is blocked until the user finishes in
 *     Opera Cashbook > Reconcile
 *
 * Locking & concurrency:
 *   - Bank-level import lock (withImportLock)
 *   - UPDLOCK + ROWLOCK on nbank read (atomic counter advance)
 *   - UPDLOCK + ROWLOCK on aentry read (prevent double-stamp)
 *   - ROWLOCK on writes
 *   - Single MSSQL transaction; rollback on validation error or any
 *     UPDATE failure
 *
 * Auto-recovery: when nk_lstrecl < 1 (fresh bank or post-reversal),
 * auto-bump nk_lstrecl + nk_reclnum to 1 in the same transaction so
 * the rec_batch_number is never 0 (which would silently leave entries
 * unreconciled).
 */
import type { Knex } from 'knex';
export interface ReconcileEntryInput {
    entry_number: string;
    statement_line: number;
}
export interface MarkReconciledInput {
    bankCode: string;
    entries: ReconcileEntryInput[];
    statementNumber: number;
    statementDate?: string | null;
    reconciliationDate?: string | null;
    partial?: boolean;
    closingBalance?: number | null;
}
export interface MarkReconciledResponse {
    success: boolean;
    message?: string;
    records_reconciled?: number;
    new_reconciled_balance?: number | null;
    /** Legacy shape — frontend reads `details`
     *  (frontend/src/api/client.ts:MarkReconciledResponse). */
    details?: string[];
    errors?: string[];
    error?: string;
}
export declare function markEntriesReconciled(appDb: Knex, operaDb: Knex, input: MarkReconciledInput): Promise<MarkReconciledResponse>;
//# sourceMappingURL=mark-reconciled.d.ts.map
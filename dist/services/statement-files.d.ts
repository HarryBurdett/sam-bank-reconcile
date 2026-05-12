/**
 * Statement-file management — port of the
 * `/api/statement-files/*` endpoints from
 * `apps/bank_reconcile/api/routes.py`.
 *
 * Manages the bank_statement_imports audit log for post-import
 * reconciliation tracking (mark as reconciled, list pending).
 */
import type { Knex } from 'knex';
export interface ImportedStatement {
    id: number;
    bank_code: string;
    filename: string;
    statement_date: string;
    opening_balance: number;
    closing_balance: number;
    source: string;
    source_ref: string;
    is_reconciled: boolean;
    reconciled_count: number;
    target_system: string;
    imported_by: string;
    imported_at: string;
    reconciled_at: string | null;
}
export interface MarkReconciledInput {
    filename: string;
    bankCode?: string | null;
    reconciledCount?: number;
}
export interface MarkReconciledResponse {
    success: boolean;
    message: string;
    error?: string;
}
export declare function markStatementReconciled(appDb: Knex, input: MarkReconciledInput): Promise<MarkReconciledResponse>;
export interface ImportedStatementsOptions {
    bankCode?: string | null;
    limit?: number;
    includeReconciled?: boolean;
    targetSystem?: string;
}
export interface ImportedStatementsResponse {
    success: boolean;
    statements: ImportedStatement[];
    count: number;
    error?: string;
}
/**
 * List imported bank statements.
 *
 * NB: in the Python implementation this also cross-checks against
 * Opera nbank.nk_recbal + period-reconciliation logic to filter out
 * already-reconciled statements. That cross-check is queued for a
 * future session — the per-app DB read works in isolation now.
 */
export declare function listImportedStatements(appDb: Knex, opts?: ImportedStatementsOptions): Promise<ImportedStatementsResponse>;
//# sourceMappingURL=statement-files.d.ts.map
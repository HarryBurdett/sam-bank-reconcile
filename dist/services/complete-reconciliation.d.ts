/**
 * Complete bank reconciliation — final closer for the recon flow.
 *
 * Faithful port of:
 *   - complete_reconciliation route handler
 *     (apps/bank_reconcile/api/routes.py:10416-10794)
 *   - OperaSQLImport.complete_reconciliation
 *     (sql_rag/opera_sql_import.py:9021-9145)
 *   - calculate_statement_line_numbers
 *     (sql_rag/opera_sql_import.py:8762-8807)
 *
 * Pipeline:
 *   1. Read aentry values for matched entries
 *   2. Compute calculated closing balance (opening + sum of values)
 *   3. Auto-detect partial mode when closing doesn't match within 1p
 *      tolerance (matches Python's behaviour rather than failing hard)
 *   4. Calculate gap-aware ae_statln statement line numbers
 *      (Opera's 10/20/30... convention with insertion gaps)
 *   5. Delegate to markEntriesReconciled (already ported) for the
 *      actual aentry/nbank writes
 *   6. Return enriched ImportResult-style payload
 *
 * The route layer adds period-bound validation, bank lock acquisition,
 * and per-app DB tracking-row updates. Those stay in the router so
 * this service is testable in isolation.
 */
import type { Knex } from 'knex';
import { type MarkReconciledResponse } from './mark-reconciled.js';
export interface CompleteReconciliationInput {
    bankCode: string;
    statementNumber: number;
    /** YYYY-MM-DD or Date. */
    statementDate: string | Date;
    /** Pounds. */
    closingBalance: number;
    matchedEntries: Array<{
        entry_number: string;
        statement_line: number;
    }>;
    /** Original statement transactions in input order — drives gap calculation. */
    statementTransactions: Array<unknown>;
    /** Skip closing balance validation (operator-confirmed partial). */
    partial?: boolean;
    /** Statement period bounds (YYYY-MM-DD). When both supplied, every
     *  matched entry must have at_pstdate within the period or the
     *  reconcile is refused. Faithful port of legacy F12 fix
     *  (routes.py:10894 — uses atran.at_pstdate joined to aentry,
     *  NOT ae_lstdate which is bumped by unrelated edits). */
    periodStart?: string | null;
    periodEnd?: string | null;
}
export interface CompleteReconciliationResponse extends MarkReconciledResponse {
    entries_reconciled?: number;
    partial?: boolean;
    statement_number?: number;
    statement_date?: string;
    closing_balance?: number;
    /** True when Python auto-flipped from full → partial because of a balance mismatch. */
    partial_auto_detected?: boolean;
}
/**
 * Compute statement line numbers (ae_statln) for matched entries with
 * gap-aware spacing for unmatched lines that may be added later in
 * Opera. Pure function — exposed for unit testing.
 *
 * Faithful port of `calculate_statement_line_numbers`. Opera convention:
 * matched lines get 10, 20, 30... with gaps preserved for the
 * unmatched lines that fell before them on the statement.
 */
export declare function calculateStatementLineNumbers(totalLines: number, matchedPositions: number[], unmatchedPositions: number[]): Map<number, number>;
export declare function completeReconciliation(operaDb: Knex, appDb: Knex, input: CompleteReconciliationInput): Promise<CompleteReconciliationResponse>;
//# sourceMappingURL=complete-reconciliation.d.ts.map
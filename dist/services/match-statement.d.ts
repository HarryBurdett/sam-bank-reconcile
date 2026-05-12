/**
 * Match bank-statement lines to unreconciled Opera cashbook entries.
 *
 * Faithful port of OperaSQLImport.match_statement_to_cashbook
 * (sql_rag/opera_sql_import.py:8367-8760) wrapped by the route at
 * apps/bank_reconcile/api/routes.py:10244-10410.
 *
 * Tiered matching:
 *   1. Exact reference + amount → 100% confidence (auto)
 *   2. Amount + closest date    → 55..100% (auto if >=95, suggested otherwise)
 *   3. Already-reconciled scan: any unmatched statement line that
 *      matches a reconciled aentry (ae_reclnum > 0) within the
 *      period/grace window is moved to the `already_reconciled`
 *      bucket so the UI can render it as ✓ instead of ✗.
 *
 * Period bounds are required for in-period matching. When omitted
 * the matcher logs a warning (via `onWarn`) and falls back to an
 * unbounded candidate pool — preserves backwards compat.
 *
 * The Opera-side filter `ae_reclnum = 0 AND ae_remove = 0` (the
 * OPEN_FOR_REC_SQL constant) restricts the candidate pool to
 * unreconciled, undeleted aentries.
 */
import type { Knex } from 'knex';
export interface StatementTransaction {
    line_number?: number;
    date?: string | Date | null;
    amount?: number | string | null;
    reference?: string | null;
    description?: string | null;
    balance?: number | string | null;
}
export interface MatchedRecord {
    statement_line: number;
    statement_date: string | null;
    statement_amount: number;
    statement_reference: string;
    statement_description: string;
    statement_balance: number | null;
    entry_number: string;
    entry_date: string;
    entry_amount: number;
    entry_reference: string;
    entry_description: string;
    confidence: number;
}
export interface UnmatchedStatementRecord {
    statement_line: number;
    statement_date: string | null;
    statement_amount: number;
    statement_reference: string;
    statement_description: string;
    statement_balance: number | null;
}
export interface UnmatchedCashbookRecord {
    entry_number: string;
    entry_date: string;
    entry_amount: number;
    entry_reference: string;
    entry_description: string;
}
export interface AlreadyReconciledRecord extends UnmatchedStatementRecord {
    entry_number: string;
    entry_date: string;
    entry_amount: number;
    entry_reference: string;
    entry_description: string;
    reclnum: number | null;
    rec_date: string;
    match_type: 'already_reconciled';
    confidence: 100;
}
export interface MatchStatementResponse {
    success: boolean;
    auto_matched: MatchedRecord[];
    suggested_matched: MatchedRecord[];
    already_reconciled: AlreadyReconciledRecord[];
    unmatched_statement: UnmatchedStatementRecord[];
    unmatched_cashbook: UnmatchedCashbookRecord[];
    summary: {
        total_statement_lines: number;
        auto_matched_count: number;
        suggested_matched_count: number;
        already_reconciled_count: number;
        unmatched_statement_count: number;
        unmatched_cashbook_count: number;
    };
    error?: string;
}
export interface MatchStatementOptions {
    bankAccount: string;
    statementTransactions: StatementTransaction[];
    /** Default 45 days. */
    dateToleranceDays?: number;
    /** YYYY-MM-DD or Date. */
    periodStart?: string | Date | null;
    /** YYYY-MM-DD or Date. */
    periodEnd?: string | Date | null;
    /** ISO date — earliest date that can legitimately match (closed-year start). */
    openYearStart?: Date | null;
    /** Optional logger for warnings (e.g. fallback to unbounded). */
    onWarn?: (msg: string) => void;
}
export declare function matchStatementToCashbook(operaDb: Knex, opts: MatchStatementOptions): Promise<MatchStatementResponse>;
//# sourceMappingURL=match-statement.d.ts.map
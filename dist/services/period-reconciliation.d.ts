/**
 * Period-reconciliation single source of truth.
 *
 * Faithful port of `sql_rag/period_reconciliation.py:94`
 * (`check_period_reconciled`). Replaces the four scattered heuristics
 * legacy used across scan-all-banks and imported-for-reconciliation.
 *
 * Two-stage rule:
 *   1. Historical match: statement_closing matches a known
 *      reconcile-batch boundary on this bank AND closing < current
 *      rec_bal → period is from a prior closed cycle.
 *   2. Period-aware: closing equals current rec_bal → count
 *      unreconciled aentries in the period; zero means done.
 *
 * Conservative default: returns UNKNOWN if inputs are missing or a
 * data-source query fails. Callers MUST treat UNKNOWN as "show, don't
 * auto-promote" to match legacy's no-quick-fixes mandate.
 */
import type { Knex } from 'knex';
export type PeriodReconciliationStatus = 'fully_reconciled' | 'partially_reconciled' | 'not_reconciled' | 'unknown';
export interface PeriodReconciliationResult {
    status: PeriodReconciliationStatus;
    unreconciled_count: number | null;
    matched_historical_boundary: boolean;
    reason: string;
}
export interface PeriodReconciliationDataSource {
    /** Set of historical reconcile-batch boundary balances for this bank,
     *  in pence (integer-rounded). Any aentry.ae_recbal where
     *  ae_reclnum > 0. */
    queryHistoricalRecbals(bankCode: string): Promise<Set<number>>;
    /** Count of aentry rows on this bank whose ae_lstdate is in
     *  [periodStart, periodEnd] AND ae_reclnum is null or zero. */
    queryUnreconciledInPeriod(bankCode: string, periodStart: string, periodEnd: string): Promise<number>;
}
export declare function checkPeriodReconciled(ds: PeriodReconciliationDataSource, args: {
    bankCode: string;
    periodStart: string | null;
    periodEnd: string | null;
    statementClosing: number | null;
    currentRecBal: number | null;
}): Promise<PeriodReconciliationResult>;
/**
 * Default Opera SE data source for the period-reconciled check.
 * Faithful port of OperaSEDataSource in duplicate_check_se.py — the
 * same NOLOCK queries against atran/aentry that legacy used.
 */
export declare function buildOperaSePeriodReconciliationDs(operaDb: Knex): PeriodReconciliationDataSource;
//# sourceMappingURL=period-reconciliation.d.ts.map
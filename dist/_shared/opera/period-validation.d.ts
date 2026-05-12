/**
 * Opera period validation — controls which dates are allowed for new
 * postings.
 *
 * Faithful port of the period helpers in `sql_rag/opera_config.py`:
 *   - get_period_for_date           (nclndd lookup)
 *   - get_current_period_info       (nparm — np_year, np_perno, np_periods)
 *   - get_period_status             (nclndd ledger-specific status)
 *   - is_open_period_accounting_enabled (seqco.co_opanl with nparm fallback)
 *   - is_real_time_update_enabled   (seqco.co_rtupdnl)
 *   - validate_posting_period       (high-level orchestration)
 *   - get_ledger_type_for_transaction (transaction-type → ledger code)
 *
 * Used by GoCardless validate-date, the bank-reconcile import flows,
 * and any service that needs to gate writes on Opera's
 * period-status rules.
 *
 * Period status values:
 *   0 = Open    (writes allowed)
 *   1 = Blocked
 *   2 = Closed
 */
import type { Knex } from 'knex';
export type LedgerType = 'NL' | 'SL' | 'PL' | 'ST' | 'WG' | 'FA';
export interface PeriodInfo {
    np_year: number | null;
    np_perno: number | null;
    np_periods: number;
}
export interface PeriodValidationResult {
    is_valid: boolean;
    error_message?: string | null;
    year: number;
    period: number;
    open_period_accounting: boolean;
}
export declare function getPeriodForDate(operaDb: Knex, postDate: Date | string): Promise<{
    period: number;
    year: number;
}>;
export declare function getCurrentPeriodInfo(operaDb: Knex): Promise<PeriodInfo>;
export declare function getPeriodStatus(operaDb: Knex, year: number, period: number, ledgerType: LedgerType): Promise<number | null>;
export declare function isOpenPeriodAccountingEnabled(operaDb: Knex): Promise<boolean>;
export declare function isRealTimeUpdateEnabled(operaDb: Knex): Promise<boolean>;
export declare function validatePostingPeriod(operaDb: Knex, postDate: Date | string, ledgerType?: LedgerType): Promise<PeriodValidationResult>;
export declare function getLedgerTypeForTransaction(transactionType: string): LedgerType;
//# sourceMappingURL=period-validation.d.ts.map
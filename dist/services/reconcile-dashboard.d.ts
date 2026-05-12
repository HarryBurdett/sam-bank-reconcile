/**
 * Bank reconciliation dashboard for a single bank account.
 *
 * Faithful port of `reconcile_bank` (apps/bank_reconcile/api/routes.py:320-720).
 * Pulls together:
 *   - Cashbook movements from atran (current year + all-time)
 *   - Bank master balance from nbank.nk_curbal
 *   - Nominal ledger balance from nacnt + ntran (current year + B/F)
 *   - Transfer file (anoml) pending and posted summaries
 * and computes three-way variance (cashbook vs bank master, bank
 * master vs nominal, cashbook vs nominal). When all three match
 * within 0.005, status is RECONCILED.
 */
import type { Knex } from 'knex';
export interface BankAccountInfo {
    code: string;
    description: string;
    sort_code: string;
    account_number: string;
}
export interface NominalLedgerDetail {
    source: string;
    account: string;
    description: string;
    current_year?: number;
    brought_forward?: number;
    current_year_debits?: number;
    current_year_credits?: number;
    current_year_net?: number;
    closing_balance?: number;
    total_balance: number;
}
export interface PendingTransfer {
    nominal_account: string;
    source: string;
    source_desc: string;
    date: string;
    value: number;
    reference: string;
    comment: string;
}
export interface ReconcileDashboardResponse {
    success: boolean;
    reconciliation_date?: string;
    bank_code?: string;
    bank_account?: BankAccountInfo;
    cashbook?: {
        source: string;
        current_year: number;
        current_year_entries: number;
        current_year_transactions: number;
        current_year_receipts: number;
        current_year_payments: number;
        current_year_movements: number;
        prior_year_bf: number;
        expected_closing: number;
        all_time_entries: number;
        all_time_net: number;
        transfer_file: {
            source: string;
            posted_to_nl: {
                count: number;
                total: number;
            };
            pending_transfer: {
                count: number;
                total: number;
                transactions: PendingTransfer[];
            };
        };
    };
    bank_master?: {
        source: string;
        balance_pence: number;
        balance_pounds: number;
    };
    nominal_ledger?: NominalLedgerDetail;
    variance?: {
        cashbook_vs_bank_master: {
            description: string;
            cashbook_expected: number;
            bank_master: number;
            amount: number;
            absolute: number;
            reconciled: boolean;
        };
        bank_master_vs_nominal: {
            description: string;
            bank_master: number;
            nominal_ledger: number;
            amount: number;
            absolute: number;
            reconciled: boolean;
        };
        cashbook_vs_nominal: {
            description: string;
            cashbook_expected: number;
            nominal_ledger: number;
            amount: number;
            absolute: number;
            reconciled: boolean;
        };
        summary: {
            current_year: number;
            cashbook_movements: number;
            prior_year_bf: number;
            cashbook_expected_closing: number;
            bank_master_balance: number;
            nominal_ledger_balance: number;
            transfer_file_pending: number;
            all_reconciled: boolean;
            has_pending_transfers: boolean;
        };
    };
    status?: 'RECONCILED' | 'UNRECONCILED';
    message?: string;
    error?: string;
}
export declare function reconcileBankDashboard(operaDb: Knex, bankCode: string): Promise<ReconcileDashboardResponse>;
//# sourceMappingURL=reconcile-dashboard.d.ts.map
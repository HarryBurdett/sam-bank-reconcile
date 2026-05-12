/**
 * Reconcile a bank account across cashbook (atran), bank master
 * (nbank.nk_curbal), and nominal ledger (ntran).
 *
 * Faithful port of `reconcile_bank` (apps/bank_reconcile/api/
 * routes.py:320-704).
 *
 * Reads:
 *   - nbank for account info + current balance (in pence)
 *   - atran for cashbook movements (current year + all time, in pence)
 *   - nacnt for prior-year B/F + description
 *   - ntran for current-year debits / credits / net (in pounds)
 *   - anoml for transfer-file posted vs pending state
 *
 * All three balances should match when fully reconciled:
 *   1. atran current-year movements + B/F  →  cashbook expected closing
 *   2. nbank.nk_curbal                    →  bank master balance
 *   3. ntran current-year net             →  nominal ledger balance
 *
 * Tolerance for "reconciled" is < £0.005.
 */
import type { Knex } from 'knex';
export interface BankAccountInfo {
    code: string;
    description: string;
    sort_code: string;
    account_number: string;
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
export interface CashbookSection {
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
}
export interface BankMasterSection {
    source: string;
    balance_pence: number;
    balance_pounds: number;
}
export interface NominalLedgerSection {
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
export interface VarianceComparison {
    description: string;
    cashbook_expected?: number;
    bank_master?: number;
    nominal_ledger?: number;
    amount: number;
    absolute: number;
    reconciled: boolean;
}
export interface ReconcileBankResponse {
    success: boolean;
    reconciliation_date?: string;
    bank_code?: string;
    bank_account?: BankAccountInfo;
    cashbook?: CashbookSection;
    bank_master?: BankMasterSection;
    nominal_ledger?: NominalLedgerSection;
    variance?: {
        cashbook_vs_bank_master: VarianceComparison;
        bank_master_vs_nominal: VarianceComparison;
        cashbook_vs_nominal: VarianceComparison;
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
    details?: unknown[];
    error?: string;
}
export declare function reconcileBank(operaDb: Knex, bankCode: string, now?: Date): Promise<ReconcileBankResponse>;
//# sourceMappingURL=reconcile-bank.d.ts.map
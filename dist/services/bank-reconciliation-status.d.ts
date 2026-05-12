/**
 * Bank reconciliation status + history queries.
 *
 * Faithful ports of:
 *   - get_bank_reconciliation_status (routes.py:711)
 *   - get_unreconciled_entries_for_bank (routes.py:10921)
 *   - get_statement_transactions (routes.py:10800)
 *
 * Used by the bank-reconciliation UI to render "where are we?" state
 * across all bank accounts and to display previously imported
 * statement transactions for review.
 */
import type { Knex } from 'knex';
export interface BankReconciliationStatusEntry {
    bank_code: string;
    description: string;
    reconciled_balance: number | null;
    current_balance: number | null;
    unreconciled_count: number;
    unreconciled_total: number;
    last_reconciled: string | null;
}
export declare function getBankReconciliationStatus(operaDb: Knex): Promise<{
    success: boolean;
    banks: BankReconciliationStatusEntry[];
    error?: string;
}>;
export interface UnreconciledEntry {
    bank_code: string;
    date: string;
    reference: string;
    amount: number;
    comment: string;
    entry_number: string;
}
export declare function getUnreconciledEntriesForBank(operaDb: Knex, bankCode: string | null): Promise<{
    success: boolean;
    entries: UnreconciledEntry[];
    error?: string;
}>;
export interface StatementTransaction {
    line_number: number;
    date: string | null;
    description: string | null;
    amount: number;
    balance: number | null;
    type: string;
    reference: string | null;
    matched_entry: string | null;
    match_confidence: number | null;
    match_type: string | null;
    is_reconciled: boolean;
    posted_entry_number: string | null;
    posted_at: string | null;
}
export declare function getStatementTransactionsForImport(appDb: Knex, importId: number): Promise<{
    success: boolean;
    transactions: StatementTransaction[];
    error?: string;
}>;
//# sourceMappingURL=bank-reconciliation-status.d.ts.map
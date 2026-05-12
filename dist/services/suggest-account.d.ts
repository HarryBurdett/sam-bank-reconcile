/**
 * Suggest a customer or supplier account for a bank-statement line.
 *
 * Faithful port of `suggest_account_for_transaction`
 * (apps/bank_reconcile/api/routes.py:11225-11334).
 *
 * Three-tier matcher:
 *   1. Substring         (confidence 95)  — direct contains in either direction
 *   2. Word match        (confidence ≥ 70) — significant words intersection
 *   3. Fuzzy             (confidence ≥ 60) — Ratcliff/Obershelp ratio
 *
 * Sales transactions search sname (customers); purchase transactions
 * search pname (suppliers). Dormant accounts are excluded.
 */
import type { Knex } from 'knex';
export type TransactionType = 'sales_receipt' | 'sales_refund' | 'purchase_payment' | 'purchase_refund';
export type MatchStrategy = 'substring' | 'word_match' | 'fuzzy';
export interface AccountSuggestion {
    code: string;
    name: string;
    score: number;
    match_type: MatchStrategy;
}
export interface SuggestAccountResponse {
    success: boolean;
    suggestions: AccountSuggestion[];
    ledger_type?: 'C' | 'S';
    searched_count?: number;
    search_term?: string;
    error?: string;
}
export declare function suggestAccountForTransaction(operaDb: Knex, name: string, transactionType: TransactionType, limit?: number): Promise<SuggestAccountResponse>;
//# sourceMappingURL=suggest-account.d.ts.map
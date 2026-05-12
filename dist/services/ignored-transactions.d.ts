/**
 * Ignored bank transactions — port of the helpers in
 * `apps/bank_reconcile/api/routes.py` that mark statement lines as
 * "already in Opera manually, don't reconcile to me".
 *
 * Storage: under Python lives in core-email's email_data.db; under SAM
 * moves to the bank-reconcile per-app database (table
 * `ignored_bank_transactions`).
 */
import type { Knex } from 'knex';
export interface IgnoredTransaction {
    id: number;
    bank_code: string;
    transaction_date: string;
    amount: number;
    description: string;
    reference: string;
    reason: string;
    ignored_by: string;
    ignored_at: string;
}
export interface IgnoreInput {
    bankCode: string;
    transactionDate: string;
    amount: number;
    description?: string | null;
    reference?: string | null;
    reason?: string | null;
    ignoredBy?: string;
}
export interface IgnoreResponse {
    success: boolean;
    message?: string;
    record_id?: number;
    error?: string;
}
export declare function ignoreTransaction(appDb: Knex, input: IgnoreInput): Promise<IgnoreResponse>;
export interface IgnoredListResponse {
    success: boolean;
    transactions: IgnoredTransaction[];
    count: number;
    error?: string;
}
export declare function listIgnoredTransactions(appDb: Knex, bankCode: string, limit?: number): Promise<IgnoredListResponse>;
export interface UnignoreResponse {
    success: boolean;
    message?: string;
    error?: string;
}
/** Remove an ignored-transaction record by id. */
export declare function unignoreTransactionById(appDb: Knex, recordId: number): Promise<UnignoreResponse>;
/**
 * Remove an ignored transaction by matching bank+date+amount.
 * Used when the user re-checks the include checkbox on an unmatched item.
 */
export declare function unignoreTransactionByMatch(appDb: Knex, bankCode: string, transactionDate: string, amount: number): Promise<UnignoreResponse>;
//# sourceMappingURL=ignored-transactions.d.ts.map
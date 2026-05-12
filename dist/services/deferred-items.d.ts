/**
 * Deferred-transaction audit log per bank account.
 *
 * Faithful ports of:
 *   - audit_defer (routes.py:16063)
 *   - get_deferred_items (routes.py:16175)
 *   - delete_deferred_items (routes.py:16113)
 *   - delete_ignored_transaction (routes.py:1213) — by record_id
 *
 * Persisted in the per-app `deferred_transactions` table created by
 * migration 011 alongside this file.
 */
import type { Knex } from 'knex';
export interface DeferredItem {
    id: number;
    bank_code: string;
    statement_date: string;
    amount: number;
    description: string;
    deferred_by: string;
    deferred_at: string;
}
export declare function recordDeferredTransaction(appDb: Knex, args: {
    bankCode: string;
    statementDate: string;
    amount: number;
    description: string;
    deferredBy: string;
}): Promise<{
    success: boolean;
    id?: number;
    error?: string;
}>;
export declare function listDeferredItems(appDb: Knex, bankCode: string): Promise<{
    success: boolean;
    items: DeferredItem[];
    error?: string;
}>;
export declare function deleteDeferredItems(appDb: Knex, bankCode: string, ids?: number[]): Promise<{
    success: boolean;
    deleted: number;
    error?: string;
}>;
export declare function deleteIgnoredTransactionByRecordId(appDb: Knex, recordId: number): Promise<{
    success: boolean;
    deleted: number;
    error?: string;
}>;
//# sourceMappingURL=deferred-items.d.ts.map
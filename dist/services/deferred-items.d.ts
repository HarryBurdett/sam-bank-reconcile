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
/**
 * Auto-clean defer audit rows whose transaction has since appeared
 * in Opera atran for this bank — i.e. the operator entered the
 * transaction manually after deferring it. Faithful port of
 * `_auto_clean_resolved_defers` (apps/bank_reconcile/api/routes.py:133).
 *
 * Match criteria:
 *   - same bank (at_acnt)
 *   - signed amount in pence matches at_value (within ±1p, sign-aware
 *     per audit F14 — ABS-on-ABS would auto-clean a deferred receipt
 *     against an unrelated payment of the same magnitude)
 *   - at_pstdate >= open nominal year start (you can't post to closed
 *     years anyway). When the nclndd/nparm lookup fails, default to a
 *     2-year lookback per legacy line 162.
 *
 * Idempotent and silent. Fire from any scan-style endpoint to keep
 * deferred_count accurate. Returns number of rows cleaned.
 */
export declare function autoCleanResolvedDefers(appDb: Knex, operaDb: Knex | null, bankCode: string): Promise<number>;
export declare function deleteIgnoredTransactionByRecordId(appDb: Knex, recordId: number): Promise<{
    success: boolean;
    deleted: number;
    error?: string;
}>;
//# sourceMappingURL=deferred-items.d.ts.map
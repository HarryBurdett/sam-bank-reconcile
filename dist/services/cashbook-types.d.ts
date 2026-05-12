/**
 * Cashbook types from Opera (atype table).
 *
 * Faithful port of `get_cashbook_types` in
 * `apps/bank_reconcile/api/routes.py:3009-3040`.
 *
 * Returns the configured cashbook entry types — used by the bank import
 * UI when the user manually assigns a transaction's posting category.
 *
 * Optional category filter:
 *   - 'R' → Receipts (sales receipts, nominal receipts, etc.)
 *   - 'P' → Payments (purchase payments, nominal payments, etc.)
 *   - 'T' → Transfers
 */
import type { Knex } from 'knex';
export interface CashbookType {
    code: string;
    description: string;
    category: string;
    batched: boolean;
}
export interface ListCashbookTypesResponse {
    success: boolean;
    types: CashbookType[];
    error?: string;
}
export declare function listCashbookTypes(operaDb: Knex, category?: string | null): Promise<ListCashbookTypesResponse>;
//# sourceMappingURL=cashbook-types.d.ts.map
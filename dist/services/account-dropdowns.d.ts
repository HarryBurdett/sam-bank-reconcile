/**
 * Customer/supplier dropdowns for bank-import UI manual override.
 *
 * Faithful port of `get_customers_for_dropdown` and
 * `get_suppliers_for_dropdown` (apps/bank_reconcile/api/routes.py
 * :4767-4849). Returns simplified rows ready for `<select>` rendering.
 *
 * Per CLAUDE.md "dormant accounts excluded — cannot post to dormant
 * accounts": adds (sn_dormant=0 OR NULL) and (pn_dormant=0 OR NULL)
 * filters that the Python source missed for these dropdowns. The
 * matcher (`/api/gocardless/match-customers`) already enforces
 * dormant-exclusion; doing the same here means the operator can't
 * manually pick a dormant account either.
 */
import type { Knex } from 'knex';
export interface CustomerAccount {
    code: string;
    name: string;
    search_key: string;
    display: string;
}
export interface SupplierAccount {
    code: string;
    name: string;
    payee: string;
    display: string;
}
export interface CustomersDropdownResponse {
    success: boolean;
    count: number;
    accounts: CustomerAccount[];
    error?: string;
}
export interface SuppliersDropdownResponse {
    success: boolean;
    count: number;
    accounts: SupplierAccount[];
    error?: string;
}
export declare function getCustomersForDropdown(operaDb: Knex): Promise<CustomersDropdownResponse>;
export declare function getSuppliersForDropdown(operaDb: Knex): Promise<SuppliersDropdownResponse>;
//# sourceMappingURL=account-dropdowns.d.ts.map
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

export async function getCustomersForDropdown(
  operaDb: Knex,
): Promise<CustomersDropdownResponse> {
  try {
    const rows = (await operaDb.raw(`
      SELECT
        RTRIM(sn_account) as code,
        RTRIM(sn_name) as name,
        RTRIM(ISNULL(sn_key1, '')) as search_key
      FROM sname WITH (NOLOCK)
      WHERE (sn_stop = 0 OR sn_stop IS NULL)
        AND (sn_dormant = 0 OR sn_dormant IS NULL)
      ORDER BY sn_account
    `)) as unknown as Array<{
      code: string | null;
      name: string | null;
      search_key: string | null;
    }>;

    const accounts: CustomerAccount[] = (Array.isArray(rows) ? rows : []).map(
      (r) => ({
        code: (r.code ?? '').trim(),
        name: (r.name ?? '').trim(),
        search_key: (r.search_key ?? '').trim(),
        display: `${(r.code ?? '').trim()} - ${(r.name ?? '').trim()}`,
      }),
    );
    return { success: true, count: accounts.length, accounts };
  } catch (err: any) {
    return {
      success: false,
      count: 0,
      accounts: [],
      error: err?.message ?? String(err),
    };
  }
}

export async function getSuppliersForDropdown(
  operaDb: Knex,
): Promise<SuppliersDropdownResponse> {
  try {
    const rows = (await operaDb.raw(`
      SELECT
        RTRIM(pn_account) as code,
        RTRIM(pn_name) as name,
        RTRIM(ISNULL(pn_payee, '')) as payee
      FROM pname WITH (NOLOCK)
      WHERE (pn_stop = 0 OR pn_stop IS NULL)
        AND (pn_dormant = 0 OR pn_dormant IS NULL)
      ORDER BY pn_account
    `)) as unknown as Array<{
      code: string | null;
      name: string | null;
      payee: string | null;
    }>;

    const accounts: SupplierAccount[] = (Array.isArray(rows) ? rows : []).map(
      (r) => ({
        code: (r.code ?? '').trim(),
        name: (r.name ?? '').trim(),
        payee: (r.payee ?? '').trim(),
        display: `${(r.code ?? '').trim()} - ${(r.name ?? '').trim()}`,
      }),
    );
    return { success: true, count: accounts.length, accounts };
  } catch (err: any) {
    return {
      success: false,
      count: 0,
      accounts: [],
      error: err?.message ?? String(err),
    };
  }
}

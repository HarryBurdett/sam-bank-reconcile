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

export async function listCashbookTypes(
  operaDb: Knex,
  category: string | null = null,
): Promise<ListCashbookTypesResponse> {
  try {
    let sql = `
      SELECT ay_cbtype, ay_desc, ay_type, ay_batched
      FROM atype WITH (NOLOCK)
    `;
    const params: string[] = [];
    if (category) {
      sql += ' WHERE RTRIM(ay_type) = ?';
      params.push(category);
    }
    sql += ' ORDER BY ay_type, ay_cbtype';

    const rows = (await operaDb.raw(sql, params)) as unknown as Array<{
      ay_cbtype: string | null;
      ay_desc: string | null;
      ay_type: string | null;
      ay_batched: number | boolean | null;
    }>;

    if (!Array.isArray(rows) || rows.length === 0) {
      return { success: true, types: [] };
    }

    const types: CashbookType[] = rows.map((r) => ({
      code: (r.ay_cbtype ?? '').trim(),
      description: (r.ay_desc ?? '').trim(),
      category: (r.ay_type ?? '').trim(),
      batched: !!r.ay_batched,
    }));

    return { success: true, types };
  } catch (err: any) {
    return {
      success: false,
      types: [],
      error: err?.message ?? String(err),
    };
  }
}

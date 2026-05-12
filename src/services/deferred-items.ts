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

export async function recordDeferredTransaction(
  appDb: Knex,
  args: {
    bankCode: string;
    statementDate: string;
    amount: number;
    description: string;
    deferredBy: string;
  },
): Promise<{ success: boolean; id?: number; error?: string }> {
  if (!args.bankCode) return { success: false, error: 'bank_code required' };
  try {
    const [id] = (await appDb('deferred_transactions')
      .insert({
        bank_code: args.bankCode,
        statement_date: args.statementDate,
        amount: args.amount,
        description: args.description.slice(0, 255),
        deferred_by: args.deferredBy,
      })
      .returning('id')) as unknown as Array<number | { id: number }>;
    const numericId =
      typeof id === 'number' ? id : Number(id?.id ?? 0);
    return { success: true, id: numericId };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

export async function listDeferredItems(
  appDb: Knex,
  bankCode: string,
): Promise<{ success: boolean; items: DeferredItem[]; error?: string }> {
  try {
    const rows = (await appDb('deferred_transactions')
      .where({ bank_code: bankCode })
      .orderBy('deferred_at', 'desc')) as unknown as Array<{
      id: number;
      bank_code: string;
      statement_date: string | Date | null;
      amount: number | string;
      description: string;
      deferred_by: string;
      deferred_at: string | Date;
    }>;
    return {
      success: true,
      items: rows.map((r) => ({
        id: Number(r.id),
        bank_code: r.bank_code,
        statement_date:
          r.statement_date instanceof Date
            ? r.statement_date.toISOString().slice(0, 10)
            : String(r.statement_date ?? '').slice(0, 10),
        amount: Number(r.amount),
        description: r.description,
        deferred_by: r.deferred_by,
        deferred_at:
          r.deferred_at instanceof Date
            ? r.deferred_at.toISOString()
            : String(r.deferred_at),
      })),
    };
  } catch (err: any) {
    return { success: false, items: [], error: err?.message ?? String(err) };
  }
}

export async function deleteDeferredItems(
  appDb: Knex,
  bankCode: string,
  ids?: number[],
): Promise<{ success: boolean; deleted: number; error?: string }> {
  try {
    let q = appDb('deferred_transactions').where({ bank_code: bankCode });
    if (ids && ids.length > 0) {
      q = q.whereIn('id', ids);
    }
    const deleted = await q.delete();
    return { success: true, deleted };
  } catch (err: any) {
    return {
      success: false,
      deleted: 0,
      error: err?.message ?? String(err),
    };
  }
}

export async function deleteIgnoredTransactionByRecordId(
  appDb: Knex,
  recordId: number,
): Promise<{ success: boolean; deleted: number; error?: string }> {
  if (!Number.isFinite(recordId) || recordId <= 0) {
    return { success: false, deleted: 0, error: 'invalid record_id' };
  }
  try {
    const deleted = await appDb('ignored_transactions')
      .where({ id: recordId })
      .delete();
    return { success: true, deleted };
  } catch (err: any) {
    return {
      success: false,
      deleted: 0,
      error: err?.message ?? String(err),
    };
  }
}

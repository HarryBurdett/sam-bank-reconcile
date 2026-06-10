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
import { companyScope } from '../_shared/get-company.js';

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
  companyCode: string,
  args: {
    bankCode: string;
    statementDate: string;
    amount: number;
    description: string;
    deferredBy: string;
  },
): Promise<{ success: boolean; id?: number; error?: string }> {
  if (!args.bankCode) return { success: false, error: 'bank_code required' };
  const scope = companyScope(companyCode);
  try {
    const [id] = (await appDb('deferred_transactions')
      .insert({
        ...scope,
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
  companyCode: string,
  bankCode: string,
): Promise<{ success: boolean; items: DeferredItem[]; error?: string }> {
  const scope = companyScope(companyCode);
  try {
    const rows = (await appDb('deferred_transactions')
      .where({ ...scope, bank_code: bankCode })
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
  companyCode: string,
  bankCode: string,
  ids?: number[],
): Promise<{ success: boolean; deleted: number; error?: string }> {
  const scope = companyScope(companyCode);
  try {
    let q = appDb('deferred_transactions').where({ ...scope, bank_code: bankCode });
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
export async function autoCleanResolvedDefers(
  appDb: Knex,
  companyCode: string,
  operaDb: Knex | null,
  bankCode: string,
): Promise<number> {
  if (!bankCode || !operaDb) return 0;
  const scope = companyScope(companyCode);
  try {
    const items = (await appDb('deferred_transactions')
      .where({ ...scope, bank_code: bankCode })
      .select('id', 'amount')) as unknown as Array<{
      id: number;
      amount: number | string | null;
    }>;
    if (!items.length) return 0;

    // Open-year start via the period-validation helper. When the
    // lookup fails (no nparm/nclndd), default to today - 730d so
    // legitimate late entries still resolve.
    let openYearStart: string | null = null;
    try {
      const rows = (await operaDb.raw(
        `SELECT TOP 1 MIN(ncd_stdate) AS open_start
         FROM nclndd WITH (NOLOCK)
         WHERE ncd_year = (SELECT TOP 1 np_year FROM nparm WITH (NOLOCK))`,
      )) as unknown as Array<{ open_start?: string | Date | null }>;
      const raw = Array.isArray(rows) ? rows[0]?.open_start : null;
      if (raw instanceof Date) {
        openYearStart = raw.toISOString().slice(0, 10);
      } else if (typeof raw === 'string' && raw.length >= 10) {
        openYearStart = raw.slice(0, 10);
      }
    } catch {
      /* tolerated */
    }
    if (!openYearStart) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - 730);
      openYearStart = d.toISOString().slice(0, 10);
    }

    const cleaned: number[] = [];
    for (const item of items) {
      try {
        const amountPence = Math.round(Number(item.amount ?? 0) * 100);
        if (amountPence === 0) continue;
        const probe = (await operaDb.raw(
          `SELECT TOP 1 at_unique FROM atran WITH (NOLOCK)
           WHERE at_acnt = ?
             AND at_pstdate >= ?
             AND ABS(at_value - ?) < 1`,
          [bankCode, openYearStart, amountPence],
        )) as unknown as Array<{ at_unique?: unknown }>;
        if (Array.isArray(probe) && probe.length > 0) {
          cleaned.push(Number(item.id));
        }
      } catch {
        /* row-level skip */
      }
    }
    if (cleaned.length > 0) {
      await appDb('deferred_transactions')
        .where({ ...scope, bank_code: bankCode })
        .whereIn('id', cleaned)
        .delete();
      // eslint-disable-next-line no-console
      console.info(
        `[bank-reconcile] defer auto-clean: removed ${cleaned.length} row(s) ` +
          `for ${bankCode} — matching atran entry now exists`,
      );
    }
    return cleaned.length;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[bank-reconcile] defer auto-clean failed for ${bankCode}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 0;
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

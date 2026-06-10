/**
 * Ignored bank transactions — port of the helpers in
 * `apps/bank_reconcile/api/routes.py` that mark statement lines as
 * "already in Opera manually, don't reconcile to me".
 *
 * Storage: under Python lives in core-email's email_data.db; under SAM
 * moves to the bank-reconcile per-app database (table
 * `ignored_bank_transactions`). Migration 020 added a `company_code`
 * column — every read and write is now company-scoped.
 */
import type { Knex } from 'knex';
import { companyScope } from '../_shared/get-company.js';

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

function dateToYmd(d: Date | string | null): string {
  if (!d) return '';
  if (d instanceof Date) {
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
  }
  return String(d).slice(0, 10);
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

export async function ignoreTransaction(
  appDb: Knex,
  companyCode: string,
  input: IgnoreInput,
): Promise<IgnoreResponse> {
  const scope = companyScope(companyCode);
  try {
    const inserted = await appDb('ignored_bank_transactions')
      .insert({
        ...scope,
        bank_code: input.bankCode,
        transaction_date: input.transactionDate,
        amount: input.amount,
        description: input.description ?? null,
        reference: input.reference ?? null,
        reason: input.reason ?? null,
        ignored_by: input.ignoredBy ?? 'API',
      })
      .returning('id');

    const recordId =
      Array.isArray(inserted) && inserted.length > 0
        ? typeof inserted[0] === 'object'
          ? (inserted[0] as { id: number }).id
          : Number(inserted[0])
        : 0;

    return {
      success: true,
      message: `Transaction ignored: £${input.amount.toFixed(2)} on ${input.transactionDate}`,
      record_id: recordId,
    };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

export interface IgnoredListResponse {
  success: boolean;
  transactions: IgnoredTransaction[];
  count: number;
  error?: string;
}

export async function listIgnoredTransactions(
  appDb: Knex,
  companyCode: string,
  bankCode: string,
  limit = 100,
): Promise<IgnoredListResponse> {
  const scope = companyScope(companyCode);
  try {
    const rows = (await appDb('ignored_bank_transactions')
      .where({ ...scope, bank_code: bankCode })
      .orderBy('transaction_date', 'desc')
      .limit(limit)) as unknown as Array<{
      id: number;
      bank_code: string;
      transaction_date: Date | string;
      amount: number;
      description: string | null;
      reference: string | null;
      reason: string | null;
      ignored_by: string | null;
      ignored_at: Date | string;
    }>;

    const transactions: IgnoredTransaction[] = rows.map((r) => ({
      id: r.id,
      bank_code: r.bank_code,
      transaction_date: dateToYmd(r.transaction_date),
      amount: Number(r.amount ?? 0),
      description: r.description ?? '',
      reference: r.reference ?? '',
      reason: r.reason ?? '',
      ignored_by: r.ignored_by ?? '',
      ignored_at:
        r.ignored_at instanceof Date
          ? r.ignored_at.toISOString()
          : String(r.ignored_at ?? ''),
    }));

    return { success: true, transactions, count: transactions.length };
  } catch (err: any) {
    return {
      success: false,
      transactions: [],
      count: 0,
      error: err?.message ?? String(err),
    };
  }
}

export interface UnignoreResponse {
  success: boolean;
  message?: string;
  error?: string;
}

/** Remove an ignored-transaction record by id. */
export async function unignoreTransactionById(
  appDb: Knex,
  companyCode: string,
  recordId: number,
): Promise<UnignoreResponse> {
  const scope = companyScope(companyCode);
  try {
    const deleted = await appDb('ignored_bank_transactions')
      .where({ ...scope, id: recordId })
      .delete();
    if (deleted > 0) {
      return { success: true, message: 'Transaction removed from ignored list' };
    }
    return { success: false, error: 'Record not found' };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

/**
 * Remove an ignored transaction by matching bank+date+amount.
 * Used when the user re-checks the include checkbox on an unmatched item.
 */
export async function unignoreTransactionByMatch(
  appDb: Knex,
  companyCode: string,
  bankCode: string,
  transactionDate: string,
  amount: number,
): Promise<UnignoreResponse> {
  const scope = companyScope(companyCode);
  try {
    const deleted = await appDb('ignored_bank_transactions')
      .where({
        ...scope,
        bank_code: bankCode,
        transaction_date: transactionDate,
        amount,
      })
      .delete();
    if (deleted > 0) {
      return { success: true, message: 'Transaction removed from ignored list' };
    }
    return { success: false, error: 'No matching ignored transaction found' };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

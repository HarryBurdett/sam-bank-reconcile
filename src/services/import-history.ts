/**
 * Bank-import history listing + deletion.
 *
 * Faithful port of:
 *   - get_bank_statement_import_history
 *     (apps/bank_reconcile/api/routes.py:9967-9997)
 *   - delete_bank_statement_import_record (10104-10131)
 *   - clear_bank_statement_import_history (10137-10165)
 *   - get_bank_statement_email_import_history_legacy (10171-10192)
 *
 * Reads from the per-app `bank_statement_imports` table populated by
 * the import flows (migrations 001 + 003 + 009). Filters: bank_code,
 * date range, target_system (default opera_se).
 */
import type { Knex } from 'knex';

export interface BankStatementImportRow {
  id: number;
  bank_code: string;
  filename: string | null;
  statement_date: string | null;
  opening_balance: number | null;
  closing_balance: number | null;
  source: string | null;
  source_ref: string | null;
  imported_by: string | null;
  imported_at: string;
  is_reconciled: boolean;
  reconciled_count: number;
  reconciled_at: string | null;
  target_system: string;
  transactions_imported: number;
  total_receipts: number;
  total_payments: number;
  account_number: string | null;
  sort_code: string | null;
  period_start: string | null;
  period_end: string | null;
  reconciled_by: string | null;
}

export interface ListImportHistoryOptions {
  bankCode?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
  limit?: number;
  /** Filter by target_system (default 'opera_se' to match Python). */
  targetSystem?: string | null;
}

export interface ListImportHistoryResponse {
  success: boolean;
  imports: BankStatementImportRow[];
  count: number;
  error?: string;
}

function dateToIso(d: Date | string | null | undefined): string {
  if (!d) return '';
  if (d instanceof Date) {
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString();
  }
  return String(d);
}

function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v === '1' || v.toLowerCase() === 'true';
  return false;
}

function rowToImport(r: any): BankStatementImportRow {
  return {
    id: Number(r.id),
    bank_code: r.bank_code ?? '',
    filename: r.filename ?? null,
    statement_date: r.statement_date ? dateToIso(r.statement_date) : null,
    opening_balance:
      r.opening_balance === null || r.opening_balance === undefined
        ? null
        : Number(r.opening_balance),
    closing_balance:
      r.closing_balance === null || r.closing_balance === undefined
        ? null
        : Number(r.closing_balance),
    source: r.source ?? null,
    source_ref: r.source_ref ?? null,
    imported_by: r.imported_by ?? null,
    imported_at: dateToIso(r.imported_at),
    is_reconciled: toBool(r.is_reconciled),
    reconciled_count: Number(r.reconciled_count ?? 0),
    reconciled_at: r.reconciled_at ? dateToIso(r.reconciled_at) : null,
    target_system: r.target_system ?? 'opera_se',
    transactions_imported: Number(r.transactions_imported ?? 0),
    total_receipts: Number(r.total_receipts ?? 0),
    total_payments: Number(r.total_payments ?? 0),
    account_number: r.account_number ?? null,
    sort_code: r.sort_code ?? null,
    period_start: r.period_start ? dateToIso(r.period_start) : null,
    period_end: r.period_end ? dateToIso(r.period_end) : null,
    reconciled_by: r.reconciled_by ?? null,
  };
}

export async function listImportHistory(
  appDb: Knex,
  opts: ListImportHistoryOptions = {},
): Promise<ListImportHistoryResponse> {
  try {
    const target = opts.targetSystem ?? 'opera_se';
    let query = appDb('bank_statement_imports')
      .where({ target_system: target })
      .orderBy('imported_at', 'desc')
      .limit(opts.limit ?? 50);
    if (opts.bankCode) {
      query = query.where({ bank_code: opts.bankCode });
    }
    if (opts.fromDate) {
      query = query.where('statement_date', '>=', opts.fromDate);
    }
    if (opts.toDate) {
      query = query.where('statement_date', '<=', opts.toDate);
    }
    const rows = (await query) as unknown as Array<Record<string, unknown>>;
    const imports = rows.map(rowToImport);
    return { success: true, imports, count: imports.length };
  } catch (err: any) {
    return {
      success: false,
      imports: [],
      count: 0,
      error: err?.message ?? String(err),
    };
  }
}

export interface DeleteImportRecordResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export async function deleteImportRecord(
  appDb: Knex,
  recordId: number,
): Promise<DeleteImportRecordResponse> {
  if (!Number.isFinite(recordId) || recordId <= 0) {
    return { success: false, error: 'Invalid record_id' };
  }
  try {
    const deleted = await appDb('bank_statement_imports')
      .where({ id: recordId })
      .delete();
    if (Number(deleted) === 0) {
      return { success: false, error: `Record ${recordId} not found` };
    }
    return {
      success: true,
      message: 'Import record deleted - statement can now be re-imported',
    };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

export interface ClearImportHistoryOptions {
  bankCode?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
}

export interface ClearImportHistoryResponse {
  success: boolean;
  deleted_count?: number;
  message?: string;
  error?: string;
}

export async function clearImportHistory(
  appDb: Knex,
  opts: ClearImportHistoryOptions = {},
): Promise<ClearImportHistoryResponse> {
  try {
    let query = appDb('bank_statement_imports');
    if (opts.bankCode) query = query.where({ bank_code: opts.bankCode });
    if (opts.fromDate)
      query = query.where('statement_date', '>=', opts.fromDate);
    if (opts.toDate)
      query = query.where('statement_date', '<=', opts.toDate);
    const deleted = await query.delete();
    const count = Number(deleted);
    return {
      success: true,
      deleted_count: count,
      message: `Cleared ${count} import history records`,
    };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

/**
 * Statement-file management — port of the
 * `/api/statement-files/*` endpoints from
 * `apps/bank_reconcile/api/routes.py`.
 *
 * Manages the bank_statement_imports audit log for post-import
 * reconciliation tracking (mark as reconciled, list pending).
 */
import type { Knex } from 'knex';
import { companyScope } from '../_shared/get-company.js';

export interface ImportedStatement {
  id: number;
  bank_code: string;
  filename: string;
  statement_date: string;
  opening_balance: number;
  closing_balance: number;
  source: string;
  source_ref: string;
  is_reconciled: boolean;
  reconciled_count: number;
  target_system: string;
  imported_by: string;
  imported_at: string;
  reconciled_at: string | null;
}

function dateToYmd(d: Date | string | null): string {
  if (!d) return '';
  if (d instanceof Date) {
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
  }
  return String(d).slice(0, 10);
}

function dateToIso(d: Date | string | null): string {
  if (!d) return '';
  if (d instanceof Date) {
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString();
  }
  return String(d);
}

// ---------------------------------------------------------------------
// mark_statement_reconciled
// ---------------------------------------------------------------------

export interface MarkReconciledInput {
  filename: string;
  bankCode?: string | null;
  reconciledCount?: number;
}

export interface MarkReconciledResponse {
  success: boolean;
  message: string;
  error?: string;
}

export async function markStatementReconciled(
  appDb: Knex,
  companyCode: string,
  input: MarkReconciledInput,
): Promise<MarkReconciledResponse> {
  const scope = companyScope(companyCode);
  try {
    const filters: Record<string, unknown> = { ...scope, filename: input.filename };
    if (input.bankCode) filters.bank_code = input.bankCode;

    const updated = await appDb('bank_statement_imports')
      .where(filters)
      .update({
        is_reconciled: true,
        reconciled_count: input.reconciledCount ?? 0,
        reconciled_at: appDb.fn.now(),
      });

    if (updated > 0) {
      return {
        success: true,
        message: `Statement '${input.filename}' marked as reconciled`,
      };
    }
    return {
      success: false,
      message: 'No matching import record found',
    };
  } catch (err: any) {
    return {
      success: false,
      message: '',
      error: err?.message ?? String(err),
    };
  }
}

// ---------------------------------------------------------------------
// imported-for-reconciliation
// ---------------------------------------------------------------------

export interface ImportedStatementsOptions {
  bankCode?: string | null;
  limit?: number;
  includeReconciled?: boolean;
  targetSystem?: string;
}

export interface ImportedStatementsResponse {
  success: boolean;
  statements: ImportedStatement[];
  count: number;
  error?: string;
}

/**
 * List imported bank statements.
 *
 * NB: in the Python implementation this also cross-checks against
 * Opera nbank.nk_recbal + period-reconciliation logic to filter out
 * already-reconciled statements. That cross-check is queued for a
 * future session — the per-app DB read works in isolation now.
 */
export async function listImportedStatements(
  appDb: Knex,
  companyCode: string,
  opts: ImportedStatementsOptions = {},
): Promise<ImportedStatementsResponse> {
  const scope = companyScope(companyCode);
  try {
    const limit = opts.limit ?? 200;
    const targetSystem = opts.targetSystem ?? 'opera_se';

    let query = appDb('bank_statement_imports')
      .where({ ...scope, target_system: targetSystem })
      .orderBy('imported_at', 'desc')
      .limit(limit);

    if (opts.bankCode) {
      query = query.andWhere({ bank_code: opts.bankCode });
    }

    if (!opts.includeReconciled) {
      query = query.andWhere(function (this: Knex.QueryBuilder) {
        this.where('is_reconciled', false).orWhereNull('is_reconciled');
      });
    }

    const rows = (await query) as unknown as Array<{
      id: number;
      bank_code: string;
      filename: string | null;
      statement_date: Date | string | null;
      opening_balance: number | null;
      closing_balance: number | null;
      source: string | null;
      source_ref: string | null;
      is_reconciled: boolean | number | null;
      reconciled_count: number | null;
      target_system: string | null;
      imported_by: string | null;
      imported_at: Date | string;
      reconciled_at: Date | string | null;
    }>;

    const statements: ImportedStatement[] = rows.map((r) => ({
      id: r.id,
      bank_code: r.bank_code,
      filename: r.filename ?? '',
      statement_date: dateToYmd(r.statement_date),
      opening_balance: Number(r.opening_balance ?? 0),
      closing_balance: Number(r.closing_balance ?? 0),
      source: r.source ?? '',
      source_ref: r.source_ref ?? '',
      is_reconciled: Boolean(r.is_reconciled),
      reconciled_count: Number(r.reconciled_count ?? 0),
      target_system: r.target_system ?? 'opera_se',
      imported_by: r.imported_by ?? '',
      imported_at: dateToIso(r.imported_at),
      reconciled_at: r.reconciled_at ? dateToIso(r.reconciled_at) : null,
    }));

    return { success: true, statements, count: statements.length };
  } catch (err: any) {
    return {
      success: false,
      statements: [],
      count: 0,
      error: err?.message ?? String(err),
    };
  }
}

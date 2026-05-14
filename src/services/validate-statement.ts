/**
 * Validate that a bank statement is ready for reconciliation.
 *
 * Faithful port of OperaSQLImport.validate_statement_for_reconciliation
 * (sql_rag/opera_sql_import.py:8285-8365) wrapped by the
 * /api/bank-reconciliation/validate-statement endpoint
 * (apps/bank_reconcile/api/routes.py:10198-10238).
 *
 * Checks:
 *   1. Opening balance matches Opera's expected (nbank.nk_recbal / 100)
 *      within 1p tolerance.
 *   2. Reports next-statement-number from nk_lststno + 1 (or the
 *      number supplied by the caller).
 */
import type { Knex } from 'knex';

export interface ValidateStatementInput {
  bankAccount: string;
  openingBalance: number;
  closingBalance: number;
  /** Statement number from the bank (optional). */
  statementNumber?: number | null;
  /** ISO date string YYYY-MM-DD. */
  statementDate?: string | null;
  /** Optional per-app DB. When provided, validate-statement consults
   *  bank_statement_imports for closings of imports that are imported
   *  but not yet reconciled — those closings chain forward virtually
   *  so the next statement can be processed even though
   *  nbank.nk_recbal hasn't been advanced yet. Faithful port of
   *  routes.py:1504 imported_pending_closings. */
  appDb?: Knex | null;
}

export interface ValidateStatementResponse {
  valid: boolean;
  expected_opening?: number;
  statement_opening?: number;
  statement_closing?: number;
  difference?: number;
  opening_matches?: boolean;
  next_statement_number?: number;
  statement_date?: string | null;
  error_message: string | null;
}

function formatPounds(pounds: number): string {
  return pounds.toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export async function validateStatementForReconciliation(
  operaDb: Knex,
  input: ValidateStatementInput,
): Promise<ValidateStatementResponse> {
  const bankAccount = (input.bankAccount ?? '').trim();
  if (!bankAccount) {
    return { valid: false, error_message: 'bank_account is required' };
  }
  if (!Number.isFinite(input.openingBalance)) {
    return { valid: false, error_message: 'opening_balance is required' };
  }
  try {
    const row = (await operaDb('nbank')
      .where({ nk_acnt: bankAccount })
      .select(
        operaDb.raw('nk_recbal / 100.0 AS expected_opening'),
        'nk_lststno AS last_statement_number',
        operaDb.raw('nk_curbal / 100.0 AS current_balance'),
      )
      .first()) as unknown as
      | {
          expected_opening: number | string | null;
          last_statement_number: number | string | null;
          current_balance: number | string | null;
        }
      | undefined;
    if (!row) {
      return {
        valid: false,
        error_message: `Bank account ${bankAccount} not found`,
      };
    }
    const expectedOpening = Number(row.expected_opening ?? 0);
    const lastStmtNo = row.last_statement_number
      ? Number(row.last_statement_number)
      : 0;
    const nextStmtNo =
      input.statementNumber && Number.isFinite(input.statementNumber)
        ? Number(input.statementNumber)
        : lastStmtNo + 1;
    let openingMatches =
      Math.abs(input.openingBalance - expectedOpening) < 0.01;

    // Imported-pending tolerance: when the operator's prior statement
    // was imported but not yet reconciled, nbank.nk_recbal still
    // points at the OLD reconciled balance — but the next statement's
    // opening should match the prior statement's CLOSING. Look up
    // bank_statement_imports for any imports on this bank whose
    // closing equals the supplied opening (within 1p). Faithful port
    // of routes.py:1504 + _build_imported_pending_closings(92).
    if (!openingMatches && input.appDb) {
      try {
        const rows = (await input.appDb('bank_statement_imports')
          .where({ bank_code: bankAccount })
          .andWhere('import_status', 'imported')
          .andWhere((qb) => {
            qb.where('is_reconciled', false)
              .orWhereNull('is_reconciled')
              .orWhere('is_reconciled', 0);
          })
          .whereNotNull('closing_balance')
          .select('closing_balance')) as unknown as Array<{
          closing_balance: number | string | null;
        }>;
        for (const r of rows) {
          const closing = Number(r.closing_balance ?? 0);
          if (Math.abs(closing - input.openingBalance) < 0.01) {
            openingMatches = true;
            break;
          }
        }
      } catch {
        /* lookup failure must not block — legacy parity */
      }
    }

    if (!openingMatches) {
      return {
        valid: false,
        expected_opening: expectedOpening,
        statement_opening: input.openingBalance,
        difference: Math.round((input.openingBalance - expectedOpening) * 100) / 100,
        opening_matches: false,
        next_statement_number: nextStmtNo,
        error_message:
          `Opening balance mismatch: Statement shows £${formatPounds(input.openingBalance)}, ` +
          `Opera expects £${formatPounds(expectedOpening)}`,
      };
    }
    return {
      valid: true,
      expected_opening: expectedOpening,
      statement_opening: input.openingBalance,
      statement_closing: input.closingBalance,
      opening_matches: true,
      next_statement_number: nextStmtNo,
      statement_date: input.statementDate ?? null,
      error_message: null,
    };
  } catch (err: any) {
    return { valid: false, error_message: err?.message ?? String(err) };
  }
}

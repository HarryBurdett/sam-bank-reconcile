/**
 * Cycle-row lookup for cumulative-statement banks (Monzo etc).
 *
 * A cycle = the set of pulls of a single calendar-month statement
 * from a bank whose statements grow within a month. The cycle key
 * is (bank_code, period_start). Use this lookup before the
 * INSERT/UPDATE decision in importBankStatementFromPdf — if a row
 * is found unreconciled, UPDATE it; if found reconciled, refuse
 * the import with a clear message; if missing, fall through to
 * the existing INSERT path.
 *
 * Returns null when no cycle row exists OR when periodStart is
 * missing — the latter means we can't form a cycle key, so the
 * import should fall through to the existing INSERT path
 * (best-effort fallback for extractions where period_start
 * couldn't be determined).
 */
import type { Knex } from 'knex';

export interface CycleRow {
  id: number;
  is_reconciled: number;
  period_end: string | null;
  closing_balance: number | null;
}

export async function findExistingCycleRow(
  appDb: Knex,
  bankCode: string,
  periodStart: string | null | undefined,
): Promise<CycleRow | null> {
  if (!periodStart) return null;
  const row = (await appDb('bank_statement_imports')
    .select('id', 'is_reconciled', 'period_end', 'closing_balance')
    .where({ bank_code: bankCode, period_start: periodStart })
    .orderBy('id', 'desc')
    .first()) as
    | { id: number; is_reconciled: number;
        period_end: string | null;
        closing_balance: number | string | null }
    | undefined;
  if (!row) return null;
  return {
    id: Number(row.id),
    is_reconciled: Number(row.is_reconciled),
    period_end: row.period_end ? String(row.period_end) : null,
    closing_balance:
      row.closing_balance !== null && row.closing_balance !== undefined
        ? Number(row.closing_balance)
        : null,
  };
}

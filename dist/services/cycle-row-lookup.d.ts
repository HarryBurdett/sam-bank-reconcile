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
export declare function findExistingCycleRow(appDb: Knex, bankCode: string, periodStart: string | null | undefined): Promise<CycleRow | null>;
//# sourceMappingURL=cycle-row-lookup.d.ts.map
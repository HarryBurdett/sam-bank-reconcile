/**
 * Period-reconciliation single source of truth.
 *
 * Faithful port of `sql_rag/period_reconciliation.py:94`
 * (`check_period_reconciled`). Replaces the four scattered heuristics
 * legacy used across scan-all-banks and imported-for-reconciliation.
 *
 * Two-stage rule:
 *   1. Historical match: statement_closing matches a known
 *      reconcile-batch boundary on this bank AND closing < current
 *      rec_bal → period is from a prior closed cycle.
 *   2. Period-aware: closing equals current rec_bal → count
 *      unreconciled aentries in the period; zero means done.
 *
 * Conservative default: returns UNKNOWN if inputs are missing or a
 * data-source query fails. Callers MUST treat UNKNOWN as "show, don't
 * auto-promote" to match legacy's no-quick-fixes mandate.
 */
import type { Knex } from 'knex';

export type PeriodReconciliationStatus =
  | 'fully_reconciled'
  | 'partially_reconciled'
  | 'not_reconciled'
  | 'unknown';

export interface PeriodReconciliationResult {
  status: PeriodReconciliationStatus;
  unreconciled_count: number | null;
  matched_historical_boundary: boolean;
  reason: string;
}

export interface PeriodReconciliationDataSource {
  /** Set of historical reconcile-batch boundary balances for this bank,
   *  in pence (integer-rounded). Any aentry.ae_recbal where
   *  ae_reclnum > 0. */
  queryHistoricalRecbals(bankCode: string): Promise<Set<number>>;
  /** Count of aentry rows on this bank whose ae_lstdate is in
   *  [periodStart, periodEnd] AND ae_reclnum is null or zero. */
  queryUnreconciledInPeriod(
    bankCode: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<number>;
}

function toPence(amount: number | null | undefined): number | null {
  if (amount === null || amount === undefined) return null;
  return Math.round(amount * 100);
}

function gbp(amount: number): string {
  return `£${amount.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export async function checkPeriodReconciled(
  ds: PeriodReconciliationDataSource,
  args: {
    bankCode: string;
    periodStart: string | null;
    periodEnd: string | null;
    statementClosing: number | null;
    currentRecBal: number | null;
  },
): Promise<PeriodReconciliationResult> {
  const { bankCode, periodStart, periodEnd, statementClosing, currentRecBal } = args;

  if (statementClosing === null || statementClosing === undefined) {
    return {
      status: 'unknown',
      unreconciled_count: null,
      matched_historical_boundary: false,
      reason: 'no statement closing balance — cannot determine state',
    };
  }
  if (currentRecBal === null || currentRecBal === undefined) {
    return {
      status: 'unknown',
      unreconciled_count: null,
      matched_historical_boundary: false,
      reason: 'no current rec_bal — cannot determine reconciliation state',
    };
  }

  const closingPence = toPence(statementClosing)!;
  const recBalPence = toPence(currentRecBal)!;

  // Stage 1: historical match
  let historical: Set<number>;
  try {
    historical = await ds.queryHistoricalRecbals(bankCode);
  } catch (e) {
    return {
      status: 'unknown',
      unreconciled_count: null,
      matched_historical_boundary: false,
      reason: `could not query historical recbals: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (closingPence < recBalPence && historical.has(closingPence)) {
    return {
      status: 'fully_reconciled',
      unreconciled_count: null,
      matched_historical_boundary: true,
      reason:
        `closing ${gbp(statementClosing)} matches a historical batch ` +
        `boundary AND is below current rec_bal ${gbp(currentRecBal)} ` +
        `(prior closed cycle)`,
    };
  }

  // Stage 2: closing equals rec_bal — query period
  if (Math.abs(closingPence - recBalPence) <= 1) {
    if (!periodStart || !periodEnd) {
      return {
        status: 'unknown',
        unreconciled_count: null,
        matched_historical_boundary: false,
        reason: 'closing matches rec_bal but period bounds missing',
      };
    }
    let unrec: number;
    try {
      unrec = await ds.queryUnreconciledInPeriod(bankCode, periodStart, periodEnd);
    } catch (e) {
      return {
        status: 'unknown',
        unreconciled_count: null,
        matched_historical_boundary: false,
        reason: `could not query unreconciled count: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (unrec === 0) {
      return {
        status: 'fully_reconciled',
        unreconciled_count: 0,
        matched_historical_boundary: false,
        reason:
          `closing ${gbp(statementClosing)} equals rec_bal AND every aentry ` +
          `in period ${periodStart}..${periodEnd} is reconciled`,
      };
    }
    return {
      status: 'partially_reconciled',
      unreconciled_count: unrec,
      matched_historical_boundary: false,
      reason:
        `closing ${gbp(statementClosing)} equals rec_bal but ${unrec} aentry ` +
        `rows in period are still unreconciled`,
    };
  }

  // Stage 3: closing > rec_bal — future statement
  if (closingPence > recBalPence) {
    return {
      status: 'not_reconciled',
      unreconciled_count: null,
      matched_historical_boundary: false,
      reason:
        `closing ${gbp(statementClosing)} is above current rec_bal ` +
        `${gbp(currentRecBal)} — future statement, awaiting reconcile`,
    };
  }

  // closing < rec_bal but not a historical boundary — orphan / gap
  return {
    status: 'not_reconciled',
    unreconciled_count: null,
    matched_historical_boundary: false,
    reason:
      `closing ${gbp(statementClosing)} is below rec_bal but doesn't match ` +
      `any historical boundary — investigate (orphan or gap)`,
  };
}

/**
 * Default Opera SE data source for the period-reconciled check.
 * Faithful port of OperaSEDataSource in duplicate_check_se.py — the
 * same NOLOCK queries against atran/aentry that legacy used.
 */
export function buildOperaSePeriodReconciliationDs(
  operaDb: Knex,
): PeriodReconciliationDataSource {
  return {
    async queryHistoricalRecbals(bankCode: string): Promise<Set<number>> {
      // ae_recbal is stored in pence already; we keep it as int.
      const rows = (await operaDb.raw(
        `SELECT DISTINCT ae_recbal
         FROM aentry WITH (NOLOCK)
         WHERE RTRIM(ae_acnt) = ?
           AND ae_reclnum > 0
           AND ae_recbal IS NOT NULL`,
        [bankCode],
      )) as unknown as Array<{ ae_recbal: number | string | null }>;
      const out = new Set<number>();
      if (Array.isArray(rows)) {
        for (const r of rows) {
          if (r.ae_recbal === null || r.ae_recbal === undefined) continue;
          out.add(Math.round(Number(r.ae_recbal)));
        }
      }
      return out;
    },
    async queryUnreconciledInPeriod(
      bankCode: string,
      periodStart: string,
      periodEnd: string,
    ): Promise<number> {
      const rows = (await operaDb.raw(
        `SELECT COUNT(*) AS cnt
         FROM aentry WITH (NOLOCK)
         WHERE RTRIM(ae_acnt) = ?
           AND ae_lstdate BETWEEN ? AND ?
           AND (ae_reclnum IS NULL OR ae_reclnum = 0)`,
        [bankCode, periodStart, periodEnd],
      )) as unknown as Array<{ cnt: number | string }>;
      const cnt = Array.isArray(rows) && rows[0] ? Number(rows[0].cnt) : 0;
      return Number.isFinite(cnt) ? cnt : 0;
    },
  };
}

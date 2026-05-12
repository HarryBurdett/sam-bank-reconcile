/**
 * Tenant-wide Opera-restore detection — runs the per-bank divergence
 * + per-line orphan checks across every nbank account and returns
 * a single summary the Bank Statement Hub can render.
 *
 * The Hub page calls this whenever the user clicks "Scan All Banks"
 * (or on page load). If any bank shows divergence, the frontend
 * renders a banner: "Opera restore likely — N banks have stale
 * tracking, [Review]". From there the user navigates into the
 * affected banks and clicks Recover.
 *
 * Detection sources per bank:
 *   1. Statement-level divergence — most recent reconciled
 *      statement's closing balance vs Opera nk_recbal (anchor-based,
 *      handles natural up-and-down balance movement correctly).
 *   2. Per-line orphan — every bank_statement_transactions row with
 *      a posted_entry_number that doesn't exist in Opera aentry.
 *
 * Driver-agnostic — Knex builder throughout, works on Opera SE and
 * Opera 3 via SAM's Write Agent.
 */
import type { Knex } from 'knex';
import { getReconciliationStatus } from './reconciliation-status.js';
import { checkOrphanedTransactions } from './transaction-orphan-check.js';

export interface BankRestoreSummary {
  bank_code: string;
  description: string;
  reconciled_balance: number;
  divergence_detected: boolean;
  divergence_message: string | null;
  orphan_line_count: number;
  orphan_statement_count: number;
  needs_recovery: boolean;
}

export interface RestoreCheckAllResponse {
  success: boolean;
  detected: boolean;
  total_banks_checked: number;
  affected_banks: number;
  banks: BankRestoreSummary[];
  summary_message: string | null;
  error?: string;
}

export async function checkRestoreAcrossAllBanks(
  operaDb: Knex,
  appDb: Knex,
): Promise<RestoreCheckAllResponse> {
  try {
    const banks = (await operaDb('nbank')
      .select(
        operaDb.raw('RTRIM(nk_acnt) AS code'),
        operaDb.raw('RTRIM(nk_desc) AS description'),
      )
      .orderBy('nk_acnt')) as unknown as Array<{
      code: string;
      description: string;
    }>;

    const results: BankRestoreSummary[] = [];
    let affected = 0;
    for (const b of banks) {
      const code = (b.code ?? '').trim();
      if (!code) continue;
      const [status, orphans] = await Promise.all([
        getReconciliationStatus(operaDb, code, appDb, null),
        checkOrphanedTransactions(operaDb, appDb, code),
      ]);
      const divDetected = !!status.opera_divergence_detected;
      const orphanLines = orphans.success ? orphans.orphan_line_count : 0;
      const orphanStmts = orphans.success ? orphans.statement_count : 0;
      const needs = divDetected || orphanLines > 0;
      if (needs) affected += 1;
      results.push({
        bank_code: code,
        description: (b.description ?? '').trim(),
        reconciled_balance: Number(status.reconciled_balance ?? 0),
        divergence_detected: divDetected,
        divergence_message: status.opera_divergence_message ?? null,
        orphan_line_count: orphanLines,
        orphan_statement_count: orphanStmts,
        needs_recovery: needs,
      });
    }

    const detected = affected > 0;
    let summary: string | null = null;
    if (detected) {
      const affectedBanks = results
        .filter((r) => r.needs_recovery)
        .map((r) => `${r.bank_code} (${r.description})`)
        .slice(0, 3)
        .join(', ');
      const more =
        results.filter((r) => r.needs_recovery).length > 3
          ? ` (+${results.filter((r) => r.needs_recovery).length - 3} more)`
          : '';
      summary =
        `Opera restore likely detected on ${affected} bank account(s): ` +
        `${affectedBanks}${more}. SAM has tracking for statements/lines ` +
        `that no longer exist in Opera. Open each affected bank's ` +
        `reconcile page to review and recover.`;
    }

    return {
      success: true,
      detected,
      total_banks_checked: results.length,
      affected_banks: affected,
      banks: results,
      summary_message: summary,
    };
  } catch (err: any) {
    return {
      success: false,
      detected: false,
      total_banks_checked: 0,
      affected_banks: 0,
      banks: [],
      summary_message: null,
      error: err?.message ?? String(err),
    };
  }
}

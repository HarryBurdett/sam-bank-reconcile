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
import { repairOrphanTransactionLinks } from './orphan-line-relink.js';
import { selfHealBalanceMatch } from './self-heal-reconciled-flag.js';

export interface BankRestoreSummary {
  bank_code: string;
  description: string;
  reconciled_balance: number;
  divergence_detected: boolean;
  divergence_message: string | null;
  /** Direction of statement-level divergence:
   *    'restore' — Opera's nk_recbal is LOWER than SAM's most-recent
   *                reconciled closing. Likely an Opera DB restore
   *                from backup. recover-from-restore can usually
   *                auto-resolve by clearing stale reconciled flags.
   *    'extra'   — Opera's nk_recbal is HIGHER than SAM's most-recent
   *                reconciled closing. Someone reconciled entries
   *                in Opera outside SAM, OR a SAM-imported statement
   *                got posted to Opera but its is_reconciled flag
   *                never set. No safe auto-recovery; needs review.
   *    null      — no statement-level divergence detected. */
  divergence_direction?: 'restore' | 'extra' | null;
  orphan_line_count: number;
  orphan_statement_count: number;
  /** When > 0, bank_statement_transactions for this bank reference
   *  parent import_ids that don't exist (the legacy-seeder orphan
   *  bug). Fixable by /api/reconcile/bank/:code/repair-orphan-links
   *  (dry-run preview via GET, apply via POST). The recover button
   *  calls this automatically as part of the recovery sequence. */
  orphan_link_count?: number;
  /** When orphan_link_count > 0, how many of them can be relinked
   *  by period+balance match. The remainder are archived rather
   *  than relinked. */
  orphan_link_repairable?: number;
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
  companyCode: string,
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
      // Self-heal pass FIRST — silently flip is_reconciled=1 on any
      // unreconciled SAM statement whose closing exactly matches
      // Opera's nk_recbal. This pre-empts the divergence detection
      // below so the banner only shows for cases the operator
      // genuinely needs to mediate (not the common
      // "SAM-workflow-completed-but-bookkeeping-update-failed" case).
      // selfHealBalanceMatch enforces strict safety (exactly one
      // match + at-or-after the anchor's statement_date), so a
      // false-positive promotion is impossible.
      await selfHealBalanceMatch(operaDb, appDb, companyCode, code);

      const [status, orphans, orphanLinks] = await Promise.all([
        getReconciliationStatus(operaDb, code, appDb, companyCode, null),
        checkOrphanedTransactions(operaDb, appDb, companyCode, code),
        // Orphan-link check: bank_statement_transactions rows whose
        // import_id no longer resolves to any bank_statement_imports
        // row. Detect via dry-run — no mutation.
        repairOrphanTransactionLinks(appDb, companyCode, code, { dryRun: true }),
      ]);
      const divDetected = !!status.opera_divergence_detected;
      const orphanLines = orphans.success ? orphans.orphan_line_count : 0;
      const orphanStmts = orphans.success ? orphans.statement_count : 0;
      const orphanLinkRows = orphanLinks.success
        ? orphanLinks.orphan_groups.reduce((s, g) => s + g.row_count, 0)
        : 0;
      const orphanLinkRepairable = orphanLinks.success
        ? orphanLinks.relinked_rows
        : 0;
      const needs =
        divDetected || orphanLines > 0 || orphanLinkRows > 0;
      if (needs) affected += 1;
      results.push({
        bank_code: code,
        description: (b.description ?? '').trim(),
        reconciled_balance: Number(status.reconciled_balance ?? 0),
        divergence_detected: divDetected,
        divergence_message: status.opera_divergence_message ?? null,
        divergence_direction: status.opera_divergence_direction ?? null,
        orphan_line_count: orphanLines,
        orphan_statement_count: orphanStmts,
        orphan_link_count: orphanLinkRows,
        orphan_link_repairable: orphanLinkRepairable,
        needs_recovery: needs,
      });
    }

    const detected = affected > 0;
    let summary: string | null = null;
    if (detected) {
      const affectedRows = results.filter((r) => r.needs_recovery);
      const affectedBanks = affectedRows
        .map((r) => `${r.bank_code} (${r.description})`)
        .slice(0, 3)
        .join(', ');
      const more =
        affectedRows.length > 3 ? ` (+${affectedRows.length - 3} more)` : '';
      // Headline reflects what we actually saw. The previous wording
      // hardcoded "Opera restore" even when the real divergence was
      // "Opera ahead of SAM" — confusing for the operator and led
      // them to click Recover expecting a restore-clear, then get
      // "Cleared 0 line(s)" because the recovery path didn't match
      // the divergence direction.
      const onlyOrphans = affectedRows.every((r) => !r.divergence_detected);
      const onlyRestore = affectedRows.every(
        (r) => r.divergence_direction === 'restore',
      );
      const onlyExtra = affectedRows.every(
        (r) => r.divergence_direction === 'extra',
      );
      let headline: string;
      if (onlyOrphans) {
        headline =
          `Opera-side orphan transactions detected on ${affected} bank account(s)`;
      } else if (onlyRestore) {
        headline =
          `Opera restore likely detected on ${affected} bank account(s)`;
      } else if (onlyExtra) {
        headline =
          `Opera-side reconciliation outside SAM on ${affected} bank account(s)`;
      } else {
        headline =
          `Opera reconciliation divergence on ${affected} bank account(s)`;
      }
      summary =
        `${headline}: ${affectedBanks}${more}. SAM's tracking is out of ` +
        `sync with Opera. Open each affected bank's reconcile page to ` +
        `review the detail and recover.`;
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

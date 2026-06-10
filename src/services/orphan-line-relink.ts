/**
 * Orphan-link repair for bank_statement_transactions.
 *
 * Background: the legacy-DB seeder in standalone/company-registry.ts
 * copied parent `bank_statement_imports` rows WITHOUT preserving the
 * legacy `id` column, while copying child `bank_statement_transactions`
 * rows WITH their legacy `import_id` value verbatim. SQLite's
 * autoincrement reassigned new parent ids → children pointed at
 * legacy ids that no longer exist anywhere.
 *
 * Example from intsys/bank-reconcile.sqlite:
 *   bank_statement_imports.id values: 12, 13, 14, ..., 31 (max=31)
 *   bank_statement_transactions.import_id values: 67, 68, 71
 *   — none of which match any parent row.
 *
 * This module:
 *   1. Detects orphan child rows (import_id with no matching parent).
 *   2. Attempts to relink by period match — child rows' post_date
 *      range falls within a parent's period_start..period_end window,
 *      AND the closing balance matches the highest balance in the
 *      child set (within tolerance).
 *   3. Surfaces unrecoverable orphans with diagnostics so the
 *      operator can choose to delete them.
 *
 * Safety: every relink is a single UPDATE statement, easy to roll
 * back. The function never deletes anything — caller must opt in
 * explicitly via a follow-up endpoint if they want orphan cleanup.
 */

import type { Knex } from 'knex';
import { companyScope } from '../_shared/get-company.js';

export interface OrphanLineGroup {
  orphan_import_id: number;
  row_count: number;
  first_date: string | null;
  last_date: string | null;
  highest_balance: number | null;
  matched_parent_import_id: number | null;
  matched_parent_filename: string | null;
  match_reason: string;
}

export interface OrphanLineRepairResult {
  success: boolean;
  bank_code: string;
  orphan_groups: OrphanLineGroup[];
  relinked_groups: number;
  relinked_rows: number;
  unmatched_groups: number;
  dry_run: boolean;
  error?: string;
}

/**
 * Detect orphan child rows for a single bank and (optionally) relink
 * them to the correct parent by period match.
 *
 * @param bankCode - The bank account code to repair.
 * @param dryRun  - If true, only report what would be done; no UPDATEs.
 */
export async function repairOrphanTransactionLinks(
  appDb: Knex,
  companyCode: string,
  bankCode: string,
  opts: { dryRun?: boolean } = {},
): Promise<OrphanLineRepairResult> {
  const dryRun = opts.dryRun ?? false;
  const scope = companyScope(companyCode);
  try {
    // Step 1: find orphan import_id values across all transactions
    // for this bank. A row is orphan when its import_id doesn't exist
    // in bank_statement_imports.
    //
    // We can't filter by bank_code directly on transactions (no FK
    // column), so we first collect every import_id used in
    // transactions, then check which ones lack a matching parent.
    const orphanIds = (await appDb('bank_statement_transactions as t')
      .leftJoin('bank_statement_imports as i', 't.import_id', 'i.id')
      .where('t.company_code', scope.company_code)
      .whereNull('i.id')
      .distinct<{ orphan_import_id: number }[]>(
        't.import_id as orphan_import_id',
      )) as Array<{ orphan_import_id: number }>;
    if (orphanIds.length === 0) {
      return {
        success: true,
        bank_code: bankCode,
        orphan_groups: [],
        relinked_groups: 0,
        relinked_rows: 0,
        unmatched_groups: 0,
        dry_run: dryRun,
      };
    }

    // Step 2: for each orphan import_id, summarise the child rows
    // (date range, max balance, count) — these are the matching
    // fingerprints.
    const orphanGroups: OrphanLineGroup[] = [];
    for (const { orphan_import_id } of orphanIds) {
      const summary = (await appDb('bank_statement_transactions')
        .where(scope)
        .andWhere('import_id', orphan_import_id)
        .select(
          appDb.raw('COUNT(*) AS row_count'),
          appDb.raw('MIN(post_date) AS first_date'),
          appDb.raw('MAX(post_date) AS last_date'),
          appDb.raw('MAX(balance) AS highest_balance'),
        )
        .first()) as
        | {
            row_count: number;
            first_date: string | null;
            last_date: string | null;
            highest_balance: number | null;
          }
        | undefined;
      if (!summary || !summary.row_count) continue;

      // Step 3: find a candidate parent for THIS bank whose period
      // brackets the child date range AND whose closing balance
      // matches the orphan group's highest observed balance.
      const candidates = (await appDb('bank_statement_imports')
        .where(scope)
        .andWhere('bank_code', bankCode)
        .andWhereRaw('period_start IS NOT NULL')
        .andWhereRaw('period_end IS NOT NULL')
        .andWhereRaw('period_start <= ?', [summary.first_date])
        .andWhereRaw('period_end >= ?', [summary.last_date])
        .select(
          'id',
          'filename',
          'period_start',
          'period_end',
          'closing_balance',
        )) as Array<{
        id: number;
        filename: string | null;
        period_start: string | null;
        period_end: string | null;
        closing_balance: number | null;
      }>;

      // Rank candidates: closing balance match wins, otherwise
      // smallest period window (most specific period that contains
      // the child dates). If multiple parents have identical match
      // strength, decline to act (ambiguous).
      let bestId: number | null = null;
      let bestFilename: string | null = null;
      let bestReason = 'no candidate parent found';
      const balanceMatches = candidates.filter(
        (c) =>
          c.closing_balance !== null &&
          summary.highest_balance !== null &&
          Math.abs(
            Number(c.closing_balance) - Number(summary.highest_balance),
          ) < 0.01,
      );
      if (balanceMatches.length === 1) {
        bestId = balanceMatches[0]!.id;
        bestFilename = balanceMatches[0]!.filename;
        bestReason = 'closing_balance match within period bracket';
      } else if (balanceMatches.length > 1) {
        bestReason = `${balanceMatches.length} candidate parents share closing balance — ambiguous`;
      } else if (candidates.length === 1) {
        // No balance match but only one parent has overlapping period
        // — accept with a softer reason. Operator can review.
        bestId = candidates[0]!.id;
        bestFilename = candidates[0]!.filename;
        bestReason = 'unique period bracket (closing balance differs)';
      } else if (candidates.length > 1) {
        bestReason = `${candidates.length} candidate periods overlap — ambiguous`;
      }

      orphanGroups.push({
        orphan_import_id: Number(orphan_import_id),
        row_count: Number(summary.row_count),
        first_date: summary.first_date,
        last_date: summary.last_date,
        highest_balance:
          summary.highest_balance !== null
            ? Number(summary.highest_balance)
            : null,
        matched_parent_import_id: bestId,
        matched_parent_filename: bestFilename,
        match_reason: bestReason,
      });
    }

    // Step 4: relink the matched groups (skip the unmatched).
    let relinkedGroups = 0;
    let relinkedRows = 0;
    let unmatched = 0;
    for (const g of orphanGroups) {
      if (g.matched_parent_import_id === null) {
        unmatched += 1;
        continue;
      }
      if (!dryRun) {
        const updated = Number(
          await appDb('bank_statement_transactions')
            .where(scope)
            .andWhere('import_id', g.orphan_import_id)
            .update({ import_id: g.matched_parent_import_id }),
        );
        relinkedRows += updated;
      } else {
        relinkedRows += g.row_count;
      }
      relinkedGroups += 1;
    }

    return {
      success: true,
      bank_code: bankCode,
      orphan_groups: orphanGroups,
      relinked_groups: relinkedGroups,
      relinked_rows: relinkedRows,
      unmatched_groups: unmatched,
      dry_run: dryRun,
    };
  } catch (err: unknown) {
    return {
      success: false,
      bank_code: bankCode,
      orphan_groups: [],
      relinked_groups: 0,
      relinked_rows: 0,
      unmatched_groups: 0,
      dry_run: dryRun,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

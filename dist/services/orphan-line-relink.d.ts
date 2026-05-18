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
export declare function repairOrphanTransactionLinks(appDb: Knex, bankCode: string, opts?: {
    dryRun?: boolean;
}): Promise<OrphanLineRepairResult>;
//# sourceMappingURL=orphan-line-relink.d.ts.map
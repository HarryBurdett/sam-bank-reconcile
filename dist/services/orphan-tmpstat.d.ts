/**
 * Orphan tmpstat helpers — list and clear ae_tmpstat reservations that
 * aren't part of a real reconciliation. Faithful port of:
 *   GET  /api/reconcile/bank/{bank_code}/orphan-tmpstat
 *   POST /api/reconcile/bank/{bank_code}/clear-orphan-tmpstat
 *
 * These are the residue of partial-reconcile attempts that didn't
 * finalise — they block the affected aentries from future
 * reconciliations until cleared. Read query is NOLOCK; clear uses
 * ROWLOCK on a narrow UPDATE.
 */
import type { Knex } from 'knex';
export interface OrphanTmpstatRow {
    entry: string;
    date: string;
    value: number;
    reference: string;
    tmpstat: number;
    statement_line: number;
}
export interface OrphanTmpstatListResponse {
    success: boolean;
    count: number;
    entries: OrphanTmpstatRow[];
    error?: string;
}
export declare function listOrphanTmpstat(operaDb: Knex, bankCode: string): Promise<OrphanTmpstatListResponse>;
export interface ClearOrphanTmpstatResponse {
    success: boolean;
    cleared: number;
    entries: Array<{
        entry: string;
        date: string;
        value: number;
        previous_tmpstat: number;
    }>;
    error?: string;
}
/**
 * Clear orphan tmpstats on a bank. Optionally restrict to specific
 * entry numbers via `entryNumbers`.
 *
 * SAFE: only touches ae_tmpstat (temporary-status field), and only on
 * entries with ae_reclnum = 0 (no committed reconcile data).
 */
export declare function clearOrphanTmpstat(operaDb: Knex, bankCode: string, entryNumbers?: string[]): Promise<ClearOrphanTmpstatResponse>;
//# sourceMappingURL=orphan-tmpstat.d.ts.map
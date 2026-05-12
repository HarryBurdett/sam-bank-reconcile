/**
 * Reverse a previously-reconciled batch.
 *
 * Faithful port of `unreconcile_entries` in
 * `apps/bank_reconcile/api/routes.py:981-1143`.
 *
 * Resets EVERY per-aentry rec field (ae_reclnum, ae_recdate, ae_recbal,
 * ae_statln, ae_frstat, ae_tostat, ae_tmpstat) for the supplied entry
 * numbers, then walks back to determine the prior batch's stamped
 * state and updates nbank to revert to it. If no entries remain
 * reconciled on this bank, nbank gets a fresh-bank reset.
 *
 * Locking:
 *   - Bank-level import lock acquired via withImportLock so Opera
 *     desktop concurrency is preserved
 *   - Single MSSQL transaction wraps both UPDATEs; rollback on error
 *   - Both UPDATEs use ROWLOCK per CLAUDE.md
 *
 * SQL injection guard:
 *   - bank_code validated by validateBankCode at the route boundary
 *   - Each entry number validated by validateEntryNumber
 *
 * Notes vs Python:
 *   - Python builds a single f-string IN (...) clause with the
 *     pre-validated entries. We use parameter binding (each entry
 *     becomes a `?` placeholder) which is strictly safer and matches
 *     the validators' belt-and-braces approach.
 */
import type { Knex } from 'knex';
export interface UnreconcileInput {
    bankCode: string;
    entryNumbers: string[];
}
export interface UnreconcileResponse {
    success: boolean;
    message?: string;
    entries_unreconciled?: number;
    new_reconciled_balance?: number;
    error?: string;
}
export declare function unreconcileEntries(appDb: Knex, operaDb: Knex, input: UnreconcileInput): Promise<UnreconcileResponse>;
//# sourceMappingURL=unreconcile.d.ts.map
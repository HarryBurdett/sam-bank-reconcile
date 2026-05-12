/**
 * Per-line bank-statement orphan detection + recovery.
 *
 * Companion to `reconciliation-status.ts` which handles statement-
 * level divergence. This module handles the finer-grained case: an
 * individual statement line was posted to Opera (we wrote its
 * `posted_entry_number` into `bank_statement_transactions`) but the
 * Opera entry no longer exists — i.e. Opera was restored to a
 * backup, or the cashbook entry was deleted directly in Opera.
 *
 * Without this detection a statement could show as "10/21 posted" in
 * the UI while Opera actually has zero of those 10 entries. The user
 * can't tell from the SAM UI alone that re-posting is needed.
 *
 * Wired into:
 *   - GET /api/reconcile/bank/:bank_code/status — surfaced as an
 *     orphan-line count in the response
 *   - GET /api/bank-import/scan-all-banks — when SAM's scan-all-banks
 *     is fully ported, it'll call this per-bank to flag affected
 *     statements
 *   - POST /api/bank-import/recover-orphan-transactions —
 *     explicit-confirmation recovery (clears posted_entry_number on
 *     orphan lines so they can be re-posted via normal import flow)
 *
 * Validation: for each `bank_statement_transactions` row with a
 * non-empty `posted_entry_number`, query Opera atran/aentry to
 * confirm the entry exists. Cost-conscious: batch the lookups, run
 * one Opera query per bank rather than one per line.
 *
 * Driver-agnostic: Knex builder + parameter binding throughout —
 * works on Opera SE (MSSQL) and Opera 3 (FoxPro via SAM's Write
 * Agent) without dialect-specific functions.
 */
import type { Knex } from 'knex';
export interface OrphanedStatementLine {
    import_id: number;
    transaction_id: number;
    line_number: number;
    post_date: string | null;
    amount: number;
    posted_entry_number: string;
    description: string;
}
export interface OrphanedStatement {
    import_id: number;
    filename: string | null;
    statement_date: string | null;
    opening_balance: number | null;
    closing_balance: number | null;
    orphan_lines: OrphanedStatementLine[];
    /** Total amount of orphaned lines (sum of `amount`). */
    orphan_total: number;
}
export interface TransactionOrphanCheckResult {
    success: boolean;
    bank_code: string;
    statement_count: number;
    orphan_line_count: number;
    orphan_statements: OrphanedStatement[];
    error?: string;
}
export interface TransactionOrphanRecoveryResult {
    success: boolean;
    bank_code: string;
    cleared_lines: number;
    cleared_statements: OrphanedStatement[];
    error?: string;
}
/**
 * Read-only orphan detection for a single bank. Walks every
 * statement on the bank, finds each `bank_statement_transactions`
 * row with a `posted_entry_number`, validates each against Opera
 * `aentry`, returns the statements with one or more orphaned lines.
 *
 * Suitable to wire into:
 *   - the bank's reconcile-status response
 *   - scan-all-banks per-bank enrichment
 *   - a dedicated read-only check endpoint
 */
export declare function checkOrphanedTransactions(operaDb: Knex, appDb: Knex, bankCode: string): Promise<TransactionOrphanCheckResult>;
/**
 * Explicit-confirmation recovery. Re-runs the detection and clears
 * `posted_entry_number` + `posted_at` on every orphaned line so the
 * normal import-from-pdf flow can re-post them. Statement-level
 * `is_reconciled` is also cleared on any affected import (those
 * statements clearly aren't reconciled anymore since Opera lost the
 * entries).
 *
 * Never auto-runs — caller is an explicit POST endpoint after the
 * user has reviewed the detection result and confirmed an Opera
 * restore has happened.
 */
export declare function recoverOrphanedTransactions(operaDb: Knex, appDb: Knex, bankCode: string): Promise<TransactionOrphanRecoveryResult>;
//# sourceMappingURL=transaction-orphan-check.d.ts.map
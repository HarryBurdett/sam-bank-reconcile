/**
 * Confirm matched transactions + mark them as reconciled.
 *
 * Faithful port of `confirm_statement_matches` (apps/bank_reconcile/
 * api/routes.py:1935-2035). Wraps mark-reconciled with two pieces of
 * extra setup the caller doesn't have to provide:
 *
 *   1. statement_line numbers — Opera convention is 10, 20, 30...
 *      so we set them automatically based on the matches list order.
 *
 *   2. statement_number — next from nbank.nk_lststno + 1. We read
 *      nbank with NOLOCK (markEntriesReconciled re-reads with UPDLOCK
 *      under a transaction so the value is correct at write time).
 *      Per CLAUDE.md, never use MAX(...)+1 to derive a sequence —
 *      this comes from nbank's stored counter.
 *
 * The actual reconciliation work — locking, validation, ae_reclnum
 * write, nbank update — happens inside markEntriesReconciled (which
 * has its own bank lock + UPDLOCK + ROWLOCK + transaction).
 */
import type { Knex } from 'knex';
import { type MarkReconciledResponse } from './mark-reconciled.js';
export interface ConfirmMatchInput {
    ae_entry?: string;
    /** Older clients nest the entry inside opera_entry.ae_entry. */
    opera_entry?: {
        ae_entry?: string;
    };
}
export interface ConfirmMatchesInput {
    bankCode: string;
    matches: ConfirmMatchInput[];
    /** closing balance in pounds (used for nk_reccfwd in partial mode;
     *  pass-through to mark-reconciled). */
    statementBalance: number;
    /** YYYY-MM-DD */
    statementDate: string;
}
export interface ConfirmMatchesResponse extends MarkReconciledResponse {
    reconciled_count?: number;
    batch_number?: number;
    statement_balance?: number;
}
export declare function confirmStatementMatches(appDb: Knex, operaDb: Knex, input: ConfirmMatchesInput): Promise<ConfirmMatchesResponse>;
//# sourceMappingURL=confirm-matches.d.ts.map
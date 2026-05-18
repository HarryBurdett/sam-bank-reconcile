/**
 * Self-heal: flip `bank_statement_imports.is_reconciled=1` when
 * Opera's nk_recbal proves the statement was reconciled.
 *
 * The data-flow invariant the operator relies on:
 *
 *   "Once a statement is reconciled to completion, Opera's
 *    nk_recbal is updated to that statement's closing balance."
 *
 * So whenever Opera's nk_recbal differs from SAM's most-recently-
 * reconciled closing AND exactly one unreconciled SAM statement
 * matches that nk_recbal — the statement IS reconciled. The Opera
 * postings happened; SAM's bookkeeping just didn't get updated.
 * (The audit identified the audit-bookkeeping-update bug at
 * src/router.ts:2209 — silent UPDATE swallow + missing import_id
 * from the file-picker path.)
 *
 * In that case, asking the operator to click a "Recover" button is
 * busywork. SAM should self-heal silently on every scan / status
 * check, and only show a banner for cases that genuinely need
 * human review.
 *
 * Safety conditions (all must hold) before auto-promoting:
 *   1. Opera and SAM diverge in the "extra" direction (Opera ahead).
 *   2. Exactly ONE unreconciled SAM statement has closing == nk_recbal.
 *      Zero matches → can't heal (Fork B: banner asks operator).
 *      Multiple matches → ambiguous, refuse (banner asks operator).
 *   3. The matching statement's statement_date is at-or-after SAM's
 *      most-recently-reconciled statement_date. Refuse to promote an
 *      OLDER statement that happens to share the balance.
 *
 * When all three hold, the function flips is_reconciled=1,
 * stamps reconciled_at, and writes reconciled_by='sync-with-opera'.
 *
 * Idempotent: when there's nothing to heal (already in sync, no
 * match, ambiguous, or stale), returns `{ promoted: false }` and
 * mutates nothing.
 */
import type { Knex } from 'knex';
export interface SelfHealResult {
    promoted: boolean;
    /** When promoted=true, the bank_statement_imports.id that got flipped. */
    import_id?: number;
    /** When promoted=true, the closing_balance that matched nk_recbal. */
    closing_balance?: number;
    /** When promoted=false, a short diagnostic explaining why.
     *  Useful for logging / FE messaging. */
    reason?: 'already_in_sync' | 'no_matching_unreconciled_statement' | 'ambiguous_multiple_matches' | 'matching_statement_is_older' | 'bank_not_found' | 'sam_ahead_of_opera';
}
export declare function selfHealBalanceMatch(operaDb: Knex, appDb: Knex, bankCode: string, opts?: {
    user?: string;
}): Promise<SelfHealResult>;
//# sourceMappingURL=self-heal-reconciled-flag.d.ts.map
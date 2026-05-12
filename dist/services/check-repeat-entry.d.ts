/**
 * Repeat-entry detection — match a bank transaction against an
 * unposted Opera repeat entry in arhead/arline.
 *
 * Faithful port of `_check_repeat_entry`
 * (sql_rag/bank_import.py:943-1134) including the alias fast-path
 * (961-1020) and the amount/reference/date matching (1022-1134).
 *
 * Two phases:
 *   1. Alias fast-path: if `repeat_entry_aliases` has a previously
 *      learned mapping for this payee + bank, validate the linked
 *      arhead row is still active and use it.
 *   2. Otherwise scan arhead+arline rows for this bank where the
 *      entry is unposted (ae_topost=0 or ae_posted<ae_topost) and
 *      either the amount matches within 10p OR a search-term LIKE
 *      hits ae_desc / at_comment. Prefer amount matches; secondary
 *      ordering by date proximity to ae_nxtpost.
 *
 * Date validation: reject when the transaction is >10 days BEFORE the
 * next-post date (legacy says "too far before" — old historical txn
 * shouldn't grab a future-dated repeat).
 *
 * Implementation notes (Opera SE + Opera 3 portable):
 *   - Knex builder + parameter binding throughout
 *   - No `WITH (NOLOCK)` (perf-only, omitting is correct)
 *   - Date proximity sort: we fetch the candidates and order in JS
 *     to avoid backend-specific DATEDIFF/JULIANDAY differences
 */
import type { Knex } from 'knex';
export interface RepeatEntryMatch {
    is_match: boolean;
    entry_ref: string;
    entry_desc: string;
    next_post_date: string | null;
    posted: number;
    topost: number;
    freq: string;
    every: number;
    match_kind: 'alias' | 'amount' | 'reference' | 'unknown' | 'none';
}
export declare function checkRepeatEntry(operaDb: Knex, appDb: Knex | null, txn: {
    bankCode: string;
    /** YYYY-MM-DD transaction date. */
    date: string;
    /** Signed amount in pounds (sign ignored — matched on absolute). */
    amountPounds: number;
    name: string;
    reference: string;
    memo: string;
}): Promise<RepeatEntryMatch>;
//# sourceMappingURL=check-repeat-entry.d.ts.map
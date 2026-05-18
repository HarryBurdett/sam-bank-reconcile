/**
 * Repeat-entry detection — match a bank transaction against an
 * unposted Opera repeat entry in arhead/arline.
 *
 * Port of `_check_repeat_entry` (sql_rag/bank_import.py:943-1134),
 * with one deliberate divergence from legacy:
 *
 *   Amount matches are STRICTLY EQUAL — no tolerance, no ±1p,
 *   no ±10p. Accounting amounts have no tolerance: £54.99 is not
 *   £55.00, ever. The legacy 10p window produced false positives
 *   like "£54.99 Amazon purchase" being classified as the £55.00
 *   'Bounce HB' subscription on BC010 — different transactions,
 *   same banker's-rounding distance.
 *
 *   Both sides of the comparison are integer pence values
 *   (Opera's `arline.at_value` is stored as integer pence; the
 *   bank line's pounds amount goes through `Math.round(× 100)`).
 *   SQL `=` and JS `===` are correct.
 *
 *   If a foreign-currency repeat genuinely needs flexibility on
 *   the GBP equivalent, the operator creates an alias — the
 *   alias fast-path bypasses amount checking entirely (the
 *   operator opted in to that mapping).
 *
 * Two phases:
 *   1. Alias fast-path: if `repeat_entry_aliases` has a previously
 *      learned mapping for this payee + bank, validate the linked
 *      arhead row is still active and use it. The alias bypasses
 *      amount strictness — the operator opted in to this mapping.
 *   2. Otherwise scan arhead+arline rows for this bank where the
 *      entry is unposted (ae_topost=0 or ae_posted<ae_topost) and
 *      either the amount matches EXACTLY OR a search-term LIKE
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
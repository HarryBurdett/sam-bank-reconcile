/**
 * Ratcliff/Obershelp similarity ratio — port of Python's
 * `difflib.SequenceMatcher.ratio()`.
 *
 * Faithful port of CPython's `Lib/difflib.py` `SequenceMatcher`:
 *   - find_longest_match  → findLongestMatch
 *   - get_matching_blocks → getMatchingBlocks (queue-based)
 *   - ratio()             → sequenceMatcherRatio
 *
 * The autojunk heuristic isn't implemented — short strings (company
 * names, transaction descriptions) don't trigger it in practice.
 *
 * Used by gocardless suggest-match (customer-mandate matching) and
 * bank-reconcile suggest-account (statement-line → customer/supplier
 * matching). Single source of truth so both plugins agree on what
 * "similarity" means.
 */
export declare function sequenceMatcherRatio(a: string, b: string): number;
//# sourceMappingURL=sequence-matcher.d.ts.map
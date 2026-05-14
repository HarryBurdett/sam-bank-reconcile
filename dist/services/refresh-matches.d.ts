/**
 * Re-check a list of bank transactions against Opera to surface
 * which are already-posted (duplicates) and which still need posting.
 *
 * Faithful port of `refresh_statement_matches`
 * (apps/bank_reconcile/api/routes.py:1647-1716).
 *
 * The Python implementation calls `BankStatementImport._is_already_posted`
 * which delegates to the type-aware `check_for_duplicate`
 * (sql_rag/duplicate_check.py). That function distinguishes between
 *   - CASHBOOK_DUPLICATE     — already posted, skip
 *   - LEDGER_ALLOCATION_TARGET — exists in SL/PL but as an
 *     allocation target (so post + auto-allocate)
 * with a type-BLIND atran fallback for the cases the matcher couldn't
 * classify cleanly.
 *
 * This TS port reuses the deterministic `findDuplicates` from
 * `duplicate-detection.ts` (all 6 strategies). A candidate with
 * confidence ≥ `posted_threshold` (default 0.85) is treated as
 * already-posted; below that the transaction is left alone.
 *
 * LEDGER_ALLOCATION_TARGET (the type-aware refund advisory) is
 * surfaced separately by `pre-posting-duplicate-check.ts` at import
 * time, not here. refresh-matches is the "operator just posted
 * something in Opera, refresh the preview" path and the
 * threshold-based check on findDuplicates is correct for it:
 * fingerprint and exact-match cases are unambiguous, and the
 * matched_account / action fields the frontend already has cover the
 * discrimination between cashbook and ledger.
 */
import type { Knex } from 'knex';
export interface RefreshTransactionInput {
    name?: string | null;
    description?: string | null;
    amount: number;
    date?: string | null;
    reference?: string | null;
    matched_account?: string | null;
    fit_id?: string | null;
    action?: string | null;
    is_duplicate?: boolean;
    skip_reason?: string | null;
    /** Anything else the frontend wants preserved. */
    [key: string]: unknown;
}
export interface RefreshedTransaction extends RefreshTransactionInput {
    is_duplicate: boolean;
    skip_reason: string;
    action: string;
}
export interface RefreshMatchesResponse {
    success: boolean;
    transactions: RefreshedTransaction[];
    matched_count: number;
    total: number;
    message?: string;
    error?: string;
}
export interface RefreshMatchesOptions {
    /** Confidence threshold above which a candidate counts as posted. */
    posted_threshold?: number;
}
export declare function refreshMatches(operaDb: Knex, bankCode: string, transactions: RefreshTransactionInput[], opts?: RefreshMatchesOptions): Promise<RefreshMatchesResponse>;
//# sourceMappingURL=refresh-matches.d.ts.map
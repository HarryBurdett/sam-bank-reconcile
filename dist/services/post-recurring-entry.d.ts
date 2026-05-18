/**
 * Post a recurring entry (arhead/arline template) to Opera SE.
 *
 * Faithful port of the single-line path of
 * `OperaSQLImport.post_recurring_entry`
 * (sql_rag/opera_sql_import.py:9714-10594). The legacy creates ONE
 * aentry header plus N atran detail lines (one per arline). For
 * single-line entries (the overwhelming majority — a monthly
 * subscription, a standing order, etc.) the inserts collapse to the
 * exact same shape as a regular bank-import row: one aentry, one
 * atran, one ntran/anoml pair, an optional stran/ptran for
 * sales/purchase, an optional VAT third entry.
 *
 * So instead of duplicating ~600 lines of careful SQL, this service:
 *   1. Reads arhead/arline for the entry on this bank.
 *   2. Validates state (active, supported ae_type, not exhausted).
 *   3. Determines the posting date (override or ae_nxtpost).
 *   4. Runs period validation (closed period blocks the post).
 *   5. For single-line: builds a PreparedTransaction in the same
 *      shape the bank-import executor uses, then calls the internal
 *      post* helpers exported from import-posting-executor.ts. After
 *      a successful post, bumps arhead.ae_posted++ and advances
 *      ae_nxtpost — atomic with the post via the same transaction.
 *   6. For multi-line: returns a clear error directing the operator
 *      to Opera. Multi-line recurring journals (multiple
 *      analytical hits under one aentry header) need dedicated
 *      multi-atran-per-aentry logic that doesn't exist in our
 *      single-line post* helpers yet. Surfaced as an honest decline
 *      rather than silent miscoding.
 *
 * Operator-facing flow: BankStatementHub's "Post recurring entries
 * now" button calls POST /api/recurring-entries/post with a list of
 * composite refs (entry_ref or entry_ref:YYYY-MM-DD). Each is posted
 * via this service in turn.
 */
import type { Knex } from 'knex';
export interface PostRecurringEntryInput {
    bankCode: string;
    /** Plain ref or composite `REC0000002:2026-05-15`. */
    entryRef: string;
    /** Optional override; falls back to the composite-key date, then ae_nxtpost. */
    overrideDate?: string | null;
    /** Audit-trail user; defaults to "RECUR" matching legacy. */
    inputBy?: string;
}
export interface PostRecurringEntryResult {
    success: boolean;
    entry_ref: string;
    entry_number?: string;
    message?: string;
    warnings?: string[];
    error?: string;
}
/**
 * Body for the multi-entry POST route.
 *
 *   { "bank_code": "BB005",
 *     "entries": [
 *       { "entry_ref": "REC0000002", "override_date": null },
 *       { "entry_ref": "REC0000002:2026-05-15", "override_date": null }
 *     ]
 *   }
 *
 * Composite refs (`entry_ref:YYYY-MM-DD`) target a specific
 * outstanding cycle for entries with multiple missed dates. The date
 * portion becomes the override_date when no explicit one is given.
 */
export interface PostRecurringEntriesBatchInput {
    bankCode: string;
    entries: Array<{
        entry_ref: string;
        override_date?: string | null;
    }>;
    inputBy?: string;
}
export interface PostRecurringEntriesBatchResult {
    success: boolean;
    results: PostRecurringEntryResult[];
    posted_count: number;
    failed_count: number;
    error?: string;
}
/**
 * Post a single recurring entry. Atomic — either the aentry+atran
 * are created AND arhead is advanced, or neither (transaction
 * rollback).
 */
export declare function postRecurringEntry(operaDb: Knex, input: PostRecurringEntryInput): Promise<PostRecurringEntryResult>;
/**
 * Batch wrapper — posts each entry in turn, collecting per-entry
 * results. Continues on individual failures so the operator can see
 * which succeeded and which need attention.
 */
export declare function postRecurringEntriesBatch(operaDb: Knex, input: PostRecurringEntriesBatchInput): Promise<PostRecurringEntriesBatchResult>;
//# sourceMappingURL=post-recurring-entry.d.ts.map
/**
 * Repeat-entry maintenance for the bank-import flow.
 *
 * Faithful port of:
 *   - update_repeat_entry_date (apps/bank_reconcile/api/routes.py:5320-5419)
 *
 * Updates ae_nxtpost on arhead so the operator can sync a repeat
 * entry's next posting date with the actual bank transaction date,
 * then run Opera's "Repeat Entries" routine to post.
 *
 * Optional alias-save: when statement_name is supplied, save a
 * repeat-entry alias in `repeat_entry_aliases` (per-app DB) so future
 * imports auto-match this bank statement description to this repeat
 * entry. Best-effort — alias-save failure doesn't fail the whole
 * operation.
 *
 * SQL injection guard: bank_code + entry_ref validated at the route
 * boundary via the shared validators.
 */
import type { Knex } from 'knex';
export interface UpdateRepeatEntryDateInput {
    bankCode: string;
    entryRef: string;
    newDate: string;
    /** Optional bank-statement description to record as alias. */
    statementName?: string | null;
}
export interface UpdateRepeatEntryDateResponse {
    success: boolean;
    message?: string;
    entry_ref?: string;
    old_date?: string | null;
    new_date?: string;
    alias_saved?: boolean;
    error?: string;
}
export interface RepeatEntry {
    entry_ref: string;
    description: string;
    next_post_date: string | null;
    frequency: string;
    every: number;
    posted_count: number;
    total_posts: number;
    status: 'Active' | 'Completed';
    amount_pence: number;
    amount_pounds: number;
    account: string;
    cb_type: string;
}
export interface ListRepeatEntriesResponse {
    success: boolean;
    bank_code: string;
    repeat_entries: RepeatEntry[];
    count: number;
    message?: string;
    error?: string;
}
export declare function listRepeatEntries(operaDb: Knex, bankCode: string): Promise<ListRepeatEntriesResponse>;
export declare function updateRepeatEntryDate(appDb: Knex, operaDb: Knex, input: UpdateRepeatEntryDateInput): Promise<UpdateRepeatEntryDateResponse>;
//# sourceMappingURL=repeat-entries.d.ts.map
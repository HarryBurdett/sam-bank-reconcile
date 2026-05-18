/**
 * Check for due recurring entries (arhead/arline) for a bank.
 *
 * Faithful port of `check_recurring_entries` (api/main.py:10320-10567,
 * worktree admiring-borg-888ae1). The frontend
 * (BankStatementHub.tsx:checkRecurringEntries) calls this endpoint
 * BEFORE loading the bank-statement preview: if any active recurring
 * entries are due (ae_nxtpost <= today, ae_posted<ae_topost) on this
 * bank, it surfaces a prompt so the operator can post them in Opera
 * first, instead of discovering them one-by-one mid-preview.
 *
 * Each due entry is expanded into its full set of outstanding posting
 * dates — a monthly subscription with ae_nxtpost three months ago
 * surfaces three rows (one per cycle), not one. Composite entry refs
 * (`REC0000002:2026-05-15`) are used so the POST route can target a
 * specific cycle.
 *
 * Per-date period validation runs via the shared
 * `getPeriodPostingDecision` helper so a date in a closed Opera period
 * comes back with `can_post=false, blocked_reason='Period N is closed
 * for posting...'` and the FE renders it greyed out.
 */
import type { Knex } from 'knex';
import { type RecurringEntriesMode } from './settings.js';
export interface RecurringEntryLineDetail {
    account: string;
    account_desc: string;
    amount_pence: number;
    amount_pounds: number;
    vat_code: string;
    vat_amount_pence: number;
    project: string;
    department: string;
    comment: string;
}
export interface RecurringEntryItem {
    /** Composite key — `REC0000002:2026-05-15` for multi-date, plain ref otherwise. */
    entry_ref: string;
    /** The plain arhead.ae_entry (no date suffix). */
    base_entry_ref: string;
    type: number;
    type_desc: string;
    description: string;
    account: string;
    account_desc: string;
    cbtype: string;
    amount_pence: number;
    amount_pounds: number;
    next_post_date: string | null;
    posted_count: number;
    total_posts: number;
    frequency: string;
    project: string;
    department: string;
    can_post: boolean;
    blocked_reason: string | null;
    comment: string;
    vat_code: string;
    vat_amount_pence: number;
    line_count: number;
    lines: RecurringEntryLineDetail[];
}
export interface CheckRecurringEntriesResponse {
    success: boolean;
    mode?: RecurringEntriesMode;
    entries?: RecurringEntryItem[];
    total_due?: number;
    postable_count?: number;
    blocked_count?: number;
    error?: string;
}
/**
 * Find all active recurring entries on this bank that are due
 * (ae_nxtpost <= today), expand each into its outstanding posting
 * dates, validate each date against the period gates, and return the
 * full UI shape.
 *
 * Read-only: no Opera writes. Safe to call before the operator has
 * made any decisions.
 */
export declare function checkRecurringEntries(operaDb: Knex, appDb: Knex | null, bankCode: string): Promise<CheckRecurringEntriesResponse>;
//# sourceMappingURL=check-recurring-entries.d.ts.map
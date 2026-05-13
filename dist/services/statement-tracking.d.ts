/**
 * Statement tracking data — consolidated lookup tables built from
 * bank_statement_imports.
 *
 * Faithful port of `EmailStorage.get_all_statement_tracking_data`
 * (api/email/storage.py:1615). Single pass over bank_statement_imports
 * builds 11 sets/maps the scan_all_banks orchestration needs.
 *
 * The legacy implementation walks rows ORDER BY id DESC so the
 * `cached_stmt_info` dict keeps the *latest* row per filename. The TS
 * version preserves that ordering exactly.
 */
import type { Knex } from 'knex';
export type EmailAttachmentKey = string;
export interface CachedStmtInfo {
    filename: string;
    bank_code: string;
    sort_code: string;
    account_number: string;
    opening_balance: number;
    closing_balance: number;
    statement_date: string | null;
    period_start: string | null;
    period_end: string | null;
}
export interface StatementTrackingData {
    /** (email_id, attachment_id) tuples for fully-reconciled rows. */
    reconciled_keys: Set<EmailAttachmentKey>;
    /** Filenames for fully-reconciled rows. */
    reconciled_filenames: Set<string>;
    /** (email_id, attachment_id) tuples imported but not reconciled and not managed. */
    imported_nr_keys: Set<EmailAttachmentKey>;
    /** Filenames imported but not reconciled and not managed. */
    imported_nr_filenames: Set<string>;
    /** bank_code → max(closing_balance) across reconciled rows. */
    reconciled_closing_balances: Map<string, number>;
    /** bank_code → set of rounded opening_balance across reconciled rows. */
    reconciled_opening_balances: Map<string, Set<number>>;
    /** (email_id, attachment_id) tuples for managed (archived/deleted/retained). */
    managed_keys: Set<EmailAttachmentKey>;
    /** Filenames for managed (archived/deleted/retained). */
    managed_filenames: Set<string>;
    /** filename → latest non-managed (and non-DEDUP) row. */
    cached_stmt_info: Map<string, CachedStmtInfo>;
    /** pdf_hash → earliest (min-id) import_id. */
    imported_hashes: Map<string, number>;
    /** Set of "<sort_code>|<account_number>|<open2dp>|<close2dp>" for non-managed rows. */
    imported_identities: Set<string>;
}
export declare function getAllStatementTrackingData(appDb: Knex): Promise<StatementTrackingData>;
//# sourceMappingURL=statement-tracking.d.ts.map
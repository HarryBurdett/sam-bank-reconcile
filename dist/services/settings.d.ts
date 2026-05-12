/**
 * Per-app settings for bank-reconcile.
 *
 * The Python implementation reads "recurring_entries_mode" and other
 * per-company settings from a JSON file. Under SAM, settings live in
 * the per-app `settings` table (key/value JSON, one row per setting
 * key) provisioned by migration 001.
 *
 * Port of:
 *   GET  /api/recurring-entries/config   (api/main.py:10290)
 *   PUT  /api/recurring-entries/config   (api/main.py:10303)
 */
import type { Knex } from 'knex';
export type RecurringEntriesMode = 'process' | 'warn';
export interface RecurringConfigResponse {
    success: boolean;
    mode: RecurringEntriesMode;
    error?: string;
}
/**
 * Read the recurring-entries processing mode. Defaults to 'process'
 * if no row exists or the stored value is invalid (matches Python).
 */
export declare function getRecurringEntriesMode(appDb: Knex): Promise<RecurringConfigResponse>;
/**
 * Update the recurring-entries processing mode. Validates input.
 */
export declare function setRecurringEntriesMode(appDb: Knex, mode: string): Promise<RecurringConfigResponse>;
//# sourceMappingURL=settings.d.ts.map
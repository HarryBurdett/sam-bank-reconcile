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

const RECURRING_KEY = 'recurring_entries_mode';

export interface RecurringConfigResponse {
  success: boolean;
  mode: RecurringEntriesMode;
  error?: string;
}

/**
 * Read the recurring-entries processing mode. Defaults to 'process'
 * if no row exists or the stored value is invalid (matches Python).
 */
export async function getRecurringEntriesMode(
  appDb: Knex,
): Promise<RecurringConfigResponse> {
  try {
    const row = await appDb('settings').where({ key: RECURRING_KEY }).first();
    let mode: RecurringEntriesMode = 'process';
    if (row?.value) {
      try {
        const parsed = JSON.parse(row.value);
        if (parsed === 'process' || parsed === 'warn') {
          mode = parsed;
        }
      } catch {
        // Stored value not JSON — fall back to default
      }
    }
    return { success: true, mode };
  } catch {
    // Match Python: even on read error, return success=true with default
    return { success: true, mode: 'process' };
  }
}

/**
 * Update the recurring-entries processing mode. Validates input.
 */
export async function setRecurringEntriesMode(
  appDb: Knex,
  mode: string,
): Promise<RecurringConfigResponse> {
  if (mode !== 'process' && mode !== 'warn') {
    return {
      success: false,
      mode: 'process',
      error: "Mode must be 'process' or 'warn'",
    };
  }

  try {
    const value = JSON.stringify(mode);
    const existing = await appDb('settings').where({ key: RECURRING_KEY }).first();
    if (existing) {
      await appDb('settings')
        .where({ key: RECURRING_KEY })
        .update({ value, updated_at: appDb.fn.now() });
    } else {
      await appDb('settings').insert({ key: RECURRING_KEY, value });
    }
    return { success: true, mode };
  } catch (err: any) {
    return {
      success: false,
      mode: 'process',
      error: err?.message ?? String(err),
    };
  }
}

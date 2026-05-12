const RECURRING_KEY = 'recurring_entries_mode';
/**
 * Read the recurring-entries processing mode. Defaults to 'process'
 * if no row exists or the stored value is invalid (matches Python).
 */
export async function getRecurringEntriesMode(appDb) {
    try {
        const row = await appDb('settings').where({ key: RECURRING_KEY }).first();
        let mode = 'process';
        if (row?.value) {
            try {
                const parsed = JSON.parse(row.value);
                if (parsed === 'process' || parsed === 'warn') {
                    mode = parsed;
                }
            }
            catch {
                // Stored value not JSON — fall back to default
            }
        }
        return { success: true, mode };
    }
    catch {
        // Match Python: even on read error, return success=true with default
        return { success: true, mode: 'process' };
    }
}
/**
 * Update the recurring-entries processing mode. Validates input.
 */
export async function setRecurringEntriesMode(appDb, mode) {
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
        }
        else {
            await appDb('settings').insert({ key: RECURRING_KEY, value });
        }
        return { success: true, mode };
    }
    catch (err) {
        return {
            success: false,
            mode: 'process',
            error: err?.message ?? String(err),
        };
    }
}
//# sourceMappingURL=settings.js.map
const DEFAULT_HOME_CURRENCY = {
    code: 'GBP',
    description: 'Sterling (default)',
    found: false,
};
// Per-Knex cache so repeated calls in a request don't re-hit Opera.
const cache = new WeakMap();
export async function getHomeCurrency(operaDb) {
    const cached = cache.get(operaDb);
    if (cached)
        return cached;
    try {
        const rows = (await operaDb.raw(`SELECT xc_curr, xc_desc FROM zxchg WITH (NOLOCK) WHERE xc_home = 1`));
        if (Array.isArray(rows) && rows.length > 0 && rows[0]) {
            const result = {
                code: (rows[0].xc_curr ?? 'GBP').trim(),
                description: (rows[0].xc_desc ?? 'Sterling').trim(),
                found: true,
            };
            cache.set(operaDb, result);
            return result;
        }
    }
    catch {
        // Fall through to default
    }
    cache.set(operaDb, DEFAULT_HOME_CURRENCY);
    return { ...DEFAULT_HOME_CURRENCY };
}
/** Used by tests to clear cache between runs. */
export function clearHomeCurrencyCache(operaDb) {
    cache.delete(operaDb);
}
//# sourceMappingURL=home-currency.js.map
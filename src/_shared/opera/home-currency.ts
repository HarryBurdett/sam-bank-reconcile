/**
 * Home currency lookup from Opera (zxchg table).
 *
 * Faithful port of `OperaSQLImport.get_home_currency` in
 * `sql_rag/opera_sql_import.py:424-466`.
 *
 * The home currency row has `xc_home = 1`. If no row is found, defaults
 * to GBP / "Sterling (default)" so callers always have a value.
 */
import type { Knex } from 'knex';

export interface HomeCurrency {
  code: string;
  description: string;
  found: boolean;
}

const DEFAULT_HOME_CURRENCY: HomeCurrency = {
  code: 'GBP',
  description: 'Sterling (default)',
  found: false,
};

// Per-Knex cache so repeated calls in a request don't re-hit Opera.
const cache = new WeakMap<Knex, HomeCurrency>();

export async function getHomeCurrency(operaDb: Knex): Promise<HomeCurrency> {
  const cached = cache.get(operaDb);
  if (cached) return cached;

  try {
    const rows = (await operaDb.raw(
      `SELECT xc_curr, xc_desc FROM zxchg WITH (NOLOCK) WHERE xc_home = 1`,
    )) as unknown as Array<{ xc_curr: string | null; xc_desc: string | null }>;
    if (Array.isArray(rows) && rows.length > 0 && rows[0]) {
      const result: HomeCurrency = {
        code: (rows[0].xc_curr ?? 'GBP').trim(),
        description: (rows[0].xc_desc ?? 'Sterling').trim(),
        found: true,
      };
      cache.set(operaDb, result);
      return result;
    }
  } catch {
    // Fall through to default
  }
  cache.set(operaDb, DEFAULT_HOME_CURRENCY);
  return { ...DEFAULT_HOME_CURRENCY };
}

/** Used by tests to clear cache between runs. */
export function clearHomeCurrencyCache(operaDb: Knex): void {
  cache.delete(operaDb);
}

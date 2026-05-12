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
export declare function getHomeCurrency(operaDb: Knex): Promise<HomeCurrency>;
/** Used by tests to clear cache between runs. */
export declare function clearHomeCurrencyCache(operaDb: Knex): void;
//# sourceMappingURL=home-currency.d.ts.map
/**
 * Opera control account lookup — faithful port of `sql_rag/opera_config.py`
 * `get_control_accounts()`.
 *
 * Control account codes vary by installation. They are loaded
 * dynamically from Opera configuration tables, NEVER hardcoded.
 *
 * Resolution order (matches the Python implementation exactly):
 *   1. `sprfls.sc_dbtctrl` for debtors control
 *   2. `pprfls.pc_crdctrl` for creditors control
 *   3. `nparm.np_dca` / `nparm.np_cca` as fallback
 *   4. Raise — never default to a hardcoded code in finance.
 *
 * The Python version caches the result on the function object. We mirror
 * this with a per-pool WeakMap so the cache is keyed to the same Knex
 * connection that produced it (one cache entry per company database).
 */
import type { Knex } from 'knex';
export interface OperaControlAccounts {
    /** Debtors (sales) control account code, e.g. "1100" */
    debtorsControl: string;
    /** Creditors (purchase) control account code, e.g. "2100" */
    creditorsControl: string;
    /** Where the values came from — for diagnostics */
    source: 'sprfls' | 'pprfls' | 'nparm' | 'default';
}
/**
 * Read control accounts from Opera config tables for a given company.
 *
 * @param db - Knex pool against the per-company Opera SE database
 * @param useCache - Whether to use cached values (default true)
 * @returns The debtors and creditors control account codes
 * @throws Error if neither sprfls/pprfls nor nparm have valid values
 */
export declare function getControlAccounts(db: Knex, useCache?: boolean): Promise<OperaControlAccounts>;
/**
 * Clear the control-accounts cache. Used in tests, or when an admin
 * has changed the Opera config and wants the next request to re-read.
 *
 * Faithful port of `clear_control_accounts_cache()` in opera_config.py.
 */
export declare function clearControlAccountsCache(): void;
//# sourceMappingURL=control-accounts.d.ts.map
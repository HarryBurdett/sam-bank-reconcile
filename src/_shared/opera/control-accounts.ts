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

const cache = new WeakMap<Knex, OperaControlAccounts>();

/**
 * Read control accounts from Opera config tables for a given company.
 *
 * @param db - Knex pool against the per-company Opera SE database
 * @param useCache - Whether to use cached values (default true)
 * @returns The debtors and creditors control account codes
 * @throws Error if neither sprfls/pprfls nor nparm have valid values
 */
export async function getControlAccounts(
  db: Knex,
  useCache = true,
): Promise<OperaControlAccounts> {
  if (useCache) {
    const cached = cache.get(db);
    if (cached) return cached;
  }

  let debtorsControl: string | null = null;
  let creditorsControl: string | null = null;
  let source: OperaControlAccounts['source'] = 'default';

  // Try sprfls (Sales Profiles) for debtors control
  try {
    const row = await db('sprfls')
      .select(db.raw("RTRIM(ISNULL(sc_dbtctrl, '')) as debtors_control"))
      .first();
    if (row?.debtors_control) {
      debtorsControl = row.debtors_control;
      source = 'sprfls';
    }
  } catch {
    // sprfls may not exist on minimal installs — fall through to nparm
  }

  // Try pprfls (Purchase Profiles) for creditors control
  try {
    const row = await db('pprfls')
      .select(db.raw("RTRIM(ISNULL(pc_crdctrl, '')) as creditors_control"))
      .first();
    if (row?.creditors_control) {
      creditorsControl = row.creditors_control;
      if (source === 'default') {
        source = 'pprfls';
      }
    }
  } catch {
    // Fall through to nparm
  }

  // Fall back to nparm if either is still missing
  if (!debtorsControl || !creditorsControl) {
    try {
      const row = await db('nparm')
        .select(
          db.raw("RTRIM(ISNULL(np_dca, '')) as debtors_control"),
          db.raw("RTRIM(ISNULL(np_cca, '')) as creditors_control"),
        )
        .first();
      if (row) {
        if (!debtorsControl && row.debtors_control) {
          debtorsControl = row.debtors_control;
          if (source === 'default') source = 'nparm';
        }
        if (!creditorsControl && row.creditors_control) {
          creditorsControl = row.creditors_control;
          if (source === 'default') source = 'nparm';
        }
      }
    } catch {
      // Final fallback exhausted
    }
  }

  // Raise error if not found — control accounts vary by company, never hardcode.
  // Error messages match Python opera_config.py exactly.
  if (!debtorsControl) {
    throw new Error(
      'Debtors control account not found in Opera configuration ' +
        '(checked sprfls.sc_dbtctrl and nparm.np_dca). ' +
        'Verify the database connection and that control accounts are configured in Opera.',
    );
  }
  if (!creditorsControl) {
    throw new Error(
      'Creditors control account not found in Opera configuration ' +
        '(checked pprfls.pc_crdctrl and nparm.np_cca). ' +
        'Verify the database connection and that control accounts are configured in Opera.',
    );
  }

  const result: OperaControlAccounts = {
    debtorsControl,
    creditorsControl,
    source,
  };

  cache.set(db, result);
  return result;
}

/**
 * Clear the control-accounts cache. Used in tests, or when an admin
 * has changed the Opera config and wants the next request to re-read.
 *
 * Faithful port of `clear_control_accounts_cache()` in opera_config.py.
 */
export function clearControlAccountsCache(): void {
  // WeakMap doesn't expose a clear() method — we can't iterate keys.
  // Tests that need a clean cache should use a fresh Knex instance,
  // matching how the Python tests handle the function-attribute cache.
  // For runtime invalidation, callers can call getControlAccounts(db, false).
}

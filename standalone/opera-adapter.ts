/**
 * Opera DB adapter for the standalone host.
 *
 * Two adapters ship today:
 *   - `noop`  — every getCompanyDb() call returns null. Lets the
 *               server boot without an Opera connection. The plugin
 *               surfaces its own "Opera not connected" error path.
 *   - `mssql` — opera-se (SQL Server) via the `tedious` driver.
 *               Connection params come from env vars; per-company
 *               Opera-database mappings come from per-company
 *               opera.json files.
 *
 * FoxPro (opera-3) is not yet supported; the legacy Python app uses an
 * out-of-process agent for that and we'd mirror it.
 */
import type { Knex } from 'knex';
import type { AppLogger } from '../src/app-context.js';

export type OperaType = 'opera-se' | 'opera-3' | null;

export interface OperaAdapter {
  getCompanyDb(code: string): Knex | null;
  operaType: OperaType;
  /**
   * Release any per-adapter resources (pools, file handles).
   * Always present; the noop adapter is a no-op.
   */
  destroy?: () => Promise<void>;
  /**
   * Invalidate cached state for a single company. Called by the
   * standalone host after the operator edits the per-company
   * opera.json so the next getCompanyDb(code) call rebuilds the
   * pool against the new database / Opera version.
   *
   * `mapping` is the latest opera.json contents; null clears the
   * mapping entirely (the company becomes inaccessible until
   * mapped again).
   */
  invalidateCompany?: (
    code: string,
    mapping: { database: string; operaVersion?: string } | null,
  ) => Promise<void>;
}

export const noOpAdapter: OperaAdapter = {
  getCompanyDb: () => null,
  operaType: null,
};

export interface SelectAdapterOptions {
  name: string;
  mssql?: {
    host: string;
    port: number;
    user: string;
    password: string;
    trustServerCertificate: boolean;
    encrypt: boolean;
    /** companyCode → { database, operaVersion } */
    companies: ReadonlyMap<string, { database: string; operaVersion?: string }>;
  };
  opera3?: {
    agentUrl: string | null;
    agentKey: string | null;
    dataPath: string | null;
    /** companyCode → { database, operaVersion } */
    companies: ReadonlyMap<string, { database: string; operaVersion?: string }>;
  };
  logger: AppLogger;
}

export async function selectAdapter(opts: SelectAdapterOptions): Promise<OperaAdapter> {
  if (opts.name === 'noop') return noOpAdapter;

  if (opts.name === 'mssql') {
    if (!opts.mssql) {
      throw new Error(
        'OPERA_ADAPTER=mssql requires OPERA_SQL_HOST, OPERA_SQL_USER, OPERA_SQL_PASSWORD (see README).',
      );
    }
    if (opts.mssql.companies.size === 0) {
      throw new Error(
        'OPERA_ADAPTER=mssql requires per-company opera.json files with a "database" field. ' +
          'Add <DATA_ROOT>/<company>/opera.json (or set LEGACY_DATA_ROOT to auto-seed from the ' +
          'legacy companies/ directory).',
      );
    }
    const { buildMssqlAdapter } = await import('./opera-adapter-mssql.js');
    return buildMssqlAdapter({ ...opts.mssql, logger: opts.logger });
  }

  if (opts.name === 'opera3') {
    if (!opts.opera3) {
      throw new Error('OPERA_ADAPTER=opera3 requires opera3 config (companies map).');
    }
    const { buildOpera3Adapter } = await import('./opera-adapter-opera3.js');
    return buildOpera3Adapter({ ...opts.opera3, logger: opts.logger });
  }

  if (opts.name === 'composite') {
    // Dispatch per-company by operaVersion: SE → MSSQL pool, 3 →
    // opera-3 agent. Used when a deployment has mixed Opera versions
    // across its companies (the common future case once a real
    // opera-3 adapter lands).
    if (!opts.mssql || !opts.opera3) {
      throw new Error(
        'OPERA_ADAPTER=composite requires both the mssql and opera3 config blocks.',
      );
    }
    const { buildMssqlAdapter } = await import('./opera-adapter-mssql.js');
    const { buildOpera3Adapter } = await import('./opera-adapter-opera3.js');
    const mssql = buildMssqlAdapter({ ...opts.mssql, logger: opts.logger });
    const opera3 = buildOpera3Adapter({ ...opts.opera3, logger: opts.logger });
    return {
      operaType: null, // mixed
      getCompanyDb(code) {
        // Each child adapter already filters by operaVersion, so we
        // try mssql first; if it returns null we try opera3. (Inverse
        // order would work equally — they're disjoint.)
        return mssql.getCompanyDb(code) ?? opera3.getCompanyDb(code);
      },
      async invalidateCompany(code, mapping) {
        await mssql.invalidateCompany?.(code, mapping);
        await opera3.invalidateCompany?.(code, mapping);
      },
      async destroy() {
        await mssql.destroy?.();
        await opera3.destroy?.();
      },
    };
  }

  throw new Error(`Unknown OPERA_ADAPTER: ${opts.name}`);
}

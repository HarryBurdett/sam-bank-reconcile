/**
 * MSSQL Opera adapter (opera-se).
 *
 * Builds a Knex pool per Opera company database, lazily. Each
 * standalone-company maps to one Opera-database name (legacy:
 * Opera3SECompany00X) plus an `operaVersion` ("SE" by default).
 *
 * Companies marked operaVersion="3" are skipped — opera-3 uses VFP
 * / FoxPro files via a separate agent service (SAM-provided or
 * external). When a real opera-3 adapter lands, it will plug in
 * alongside this one.
 *
 * Connection params are server-wide (one MSSQL instance for all
 * companies, with the database name being the only per-company
 * variable — same pattern as the legacy Python implementation).
 */
import knex, { type Knex } from 'knex';
import type { OperaAdapter } from './opera-adapter.js';
import type { AppLogger } from '../src/app-context.js';

export interface CompanyMapping {
  database: string;
  operaVersion?: string;
}

export interface MssqlAdapterConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  /** Set true for Opera servers that present self-signed certs (the default in legacy deployments). */
  trustServerCertificate: boolean;
  encrypt: boolean;
  /** Standalone-company code → { database, operaVersion }. */
  companies: ReadonlyMap<string, CompanyMapping>;
  logger: AppLogger;
}

export interface MssqlAdapter extends OperaAdapter {
  /** Destroy all per-database pools. Called at server shutdown. */
  destroy(): Promise<void>;
}

function isOperaSe(version: string | undefined): boolean {
  if (!version) return true;
  const v = version.toLowerCase();
  return v === 'se' || v === 'opera-se' || v === 'sql_se';
}

export function buildMssqlAdapter(config: MssqlAdapterConfig): MssqlAdapter {
  // Mutable so invalidateCompany() can update without re-building the adapter.
  const companyMap = new Map(config.companies);
  const pools = new Map<string, Knex>();

  function getCompanyDb(code: string): Knex | null {
    const mapping = companyMap.get(code);
    if (!mapping) {
      config.logger.warn(`[opera-mssql] no Opera database mapping for company "${code}"`);
      return null;
    }
    if (!isOperaSe(mapping.operaVersion)) {
      config.logger.warn(
        `[opera-mssql] company "${code}" is configured as Opera ${mapping.operaVersion} ` +
          `(not opera-se). MSSQL adapter cannot serve this company; ` +
          `wire in an opera-3 adapter to read/write FoxPro data.`,
      );
      return null;
    }
    let pool = pools.get(code);
    if (!pool) {
      pool = knex({
        client: 'mssql',
        connection: {
          host: config.host,
          port: config.port,
          user: config.user,
          password: config.password,
          database: mapping.database,
          options: {
            encrypt: config.encrypt,
            trustServerCertificate: config.trustServerCertificate,
          },
        },
        // max=10 leaves headroom for lock-only transactions (one per
        // active bank-level import) plus active query traffic. The
        // standalone host's applock holds one connection per held
        // lock for its lifetime; over-provisioning here is cheap.
        pool: { min: 0, max: 5 },
      });
      pools.set(code, pool);
      config.logger.info(
        `[opera-mssql] created pool for "${code}" → ${mapping.database}`,
      );
    }
    return pool;
  }

  async function invalidateCompany(
    code: string,
    mapping: CompanyMapping | null,
  ): Promise<void> {
    const existing = pools.get(code);
    if (existing) {
      try {
        await existing.destroy();
      } catch (err) {
        config.logger.warn(
          `[opera-mssql] error destroying pool for ${code}: ${(err as Error).message}`,
        );
      }
      pools.delete(code);
    }
    if (mapping) {
      companyMap.set(code, mapping);
    } else {
      companyMap.delete(code);
    }
  }

  async function destroy(): Promise<void> {
    for (const [code, pool] of pools.entries()) {
      try {
        await pool.destroy();
      } catch (err) {
        config.logger.warn(
          `[opera-mssql] error closing pool for ${code}: ${(err as Error).message}`,
        );
      }
    }
    pools.clear();
  }

  return {
    operaType: 'opera-se',
    getCompanyDb,
    invalidateCompany,
    destroy,
  };
}

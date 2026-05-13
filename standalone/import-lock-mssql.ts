/**
 * SQL Server applock-backed import lock for the standalone host.
 *
 * Use case: protect the bank-level import lock-key across multiple
 * Node processes / replicas hitting the same Opera SQL Server. The
 * legacy in-memory lock works only inside a single process; deploys
 * that scale horizontally (or just survive a `pm2 restart` mid-run)
 * lose mutual exclusion and rely on the per-import-id idempotency
 * check alone.
 *
 * Mechanism: `sp_getapplock @LockOwner='Transaction'` held by a
 * lock-only Knex transaction. While the transaction lives, the lock
 * lives. Committing the transaction releases it. If the connection
 * drops (process crash, network blip) SQL Server rolls back the
 * transaction and releases automatically — no stale-lock cliff.
 *
 * Design notes:
 *   - The lock-only transaction holds one connection from the
 *     per-company Knex pool for the lock's lifetime. Pool sizing
 *     in opera-adapter-mssql is set wide enough that this doesn't
 *     starve actual query traffic.
 *   - For companies whose Opera adapter returns null (operaVersion=3
 *     in composite mode, or OPERA_ADAPTER=noop entirely), the
 *     adapter transparently falls back to a process-local in-memory
 *     lock. The plugin's import path is unchanged either way.
 *   - The helper is plugin-agnostic — the same shape backs the
 *     gocardless app's mandate-level lock.
 */
import type { Knex } from 'knex';
import type { ImportLockAdapter } from '../src/services/import-from-pdf.js';
import type { AppLogger } from '../src/app-context.js';

/** Stale-lock cutoff for the in-memory fallback (matches the legacy 5-minute default). */
const FALLBACK_STALE_LOCK_MS = 5 * 60 * 1000;

/** Module-shared in-memory locks for fallback. Same Map across all
 * companies in this process — bank-code collisions across companies
 * intentionally serialise (matches the legacy semantics). */
const fallbackLocks = new Map<string, { acquiredAt: number; locker: string }>();

interface HeldLock {
  kind: 'mssql' | 'memory';
  /** Open lock-only transaction for the mssql path; undefined for memory. */
  trx?: Knex.Transaction;
}

/**
 * Build an ImportLockAdapter that uses `sp_getapplock` against the
 * Opera SQL Server when available, with an in-memory fallback.
 *
 * The plugin's lock key (e.g. `BC010`) is namespaced internally with
 * the company code before reaching the underlying lock primitive — so
 * two standalone companies that happen to use the same bank code
 * don't false-share a lock. (In SAM, each tenant runs in its own
 * worker, so this collision can't happen; the namespace prefix is a
 * standalone-only safeguard.)
 *
 * @param companyCode Identifier prefixed to every lock key.
 * @param getOperaDb  Returns the per-company Opera Knex pool, or
 *                    null if the company has no SQL connection
 *                    (noop or operaVersion=3). Re-evaluated on every
 *                    acquire() so a runtime adapter swap is honoured
 *                    without restarting.
 * @param logger      Standalone host logger.
 */
export function buildOperaAwareImportLock(
  companyCode: string,
  getOperaDb: () => Knex | null,
  logger: AppLogger,
): ImportLockAdapter {
  const namespaced = (key: string) => `${companyCode}::${key}`;
  /** Per-adapter-instance map of currently-held locks. */
  const held = new Map<string, HeldLock>();

  return {
    async acquire(key: string, locker: string): Promise<boolean> {
      const resource = namespaced(key);
      if (held.has(key)) return false;

      const operaDb = getOperaDb();
      if (operaDb) {
        const trx = await operaDb.transaction();
        try {
          const result = await trx.raw(
            `DECLARE @r INT;
             EXEC @r = sp_getapplock @Resource = ?, @LockMode = ?, @LockOwner = ?, @LockTimeout = 0;
             SELECT @r AS r`,
            [resource, 'Exclusive', 'Transaction'],
          );
          const rv = parseApplockResult(result);
          if (rv < 0) {
            await trx.rollback();
            return false;
          }
          held.set(key, { kind: 'mssql', trx });
          logger.debug(`[applock] acquired mssql lock "${resource}" for ${locker}`);
          return true;
        } catch (err) {
          await trx.rollback().catch(() => {});
          logger.warn(
            `[applock] mssql acquire failed for "${resource}": ${(err as Error).message}; falling back to in-memory`,
          );
          // fall through to in-memory below
        }
      }

      // In-memory fallback path — also namespaced so two standalone
      // companies don't false-share a key in the process-shared Map.
      const existing = fallbackLocks.get(resource);
      if (existing && Date.now() - existing.acquiredAt < FALLBACK_STALE_LOCK_MS) {
        return false;
      }
      fallbackLocks.set(resource, { acquiredAt: Date.now(), locker });
      held.set(key, { kind: 'memory' });
      return true;
    },

    async release(key: string): Promise<void> {
      const entry = held.get(key);
      if (!entry) return;
      held.delete(key);
      const resource = namespaced(key);
      if (entry.kind === 'mssql' && entry.trx) {
        try {
          // Committing releases Transaction-scoped applocks.
          await entry.trx.commit();
        } catch (err) {
          logger.warn(
            `[applock] release commit failed for "${resource}": ${(err as Error).message}`,
          );
          await entry.trx.rollback().catch(() => {});
        }
      } else {
        fallbackLocks.delete(resource);
      }
    },
  };
}

/**
 * Parse the return value of `sp_getapplock` out of a Knex `.raw` result.
 * tedious's response shape varies a little between knex versions, so
 * we accept the common forms; -999 is "couldn't read it" and is
 * treated as a failed acquire by the caller.
 */
export function parseApplockResult(result: unknown): number {
  if (Array.isArray(result)) {
    const row = result[0] as { r?: unknown } | undefined;
    if (row && typeof row.r === 'number') return row.r;
    // Knex+tedious wraps recordsets: [[ { r: x } ]]
    const inner = (result as unknown[][])[0];
    if (Array.isArray(inner) && inner[0] && typeof (inner[0] as { r?: unknown }).r === 'number') {
      return (inner[0] as { r: number }).r;
    }
  }
  if (result !== null && typeof result === 'object') {
    const rs = (result as { recordset?: Array<{ r?: unknown }> }).recordset;
    if (Array.isArray(rs) && rs.length > 0 && typeof rs[0]?.r === 'number') {
      return rs[0]!.r as number;
    }
  }
  return -999;
}

/**
 * Test-only: wipe the module-shared in-memory fallback. Exposed so
 * unit tests can isolate from each other.
 */
export function _resetFallbackLocksForTests(): void {
  fallbackLocks.clear();
}

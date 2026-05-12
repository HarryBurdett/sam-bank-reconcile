/**
 * Bank-level import lock — prevents concurrent imports to the same
 * Opera bank account.
 *
 * Faithful port of `sql_rag/import_lock.py`. The Python version uses
 * a per-company SQLite file (`import_locks.db`) — the SAM port uses
 * the per-app DB's `import_locks` table (provisioned by migration
 * 001_initial_schema.ts).
 *
 * Stale lock cleanup: any lock older than `LOCK_EXPIRY_SECONDS` is
 * deleted on each acquire. Default 5 minutes — same as Python.
 *
 * Lock granularity is per Opera bank account code (NOT per tenant)
 * because the import flow's destination is the Opera bank account,
 * not SAM tenant. Two tenants importing to the same Opera company's
 * BC010 must serialise; that's by design (per CLAUDE.md "this is a
 * finance system — no concurrent writes to the same bank").
 *
 * Usage:
 *   if (!await acquireImportLock(appDb, 'BC010', 'api', 'import')) {
 *     return res.json({ success: false, error: 'Bank is locked' });
 *   }
 *   try {
 *     // do the import
 *   } finally {
 *     await releaseImportLock(appDb, 'BC010');
 *   }
 *
 * Or with the context-manager helper:
 *   await withImportLock(appDb, 'BC010', { locked_by, endpoint }, async () => {
 *     // do the import
 *   });
 */
import type { Knex } from 'knex';

export const LOCK_EXPIRY_SECONDS = 300; // 5 minutes

export interface ImportLockOptions {
  locked_by?: string;
  endpoint?: string;
  description?: string;
}

export interface ActiveLock {
  bank_code: string;
  locked_at: Date | string;
  locked_by: string;
  endpoint: string;
  description: string;
  age_seconds: number;
}

// ---------------------------------------------------------------------
// acquire / release / list
// ---------------------------------------------------------------------

async function cleanupStaleLocks(appDb: Knex): Promise<number> {
  const cutoff = new Date(Date.now() - LOCK_EXPIRY_SECONDS * 1000);
  return Number(
    await appDb('import_locks').where('locked_at', '<', cutoff).delete(),
  );
}

export async function acquireImportLock(
  appDb: Knex,
  bankCode: string,
  opts: ImportLockOptions = {},
): Promise<boolean> {
  const code = (bankCode ?? '').trim();
  if (!code) return false;

  await cleanupStaleLocks(appDb);

  const existing = (await appDb('import_locks')
    .where({ bank_code: code })
    .first()) as
    | { bank_code: string; locked_at: Date | string; locked_by: string }
    | undefined;
  if (existing) return false;

  try {
    await appDb('import_locks').insert({
      bank_code: code,
      locked_at: appDb.fn.now(),
      locked_by: opts.locked_by ?? 'unknown',
      endpoint: opts.endpoint ?? 'unknown',
      description: opts.description ?? '',
    });
    return true;
  } catch {
    // Likely a race lost on the unique constraint
    return false;
  }
}

export async function releaseImportLock(
  appDb: Knex,
  bankCode: string,
): Promise<void> {
  const code = (bankCode ?? '').trim();
  if (!code) return;
  await appDb('import_locks').where({ bank_code: code }).delete();
}

export async function getActiveLocks(appDb: Knex): Promise<ActiveLock[]> {
  await cleanupStaleLocks(appDb);
  const rows = (await appDb('import_locks').select(
    'bank_code',
    'locked_at',
    'locked_by',
    'endpoint',
    'description',
  )) as unknown as Array<{
    bank_code: string;
    locked_at: Date | string;
    locked_by: string | null;
    endpoint: string | null;
    description: string | null;
  }>;

  const now = Date.now();
  return rows.map((r) => {
    const lockedAtMs =
      r.locked_at instanceof Date
        ? r.locked_at.getTime()
        : new Date(String(r.locked_at)).getTime();
    return {
      bank_code: r.bank_code,
      locked_at: r.locked_at,
      locked_by: r.locked_by ?? 'unknown',
      endpoint: r.endpoint ?? 'unknown',
      description: r.description ?? '',
      age_seconds: Number(((now - lockedAtMs) / 1000).toFixed(1)),
    };
  });
}

// ---------------------------------------------------------------------
// withImportLock — context-manager equivalent
// ---------------------------------------------------------------------

export class ImportLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportLockError';
  }
}

export async function withImportLock<T>(
  appDb: Knex,
  bankCode: string,
  opts: ImportLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const acquired = await acquireImportLock(appDb, bankCode, opts);
  if (!acquired) {
    throw new ImportLockError(
      `Bank account ${bankCode} is currently being imported by another user. ` +
        'Please wait for the current import to complete before starting another.',
    );
  }
  try {
    return await fn();
  } finally {
    await releaseImportLock(appDb, bankCode);
  }
}

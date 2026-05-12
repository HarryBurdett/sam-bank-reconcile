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
export declare const LOCK_EXPIRY_SECONDS = 300;
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
export declare function acquireImportLock(appDb: Knex, bankCode: string, opts?: ImportLockOptions): Promise<boolean>;
export declare function releaseImportLock(appDb: Knex, bankCode: string): Promise<void>;
export declare function getActiveLocks(appDb: Knex): Promise<ActiveLock[]>;
export declare class ImportLockError extends Error {
    constructor(message: string);
}
export declare function withImportLock<T>(appDb: Knex, bankCode: string, opts: ImportLockOptions, fn: () => Promise<T>): Promise<T>;
//# sourceMappingURL=import-lock.d.ts.map
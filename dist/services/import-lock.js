export const LOCK_EXPIRY_SECONDS = 300; // 5 minutes
// ---------------------------------------------------------------------
// acquire / release / list
// ---------------------------------------------------------------------
async function cleanupStaleLocks(appDb) {
    const cutoff = new Date(Date.now() - LOCK_EXPIRY_SECONDS * 1000);
    return Number(await appDb('import_locks').where('locked_at', '<', cutoff).delete());
}
export async function acquireImportLock(appDb, bankCode, opts = {}) {
    const code = (bankCode ?? '').trim();
    if (!code)
        return false;
    await cleanupStaleLocks(appDb);
    const existing = (await appDb('import_locks')
        .where({ bank_code: code })
        .first());
    if (existing)
        return false;
    try {
        await appDb('import_locks').insert({
            bank_code: code,
            locked_at: appDb.fn.now(),
            locked_by: opts.locked_by ?? 'unknown',
            endpoint: opts.endpoint ?? 'unknown',
            description: opts.description ?? '',
        });
        return true;
    }
    catch {
        // Likely a race lost on the unique constraint
        return false;
    }
}
export async function releaseImportLock(appDb, bankCode) {
    const code = (bankCode ?? '').trim();
    if (!code)
        return;
    await appDb('import_locks').where({ bank_code: code }).delete();
}
export async function getActiveLocks(appDb) {
    await cleanupStaleLocks(appDb);
    const rows = (await appDb('import_locks').select('bank_code', 'locked_at', 'locked_by', 'endpoint', 'description'));
    const now = Date.now();
    return rows.map((r) => {
        const lockedAtMs = r.locked_at instanceof Date
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
    constructor(message) {
        super(message);
        this.name = 'ImportLockError';
    }
}
export async function withImportLock(appDb, bankCode, opts, fn) {
    const acquired = await acquireImportLock(appDb, bankCode, opts);
    if (!acquired) {
        throw new ImportLockError(`Bank account ${bankCode} is currently being imported by another user. ` +
            'Please wait for the current import to complete before starting another.');
    }
    try {
        return await fn();
    }
    finally {
        await releaseImportLock(appDb, bankCode);
    }
}
//# sourceMappingURL=import-lock.js.map
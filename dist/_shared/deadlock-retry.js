const DEADLOCK_MAX_RETRIES = 3;
const DEADLOCK_BACKOFF_MS = [100, 500, 1500];
export function isDeadlockError(err) {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    if (!msg)
        return false;
    return (msg.includes('1205') ||
        msg.includes('40001') ||
        msg.includes('deadlock'));
}
function sleep(ms) {
    return new Promise((res) => setTimeout(res, ms));
}
/**
 * Run `op` inside a Knex transaction with automatic deadlock retry.
 * `op` receives the trx and should perform ALL its writes through
 * it; throwing rolls back, returning resolves the transaction.
 *
 * The `operationName` shows up in deadlock log messages so the
 * operator can correlate retries with the underlying activity.
 */
export async function executeWithDeadlockRetry(operaDb, op, operationName = 'opera-write', logger) {
    let lastErr = null;
    for (let attempt = 0; attempt <= DEADLOCK_MAX_RETRIES; attempt++) {
        try {
            return await operaDb.transaction((trx) => op(trx));
        }
        catch (err) {
            if (!isDeadlockError(err) || attempt >= DEADLOCK_MAX_RETRIES) {
                if (isDeadlockError(err)) {
                    logger?.error?.(`[deadlock-retry] exhausted for ${operationName} after ` +
                        `${DEADLOCK_MAX_RETRIES + 1} attempts: ${err instanceof Error ? err.message : String(err)}`);
                }
                throw err;
            }
            const delay = DEADLOCK_BACKOFF_MS[attempt];
            logger?.warn?.(`[deadlock-retry] ${operationName} attempt ${attempt + 1}/${DEADLOCK_MAX_RETRIES + 1} ` +
                `hit deadlock — retrying in ${delay}ms: ${err instanceof Error ? err.message : String(err)}`);
            lastErr = err;
            await sleep(delay);
        }
    }
    // Safety net — unreachable in practice (the for-loop exits via
    // return or throw on the final iteration).
    throw lastErr ?? new Error(`Deadlock retry exhausted for ${operationName}`);
}
//# sourceMappingURL=deadlock-retry.js.map
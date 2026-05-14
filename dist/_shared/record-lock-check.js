export async function isRecordLocked(operaDb, opts) {
    const { table, keyColumn, keyValue } = opts;
    if (!keyValue)
        return false;
    try {
        await operaDb.transaction(async (trx) => {
            await trx.raw(`SET LOCK_TIMEOUT 500`);
            await trx.raw(`SELECT 1 FROM ${table} WITH (UPDLOCK, ROWLOCK, NOWAIT)
         WHERE RTRIM(${keyColumn}) = ?`, [keyValue]);
            // Trivial rollback — we just wanted to probe the lock.
            throw new Error('__record_lock_probe_done__');
        });
        return false;
    }
    catch (err) {
        const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
        // The probe-done marker means the row was free.
        if (msg.includes('__record_lock_probe_done__'))
            return false;
        if (msg.includes('lock') ||
            msg.includes('1222') ||
            msg.includes('timeout') ||
            msg.includes('nowait')) {
            return true;
        }
        // Unknown error — treat as "not locked" so the actual posting
        // surfaces the real error. Matches legacy permissive fallback.
        return false;
    }
}
//# sourceMappingURL=record-lock-check.js.map
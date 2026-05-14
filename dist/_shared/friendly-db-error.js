/**
 * Translate raw pyodbc / MSSQL / network error strings into operator-
 * friendly text. Faithful port of `friendly_db_error()` (legacy Python
 * helper used throughout apps/bank_reconcile/api/routes.py) — same
 * patterns the FE's api-shim friendlyError handles, but applied
 * server-side so raw stack strings never leave the API in the first
 * place.
 *
 * Idempotent: if no pattern matches, the original message comes back
 * unchanged. Always returns a non-empty string.
 */
const PATTERNS = [
    {
        test: /4060|cannot open database/i,
        msg: 'Opera database is currently unavailable — it may be locked by a backup or another process. Please try again in a few minutes.',
    },
    {
        test: /18456|login failed/i,
        msg: 'Cannot connect to Opera — database login failed. Please check the connection settings.',
    },
    {
        test: /(timeout).*(connection|login)|(connection|login).*timeout/i,
        msg: 'Connection to the Opera database timed out. Please try again shortly.',
    },
    {
        test: /(network|unreachable|tcp provider|server is not found)/i,
        msg: 'Cannot reach the Opera database server. Please check the network connection.',
    },
    {
        test: /(deadlock|1205)/i,
        msg: 'The operation was temporarily blocked by another user. Please try again.',
    },
    {
        test: /(lock request time out|lock timeout)/i,
        msg: 'Opera is busy — another user or process is updating the same data. Please wait and try again.',
    },
    {
        test: /(connection reset|broken pipe)/i,
        msg: 'The database connection was interrupted. Please try again.',
    },
];
export function friendlyDbError(raw) {
    if (raw === null || raw === undefined)
        return 'An unexpected error occurred.';
    const msg = (raw instanceof Error ? raw.message : String(raw)).trim();
    if (!msg)
        return 'An unexpected error occurred.';
    for (const p of PATTERNS) {
        if (p.test.test(msg))
            return p.msg;
    }
    // Recursive trim for "database connection failed: <inner>" style
    // messages — try the inner clause for a pattern hit.
    if (/database connection failed|query execution failed/i.test(msg) && msg.includes(': ')) {
        const inner = msg.split(': ').slice(1).join(': ').trim();
        if (inner && inner !== msg) {
            const innerFriendly = friendlyDbError(inner);
            if (innerFriendly !== inner)
                return innerFriendly;
        }
    }
    return msg;
}
//# sourceMappingURL=friendly-db-error.js.map
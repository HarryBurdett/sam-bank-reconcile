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
export declare function friendlyDbError(raw: unknown): string;
//# sourceMappingURL=friendly-db-error.d.ts.map
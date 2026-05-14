/**
 * SQL Server deadlock retry helper.
 *
 * Faithful port of `execute_with_deadlock_retry` + `is_deadlock_error`
 * (sql_rag/opera_sql_import.py:260-316). Wraps Knex.transaction with
 * automatic retry on SQL Server 1205 / SQLSTATE 40001 / "deadlock"
 * errors. Exponential backoff: 100ms, 500ms, 1500ms (3 retries
 * total + initial attempt = 4 calls max).
 *
 * Behaviour:
 *   - Non-deadlock errors propagate immediately (no retry).
 *   - On deadlock, the entire transaction is restarted from scratch
 *     — Knex rolls back automatically when the trx callback throws.
 *   - Logs each retry so operators can see the deadlock in the
 *     server log.
 */
import type { Knex } from 'knex';
export declare function isDeadlockError(err: unknown): boolean;
interface DeadlockRetryLogger {
    warn?(msg: string): void;
    error?(msg: string): void;
}
/**
 * Run `op` inside a Knex transaction with automatic deadlock retry.
 * `op` receives the trx and should perform ALL its writes through
 * it; throwing rolls back, returning resolves the transaction.
 *
 * The `operationName` shows up in deadlock log messages so the
 * operator can correlate retries with the underlying activity.
 */
export declare function executeWithDeadlockRetry<T>(operaDb: Knex, op: (trx: Knex.Transaction) => Promise<T>, operationName?: string, logger?: DeadlockRetryLogger): Promise<T>;
export {};
//# sourceMappingURL=deadlock-retry.d.ts.map
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

const DEADLOCK_MAX_RETRIES = 3;
const DEADLOCK_BACKOFF_MS = [100, 500, 1500] as const;

export function isDeadlockError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (!msg) return false;
  return (
    msg.includes('1205') ||
    msg.includes('40001') ||
    msg.includes('deadlock')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

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
export async function executeWithDeadlockRetry<T>(
  operaDb: Knex,
  op: (trx: Knex.Transaction) => Promise<T>,
  operationName: string = 'opera-write',
  logger?: DeadlockRetryLogger,
): Promise<T> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= DEADLOCK_MAX_RETRIES; attempt++) {
    try {
      return await operaDb.transaction((trx) => op(trx));
    } catch (err) {
      if (!isDeadlockError(err) || attempt >= DEADLOCK_MAX_RETRIES) {
        if (isDeadlockError(err)) {
          logger?.error?.(
            `[deadlock-retry] exhausted for ${operationName} after ` +
              `${DEADLOCK_MAX_RETRIES + 1} attempts: ${
                err instanceof Error ? err.message : String(err)
              }`,
          );
        }
        throw err;
      }
      const delay = DEADLOCK_BACKOFF_MS[attempt]!;
      logger?.warn?.(
        `[deadlock-retry] ${operationName} attempt ${attempt + 1}/${DEADLOCK_MAX_RETRIES + 1} ` +
          `hit deadlock — retrying in ${delay}ms: ${
            err instanceof Error ? err.message : String(err)
          }`,
      );
      lastErr = err;
      await sleep(delay);
    }
  }
  // Safety net — unreachable in practice (the for-loop exits via
  // return or throw on the final iteration).
  throw lastErr ?? new Error(`Deadlock retry exhausted for ${operationName}`);
}

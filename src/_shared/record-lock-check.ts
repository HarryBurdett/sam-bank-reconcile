/**
 * Pre-check whether a master-file record (sname/pname/etc.) is locked
 * by another Opera user before opening a multi-table import
 * transaction. Faithful port of `check_record_locked`
 * (sql_rag/opera_sql_import.py:cf9cbde commit).
 *
 * Strategy: try an UPDLOCK + ROWLOCK + NOWAIT against the target row
 * with a 500ms lock timeout. If it returns immediately, the row is
 * free — release the trivial trx and proceed. If the lock times out
 * or hits SQL error 1222 / 'NOWAIT' / 'timeout', the record IS held
 * by another user — return true so the caller can surface a clean
 * "locked — try again in a moment" error instead of opening a
 * cross-table transaction that would block mid-write.
 *
 * Idempotent. Read-only — never modifies the target.
 */
import type { Knex } from 'knex';

interface RecordLockOptions {
  table: 'sname' | 'pname';
  keyColumn: 'sn_account' | 'pn_account';
  keyValue: string;
}

export async function isRecordLocked(
  operaDb: Knex,
  opts: RecordLockOptions,
): Promise<boolean> {
  const { table, keyColumn, keyValue } = opts;
  if (!keyValue) return false;
  try {
    await operaDb.transaction(async (trx) => {
      await trx.raw(`SET LOCK_TIMEOUT 500`);
      await trx.raw(
        `SELECT 1 FROM ${table} WITH (UPDLOCK, ROWLOCK, NOWAIT)
         WHERE RTRIM(${keyColumn}) = ?`,
        [keyValue],
      );
      // Trivial rollback — we just wanted to probe the lock.
      throw new Error('__record_lock_probe_done__');
    });
    return false;
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    // The probe-done marker means the row was free.
    if (msg.includes('__record_lock_probe_done__')) return false;
    if (
      msg.includes('lock') ||
      msg.includes('1222') ||
      msg.includes('timeout') ||
      msg.includes('nowait')
    ) {
      return true;
    }
    // Unknown error — treat as "not locked" so the actual posting
    // surfaces the real error. Matches legacy permissive fallback.
    return false;
  }
}

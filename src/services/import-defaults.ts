/**
 * Default adapters for bank-reconcile import flows.
 *
 * These let the route layer run end-to-end without explicit SAM
 * wiring; the SAM team can override any of them via the runtime
 * context object.
 *
 *   - inMemoryImportLock        → bank-level lock (5-minute stale TTL)
 *   - bankStatementImportsOverlapChecker → reads the bank_statement_imports
 *                                  audit table for period overlaps
 */
import type { Knex } from 'knex';
import type {
  ImportLockAdapter,
  PeriodOverlapChecker,
} from './import-from-pdf.js';

const STALE_LOCK_MS = 5 * 60 * 1000;
const locks = new Map<string, { locker: string; acquiredAt: number }>();

export const inMemoryImportLock: ImportLockAdapter = {
  async acquire(key, locker) {
    const existing = locks.get(key);
    if (existing && Date.now() - existing.acquiredAt < STALE_LOCK_MS) {
      return false;
    }
    locks.set(key, { locker, acquiredAt: Date.now() });
    return true;
  },
  async release(key) {
    locks.delete(key);
  },
};

export function makeBankStatementOverlapChecker(
  appDb: Knex,
): PeriodOverlapChecker {
  return {
    async checkOverlap({
      bankCode,
      periodStart,
      periodEnd,
      filename,
      resumeImportId,
      skipOverlapCheck,
    }) {
      if (skipOverlapCheck || !periodStart || !periodEnd) {
        return { resumeImportId };
      }
      try {
        // The SAM SQLite schema has no `import_status` column — row
        // existence implies "imported". Earlier filter `.andWhereNot
        // ({ import_status: 'failed' })` always errored and the catch
        // swallowed the result, silently disabling overlap detection.
        const row = (await appDb('bank_statement_imports')
          .where('bank_code', bankCode)
          .andWhere(function overlap(this: Knex.QueryBuilder) {
            // Two ranges overlap iff start <= other_end AND end >= other_start
            this.where('period_start', '<=', periodEnd).andWhere(
              'period_end',
              '>=',
              periodStart,
            );
          })
          .orderBy('imported_at', 'desc')
          .first()) as
          | {
              id?: number;
              filename?: string | null;
              period_start?: string;
              period_end?: string;
            }
          | undefined;
        if (!row) return { resumeImportId };

        // Same-filename re-import is a continuation, not a conflict
        // — operator went back to add missed lines. Faithful port of
        // import_orchestration.py:105-109. Returns the existing
        // import_id so the orchestrator's resume path kicks in.
        if ((row.filename ?? '').trim() === (filename ?? '').trim() && row.id) {
          return { resumeImportId: Number(row.id) };
        }
        return {
          overlapError: {
            success: false,
            error:
              `Statement period ${periodStart}–${periodEnd} overlaps with ` +
              `previously imported statement (id=${row.id ?? 'n/a'}, ` +
              `${row.filename ?? 'unknown'}, ${row.period_start ?? '?'}–${row.period_end ?? '?'}). ` +
              `Pass skip_overlap_check=true if intentional.`,
          },
          resumeImportId,
        };
      } catch {
        return { resumeImportId };
      }
    },
  };
}

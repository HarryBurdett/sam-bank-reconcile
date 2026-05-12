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
      void filename;
      if (skipOverlapCheck || !periodStart || !periodEnd) {
        return { resumeImportId };
      }
      try {
        const row = (await appDb('bank_statement_imports')
          .where('bank_code', bankCode)
          .andWhereNot({ import_status: 'failed' })
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
              import_status?: string;
            }
          | undefined;
        if (!row) return { resumeImportId };
        if (row.import_status === 'partial' && row.id) {
          // Resume the prior partial import instead of erroring.
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

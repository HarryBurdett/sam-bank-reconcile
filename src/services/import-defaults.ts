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
import { companyScope } from '../_shared/get-company.js';

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
  companyCode: string,
): PeriodOverlapChecker {
  const scope = companyScope(companyCode);
  return {
    async checkOverlap({
      bankCode,
      periodStart,
      periodEnd,
      transactionDates,
      filename,
      resumeImportId,
      skipOverlapCheck,
    }) {
      if (skipOverlapCheck) {
        return { resumeImportId };
      }
      // Fall back to txn min/max dates when the statement has no
      // explicit period_start / period_end. Some banks only print
      // statement_date (not period range); without this fallback the
      // overlap check would short-circuit entirely and operators
      // could re-import the same statement under a renamed filename
      // with no warning. Faithful port of import_orchestration.py:
      // 85-94. Audit 2026-05-14 HIGH.
      let effStart = periodStart;
      let effEnd = periodEnd;
      if ((!effStart || !effEnd) && transactionDates) {
        const valid = transactionDates
          .filter((d): d is string => typeof d === 'string' && d.length >= 10)
          .map((d) => d.slice(0, 10));
        if (valid.length > 0) {
          effStart = effStart ?? valid.reduce((a, b) => (a < b ? a : b));
          effEnd = effEnd ?? valid.reduce((a, b) => (a > b ? a : b));
        }
      }
      if (!effStart || !effEnd) {
        return { resumeImportId };
      }
      try {
        // The SAM SQLite schema has no `import_status` column — row
        // existence implies "imported". Earlier filter `.andWhereNot
        // ({ import_status: 'failed' })` always errored and the catch
        // swallowed the result, silently disabling overlap detection.
        // Exclude the current resume_import_id so a resume doesn't
        // re-trigger overlap against itself. Audit 2026-05-14 HIGH.
        const query = appDb('bank_statement_imports')
          .where(scope)
          .andWhere('bank_code', bankCode)
          .andWhere(function overlap(this: Knex.QueryBuilder) {
            // Two ranges overlap iff start <= other_end AND end >= other_start
            this.where('period_start', '<=', effEnd).andWhere(
              'period_end',
              '>=',
              effStart,
            );
          });
        if (resumeImportId != null) {
          query.andWhereNot('id', Number(resumeImportId));
        }
        const row = (await query
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
              `Statement period ${effStart}–${effEnd} overlaps with ` +
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

const STALE_LOCK_MS = 5 * 60 * 1000;
const locks = new Map();
export const inMemoryImportLock = {
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
export function makeBankStatementOverlapChecker(appDb) {
    return {
        async checkOverlap({ bankCode, periodStart, periodEnd, transactionDates, filename, resumeImportId, skipOverlapCheck, }) {
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
                    .filter((d) => typeof d === 'string' && d.length >= 10)
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
                    .where('bank_code', bankCode)
                    .andWhere(function overlap() {
                    // Two ranges overlap iff start <= other_end AND end >= other_start
                    this.where('period_start', '<=', effEnd).andWhere('period_end', '>=', effStart);
                });
                if (resumeImportId != null) {
                    query.andWhereNot('id', Number(resumeImportId));
                }
                const row = (await query
                    .orderBy('imported_at', 'desc')
                    .first());
                if (!row)
                    return { resumeImportId };
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
                        error: `Statement period ${effStart}–${effEnd} overlaps with ` +
                            `previously imported statement (id=${row.id ?? 'n/a'}, ` +
                            `${row.filename ?? 'unknown'}, ${row.period_start ?? '?'}–${row.period_end ?? '?'}). ` +
                            `Pass skip_overlap_check=true if intentional.`,
                    },
                    resumeImportId,
                };
            }
            catch {
                return { resumeImportId };
            }
        },
    };
}
//# sourceMappingURL=import-defaults.js.map
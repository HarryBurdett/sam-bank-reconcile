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
        async checkOverlap({ bankCode, periodStart, periodEnd, filename, resumeImportId, skipOverlapCheck, }) {
            if (skipOverlapCheck || !periodStart || !periodEnd) {
                return { resumeImportId };
            }
            try {
                const row = (await appDb('bank_statement_imports')
                    .where('bank_code', bankCode)
                    .andWhereNot({ import_status: 'failed' })
                    .andWhere(function overlap() {
                    // Two ranges overlap iff start <= other_end AND end >= other_start
                    this.where('period_start', '<=', periodEnd).andWhere('period_end', '>=', periodStart);
                })
                    .orderBy('imported_at', 'desc')
                    .first());
                if (!row)
                    return { resumeImportId };
                // Same-filename re-import is a continuation, not a conflict
                // — operator went back to add missed lines. Faithful port of
                // import_orchestration.py:105-109. Returns the existing
                // import_id so the orchestrator's resume path kicks in
                // regardless of import_status.
                if ((row.filename ?? '').trim() === (filename ?? '').trim() && row.id) {
                    return { resumeImportId: Number(row.id) };
                }
                if (row.import_status === 'partial' && row.id) {
                    // Resume the prior partial import instead of erroring.
                    return { resumeImportId: Number(row.id) };
                }
                return {
                    overlapError: {
                        success: false,
                        error: `Statement period ${periodStart}–${periodEnd} overlaps with ` +
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
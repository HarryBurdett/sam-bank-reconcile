function dateToYmd(d) {
    if (!d)
        return '';
    if (d instanceof Date) {
        if (Number.isNaN(d.getTime()))
            return '';
        return d.toISOString().slice(0, 10);
    }
    return String(d).slice(0, 10);
}
function dateToIso(d) {
    if (!d)
        return '';
    if (d instanceof Date) {
        if (Number.isNaN(d.getTime()))
            return '';
        return d.toISOString();
    }
    return String(d);
}
export async function markStatementReconciled(appDb, input) {
    try {
        const filters = { filename: input.filename };
        if (input.bankCode)
            filters.bank_code = input.bankCode;
        const updated = await appDb('bank_statement_imports')
            .where(filters)
            .update({
            is_reconciled: true,
            reconciled_count: input.reconciledCount ?? 0,
            reconciled_at: appDb.fn.now(),
        });
        if (updated > 0) {
            return {
                success: true,
                message: `Statement '${input.filename}' marked as reconciled`,
            };
        }
        return {
            success: false,
            message: 'No matching import record found',
        };
    }
    catch (err) {
        return {
            success: false,
            message: '',
            error: err?.message ?? String(err),
        };
    }
}
/**
 * List imported bank statements.
 *
 * NB: in the Python implementation this also cross-checks against
 * Opera nbank.nk_recbal + period-reconciliation logic to filter out
 * already-reconciled statements. That cross-check is queued for a
 * future session — the per-app DB read works in isolation now.
 */
export async function listImportedStatements(appDb, opts = {}) {
    try {
        const limit = opts.limit ?? 200;
        const targetSystem = opts.targetSystem ?? 'opera_se';
        let query = appDb('bank_statement_imports')
            .where({ target_system: targetSystem })
            .orderBy('imported_at', 'desc')
            .limit(limit);
        if (opts.bankCode) {
            query = query.andWhere({ bank_code: opts.bankCode });
        }
        if (!opts.includeReconciled) {
            query = query.andWhere(function () {
                this.where('is_reconciled', false).orWhereNull('is_reconciled');
            });
        }
        const rows = (await query);
        const statements = rows.map((r) => ({
            id: r.id,
            bank_code: r.bank_code,
            filename: r.filename ?? '',
            statement_date: dateToYmd(r.statement_date),
            opening_balance: Number(r.opening_balance ?? 0),
            closing_balance: Number(r.closing_balance ?? 0),
            source: r.source ?? '',
            source_ref: r.source_ref ?? '',
            is_reconciled: Boolean(r.is_reconciled),
            reconciled_count: Number(r.reconciled_count ?? 0),
            target_system: r.target_system ?? 'opera_se',
            imported_by: r.imported_by ?? '',
            imported_at: dateToIso(r.imported_at),
            reconciled_at: r.reconciled_at ? dateToIso(r.reconciled_at) : null,
        }));
        return { success: true, statements, count: statements.length };
    }
    catch (err) {
        return {
            success: false,
            statements: [],
            count: 0,
            error: err?.message ?? String(err),
        };
    }
}
//# sourceMappingURL=statement-files.js.map
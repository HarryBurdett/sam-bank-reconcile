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
function toBool(v) {
    if (typeof v === 'boolean')
        return v;
    if (typeof v === 'number')
        return v !== 0;
    if (typeof v === 'string')
        return v === '1' || v.toLowerCase() === 'true';
    return false;
}
function rowToImport(r) {
    return {
        id: Number(r.id),
        bank_code: r.bank_code ?? '',
        filename: r.filename ?? null,
        statement_date: r.statement_date ? dateToIso(r.statement_date) : null,
        opening_balance: r.opening_balance === null || r.opening_balance === undefined
            ? null
            : Number(r.opening_balance),
        closing_balance: r.closing_balance === null || r.closing_balance === undefined
            ? null
            : Number(r.closing_balance),
        source: r.source ?? null,
        source_ref: r.source_ref ?? null,
        imported_by: r.imported_by ?? null,
        imported_at: dateToIso(r.imported_at),
        is_reconciled: toBool(r.is_reconciled),
        reconciled_count: Number(r.reconciled_count ?? 0),
        reconciled_at: r.reconciled_at ? dateToIso(r.reconciled_at) : null,
        target_system: r.target_system ?? 'opera_se',
        transactions_imported: Number(r.transactions_imported ?? 0),
        total_receipts: Number(r.total_receipts ?? 0),
        total_payments: Number(r.total_payments ?? 0),
        account_number: r.account_number ?? null,
        sort_code: r.sort_code ?? null,
        period_start: r.period_start ? dateToIso(r.period_start) : null,
        period_end: r.period_end ? dateToIso(r.period_end) : null,
        reconciled_by: r.reconciled_by ?? null,
    };
}
export async function listImportHistory(appDb, opts = {}) {
    try {
        const target = opts.targetSystem ?? 'opera_se';
        let query = appDb('bank_statement_imports')
            .where({ target_system: target })
            .orderBy('imported_at', 'desc')
            .limit(opts.limit ?? 50);
        if (opts.bankCode) {
            query = query.where({ bank_code: opts.bankCode });
        }
        if (opts.fromDate) {
            query = query.where('statement_date', '>=', opts.fromDate);
        }
        if (opts.toDate) {
            query = query.where('statement_date', '<=', opts.toDate);
        }
        const rows = (await query);
        const imports = rows.map(rowToImport);
        return { success: true, imports, count: imports.length };
    }
    catch (err) {
        return {
            success: false,
            imports: [],
            count: 0,
            error: err?.message ?? String(err),
        };
    }
}
export async function deleteImportRecord(appDb, recordId) {
    if (!Number.isFinite(recordId) || recordId <= 0) {
        return { success: false, error: 'Invalid record_id' };
    }
    try {
        const deleted = await appDb('bank_statement_imports')
            .where({ id: recordId })
            .delete();
        if (Number(deleted) === 0) {
            return { success: false, error: `Record ${recordId} not found` };
        }
        return {
            success: true,
            message: 'Import record deleted - statement can now be re-imported',
        };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
export async function clearImportHistory(appDb, opts = {}) {
    try {
        let query = appDb('bank_statement_imports');
        if (opts.bankCode)
            query = query.where({ bank_code: opts.bankCode });
        if (opts.fromDate)
            query = query.where('statement_date', '>=', opts.fromDate);
        if (opts.toDate)
            query = query.where('statement_date', '<=', opts.toDate);
        const deleted = await query.delete();
        const count = Number(deleted);
        return {
            success: true,
            deleted_count: count,
            message: `Cleared ${count} import history records`,
        };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
//# sourceMappingURL=import-history.js.map
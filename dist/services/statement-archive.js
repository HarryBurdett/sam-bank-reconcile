export async function archiveStatement(appDb, importId, by) {
    if (!Number.isFinite(importId) || importId <= 0) {
        return { success: false, error: 'invalid import_id' };
    }
    try {
        const updated = await appDb('bank_statement_imports')
            .where({ id: importId })
            .update({
            import_status: 'archived',
            archived_at: appDb.fn.now(),
            archived_by: by,
        });
        if (!updated)
            return { success: false, error: 'Import row not found' };
        return { success: true };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
export async function listArchivedStatements(appDb, bankCode, limit = 200) {
    try {
        let q = appDb('bank_statement_imports')
            .where({ import_status: 'archived' })
            .orderBy('archived_at', 'desc')
            .limit(limit);
        if (bankCode)
            q = q.andWhere('bank_code', bankCode);
        const rows = (await q);
        const items = rows.map((r) => ({
            id: Number(r.id),
            bank_code: r.bank_code,
            filename: (r.source_ref ?? '').split(/[/\\]/).pop() ?? '',
            source: r.source ?? '',
            source_ref: r.source_ref ?? '',
            opening_balance: r.opening_balance,
            closing_balance: r.closing_balance,
            imported_at: r.imported_at instanceof Date
                ? r.imported_at.toISOString()
                : String(r.imported_at ?? ''),
            import_status: r.import_status ?? '',
            archived_at: r.archived_at instanceof Date
                ? r.archived_at.toISOString()
                : r.archived_at
                    ? String(r.archived_at)
                    : null,
        }));
        return { success: true, statements: items, count: items.length };
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
export async function restoreStatement(appDb, importId) {
    try {
        const updated = await appDb('bank_statement_imports')
            .where({ id: importId, import_status: 'archived' })
            .update({
            import_status: 'imported',
            archived_at: null,
        });
        if (!updated) {
            return { success: false, error: 'Archived statement not found' };
        }
        return { success: true };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
export async function getArchivedStatementPdf(appDb, storage, recordId) {
    if (!storage) {
        return {
            success: false,
            error: 'ctx.fileStorage adapter not configured.',
        };
    }
    try {
        const row = (await appDb('bank_statement_imports')
            .where({ id: recordId })
            .first());
        if (!row)
            return { success: false, error: 'Statement not found' };
        // Storage adapter is filesystem-bound; we surface the path for
        // the SAM team to fetch via Graph or local FS.
        return {
            success: true,
            filename: row.source_ref ?? '',
        };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
export async function deleteArchivedStatement(appDb, recordId) {
    try {
        const deleted = await appDb('bank_statement_imports')
            .where({ id: recordId, import_status: 'archived' })
            .delete();
        if (!deleted)
            return { success: false, error: 'Archived statement not found' };
        return { success: true };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
export async function manageStatements(appDb, bankCode, includeArchived) {
    try {
        let q = appDb('bank_statement_imports').orderBy('imported_at', 'desc');
        if (bankCode)
            q = q.where('bank_code', bankCode);
        if (!includeArchived)
            q = q.whereNot('import_status', 'archived');
        const rows = (await q);
        const items = rows.map((r) => ({
            id: Number(r.id),
            bank_code: r.bank_code,
            filename: (r.source_ref ?? '').split(/[/\\]/).pop() ?? '',
            source: r.source ?? '',
            imported_at: r.imported_at instanceof Date
                ? r.imported_at.toISOString()
                : String(r.imported_at ?? ''),
            import_status: r.import_status ?? '',
            opening_balance: r.opening_balance,
            closing_balance: r.closing_balance,
            records_imported: Number(r.records_imported ?? 0),
        }));
        return { success: true, statements: items, count: items.length };
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
//# sourceMappingURL=statement-archive.js.map
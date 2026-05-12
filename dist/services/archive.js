export const SUPPORTED_IMPORT_TYPES = [
    'bank-statement',
    'gocardless',
    'invoice',
];
function mapLogRow(row) {
    let metadata = {};
    try {
        if (row.metadata)
            metadata = JSON.parse(row.metadata);
    }
    catch {
        // ignore malformed
    }
    const archivedAt = row.archived_at instanceof Date
        ? row.archived_at.toISOString()
        : String(row.archived_at);
    const restoredAt = row.restored_at
        ? row.restored_at instanceof Date
            ? row.restored_at.toISOString()
            : String(row.restored_at)
        : null;
    return {
        id: Number(row.id),
        archived_at: archivedAt,
        original_path: row.original_path,
        archive_path: row.archive_path,
        import_type: row.import_type,
        filename: row.filename,
        metadata,
        restored_at: restoredAt,
        restored_to: row.restored_to,
    };
}
export async function archiveFile(appDb, storage, input) {
    if (!input.filePath)
        return { success: false, error: 'file_path is required' };
    if (!SUPPORTED_IMPORT_TYPES.includes(input.importType)) {
        return {
            success: false,
            error: `Unsupported import_type: ${input.importType}`,
        };
    }
    let archivePath;
    try {
        const r = await storage.archive({
            sourcePath: input.filePath,
            importType: input.importType,
        });
        archivePath = r.archivePath;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Archive failed: ${msg}` };
    }
    const filename = input.filePath.split(/[/\\]/).pop() ?? input.filePath;
    const metadata = {
        transactions_extracted: input.transactionsExtracted ?? null,
        transactions_matched: input.transactionsMatched ?? null,
        transactions_reconciled: input.transactionsReconciled ?? null,
    };
    try {
        await appDb('file_archive_log').insert({
            archived_at: appDb.fn.now(),
            original_path: input.filePath,
            archive_path: archivePath,
            import_type: input.importType,
            filename,
            metadata: JSON.stringify(metadata),
        });
    }
    catch {
        // log-write failure is non-fatal
    }
    return {
        success: true,
        message: `Archived to ${archivePath}`,
        archive_path: archivePath,
        original_path: input.filePath,
    };
}
export async function getArchiveHistory(appDb, importType, limit = 50) {
    try {
        let q = appDb('file_archive_log')
            .orderBy('archived_at', 'desc')
            .limit(limit);
        if (importType)
            q = q.where({ import_type: importType });
        const rows = (await q);
        return {
            success: true,
            history: rows.map(mapLogRow),
            count: rows.length,
        };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
export async function restoreArchivedFile(appDb, storage, archivePath) {
    if (!archivePath) {
        return { success: false, error: 'archive_path is required' };
    }
    const row = (await appDb('file_archive_log')
        .where({ archive_path: archivePath })
        .orderBy('archived_at', 'desc')
        .first());
    if (!row) {
        return {
            success: false,
            error: `No archive log entry found for path '${archivePath}'`,
        };
    }
    try {
        const result = await storage.restore({
            archivePath,
            originalPath: row.original_path,
        });
        await appDb('file_archive_log').where({ id: row.id }).update({
            restored_at: appDb.fn.now(),
            restored_to: result.restoredPath,
        });
        return {
            success: true,
            message: `Restored to ${result.restoredPath}`,
            restored_path: result.restoredPath,
            original_path: row.original_path,
        };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
export async function getPendingFiles(storage, importType) {
    if (!SUPPORTED_IMPORT_TYPES.includes(importType)) {
        return {
            success: false,
            error: `Unsupported import_type: ${importType}`,
            files: [],
        };
    }
    try {
        const files = await storage.listPending(importType);
        return { success: true, files, count: files.length };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err), files: [] };
    }
}
//# sourceMappingURL=archive.js.map
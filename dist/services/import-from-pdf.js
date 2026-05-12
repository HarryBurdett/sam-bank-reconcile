import { validateBankCode, SqlInputValidationError, } from '../_shared/index.js';
async function bankExists(operaDb, bankCode) {
    try {
        const row = (await operaDb('nbank')
            .whereRaw('RTRIM(nk_acnt) = ?', [bankCode])
            .select('nk_acnt')
            .first());
        return !!row;
    }
    catch {
        return false;
    }
}
export async function importBankStatementFromPdf(operaDb, appDb, input, extractor, executor, importLock, overlapChecker) {
    let bankCode;
    try {
        bankCode = validateBankCode(input.bankCode);
    }
    catch (e) {
        if (e instanceof SqlInputValidationError) {
            return { success: false, error: e.message };
        }
        return { success: false, error: e?.message ?? String(e) };
    }
    if (!input.filePath || !input.filePath.trim()) {
        return { success: false, error: 'file_path is required' };
    }
    if (!(await bankExists(operaDb, bankCode))) {
        return {
            success: false,
            error: `Bank account '${bankCode}' not found in Opera.`,
        };
    }
    let extracted;
    try {
        extracted = await extractor.extractFromPdf({
            filePath: input.filePath,
            filename: input.filename,
        });
    }
    catch (e) {
        return {
            success: false,
            error: `PDF extraction failed: ${e?.message ?? String(e)}`,
        };
    }
    if (!extracted || !extracted.transactions) {
        return {
            success: false,
            error: 'Failed to extract statement information from PDF',
        };
    }
    const overlap = await overlapChecker.checkOverlap({
        bankCode,
        periodStart: extracted.period_start,
        periodEnd: extracted.period_end,
        filename: input.filename ?? input.filePath.split('/').pop() ?? '',
        resumeImportId: input.resumeImportId ?? null,
        skipOverlapCheck: !!input.skipOverlapCheck,
    });
    if (overlap.overlapError) {
        return {
            ...overlap.overlapError,
            resume_import_id: overlap.resumeImportId,
        };
    }
    const lockKey = `bank-import:${bankCode}`;
    const acquired = await importLock.acquire(lockKey, 'import-from-pdf');
    if (!acquired) {
        return {
            success: false,
            error: `Bank account ${bankCode} is currently being imported by another user. Please wait for the current import to complete.`,
        };
    }
    try {
        const result = await executor.postBankImport({
            operaDb,
            bankCode,
            statementInfo: extracted,
            transactions: extracted.transactions,
            overrides: input.overrides ?? [],
            selectedRows: input.selectedRows ?? null,
            autoAllocate: !!input.autoAllocate,
            autoReconcile: !!input.autoReconcile,
        });
        if (result.success) {
            try {
                const [insertedId] = (await appDb('bank_statement_imports')
                    .insert({
                    bank_code: bankCode,
                    source: 'file',
                    source_ref: input.filename ?? input.filePath,
                    opening_balance: extracted.opening_balance,
                    closing_balance: extracted.closing_balance,
                    imported_at: appDb.fn.now(),
                    import_status: 'imported',
                    records_imported: result.records_imported,
                    filename: input.filename ?? null,
                })
                    .returning('id'));
                const importId = typeof insertedId === 'number'
                    ? insertedId
                    : insertedId?.id;
                // Per-line tracking — write one row per posted statement
                // line so subsequent Opera-restore detection can verify the
                // posting still exists. New in SAM port (legacy had this
                // table but the SAM port omitted it until 2026-05; see
                // bank_statement_transactions migration 013).
                if (importId && Array.isArray(result.posted_lines) && result.posted_lines.length > 0) {
                    const rows = result.posted_lines.map((line) => ({
                        import_id: importId,
                        line_number: line.line_number,
                        post_date: line.post_date,
                        description: line.description,
                        amount: line.amount,
                        transaction_type: String(line.at_type),
                        posted_entry_number: line.posted_entry_number,
                        posted_at: appDb.fn.now(),
                        is_reconciled: 0,
                    }));
                    await appDb('bank_statement_transactions').insert(rows);
                }
            }
            catch (writeErr) {
                // History write failure is non-fatal at the import level —
                // log so it's visible, then proceed. (Legacy did the same.)
                // eslint-disable-next-line no-console
                console.warn(`[bank-reconcile] persist post-import tracking failed: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
            }
            return {
                success: true,
                message: `Imported ${result.records_imported} transactions`,
                records_imported: result.records_imported,
                records_failed: result.records_failed,
                skipped_count: result.skipped_count,
                warnings: result.warnings,
                import_id: result.import_id ?? null,
                resume_import_id: overlap.resumeImportId,
            };
        }
        return {
            success: false,
            error: result.errors.join('; ') || 'Import failed',
            errors: result.errors,
            warnings: result.warnings,
            resume_import_id: overlap.resumeImportId,
        };
    }
    finally {
        try {
            await importLock.release(lockKey);
        }
        catch {
            // best-effort
        }
    }
}
//# sourceMappingURL=import-from-pdf.js.map
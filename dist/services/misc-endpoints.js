export async function listCsvFiles(storage) {
    if (!storage) {
        return { success: false, files: [], error: 'fileStorage not configured' };
    }
    try {
        const files = await storage.listPending('bank-statement');
        return {
            success: true,
            files: files.filter((f) => f.filename.toLowerCase().endsWith('.csv')),
        };
    }
    catch (err) {
        return { success: false, files: [], error: err?.message ?? String(err) };
    }
}
export async function listPdfFiles(storage) {
    if (!storage) {
        return { success: false, files: [], error: 'fileStorage not configured' };
    }
    try {
        const files = await storage.listPending('bank-statement');
        return {
            success: true,
            files: files.filter((f) => f.filename.toLowerCase().endsWith('.pdf')),
        };
    }
    catch (err) {
        return { success: false, files: [], error: err?.message ?? String(err) };
    }
}
export async function getPdfContent(reader, filePath) {
    if (!reader) {
        return {
            success: false,
            error: 'ctx.pdfContentReader not configured. SAM team must wire a PDF reader adapter.',
        };
    }
    try {
        const bytes = await reader.readBytes({ path: filePath });
        if (!bytes)
            return { success: false, error: 'PDF not found' };
        return { success: true, bytes, size: bytes.byteLength };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
// ---------------------------------------------------------------------
// Scan folder / emails / all-banks
// ---------------------------------------------------------------------
export async function scanFolder(storage) {
    if (!storage) {
        return {
            success: false,
            files: [],
            count: 0,
            error: 'fileStorage not configured',
        };
    }
    try {
        const files = await storage.listPending('bank-statement');
        return { success: true, files, count: files.length };
    }
    catch (err) {
        return {
            success: false,
            files: [],
            count: 0,
            error: err?.message ?? String(err),
        };
    }
}
export async function fetchEmailsToFolder(attachments, storage, emails) {
    if (!attachments || !storage) {
        return {
            success: false,
            downloaded: 0,
            errors: ['email attachment provider or fileStorage not configured'],
        };
    }
    let downloaded = 0;
    const errors = [];
    for (const e of emails) {
        try {
            const att = await attachments.fetchAttachment({
                emailId: e.emailId,
                attachmentId: e.attachmentId,
            });
            if (att)
                downloaded += 1;
            else
                errors.push(`Email ${e.emailId}: attachment not found`);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`Email ${e.emailId}: ${msg}`);
        }
    }
    return { success: errors.length === 0, downloaded, errors };
}
export async function scanAllBanks(operaDb) {
    // Legacy response shape: each bank includes statements: [] (always an array)
    // plus reconciliation balances. The frontend iterates over bank.statements,
    // so omitting it causes a runtime crash in PendingStatementsTab.
    // See apps/bank_reconcile/api/routes.py:6688 for the canonical legacy shape.
    // Email scanning + extraction + balance validation are NOT ported in this
    // pass (they're the heavy AI/email-ingest flows deferred from the rewrite);
    // we return the bank list with empty statements arrays so the page renders.
    try {
        const rows = (await operaDb.raw(`SELECT RTRIM(nk_acnt) AS bank_code,
              RTRIM(nk_desc) AS description,
              RTRIM(ISNULL(nk_sort, '')) AS sort_code,
              RTRIM(ISNULL(nk_number, '')) AS account_number,
              ISNULL(nk_recbal, 0) / 100.0 AS reconciled_balance,
              ISNULL(nk_curbal, 0) / 100.0 AS current_balance
       FROM nbank WITH (NOLOCK)
       ORDER BY nk_acnt`));
        const banks = (rows ?? []).map((r) => ({
            ...r,
            type: null,
            statements: [],
            statement_count: 0,
        }));
        return { success: true, banks };
    }
    catch (err) {
        return { success: false, banks: [], error: err?.message ?? String(err) };
    }
}
// ---------------------------------------------------------------------
// Raw / multiformat preview (LLM-bound or text-parsing)
// ---------------------------------------------------------------------
export async function rawPreviewFromPdf(llm, pdfBytes, filePath) {
    if (!llm) {
        return { success: false, error: 'ctx.llm not configured' };
    }
    if (!pdfBytes && !filePath) {
        return { success: false, error: 'pdf bytes or file path required' };
    }
    try {
        const ref = filePath ?? `<pdf-bytes:${pdfBytes?.byteLength ?? 0}>`;
        const stream = llm.chat({
            messages: [
                {
                    role: 'user',
                    content: `Extract the raw text from this PDF without parsing or interpreting. Just the text content as it appears.\n\nPDF: ${ref}`,
                },
            ],
            model: 'claude-sonnet-4',
            maxTokens: 8000,
            temperature: 0,
        });
        const buf = [];
        for await (const chunk of stream) {
            if (typeof chunk === 'string')
                buf.push(chunk);
            else if (chunk && typeof chunk === 'object') {
                const c = chunk;
                if (typeof c.text === 'string')
                    buf.push(c.text);
                else if (c.delta?.text)
                    buf.push(c.delta.text);
            }
        }
        return { success: true, text: buf.join('').trim() };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
export async function previewMultiformat(parser, content, formatOverride) {
    if (!parser) {
        return {
            success: false,
            error: 'multiformat parser not configured',
        };
    }
    try {
        const format = formatOverride ?? parser.detectFormat(content);
        if (format === 'unknown') {
            return { success: false, error: 'Could not detect file format' };
        }
        const transactions = parser.parse(content, format);
        return { success: true, format, transactions };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
export async function validateCsv(parser, content) {
    if (!parser) {
        return {
            success: false,
            valid: false,
            error: 'multiformat parser not configured',
        };
    }
    try {
        const format = parser.detectFormat(content);
        if (format !== 'csv') {
            return { success: true, valid: false, format };
        }
        const rows = parser.parse(content, 'csv');
        return {
            success: true,
            valid: rows.length > 0,
            format,
            row_count: rows.length,
        };
    }
    catch (err) {
        return { success: false, valid: false, error: err?.message ?? String(err) };
    }
}
export async function getStatementReview(appDb, importId) {
    if (!Number.isFinite(importId) || importId <= 0) {
        return { success: false, error: 'invalid import_id' };
    }
    try {
        const row = (await appDb('bank_statement_imports')
            .where({ id: importId })
            .first());
        if (!row) {
            return { success: false, error: 'Import not found' };
        }
        return {
            success: true,
            review: {
                import_id: Number(row.id),
                bank_code: row.bank_code,
                filename: (row.source_ref ?? '').split(/[/\\]/).pop() ?? '',
                imported_at: row.imported_at instanceof Date
                    ? row.imported_at.toISOString()
                    : String(row.imported_at ?? ''),
                records_imported: Number(row.records_imported ?? 0),
                records_failed: Number(row.records_failed ?? 0),
                opening_balance: row.opening_balance,
                closing_balance: row.closing_balance,
                status: row.import_status ?? '',
            },
        };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
//# sourceMappingURL=misc-endpoints.js.map
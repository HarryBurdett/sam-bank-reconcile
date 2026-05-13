import { detectBankFromEmail, extractStatementNumberFromFilename, isBankStatementAttachment, compareSortKeys, } from './email-helpers.js';
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
/**
 * Resolve a `detectBankFromEmail` keyword (`barclays`, `tide`, …) and
 * any account-number digits scraped from the filename to a specific
 * row in nbank. Account-number match wins over name match because
 * a customer typically has multiple accounts at the same bank.
 */
function pickBank(banks, detectedBankName, filename, subject) {
    // 1. Account-number scan: extract any sequence of 6+ digits from
    //    filename/subject and prefer the exact match against nk_number.
    const digitGroups = `${filename} ${subject ?? ''}`.match(/\d{6,}/g) ?? [];
    if (digitGroups.length > 0) {
        for (const candidate of digitGroups) {
            const hit = banks.find((b) => b.account_number && b.account_number === candidate);
            if (hit)
                return hit;
            // Some statements pad to 10 digits, Opera may store unpadded:
            // also try comparing the last 8 digits.
            const tail8 = candidate.slice(-8);
            const hit2 = banks.find((b) => b.account_number &&
                b.account_number.replace(/\D+/g, '').endsWith(tail8));
            if (hit2)
                return hit2;
        }
    }
    // 2. Bank-name keyword match against description.
    if (detectedBankName) {
        const key = detectedBankName.toLowerCase();
        const hit = banks.find((b) => (b.description ?? '').toLowerCase().includes(key));
        if (hit)
            return hit;
    }
    return null;
}
/**
 * Already-imported lookup. Reads bank_statement_imports for any row
 * whose source_ref is the email-id or filename of the candidate, so
 * the Hub can grey out previously-processed entries instead of
 * re-presenting them.
 */
async function loadAlreadyProcessed(appDb) {
    const emailIds = new Set();
    const filenames = new Set();
    if (!appDb)
        return { emailIds, filenames };
    try {
        const rows = (await appDb('bank_statement_imports')
            .select('source', 'source_ref'));
        for (const r of rows) {
            const ref = (r.source_ref ?? '').trim();
            if (!ref)
                continue;
            if (r.source === 'email') {
                const n = Number(ref);
                if (Number.isFinite(n) && n > 0)
                    emailIds.add(n);
            }
            // Always also track the filename basename — covers both PDF
            // uploads and email-derived imports that recorded a filename.
            const base = ref.split(/[/\\]/).pop() ?? ref;
            if (base.length > 0)
                filenames.add(base);
        }
    }
    catch {
        // Tolerated — the table may be empty / not provisioned in tests.
    }
    return { emailIds, filenames };
}
export async function scanAllBanks(operaDb, mailbox = null, appDb = null, opts = {}) {
    const daysBack = Number.isFinite(opts.daysBack) ? Number(opts.daysBack) : 30;
    const pageSize = Number.isFinite(opts.pageSize) ? Number(opts.pageSize) : 200;
    // 1. Banks from Opera (always).
    let banks;
    try {
        const rows = (await operaDb.raw(`SELECT RTRIM(nk_acnt) AS bank_code,
              RTRIM(nk_desc) AS description,
              RTRIM(ISNULL(nk_sort, '')) AS sort_code,
              RTRIM(ISNULL(nk_number, '')) AS account_number,
              ISNULL(nk_recbal, 0) / 100.0 AS reconciled_balance,
              ISNULL(nk_curbal, 0) / 100.0 AS current_balance
       FROM nbank WITH (NOLOCK)
       ORDER BY nk_acnt`));
        banks = (rows ?? []).map((r) => ({
            ...r,
            type: null,
            statements: [],
            statement_count: 0,
        }));
    }
    catch (err) {
        return {
            success: false,
            banks: [],
            unidentified: [],
            total_statements: 0,
            total_banks_with_statements: 0,
            total_banks_loaded: 0,
            total_emails_scanned: 0,
            total_pdfs_found: 0,
            duplicates_archived: 0,
            error: err?.message ?? String(err),
        };
    }
    const unidentified = [];
    let totalEmailsScanned = 0;
    let totalPdfsFound = 0;
    // 2. Scan mailbox (when adapter is wired).
    if (mailbox) {
        const fromDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
        try {
            const { emails } = await mailbox.list({ fromDate, pageSize });
            totalEmailsScanned = emails.length;
            const { emailIds, filenames } = await loadAlreadyProcessed(appDb);
            for (const email of emails) {
                const attachments = email.attachments ?? [];
                if (attachments.length === 0)
                    continue;
                for (const att of attachments) {
                    if (!isBankStatementAttachment({
                        filename: att.filename ?? null,
                        contentType: att.content_type ?? null,
                        subject: email.subject ?? null,
                        fromAddress: email.from_address ?? null,
                    })) {
                        continue;
                    }
                    totalPdfsFound += 1;
                    const detectedBankName = detectBankFromEmail(email.from_address ?? null, att.filename ?? null, email.subject ?? null);
                    const matched = pickBank(banks, detectedBankName, att.filename ?? '', email.subject ?? null);
                    const dateInfo = extractStatementNumberFromFilename(att.filename ?? null, email.subject ?? null);
                    const receivedAt = email.received_at instanceof Date
                        ? email.received_at.toISOString()
                        : (email.received_at ?? null);
                    const entry = {
                        source: 'email',
                        email_id: typeof email.id === 'number' ? email.id : Number(email.id),
                        attachment_id: att.attachment_id,
                        filename: att.filename ?? 'attachment',
                        subject: email.subject ?? null,
                        from_address: email.from_address ?? null,
                        received_at: receivedAt,
                        detected_bank_name: detectedBankName,
                        matched_bank_code: matched?.bank_code ?? null,
                        matched_bank_description: matched?.description ?? null,
                        matched_sort_code: matched?.sort_code ?? null,
                        matched_account_number: matched?.account_number ?? null,
                        statement_date: dateInfo.display_date,
                        sort_key: dateInfo.sort_key,
                        already_processed: (typeof email.id === 'number' && emailIds.has(email.id)) ||
                            filenames.has(att.filename ?? ''),
                        status: 'ready',
                    };
                    if (matched)
                        matched.statements.push(entry);
                    else
                        unidentified.push(entry);
                }
            }
        }
        catch (err) {
            // Surface as soft error: the bank list and any folder/identified
            // candidates so far still go back to the caller.
            return {
                success: false,
                banks,
                unidentified,
                total_statements: 0,
                total_banks_with_statements: 0,
                total_banks_loaded: banks.length,
                total_emails_scanned: totalEmailsScanned,
                total_pdfs_found: totalPdfsFound,
                duplicates_archived: 0,
                error: `Mailbox scan failed: ${err?.message ?? String(err)}`,
            };
        }
    }
    // 3. Sort each bank's statements newest-first (by sort_key) and
    //    fill counts.
    let totalStatements = 0;
    let banksWithStatements = 0;
    for (const b of banks) {
        b.statements.sort((a, c) => compareSortKeys(c.sort_key, a.sort_key));
        b.statement_count = b.statements.length;
        totalStatements += b.statement_count;
        if (b.statement_count > 0)
            banksWithStatements += 1;
    }
    unidentified.sort((a, b) => compareSortKeys(b.sort_key, a.sort_key));
    totalStatements += unidentified.length;
    return {
        success: true,
        banks,
        unidentified,
        total_statements: totalStatements,
        total_banks_with_statements: banksWithStatements,
        total_banks_loaded: banks.length,
        total_emails_scanned: totalEmailsScanned,
        total_pdfs_found: totalPdfsFound,
        duplicates_archived: 0,
    };
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
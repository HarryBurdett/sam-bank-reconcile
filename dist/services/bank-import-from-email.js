import { importBankStatementFromPdf, } from './import-from-pdf.js';
export async function importBankStatementFromEmail(operaDb, appDb, attachments, pdfExtractor, executor, importLock, overlapChecker, input) {
    if (!Number.isFinite(input.emailId) || input.emailId <= 0) {
        return { success: false, error: 'email_id required' };
    }
    if (!input.attachmentId) {
        return { success: false, error: 'attachment_id required' };
    }
    let downloaded;
    try {
        downloaded = await attachments.fetchAttachment({
            emailId: input.emailId,
            attachmentId: input.attachmentId,
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Email download failed: ${msg}` };
    }
    if (!downloaded) {
        return { success: false, error: 'Attachment not found' };
    }
    // Pass the downloaded bytes through directly so the extractor
    // doesn't try to readFileSync the synthetic `email://N/X`
    // identifier (which fails with ENOENT). filePath is still set —
    // import-from-pdf threads it into the audit row and the
    // synthetic identifier is fine for that purpose (it's never
    // opened when bytes is present).
    const pdfInput = {
        filePath: `email://${input.emailId}/${input.attachmentId}`,
        bytes: downloaded.bytes,
        filename: downloaded.filename,
        bankCode: input.bankCode,
        autoAllocate: input.autoAllocate,
        autoReconcile: input.autoReconcile,
        resumeImportId: input.resumeImportId ?? null,
        overrides: input.overrides ?? [],
        selectedRows: input.selectedRows ?? null,
        dateOverrides: input.dateOverrides ?? [],
        rejectedRefundRows: input.rejectedRefundRows ?? [],
        skipOverlapCheck: !!input.skipOverlapCheck,
    };
    return importBankStatementFromPdf(operaDb, appDb, pdfInput, pdfExtractor, executor, importLock, overlapChecker);
}
//# sourceMappingURL=bank-import-from-email.js.map
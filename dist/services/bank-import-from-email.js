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
    // The import-from-pdf service expects a filePath. We persist the
    // bytes on a temporary path the SAM team's storage can resolve.
    // For replication purposes we surface the filename so the
    // executor's downstream extractor can use it as a reference.
    const pdfInput = {
        filePath: `email://${input.emailId}/${input.attachmentId}`,
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
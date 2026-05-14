import { previewBankImportFromPdf, } from './preview-from-pdf.js';
export async function previewBankImportFromEmail(operaDb, llm, attachments, input, extractor = null, appDb = null) {
    if (!Number.isFinite(input.emailId) || input.emailId <= 0) {
        return { success: false, error: 'email_id is required (positive number)' };
    }
    if (!input.attachmentId) {
        return { success: false, error: 'attachment_id is required' };
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
        return { success: false, error: `Failed to download attachment: ${msg}` };
    }
    if (!downloaded) {
        return {
            success: false,
            error: 'Attachment not found or download failed',
        };
    }
    return previewBankImportFromPdf(operaDb, llm, {
        pdfBytes: downloaded.bytes,
        filename: downloaded.filename,
        bankCode: input.bankCode,
    }, extractor, appDb);
}
//# sourceMappingURL=preview-from-email.js.map
/**
 * Preview a bank statement from an email attachment via ctx.llm.
 *
 * Faithful port of `preview_bank_import_from_email`
 * (apps/bank_reconcile/api/routes.py:8645-8870). Thin wrapper around
 * `previewBankImportFromPdf` that downloads the attachment first
 * via an `EmailAttachmentProvider` adapter (the SAM team plugs in
 * the actual Microsoft Graph fetch).
 */
import type { Knex } from 'knex';
import { type LlmService, type PreviewResponse } from './preview-from-pdf.js';
export interface EmailAttachmentProvider {
    fetchAttachment(opts: {
        emailId: number;
        attachmentId: string;
    }): Promise<{
        bytes: Uint8Array;
        filename: string;
        contentType: string;
    } | null>;
}
export interface PreviewFromEmailInput {
    emailId: number;
    attachmentId: string;
    bankCode: string;
}
export declare function previewBankImportFromEmail(operaDb: Knex, llm: LlmService, attachments: EmailAttachmentProvider, input: PreviewFromEmailInput): Promise<PreviewResponse>;
//# sourceMappingURL=preview-from-email.d.ts.map
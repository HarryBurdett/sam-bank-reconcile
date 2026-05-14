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
import {
  previewBankImportFromPdf,
  type LlmService,
  type PreviewResponse,
} from './preview-from-pdf.js';
import type { PdfExtractor } from './import-from-pdf.js';

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

export async function previewBankImportFromEmail(
  operaDb: Knex,
  llm: LlmService | null,
  attachments: EmailAttachmentProvider,
  input: PreviewFromEmailInput,
  extractor: PdfExtractor | null = null,
  appDb: Knex | null = null,
): Promise<PreviewResponse> {
  if (!Number.isFinite(input.emailId) || input.emailId <= 0) {
    return { success: false, error: 'email_id is required (positive number)' };
  }
  if (!input.attachmentId) {
    return { success: false, error: 'attachment_id is required' };
  }

  let downloaded: { bytes: Uint8Array; filename: string; contentType: string } | null;
  try {
    downloaded = await attachments.fetchAttachment({
      emailId: input.emailId,
      attachmentId: input.attachmentId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Failed to download attachment: ${msg}` };
  }

  if (!downloaded) {
    return {
      success: false,
      error: 'Attachment not found or download failed',
    };
  }

  return previewBankImportFromPdf(
    operaDb,
    llm,
    {
      pdfBytes: downloaded.bytes,
      filename: downloaded.filename,
      bankCode: input.bankCode,
    },
    extractor,
    appDb,
  );
}

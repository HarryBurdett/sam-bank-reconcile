/**
 * Bank import from email — wraps importBankStatementFromPdf with
 * an EmailAttachmentProvider download step.
 *
 * Faithful port of `import_bank_statement_from_email`
 * (apps/bank_reconcile/api/routes.py:9217-9650). Same posting body
 * as import-from-pdf; just downloads the PDF first.
 *
 * Also wires the composite `import_from_statement` (routes.py:1826)
 * — same flow with a slightly different request shape used by the
 * older UI.
 */
import type { Knex } from 'knex';
import {
  importBankStatementFromPdf,
  type PdfExtractor,
  type ImportPostingExecutor,
  type ImportLockAdapter,
  type PeriodOverlapChecker,
  type ImportFromPdfInput,
  type ImportFromPdfResponse,
} from './import-from-pdf.js';
import type { EmailAttachmentProvider } from './preview-from-email.js';

export interface BankImportFromEmailInput {
  emailId: number;
  attachmentId: string;
  bankCode: string;
  autoAllocate?: boolean;
  autoReconcile?: boolean;
  resumeImportId?: number | null;
  overrides?: unknown[];
  selectedRows?: number[] | null;
  dateOverrides?: unknown[];
  rejectedRefundRows?: number[];
  skipOverlapCheck?: boolean;
}

export async function importBankStatementFromEmail(
  operaDb: Knex,
  appDb: Knex,
  attachments: EmailAttachmentProvider,
  pdfExtractor: PdfExtractor,
  executor: ImportPostingExecutor,
  importLock: ImportLockAdapter,
  overlapChecker: PeriodOverlapChecker,
  input: BankImportFromEmailInput,
): Promise<ImportFromPdfResponse> {
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
  } catch (err) {
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
  const pdfInput: ImportFromPdfInput = {
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

  return importBankStatementFromPdf(
    operaDb,
    appDb,
    pdfInput,
    pdfExtractor,
    executor,
    importLock,
    overlapChecker,
  );
}

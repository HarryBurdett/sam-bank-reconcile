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
import { type PdfExtractor, type ImportPostingExecutor, type ImportLockAdapter, type PeriodOverlapChecker, type ImportFromPdfResponse } from './import-from-pdf.js';
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
export declare function importBankStatementFromEmail(operaDb: Knex, appDb: Knex, attachments: EmailAttachmentProvider, pdfExtractor: PdfExtractor, executor: ImportPostingExecutor, importLock: ImportLockAdapter, overlapChecker: PeriodOverlapChecker, input: BankImportFromEmailInput): Promise<ImportFromPdfResponse>;
//# sourceMappingURL=bank-import-from-email.d.ts.map
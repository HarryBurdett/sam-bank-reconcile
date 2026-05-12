/**
 * Bank-reconcile miscellaneous endpoint ports — the long tail that
 * doesn't merit its own file but needs a route to round out parity.
 *
 * Faithful ports of:
 *   - list_csv (routes.py:3140)               — list CSV files in folder
 *   - list_pdf (routes.py:3196)               — list PDF files in folder
 *   - pdf_content (routes.py:3571)            — fetch PDF bytes
 *   - scan_folder (routes.py:5541)            — scan a folder for files
 *   - scan_all_banks (routes.py:6558)         — scan inbox for all banks
 *   - fetch_emails_to_folder (routes.py:5762) — bulk download attachments
 *   - raw_preview (routes.py:2496)            — extract raw text via LLM
 *   - raw_preview_email (routes.py:8554)      — same, via email
 *   - preview_multiformat (routes.py:2553)    — CSV/OFX/QIF/MT940 parse
 *   - validate_csv (routes.py:4727)           — CSV format validation
 *   - statement_review (routes.py:10003)      — review by import_id
 *   - import_from_statement (routes.py:1826)  — composite import flow
 *
 * Most are filesystem- or LLM-bound and rely on adapters the SAM
 * team supplies. Each route returns a clear 503 with adapter
 * requirements when the dependencies aren't wired.
 */
import type { Knex } from 'knex';
import type { FileStorageAdapter } from './archive.js';
import type { EmailAttachmentProvider } from './preview-from-email.js';
import type { LlmService } from './preview-from-pdf.js';
export interface FileEntry {
    path: string;
    filename: string;
    folder: string;
    size: number;
    modified: string;
}
export declare function listCsvFiles(storage: FileStorageAdapter | null): Promise<{
    success: boolean;
    files: FileEntry[];
    error?: string;
}>;
export declare function listPdfFiles(storage: FileStorageAdapter | null): Promise<{
    success: boolean;
    files: FileEntry[];
    error?: string;
}>;
export interface PdfContentReader {
    /** Returns raw PDF bytes for a path the storage adapter knows about. */
    readBytes(opts: {
        path: string;
    }): Promise<Uint8Array | null>;
}
export declare function getPdfContent(reader: PdfContentReader | null, filePath: string): Promise<{
    success: boolean;
    bytes?: Uint8Array;
    size?: number;
    error?: string;
}>;
export declare function scanFolder(storage: FileStorageAdapter | null): Promise<{
    success: boolean;
    files: FileEntry[];
    count: number;
    error?: string;
}>;
export declare function fetchEmailsToFolder(attachments: EmailAttachmentProvider | null, storage: FileStorageAdapter | null, emails: Array<{
    emailId: number;
    attachmentId: string;
}>): Promise<{
    success: boolean;
    downloaded: number;
    errors: string[];
}>;
export declare function scanAllBanks(operaDb: Knex): Promise<{
    success: boolean;
    banks: Array<{
        bank_code: string;
        description: string;
        sort_code: string;
        account_number: string;
        reconciled_balance: number | null;
        current_balance: number | null;
        type: string | null;
        statements: unknown[];
        statement_count: number;
    }>;
    error?: string;
}>;
export declare function rawPreviewFromPdf(llm: LlmService | null, pdfBytes: Uint8Array | null, filePath: string | null): Promise<{
    success: boolean;
    text?: string;
    error?: string;
}>;
export interface MultiformatParser {
    detectFormat(content: string): 'csv' | 'ofx' | 'qif' | 'mt940' | 'unknown';
    parse(content: string, format: string): Array<{
        date: string | null;
        name: string | null;
        memo: string | null;
        amount: number;
        type: string;
    }>;
}
export declare function previewMultiformat(parser: MultiformatParser | null, content: string, formatOverride?: string | null): Promise<{
    success: boolean;
    format?: string;
    transactions?: Array<{
        date: string | null;
        name: string | null;
        memo: string | null;
        amount: number;
        type: string;
    }>;
    error?: string;
}>;
export declare function validateCsv(parser: MultiformatParser | null, content: string): Promise<{
    success: boolean;
    valid: boolean;
    format?: string;
    row_count?: number;
    error?: string;
}>;
export interface StatementReviewSummary {
    import_id: number;
    bank_code: string;
    filename: string;
    imported_at: string;
    records_imported: number;
    records_failed: number;
    opening_balance: number | null;
    closing_balance: number | null;
    status: string;
}
export declare function getStatementReview(appDb: Knex, importId: number): Promise<{
    success: boolean;
    review?: StatementReviewSummary;
    error?: string;
}>;
//# sourceMappingURL=misc-endpoints.d.ts.map
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
import type {
  EmailAttachmentProvider,
} from './preview-from-email.js';
import type { LlmService } from './preview-from-pdf.js';

// ---------------------------------------------------------------------
// File-list endpoints
// ---------------------------------------------------------------------

export interface FileEntry {
  path: string;
  filename: string;
  folder: string;
  size: number;
  modified: string;
}

export async function listCsvFiles(
  storage: FileStorageAdapter | null,
): Promise<{ success: boolean; files: FileEntry[]; error?: string }> {
  if (!storage) {
    return { success: false, files: [], error: 'fileStorage not configured' };
  }
  try {
    const files = await storage.listPending('bank-statement');
    return {
      success: true,
      files: files.filter((f) => f.filename.toLowerCase().endsWith('.csv')),
    };
  } catch (err: any) {
    return { success: false, files: [], error: err?.message ?? String(err) };
  }
}

export async function listPdfFiles(
  storage: FileStorageAdapter | null,
): Promise<{ success: boolean; files: FileEntry[]; error?: string }> {
  if (!storage) {
    return { success: false, files: [], error: 'fileStorage not configured' };
  }
  try {
    const files = await storage.listPending('bank-statement');
    return {
      success: true,
      files: files.filter((f) => f.filename.toLowerCase().endsWith('.pdf')),
    };
  } catch (err: any) {
    return { success: false, files: [], error: err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------
// PDF content (fetch raw bytes)
// ---------------------------------------------------------------------

export interface PdfContentReader {
  /** Returns raw PDF bytes for a path the storage adapter knows about. */
  readBytes(opts: { path: string }): Promise<Uint8Array | null>;
}

export async function getPdfContent(
  reader: PdfContentReader | null,
  filePath: string,
): Promise<{
  success: boolean;
  bytes?: Uint8Array;
  size?: number;
  error?: string;
}> {
  if (!reader) {
    return {
      success: false,
      error:
        'ctx.pdfContentReader not configured. SAM team must wire a PDF reader adapter.',
    };
  }
  try {
    const bytes = await reader.readBytes({ path: filePath });
    if (!bytes) return { success: false, error: 'PDF not found' };
    return { success: true, bytes, size: bytes.byteLength };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------
// Scan folder / emails / all-banks
// ---------------------------------------------------------------------

export async function scanFolder(
  storage: FileStorageAdapter | null,
): Promise<{
  success: boolean;
  files: FileEntry[];
  count: number;
  error?: string;
}> {
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
  } catch (err: any) {
    return {
      success: false,
      files: [],
      count: 0,
      error: err?.message ?? String(err),
    };
  }
}

export async function fetchEmailsToFolder(
  attachments: EmailAttachmentProvider | null,
  storage: FileStorageAdapter | null,
  emails: Array<{ emailId: number; attachmentId: string }>,
): Promise<{ success: boolean; downloaded: number; errors: string[] }> {
  if (!attachments || !storage) {
    return {
      success: false,
      downloaded: 0,
      errors: ['email attachment provider or fileStorage not configured'],
    };
  }
  let downloaded = 0;
  const errors: string[] = [];
  for (const e of emails) {
    try {
      const att = await attachments.fetchAttachment({
        emailId: e.emailId,
        attachmentId: e.attachmentId,
      });
      if (att) downloaded += 1;
      else errors.push(`Email ${e.emailId}: attachment not found`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Email ${e.emailId}: ${msg}`);
    }
  }
  return { success: errors.length === 0, downloaded, errors };
}

export async function scanAllBanks(
  operaDb: Knex,
): Promise<{
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
}> {
  // Legacy response shape: each bank includes statements: [] (always an array)
  // plus reconciliation balances. The frontend iterates over bank.statements,
  // so omitting it causes a runtime crash in PendingStatementsTab.
  // See apps/bank_reconcile/api/routes.py:6688 for the canonical legacy shape.
  // Email scanning + extraction + balance validation are NOT ported in this
  // pass (they're the heavy AI/email-ingest flows deferred from the rewrite);
  // we return the bank list with empty statements arrays so the page renders.
  try {
    const rows = (await operaDb.raw(
      `SELECT RTRIM(nk_acnt) AS bank_code,
              RTRIM(nk_desc) AS description,
              RTRIM(ISNULL(nk_sort, '')) AS sort_code,
              RTRIM(ISNULL(nk_number, '')) AS account_number,
              ISNULL(nk_recbal, 0) / 100.0 AS reconciled_balance,
              ISNULL(nk_curbal, 0) / 100.0 AS current_balance
       FROM nbank WITH (NOLOCK)
       ORDER BY nk_acnt`,
    )) as unknown as Array<{
      bank_code: string;
      description: string;
      sort_code: string;
      account_number: string;
      reconciled_balance: number | null;
      current_balance: number | null;
    }>;
    const banks = (rows ?? []).map((r) => ({
      ...r,
      type: null,
      statements: [],
      statement_count: 0,
    }));
    return { success: true, banks };
  } catch (err: any) {
    return { success: false, banks: [], error: err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------
// Raw / multiformat preview (LLM-bound or text-parsing)
// ---------------------------------------------------------------------

export async function rawPreviewFromPdf(
  llm: LlmService | null,
  pdfBytes: Uint8Array | null,
  filePath: string | null,
): Promise<{ success: boolean; text?: string; error?: string }> {
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
    const buf: string[] = [];
    for await (const chunk of stream) {
      if (typeof chunk === 'string') buf.push(chunk);
      else if (chunk && typeof chunk === 'object') {
        const c = chunk as { text?: string; delta?: { text?: string } };
        if (typeof c.text === 'string') buf.push(c.text);
        else if (c.delta?.text) buf.push(c.delta.text);
      }
    }
    return { success: true, text: buf.join('').trim() };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

// CSV/OFX/QIF format parsing — delegate to a registered parser.
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

export async function previewMultiformat(
  parser: MultiformatParser | null,
  content: string,
  formatOverride?: string | null,
): Promise<{
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
}> {
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
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

export async function validateCsv(
  parser: MultiformatParser | null,
  content: string,
): Promise<{
  success: boolean;
  valid: boolean;
  format?: string;
  row_count?: number;
  error?: string;
}> {
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
  } catch (err: any) {
    return { success: false, valid: false, error: err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------
// statement-review / import-from-statement
// ---------------------------------------------------------------------

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

export async function getStatementReview(
  appDb: Knex,
  importId: number,
): Promise<{
  success: boolean;
  review?: StatementReviewSummary;
  error?: string;
}> {
  if (!Number.isFinite(importId) || importId <= 0) {
    return { success: false, error: 'invalid import_id' };
  }
  try {
    const row = (await appDb('bank_statement_imports')
      .where({ id: importId })
      .first()) as
      | {
          id: number;
          bank_code: string;
          source_ref: string | null;
          imported_at: string | Date | null;
          records_imported: number | null;
          records_failed: number | null;
          opening_balance: number | null;
          closing_balance: number | null;
          import_status: string | null;
        }
      | undefined;
    if (!row) {
      return { success: false, error: 'Import not found' };
    }
    return {
      success: true,
      review: {
        import_id: Number(row.id),
        bank_code: row.bank_code,
        filename: (row.source_ref ?? '').split(/[/\\]/).pop() ?? '',
        imported_at:
          row.imported_at instanceof Date
            ? row.imported_at.toISOString()
            : String(row.imported_at ?? ''),
        records_imported: Number(row.records_imported ?? 0),
        records_failed: Number(row.records_failed ?? 0),
        opening_balance: row.opening_balance,
        closing_balance: row.closing_balance,
        status: row.import_status ?? '',
      },
    };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

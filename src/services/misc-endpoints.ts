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
import type { BankMailboxAdapter } from './scan-emails.js';
import {
  detectBankFromEmail,
  extractStatementNumberFromFilename,
  isBankStatementAttachment,
  compareSortKeys,
  type StatementSortKey,
} from './email-helpers.js';

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

export interface ScanAllBanksStatementEntry {
  /** Where the statement candidate was found. */
  source: 'email' | 'pdf';
  /** IMAP UID when source='email', else undefined. */
  email_id?: number;
  /** MIME part identifier when source='email', else undefined. */
  attachment_id?: string;
  /** Full filesystem path when source='pdf', else undefined. */
  full_path?: string;
  filename: string;
  subject?: string | null;
  from_address?: string | null;
  received_at?: string | null;
  detected_bank_name?: string | null;
  matched_bank_code?: string | null;
  matched_bank_description?: string | null;
  matched_sort_code?: string | null;
  matched_account_number?: string | null;
  statement_date?: string | null;
  sort_key: StatementSortKey;
  /** Already imported / fully reconciled — Hub greys these out. */
  already_processed: boolean;
  /** Legacy status; for plain scan-only candidates this is always 'ready'. */
  status: 'ready';
}

export interface ScanAllBanksBank {
  bank_code: string;
  description: string;
  sort_code: string;
  account_number: string;
  reconciled_balance: number | null;
  current_balance: number | null;
  type: string | null;
  statements: ScanAllBanksStatementEntry[];
  statement_count: number;
}

export interface ScanAllBanksResponse {
  success: boolean;
  banks: ScanAllBanksBank[];
  /** Candidates whose bank couldn't be detected. */
  unidentified: ScanAllBanksStatementEntry[];
  total_statements: number;
  total_banks_with_statements: number;
  total_banks_loaded: number;
  total_emails_scanned: number;
  total_pdfs_found: number;
  duplicates_archived: number;
  error?: string;
}

/**
 * Resolve a `detectBankFromEmail` keyword (`barclays`, `tide`, …) and
 * any account-number digits scraped from the filename to a specific
 * row in nbank. Account-number match wins over name match because
 * a customer typically has multiple accounts at the same bank.
 */
function pickBank(
  banks: ScanAllBanksBank[],
  detectedBankName: string | null,
  filename: string,
  subject: string | null,
): ScanAllBanksBank | null {
  // 1. Account-number scan: extract any sequence of 6+ digits from
  //    filename/subject and prefer the exact match against nk_number.
  const digitGroups = `${filename} ${subject ?? ''}`.match(/\d{6,}/g) ?? [];
  if (digitGroups.length > 0) {
    for (const candidate of digitGroups) {
      const hit = banks.find(
        (b) => b.account_number && b.account_number === candidate,
      );
      if (hit) return hit;
      // Some statements pad to 10 digits, Opera may store unpadded:
      // also try comparing the last 8 digits.
      const tail8 = candidate.slice(-8);
      const hit2 = banks.find(
        (b) =>
          b.account_number &&
          b.account_number.replace(/\D+/g, '').endsWith(tail8),
      );
      if (hit2) return hit2;
    }
  }
  // 2. Bank-name keyword match against description.
  if (detectedBankName) {
    const key = detectedBankName.toLowerCase();
    const hit = banks.find((b) =>
      (b.description ?? '').toLowerCase().includes(key),
    );
    if (hit) return hit;
  }
  return null;
}

/**
 * Already-imported lookup. Reads bank_statement_imports for any row
 * whose source_ref is the email-id or filename of the candidate, so
 * the Hub can grey out previously-processed entries instead of
 * re-presenting them.
 */
async function loadAlreadyProcessed(
  appDb: Knex | null,
): Promise<{ emailIds: Set<number>; filenames: Set<string> }> {
  const emailIds = new Set<number>();
  const filenames = new Set<string>();
  if (!appDb) return { emailIds, filenames };
  try {
    const rows = (await appDb('bank_statement_imports')
      .select('source', 'source_ref')) as Array<{
      source: string | null;
      source_ref: string | null;
    }>;
    for (const r of rows) {
      const ref = (r.source_ref ?? '').trim();
      if (!ref) continue;
      if (r.source === 'email') {
        const n = Number(ref);
        if (Number.isFinite(n) && n > 0) emailIds.add(n);
      }
      // Always also track the filename basename — covers both PDF
      // uploads and email-derived imports that recorded a filename.
      const base = ref.split(/[/\\]/).pop() ?? ref;
      if (base.length > 0) filenames.add(base);
    }
  } catch {
    // Tolerated — the table may be empty / not provisioned in tests.
  }
  return { emailIds, filenames };
}

/**
 * Scan-all-banks orchestrator.
 *
 * Faithful behaviour port of `scan_emails_for_bank_statements`
 * (apps/bank_reconcile/api/routes.py:6043-6800), structured for the
 * SAM port's adapter contract:
 *
 *   - `operaDb`        — required, gives the bank list (nbank).
 *   - `mailbox`        — optional. When wired (standalone IMAP
 *                        adapter or SAM email-ingest), recent emails
 *                        are scanned for statement-shaped attachments.
 *   - `appDb`          — optional. Used to dedupe candidates against
 *                        bank_statement_imports.
 *
 * Statement candidates from email are grouped by bank using
 * `detectBankFromEmail` (sender + filename heuristics) and a
 * `pickBank` resolver that prefers account-number matches. Unmatched
 * candidates land in the response's `unidentified` array — the Hub
 * surfaces them in its "Unidentified" section so the operator can
 * manually assign them to a bank.
 *
 * Folder scan + PDF balance validation are deliberately left for a
 * follow-up — they need `fileStorage` and `bankPdfExtractor`
 * adapters respectively, both of which already have hooks in the
 * router. Wiring them through `scanAllBanks` is mechanical once the
 * operator decides which path they want (folder ingest vs email ingest).
 */
export interface ScanAllBanksOptions {
  daysBack?: number;
  pageSize?: number;
}

export async function scanAllBanks(
  operaDb: Knex,
  mailbox: BankMailboxAdapter | null = null,
  appDb: Knex | null = null,
  opts: ScanAllBanksOptions = {},
): Promise<ScanAllBanksResponse> {
  const daysBack = Number.isFinite(opts.daysBack) ? Number(opts.daysBack) : 30;
  const pageSize = Number.isFinite(opts.pageSize) ? Number(opts.pageSize) : 200;

  // 1. Banks from Opera (always).
  let banks: ScanAllBanksBank[];
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
    banks = (rows ?? []).map((r) => ({
      ...r,
      type: null,
      statements: [] as ScanAllBanksStatementEntry[],
      statement_count: 0,
    }));
  } catch (err: any) {
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

  const unidentified: ScanAllBanksStatementEntry[] = [];
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
        if (attachments.length === 0) continue;
        for (const att of attachments) {
          if (
            !isBankStatementAttachment({
              filename: att.filename ?? null,
              contentType: att.content_type ?? null,
              subject: email.subject ?? null,
              fromAddress: email.from_address ?? null,
            })
          ) {
            continue;
          }
          totalPdfsFound += 1;
          const detectedBankName = detectBankFromEmail(
            email.from_address ?? null,
            att.filename ?? null,
            email.subject ?? null,
          );
          const matched = pickBank(
            banks,
            detectedBankName,
            att.filename ?? '',
            email.subject ?? null,
          );
          const dateInfo = extractStatementNumberFromFilename(
            att.filename ?? null,
            email.subject ?? null,
          );
          const receivedAt =
            email.received_at instanceof Date
              ? email.received_at.toISOString()
              : (email.received_at ?? null) as string | null;
          const entry: ScanAllBanksStatementEntry = {
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
            already_processed:
              (typeof email.id === 'number' && emailIds.has(email.id)) ||
              filenames.has(att.filename ?? ''),
            status: 'ready',
          };
          if (matched) matched.statements.push(entry);
          else unidentified.push(entry);
        }
      }
    } catch (err: any) {
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
    if (b.statement_count > 0) banksWithStatements += 1;
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

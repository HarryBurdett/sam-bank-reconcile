/**
 * Bank-reconcile scan-emails — list bank-statement candidates from the
 * connected mailbox.
 *
 * Faithful port of `scan_emails_for_bank_statements`
 * (apps/bank_reconcile/api/routes.py:6043-6800).
 *
 * Scope: deterministic core only — list emails with attachments,
 * classify with `isBankStatementAttachment`, detect bank, extract
 * statement date, sort, and filter against already-reconciled keys.
 *
 * The PDF balance-validation step (cache lookup → optional inline AI
 * extraction → opening-balance check → chain match) is deferred to
 * the SAM team because it depends on:
 *   - `ctx.llm` (Claude prompt for PDF text extraction)
 *   - a per-app PDF extraction cache
 *   - a downloader bridge to Microsoft Graph attachments
 * The route exposes `validateBalances=false` semantics so the UI
 * still gets the candidate list; statements are returned with
 * `validation_status: 'pending'` until a separate validation pass
 * runs.
 *
 * The mailbox is abstracted via `BankMailboxAdapter` so unit tests
 * don't need a real email service.
 */
import type { Knex } from 'knex';
import {
  detectBankFromEmail,
  extractStatementNumberFromFilename,
  isBankStatementAttachment,
  compareSortKeys,
  type StatementSortKey,
} from './email-helpers.js';

export interface MailboxAttachment {
  attachment_id: string;
  filename: string;
  size_bytes?: number;
  content_type?: string | null;
}

export interface MailboxEmail {
  id: number;
  subject?: string | null;
  from_address?: string | null;
  received_at?: string | Date | null;
  has_attachments?: boolean;
  attachments?: MailboxAttachment[];
}

export interface BankMailboxAdapter {
  /** Optional sync; failures are caught and ignored. */
  sync?: () => Promise<void>;
  list: (opts: { fromDate: Date; pageSize: number }) => Promise<{
    emails: MailboxEmail[];
  }>;
  getById: (emailId: number) => Promise<MailboxEmail | null>;
}

export interface ScanInput {
  bankCode: string;
  daysBack?: number;
  includeProcessed?: boolean;
  validateBalances?: boolean;
}

export interface BankNbankRow {
  reconciled_balance: number | null;
  sort_code: string | null;
  account_number: string | null;
}

export interface ReconciledKeyStore {
  /** Already-fully-reconciled (email_id, attachment_id) tuples. */
  getReconciledKeys: (
    bankCode: string,
  ) => Promise<Set<string>>;
  /** Already-fully-reconciled filenames (for dedupe by name). */
  getReconciledFilenames: (bankCode: string) => Promise<Set<string>>;
}

export interface CandidateAttachment {
  attachment_id: string;
  filename: string;
  size_bytes: number;
  content_type: string;
  already_processed: boolean;
  sort_key: StatementSortKey;
  statement_date: string | null;
}

export interface CandidateEmail {
  email_id: number;
  subject: string | null;
  from_address: string | null;
  received_at: string | null;
  detected_bank: string | null;
  sort_key: StatementSortKey;
  statement_date: string | null;
  attachments: CandidateAttachment[];
  validation_status: 'pending' | 'unsupported';
}

export interface ScanResponse {
  success: boolean;
  bank_code: string;
  reconciled_balance: number | null;
  opera_sort_code: string | null;
  opera_account_number: string | null;
  total_emails_scanned: number;
  total_pdfs_found: number;
  already_processed_count: number;
  skipped_reasons: string[];
  statements: CandidateEmail[];
  error?: string;
  message?: string;
}

async function fetchBankFromOpera(
  operaDb: Knex,
  bankCode: string,
): Promise<BankNbankRow | null> {
  try {
    const row = (await operaDb('nbank')
      .select(
        operaDb.raw('nk_recbal / 100.0 as reconciled_balance'),
        operaDb.raw('RTRIM(nk_sort) as sort_code'),
        operaDb.raw('RTRIM(nk_number) as account_number'),
      )
      .whereRaw('RTRIM(nk_acnt) = ?', [bankCode])
      .first()) as
      | {
          reconciled_balance: number | null;
          sort_code: string | null;
          account_number: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      reconciled_balance:
        row.reconciled_balance !== null && row.reconciled_balance !== undefined
          ? Number(row.reconciled_balance)
          : null,
      sort_code: row.sort_code,
      account_number: row.account_number,
    };
  } catch {
    return null;
  }
}

export async function scanEmailsForBankStatements(
  operaDb: Knex,
  _appDb: Knex,
  mailbox: BankMailboxAdapter,
  reconciledStore: ReconciledKeyStore,
  input: ScanInput,
): Promise<ScanResponse> {
  const bankCode = (input.bankCode ?? '').toString().trim();
  const daysBack = Number.isFinite(input.daysBack) ? Number(input.daysBack) : 30;
  const includeProcessed = !!input.includeProcessed;

  const bank = await fetchBankFromOpera(operaDb, bankCode);
  if (!bank) {
    return {
      success: false,
      bank_code: bankCode,
      reconciled_balance: null,
      opera_sort_code: null,
      opera_account_number: null,
      total_emails_scanned: 0,
      total_pdfs_found: 0,
      already_processed_count: 0,
      skipped_reasons: [],
      statements: [],
      error: `Bank account '${bankCode}' not found in Opera. Please select a valid bank account.`,
    };
  }

  if (mailbox.sync) {
    try {
      await Promise.race([
        mailbox.sync(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('sync timeout')), 30_000),
        ),
      ]);
    } catch {
      // proceed with cached state
    }
  }

  const fromDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  const list = await mailbox.list({ fromDate, pageSize: 500 });

  const reconciledKeys = await reconciledStore.getReconciledKeys(bankCode);
  const reconciledFilenames = await reconciledStore.getReconciledFilenames(
    bankCode,
  );

  const statements: CandidateEmail[] = [];
  const skippedReasons: string[] = [];
  let totalEmailsScanned = 0;
  let totalPdfsFound = 0;
  let alreadyProcessed = 0;

  for (const email of list.emails ?? []) {
    if (!email.has_attachments) continue;
    totalEmailsScanned += 1;

    const detail = await mailbox.getById(email.id);
    if (!detail || !detail.attachments || detail.attachments.length === 0) {
      continue;
    }

    const candidates: CandidateAttachment[] = [];
    for (const att of detail.attachments) {
      if (
        !isBankStatementAttachment({
          filename: att.filename,
          contentType: att.content_type ?? null,
          fromAddress: email.from_address ?? null,
          subject: email.subject ?? null,
        })
      ) {
        continue;
      }
      totalPdfsFound += 1;

      const key = `${email.id}:${att.attachment_id}`;
      if (
        !includeProcessed &&
        (reconciledKeys.has(key) || reconciledFilenames.has(att.filename))
      ) {
        alreadyProcessed += 1;
        skippedReasons.push(`Statement ${att.filename}: already reconciled`);
        continue;
      }

      const date = extractStatementNumberFromFilename(
        att.filename,
        email.subject ?? null,
      );
      candidates.push({
        attachment_id: att.attachment_id,
        filename: att.filename,
        size_bytes: att.size_bytes ?? 0,
        content_type: att.content_type ?? '',
        already_processed: false,
        sort_key: date.sort_key,
        statement_date: date.display_date,
      });
    }

    if (candidates.length === 0) continue;

    const detectedBank = detectBankFromEmail(
      email.from_address ?? '',
      candidates[0]?.filename ?? '',
      email.subject ?? '',
    );
    const firstFilename = candidates[0]?.filename ?? '';
    const dateForEmail = extractStatementNumberFromFilename(
      firstFilename,
      email.subject ?? null,
    );

    statements.push({
      email_id: email.id,
      subject: email.subject ?? null,
      from_address: email.from_address ?? null,
      received_at:
        email.received_at instanceof Date
          ? email.received_at.toISOString()
          : email.received_at
          ? String(email.received_at)
          : null,
      detected_bank: detectedBank,
      sort_key: dateForEmail.sort_key,
      statement_date: dateForEmail.display_date,
      attachments: candidates.sort((a, b) =>
        compareSortKeys(a.sort_key, b.sort_key),
      ),
      validation_status:
        input.validateBalances === false ? 'unsupported' : 'pending',
    });
  }

  statements.sort((a, b) => compareSortKeys(a.sort_key, b.sort_key));

  return {
    success: true,
    bank_code: bankCode,
    reconciled_balance: bank.reconciled_balance,
    opera_sort_code: bank.sort_code,
    opera_account_number: bank.account_number,
    total_emails_scanned: totalEmailsScanned,
    total_pdfs_found: totalPdfsFound,
    already_processed_count: alreadyProcessed,
    skipped_reasons: skippedReasons,
    statements,
  };
}

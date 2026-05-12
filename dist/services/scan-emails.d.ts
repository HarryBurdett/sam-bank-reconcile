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
import { type StatementSortKey } from './email-helpers.js';
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
    list: (opts: {
        fromDate: Date;
        pageSize: number;
    }) => Promise<{
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
    getReconciledKeys: (bankCode: string) => Promise<Set<string>>;
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
export declare function scanEmailsForBankStatements(operaDb: Knex, _appDb: Knex, mailbox: BankMailboxAdapter, reconciledStore: ReconciledKeyStore, input: ScanInput): Promise<ScanResponse>;
//# sourceMappingURL=scan-emails.d.ts.map
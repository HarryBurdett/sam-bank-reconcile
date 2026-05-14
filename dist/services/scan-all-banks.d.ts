import type { Knex } from 'knex';
import type { AppLogger as Logger } from '../app-context.js';
import type { BankMailboxAdapter } from './scan-emails.js';
import type { BankWithStatements, StatementCandidate } from './scan-all-banks-types.js';
import type { PdfExtractor } from './import-from-pdf.js';
import type { EmailAttachmentProvider } from './preview-from-email.js';
/**
 * Full response shape — matches legacy line 7910 verbatim.
 */
export interface ScanAllBanksResponse {
    success: boolean;
    banks: Record<string, BankWithStatements & {
        statements_total?: number;
        statements_extracted?: number;
        extraction_failures?: Array<{
            filename: string;
            reason: string;
        }>;
        extraction_status?: 'complete' | 'incomplete';
    }>;
    unidentified: StatementCandidate[];
    non_current: {
        already_processed: StatementCandidate[];
        old_statements: StatementCandidate[];
        not_classified: StatementCandidate[];
        advanced: StatementCandidate[];
    };
    non_current_count: number;
    total_statements: number;
    total_banks_with_statements: number;
    total_banks_loaded: number;
    total_emails_scanned: number;
    total_pdfs_found: number;
    emails_saved_to_folders: number;
    duplicates_archived: number;
    days_searched: number;
    mailbox_synced: boolean;
    mailbox_sync_skipped: boolean;
    timings: Record<string, number>;
    message: string;
    error?: string;
}
export interface ScanAllBanksOptions {
    daysBack?: number;
    includeProcessed?: boolean;
    validateBalances?: boolean;
    /** When true (default) and an extractor is supplied, the scanner
     *  eagerly extracts the first pending_extraction PDF per bank so
     *  the operator sees opening/closing balances + the next-in-
     *  sequence marker without a separate Analyse pass. Bounded to one
     *  Gemini call per pending bank per scan to cap cost. */
    extractOnMiss?: boolean;
    /** PDF extractor (Gemini). When present + extractOnMiss=true,
     *  pending PDFs that lack cached balances get extracted inline. */
    extractor?: PdfExtractor | null;
    /** Email-attachment provider — required to eager-extract PDFs
     *  whose only source is the IMAP mailbox (no folder copy). */
    emailAttachments?: EmailAttachmentProvider | null;
    pageSize?: number;
}
export declare function scanAllBanksFaithful(operaDb: Knex, mailbox: BankMailboxAdapter | null, appDb: Knex | null, logger: Logger, opts?: ScanAllBanksOptions): Promise<ScanAllBanksResponse>;
//# sourceMappingURL=scan-all-banks.d.ts.map
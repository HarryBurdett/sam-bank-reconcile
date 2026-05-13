/**
 * scan_all_banks_for_statements — faithful TS port of
 * apps/bank_reconcile/api/routes.py:6559 (1,375 lines).
 *
 * 8-step orchestration:
 *   1. Bank discovery + lookup tables          (legacy: 6662-6712)
 *   2. Email fetch (cached or live IMAP)       (legacy: 6714-6730)
 *      + load statement tracking data         (legacy: 6720-6749)
 *      + imported_pending_closings chain      (legacy: 6750-6789)
 *   3. Email scan + classify + bucket          (legacy: 6873-7303)
 *   4. Folder scan                             (legacy: 7306-7556)  — pending
 *   4a. Cross-check by sort/acct               (legacy: 7557-7597)  — pending
 *   4b. Sort statements                        (legacy: 7598-7605)
 *   5. Sort + filter reconciled + finalize     (legacy: 7615-7905)
 *      + draft annotation                     (legacy: 7647-7684)
 *      + final cleanup                        (legacy: 7686-7805)
 *      + per-bank extraction_status           (legacy: 7817-7861)
 *      + sequential statement gating          (legacy: 7862-7906)
 *
 * Legacy uses six external dependencies the SAM port doesn't have yet:
 *
 *   - email_sync_manager.sync_all_providers()  — IMAP sync trigger.
 *     SAM port reads IMAP live via the standalone IMAP adapter
 *     (or SAM's ctx.emailIngest), no sync trigger needed.
 *   - email_storage.get_emails_with_attachments() — cached emails.
 *     SAM port reads live via mailbox.list(); same response shape.
 *   - sql_rag.pdf_extraction_cache.get_extraction_cache()  — PDF
 *     content cache. Without it the cached-info fast-path simply
 *     does not fire; matches legacy's degraded behaviour when the
 *     cache module is unavailable (try/except return).
 *   - sql_rag.period_reconciliation.check_period_reconciled — used
 *     in step 5 final cleanup. Same degradation: when the module
 *     can't be imported, legacy line 7768 catches and continues.
 *   - DeferredTransactionsDB.count_for_statement — used for
 *     deferred_count. SAM port reads the migrated
 *     deferred_transactions table directly (line ~565 below).
 *   - email_storage.get_draft_statement_keys — read from migrated
 *     bank_import_drafts table.
 *
 * Each of those gaps surfaces as a `logger.debug(...)` line in the
 * legacy itself, so this port matches legacy behaviour when the
 * dependency is absent.
 */
import type { Knex } from 'knex';
import type { AppLogger as Logger } from '../app-context.js';
import type { BankMailboxAdapter } from './scan-emails.js';
import type { BankWithStatements, StatementCandidate } from './scan-all-banks-types.js';
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
    extractOnMiss?: boolean;
    pageSize?: number;
}
export declare function scanAllBanksFaithful(operaDb: Knex, mailbox: BankMailboxAdapter | null, appDb: Knex | null, logger: Logger, opts?: ScanAllBanksOptions): Promise<ScanAllBanksResponse>;
//# sourceMappingURL=scan-all-banks.d.ts.map
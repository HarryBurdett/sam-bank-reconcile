/**
 * Bank-import / import-from-pdf — orchestration shell.
 *
 * Faithful port of the route-level orchestration from
 * `import_bank_statement_from_pdf` (apps/bank_reconcile/api/routes.py:4031-4787)
 * with the heavy lifting (PDF extraction, transaction matching, the
 * actual aentry/atran/sname/pname/ntran writes, auto-allocate, and
 * auto-reconcile) delegated to discrete executor adapters.
 *
 * Why split this up?
 *   - PDF extraction needs `ctx.llm` (Claude vision) — not yet wired.
 *   - The 750-line posting body has many seams that the SAM team will
 *     fill against the unified Knex client. Carving the contract now
 *     lets the frontend wire while the executor is built independently.
 *   - Keeping the orchestration shell deterministic means the route
 *     can run validations + audit-row writes today without ctx.llm.
 *
 * Validations performed here (Python parity):
 *   - bank_code exists in nbank
 *   - file path provided + non-empty
 *   - import-lock acquired/released around the executor
 *   - import history row written on success
 *
 * Everything between extraction and posting is an executor seam.
 */
import type { Knex } from 'knex';
export interface PdfExtractionResult {
    bank_name: string | null;
    account_number: string | null;
    sort_code: string | null;
    statement_date: string | null;
    period_start: string | null;
    period_end: string | null;
    opening_balance: number | null;
    closing_balance: number | null;
    transactions: Array<{
        date: string | null;
        name: string | null;
        memo: string | null;
        amount: number;
        type: 'credit' | 'debit' | string;
        /** Running balance after this transaction, when the statement shows it. */
        balance?: number | null;
        line_number?: number;
    }>;
}
export interface PdfExtractor {
    /**
     * Read a PDF (or PDF bytes) and return extracted statement +
     * transactions. Implementation will use ctx.llm when wired.
     */
    extractFromPdf(opts: {
        filePath?: string;
        bytes?: Uint8Array;
        filename?: string;
    }): Promise<PdfExtractionResult>;
}
export interface PostedLine {
    line_number: number;
    post_date: string;
    amount: number;
    posted_entry_number: string;
    description: string;
    /**
     * The Opera at_type that was posted (1 nom-pay, 2 nom-rec, 3 sale-
     * refund, 4 sale-rec, 5 pur-pay, 6 pur-refund, 8 transfer). Used by
     * later validation passes.
     */
    at_type: number;
}
/**
 * Lookup hook for the auto-allocate Rule 0 branch. Returns the
 * invoice_refs stored against a gc_payment_id, or null/[] when the
 * payment ID isn't known (e.g. gocardless plugin not active). Faithful
 * port surface for opera_sql_import.py:7128.
 */
export type PaymentRequestInvoiceLookup = (gcPaymentId: string) => Promise<string[] | null>;
export interface ImportPostingExecutor {
    postBankImport(opts: {
        operaDb: Knex;
        bankCode: string;
        statementInfo: PdfExtractionResult;
        transactions: PdfExtractionResult['transactions'];
        overrides: unknown[];
        selectedRows: number[] | null;
        autoAllocate: boolean;
        autoReconcile: boolean;
        paymentRequestLookup?: PaymentRequestInvoiceLookup | null;
    }): Promise<{
        success: boolean;
        records_imported: number;
        records_failed: number;
        skipped_count: number;
        errors: string[];
        warnings: string[];
        import_id?: number | null;
        /**
         * Per-line posted-entry record — populated by the executor for
         * every line that posted successfully. Used by the import flow to
         * write `bank_statement_transactions` rows so subsequent
         * Opera-restore detection can validate per-line. New in SAM port.
         */
        posted_lines?: PostedLine[];
    }>;
}
export interface ImportLockAdapter {
    acquire(key: string, locker: string): Promise<boolean>;
    release(key: string): Promise<void>;
}
export interface PeriodOverlapChecker {
    checkOverlap(opts: {
        bankCode: string;
        periodStart: string | null;
        periodEnd: string | null;
        filename: string;
        resumeImportId: number | null;
        skipOverlapCheck: boolean;
    }): Promise<{
        overlapError?: {
            success: false;
            error: string;
        } | null;
        resumeImportId: number | null;
    }>;
}
export interface ImportFromPdfInput {
    filePath: string;
    bankCode: string;
    filename?: string;
    autoAllocate?: boolean;
    autoReconcile?: boolean;
    resumeImportId?: number | null;
    overrides?: unknown[];
    selectedRows?: number[] | null;
    dateOverrides?: unknown[];
    rejectedRefundRows?: number[];
    skipOverlapCheck?: boolean;
    /** Operator username for the bank_statement_imports audit row.
     *  Legacy threads `request.state.user.username` here
     *  (routes.py:4502). When omitted, defaults to 'system'. */
    importedBy?: string | null;
    /** Tenant company code (e.g. 'intsys', 'cloudsis'). Threaded onto
     *  bank_import_patterns rows so the legacy upsert key
     *  (company_code, description_normalized) works. Defaults to
     *  'default' to match BankPatternLearner's fallback
     *  (bank_patterns.py:54). */
    companyCode?: string | null;
    /** Hook used by auto-allocate Rule 0 to fetch invoice_refs for a
     *  GoCardless payment ID. Wired from the standalone host
     *  (company-registry.ts) when the gocardless plugin is present;
     *  null in plain-SAM mode. */
    paymentRequestLookup?: PaymentRequestInvoiceLookup | null;
}
export interface ImportFromPdfResponse {
    success: boolean;
    message?: string;
    records_imported?: number;
    records_failed?: number;
    skipped_count?: number;
    deferred_count?: number;
    warnings?: string[];
    errors?: string[];
    error?: string;
    resume_import_id?: number | null;
    import_id?: number | null;
    imported_count?: number;
    imported_transactions_count?: number;
    receipts_imported?: number;
    payments_imported?: number;
    refunds_imported?: number;
    transfers_imported?: number;
    total_receipts?: number;
    total_payments?: number;
    skipped_not_selected?: number;
    skipped_incomplete?: number;
    skipped_duplicates?: number;
    imported_transactions?: Array<Record<string, unknown>>;
    auto_allocate_enabled?: boolean;
    statement_info?: Record<string, unknown>;
    /** Result of the post-import auto-reconciliation pass, populated
     *  only when input.autoReconcile is true. Mirrors legacy
     *  `result['reconciliation_result']` (routes.py:4680). */
    reconciliation_result?: {
        success: boolean;
        entries_reconciled: number;
        statement_number?: number;
        statement_date?: string;
        messages?: string[];
    };
    auto_reconcile_enabled?: boolean;
}
export declare function importBankStatementFromPdf(operaDb: Knex, appDb: Knex, input: ImportFromPdfInput, extractor: PdfExtractor, executor: ImportPostingExecutor, importLock: ImportLockAdapter, overlapChecker: PeriodOverlapChecker): Promise<ImportFromPdfResponse>;
//# sourceMappingURL=import-from-pdf.d.ts.map
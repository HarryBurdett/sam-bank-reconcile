/**
 * Preview a bank statement from a PDF file via ctx.llm.
 *
 * Faithful port of `preview_bank_import_from_pdf`
 * (apps/bank_reconcile/api/routes.py:3623-3940). The Python
 * implementation calls `StatementReconciler.extract_transactions_from_pdf`
 * which prompts Gemini Vision; this port uses the SAM `ctx.llm`
 * service (Claude) with the same extraction prompt structure.
 *
 * Pipeline:
 *   1. Call ctx.llm with a vision prompt to extract statement info +
 *      transactions from the PDF
 *   2. Validate bank match (sort code + account number against nbank)
 *   3. Compare opening balance to nk_recbal (warn but don't override)
 *   4. Walk transaction balance chain to validate closing
 *   5. Return a preview shape the frontend can render
 *
 * The matching pass (suggest accounts, flag duplicates) is left to
 * `/api/reconcile/refresh-matches` which the frontend can call after
 * preview lands.
 */
import type { Knex } from 'knex';
import type { PdfExtractor } from './import-from-pdf.js';
export interface LlmService {
    chat(req: {
        messages: Array<{
            role: string;
            content: string;
        }>;
        tools?: unknown[];
        model?: string;
        maxTokens?: number;
        temperature?: number;
        context?: string;
    }): AsyncIterable<unknown>;
    stream?: unknown;
}
export interface PreviewFromPdfInput {
    /** Either filePath OR pdfBytes must be supplied. */
    filePath?: string;
    pdfBytes?: Uint8Array;
    filename?: string;
    bankCode: string;
}
export interface PreviewBankInfo {
    code: string;
    description: string;
    sort_code: string;
    account_number: string;
    reconciled_balance: number | null;
}
export interface PreviewTxn {
    row: number;
    date: string | null;
    amount: number;
    name: string | null;
    reference: string | null;
    memo: string | null;
    fit_id: string | null;
    account: string | null;
    account_name: string | null;
    match_score: number;
    match_source: string | null;
    action: string | null;
    reason: string | null;
    is_duplicate: boolean;
    duplicate_candidates: unknown[];
    refund_credit_note: unknown;
    refund_credit_amount: number | null;
    repeat_entry_ref: string | null;
    repeat_entry_desc: string | null;
    repeat_entry_next_date: string | null;
    repeat_entry_posted: number | null;
    repeat_entry_total: number | null;
    repeat_entry_freq: string | null;
    repeat_entry_every: number | null;
    period_valid: boolean;
    period_error: string | null;
    original_date: string | null;
    type?: string;
    balance?: number | null;
    line_number?: number;
    matched_entry_number?: string | null;
}
export interface PreviewResponse {
    success: boolean;
    filename?: string;
    detected_format?: string;
    total_transactions?: number;
    /** Bucketed transactions — legacy contract from routes.py:2787-2822.
     *  The FE reads matched_receipts/payments/refunds/repeat_entries/
     *  unmatched/already_posted/skipped directly into the preview UI.
     *  A flat transactions array is also kept for callers that read it. */
    matched_receipts?: PreviewTxn[];
    matched_payments?: PreviewTxn[];
    matched_refunds?: PreviewTxn[];
    repeat_entries?: PreviewTxn[];
    unmatched?: PreviewTxn[];
    already_posted?: PreviewTxn[];
    skipped?: PreviewTxn[];
    summary?: {
        to_import: number;
        refund_count: number;
        repeat_entry_count: number;
        unmatched_count: number;
        already_posted_count: number;
        skipped_count: number;
    };
    errors?: string[];
    /** Statement metadata (AI extraction). Used by the FE's Statement
     *  Summary card. */
    statement_bank_info?: {
        bank_name: string | null;
        account_number: string | null;
        sort_code: string | null;
        statement_date: string | null;
        period_start: string | null;
        period_end: string | null;
        opening_balance: number | null;
        closing_balance: number | null;
        matched_opera_bank?: string | null;
    };
    /** Full extracted statement transactions (unbucketed) — used by the
     *  reconcile screen to render the raw statement. */
    statement_transactions?: PreviewTxn[];
    statement_info?: {
        bank_name: string | null;
        account_number: string | null;
        sort_code: string | null;
        statement_date: string | null;
        period_start: string | null;
        period_end: string | null;
        opening_balance: number | null;
        closing_balance: number | null;
    };
    /** Kept for backward-compat with code that still reads the flat
     *  transactions array. The bucketed arrays above are the legacy
     *  contract. */
    transactions?: PreviewTxn[];
    bank?: PreviewBankInfo;
    warnings?: string[];
    error?: string;
    bank_mismatch?: boolean;
    detected_bank?: string;
    selected_bank?: string;
    correct_bank_code?: string | null;
}
export declare function previewBankImportFromPdf(operaDb: Knex, llm: LlmService | null, input: PreviewFromPdfInput, extractor?: PdfExtractor | null, appDb?: Knex | null): Promise<PreviewResponse>;
//# sourceMappingURL=preview-from-pdf.d.ts.map
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
export interface PreviewResponse {
    success: boolean;
    filename?: string;
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
    transactions?: Array<{
        date: string | null;
        name: string | null;
        memo: string | null;
        amount: number;
        type: string;
        balance?: number | null;
        line_number?: number;
        /** Set when the matcher's process_transactions pass found the row
         *  already exists in Opera's cashbook. Faithful port of
         *  bank_import.py:1946. The UI uses this to render the "already
         *  posted" badge and pre-deselect the row. */
        is_duplicate?: boolean;
        /** Skip flag — when set, the import-from-pdf orchestration
         *  shell will route this row through the executor's skip path
         *  (no cashbook write). Set by the duplicate-detection pass at
         *  preview time. */
        action?: string;
        /** Human-readable explanation for the skip, surfaced in the
         *  preview UI alongside is_duplicate. Mirrors
         *  BankTransaction.skip_reason in bank_import.py:252. */
        skip_reason?: string | null;
        /** The Opera entry_number that already holds this posting. Used
         *  by the FE's duplicate-override modal and by the import loop's
         *  consumed-entries seeding. */
        matched_entry_number?: string | null;
        /** Customer or supplier account code that the alias matcher
         *  resolved this row to. Mirrors BankTransaction.matched_account
         *  in bank_import.py:252. */
        matched_account?: string | null;
        /** Display name for the matched account, surfaced as the
         *  "matched to" badge in the preview UI. */
        matched_name?: string | null;
        /** Confidence (0..1) of the alias match. */
        match_confidence?: number | null;
    }>;
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
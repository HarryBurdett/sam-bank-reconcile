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
    }>;
    bank?: PreviewBankInfo;
    warnings?: string[];
    error?: string;
    bank_mismatch?: boolean;
    detected_bank?: string;
    selected_bank?: string;
    correct_bank_code?: string | null;
}
export declare function previewBankImportFromPdf(operaDb: Knex, llm: LlmService | null, input: PreviewFromPdfInput, extractor?: PdfExtractor | null): Promise<PreviewResponse>;
//# sourceMappingURL=preview-from-pdf.d.ts.map
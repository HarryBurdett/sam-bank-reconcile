/**
 * Process a bank statement — extract + match in one pass.
 *
 * Faithful port of `process_bank_statement`
 * (apps/bank_reconcile/api/routes.py:1370-1645) and
 * `process_statement_unified` (1719+).
 *
 * Pipeline:
 *   1. Extract statement + transactions via ctx.llm
 *   2. Build a shared MatchContext (load customers, suppliers, other
 *      banks for transfer detection)
 *   3. For each transaction:
 *      - Run duplicate detection (six-strategy via findDuplicates)
 *      - Run the full _match_transaction flow:
 *           Stage 0    repeat-entry check (arhead/arline)
 *           Stage 0.5  bank-transfer detection (other Opera banks)
 *           Stage 1    alias lookup (per-bank → global)
 *           Stage 2    fuzzy match (BankMatcher, with payee-clean
 *                      fallback)
 *           Stage 3    ambiguity resolution + credit-note refund
 *                      detection (when payment matched customer or
 *                      receipt matched supplier)
 *           Stage 4    direction-based decision + alias learning at
 *                      score ≥ 0.85
 *      - Translate the matcher result back into the existing UI shape
 *        (suggested_account, ledger_type, action)
 *
 * Backwards-compatible response: matched_transactions[] retains the
 * legacy shape; new fields (refund_credit_note, bank_transfer_details,
 * repeat_entry_ref, etc.) are additive.
 */
import type { Knex } from 'knex';
import { type LlmService, type PreviewResponse } from './preview-from-pdf.js';
import { type TransactionType } from './suggest-account.js';
import { type MatchAction } from './match-transaction.js';
export interface ProcessTransaction {
    date: string | null;
    name: string | null;
    memo: string | null;
    amount: number;
    type: string;
    balance?: number | null;
    line_number?: number;
    is_duplicate: boolean;
    duplicate_reason: string | null;
    suggested_account: {
        code: string;
        name: string;
        score: number;
        match_type: string;
    } | null;
    ledger_type: 'C' | 'S' | null;
    /**
     * Final matched action — extends the legacy TransactionType enum
     * with `bank_transfer` / `repeat_entry` / `defer` so the UI can
     * render the new categories.
     */
    action: TransactionType | MatchAction | 'skip';
    match_source?: string;
    match_score?: number;
    skip_reason?: string | null;
    /** When action = 'bank_transfer' */
    bank_transfer_details?: {
        dest_bank: string;
    } | null;
    /** When action = 'repeat_entry' */
    repeat_entry?: {
        entry_ref: string;
        entry_desc: string;
        next_post_date: string | null;
        freq: string;
        every: number;
        posted: number;
        topost: number;
    } | null;
    /** When action = 'sales_refund' or 'purchase_refund' */
    refund_credit_note?: string | null;
    refund_credit_amount?: number;
}
export interface ProcessStatementResponse extends PreviewResponse {
    matched_transactions?: ProcessTransaction[];
    matched_count?: number;
    duplicate_count?: number;
}
export declare function processStatement(operaDb: Knex, llm: LlmService, input: {
    filePath?: string;
    pdfBytes?: Uint8Array;
    bankCode: string;
}, appDb?: Knex | null): Promise<ProcessStatementResponse>;
//# sourceMappingURL=process-statement.d.ts.map
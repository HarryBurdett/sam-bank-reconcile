/**
 * `_match_transaction` orchestrator — the per-transaction matching
 * brain used during PDF import / preview.
 *
 * Faithful port of `BankImporter._match_transaction`
 * (sql_rag/bank_import.py:1297-1495). The legacy six-stage flow:
 *
 *   Stage 0  Repeat-entry check (handled by Opera auto-post)
 *   Stage 0.5 Bank-transfer detection (matches another Opera bank)
 *   Stage 1  Alias lookup (per-bank then global)
 *   Stage 2  Fuzzy match (BankMatcher) — full name, then payee-cleaned
 *   Stage 3  Ambiguity resolution + refund-detection-via-credit-note
 *   Stage 4  Save high-score alias for next time
 *
 * One `matchTransaction(...)` call returns the decided action +
 * matched account + match metadata. Caller (process-statement) uses
 * this to populate each row's `action`/`suggested_account`/
 * `ledger_type` before returning the preview to the frontend.
 *
 * Portable across Opera SE (MSSQL) and Opera 3 (FoxPro) — all queries
 * are routed through helper services that already use Knex builder.
 */
import type { Knex } from 'knex';
import { BankMatcher, type MatchCandidate } from './bank-matcher.js';
import { type OtherBank } from './check-bank-transfer.js';
import { type RepeatEntryMatch } from './check-repeat-entry.js';
export type MatchAction = 'sales_receipt' | 'purchase_payment' | 'sales_refund' | 'purchase_refund' | 'bank_transfer' | 'repeat_entry' | 'skip' | 'defer';
export interface MatchTransactionInput {
    bankCode: string;
    /** YYYY-MM-DD transaction date. */
    date: string;
    /** Signed amount in pounds — positive = receipt, negative = payment. */
    amount: number;
    /** Extracted payee/payer name from the bank line. */
    name: string;
    /** Bank reference (e.g. cheque number, faster-payment ref). */
    reference: string;
    /** Full memo as it appears on the statement. */
    memo: string;
    /** If user already deferred this row, preserve. */
    preDeferred?: boolean;
}
export interface MatchTransactionResult {
    action: MatchAction;
    match_type: 'customer' | 'supplier' | null;
    matched_account: string | null;
    matched_name: string | null;
    match_score: number;
    match_source: string;
    skip_reason: string | null;
    /** When action = 'bank_transfer' */
    bank_transfer_details: {
        dest_bank: string;
    } | null;
    /** When action = 'repeat_entry' */
    repeat_entry: RepeatEntryMatch | null;
    /** When action = 'sales_refund' or 'purchase_refund' — credit note used. */
    refund_credit_note: string | null;
    refund_credit_amount: number;
}
/**
 * Loaded once per import, shared across all transactions in the run.
 * Significant work to build (loads sname + pname + nbank); reusing it
 * across rows is essential for batch performance.
 */
export interface MatchContext {
    bankCode: string;
    matcher: BankMatcher;
    otherBanks: OtherBank[];
    /**
     * Score threshold above which to auto-save a learned alias. Defaults
     * to 0.85 per legacy `learn_threshold`.
     */
    learnThreshold: number;
}
export declare function buildMatchContext(operaDb: Knex, bankCode: string, opts: {
    customers: MatchCandidate[];
    suppliers: MatchCandidate[];
    minScore?: number;
    learnThreshold?: number;
}): Promise<MatchContext>;
/**
 * Drives the legacy match flow. Returns a full result describing the
 * decision; never throws (errors fall through to skip with reason).
 */
export declare function matchTransaction(operaDb: Knex, appDb: Knex | null, ctx: MatchContext, input: MatchTransactionInput): Promise<MatchTransactionResult>;
//# sourceMappingURL=match-transaction.d.ts.map
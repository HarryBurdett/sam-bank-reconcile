/**
 * Bank-import duplicate detection.
 *
 * Faithful port of `EnhancedDuplicateDetector` in
 * `sql_rag/bank_duplicates.py`. The Python implementation runs six
 * strategies in priority order — all ported here.
 *
 * Strategies (priority order, fingerprint short-circuits the rest):
 *   0. fingerprint  — BKIMP:HASH:DATE in at_refer/st_trref/pt_trref
 *                     (confidence 1.0, definitive)
 *   1. fit_id       — OFX bank-issued unique transaction id in at_refer
 *                     (confidence 0.95)
 *   2. exact        — date + amount + account (confidence 0.90)
 *   3. fuzzy_amount — date + ±5% amount + account
 *                     (confidence 0.5–0.7 by diff %)
 *   4. reference    — partial reference + account
 *                     (confidence 0.6, top-5 by date)
 *   5. cross_period — ±7 days + amount + account
 *                     (confidence 0.5–0.75 by date diff)
 *   6. bank_amount  — ±14 days + signed amount on aentry header,
 *                     no account required (catches direct Opera entries
 *                     like HMRC). Only runs if no account-level match.
 *                     (confidence 0.5–0.95 by date diff)
 *
 * Sign-aware throughout: a +£X receipt and a -£X payment are NOT
 * duplicates. Receipt amounts route to stran (st_trtype='R'),
 * payment amounts route to ptran (pt_trtype='P').
 *
 * Determinism: fingerprint uses a stable MD5 of name|amount|date.
 * Test depth proves it stable across calls and resilient against
 * dataframe-shaped DB responses.
 */
import type { Knex } from 'knex';
export interface DuplicateCandidate {
    table: 'atran' | 'stran' | 'ptran' | 'aentry';
    record_id: string;
    match_type: 'fingerprint' | 'exact' | 'fit_id' | 'fuzzy_amount' | 'reference' | 'cross_period' | 'bank_amount';
    confidence: number;
    details: Record<string, unknown>;
}
export interface CheckTransactionInput {
    name: string;
    amount: number;
    date: Date | string;
    /** Optional matched Opera account code (customer or supplier). */
    account?: string | null;
    /** Optional bank account code. */
    bank_code?: string | null;
    /** Optional FIT ID (OFX bank-issued unique transaction id). */
    fit_id?: string | null;
    /** Optional transaction reference. */
    reference?: string | null;
    /** Optional matcher-derived action — when supplied, the stran/ptran
     *  probes use the correct trtype filter (R/P for normal,
     *  F for refunds). Without it, we fall back to a sign-derived
     *  default that matches receipts/payments but NOT refunds — same
     *  behaviour SAM has shipped, kept for backward-compat with callers
     *  that don't classify rows. Faithful port of
     *  duplicate_check.py:ACTION_TYPE_MAP. */
    action?: string | null;
}
export declare function generateImportFingerprint(name: string, amount: number, txnDate: Date | string): string;
export declare function extractHashFromFingerprint(fingerprint: string): string | null;
export declare function findDuplicates(operaDb: Knex, input: CheckTransactionInput): Promise<DuplicateCandidate[]>;
export interface CheckBatchResult {
    index: number;
    candidates: DuplicateCandidate[];
}
export interface CheckBatchResponse {
    success: boolean;
    duplicates_found: number;
    results: Record<string, Array<{
        table: string;
        record_id: string;
        match_type: string;
        confidence: number;
        details: Record<string, unknown>;
    }>>;
    error?: string;
}
export declare function checkBatch(operaDb: Knex, transactions: CheckTransactionInput[], bankCode?: string | null): Promise<CheckBatchResponse>;
//# sourceMappingURL=duplicate-detection.d.ts.map
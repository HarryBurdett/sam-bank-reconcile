/**
 * Chain-complete check — port of
 * `apps/bank_reconcile/logic/scan_pdf_validation.py:check_chain_complete`.
 *
 * Two ways a statement gets classified as "already processed":
 *   (A) closing_matches_reconciled_opening — this statement's
 *       closing balance equals an opening balance of a previously
 *       reconciled statement (chain has moved past it).
 *   (B) opening_below_reconciled — this statement's opening is
 *       more than a penny below the bank's effective reconciled
 *       balance (the bank has already processed forward).
 *
 * Legacy signature includes an `opening_unblocks_chain` callback for
 * Opera 3 sequential gating (imported-but-not-reconciled previous
 * statement). Same hook here.
 */
export interface ChainCheckInput {
    openingBalance: number | null;
    closingBalance: number | null;
    /** Bank's current reconciled balance (Opera nbank.nk_recbal). */
    effectiveReconciledBalance: number | null;
    /** Fallback when effectiveReconciledBalance is null. */
    fallbackReconciledBalance?: number | null;
    /** Set of opening balances of previously-reconciled statements. */
    bankRecOpenings: Set<number>;
    filename: string;
    /** Optional gating callback: returns true if this opening should
     *  be allowed through despite being below the reconciled balance
     *  (e.g. the prior statement is imported-but-not-yet-reconciled). */
    openingUnblocksChain?: (opening: number) => boolean;
}
export interface ChainCheckResult {
    chainComplete: boolean;
    reasonKind?: 'closing_matches_reconciled_opening' | 'opening_below_reconciled';
    skipReason?: string;
}
export declare function checkChainComplete(input: ChainCheckInput): ChainCheckResult;
//# sourceMappingURL=scan-chain-check.d.ts.map
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
  reasonKind?:
    | 'closing_matches_reconciled_opening'
    | 'opening_below_reconciled';
  skipReason?: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function checkChainComplete(input: ChainCheckInput): ChainCheckResult {
  if (input.openingBalance === null || input.openingBalance === undefined) {
    return { chainComplete: false };
  }
  const opening = input.openingBalance;
  const eff =
    input.effectiveReconciledBalance ??
    input.fallbackReconciledBalance ??
    null;

  // (A) closing_matches_reconciled_opening
  const chainMatch =
    input.closingBalance !== null &&
    input.closingBalance !== undefined &&
    input.bankRecOpenings.has(round2(input.closingBalance));
  if (chainMatch) {
    return {
      chainComplete: true,
      reasonKind: 'closing_matches_reconciled_opening',
      skipReason: `Statement ${input.filename}: already processed (closing matches reconciled statement's opening)`,
    };
  }

  // (B) opening_below_reconciled
  const belowReconciled = eff !== null && opening < eff - 0.01;
  if (belowReconciled) {
    if (
      input.openingUnblocksChain &&
      input.openingUnblocksChain(opening)
    ) {
      return { chainComplete: false };
    }
    return {
      chainComplete: true,
      reasonKind: 'opening_below_reconciled',
      skipReason: `Statement ${input.filename}: already processed (opening £${opening.toFixed(2)} < reconciled £${eff!.toFixed(2)})`,
    };
  }

  return { chainComplete: false };
}

function round2(n) {
    return Math.round(n * 100) / 100;
}
export function checkChainComplete(input) {
    if (input.openingBalance === null || input.openingBalance === undefined) {
        return { chainComplete: false };
    }
    const opening = input.openingBalance;
    const eff = input.effectiveReconciledBalance ??
        input.fallbackReconciledBalance ??
        null;
    // (A) closing_matches_reconciled_opening
    const chainMatch = input.closingBalance !== null &&
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
        if (input.openingUnblocksChain &&
            input.openingUnblocksChain(opening)) {
            return { chainComplete: false };
        }
        return {
            chainComplete: true,
            reasonKind: 'opening_below_reconciled',
            skipReason: `Statement ${input.filename}: already processed (opening £${opening.toFixed(2)} < reconciled £${eff.toFixed(2)})`,
        };
    }
    return { chainComplete: false };
}
//# sourceMappingURL=scan-chain-check.js.map
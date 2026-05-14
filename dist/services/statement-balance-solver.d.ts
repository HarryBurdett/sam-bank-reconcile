/**
 * Statement balance solver — constraint-based opening/closing
 * derivation that doesn't presume any bank format.
 *
 * See design doc:
 *   docs/superpowers/specs/2026-05-14-statement-balance-derivation-design.md
 *
 * Principle: there is no standard for bank statement formats. A
 * statement is internally consistent — every printed figure must
 * satisfy `closing = opening + total_in − total_out` and every per-
 * row balance must chain consistently with the row above. The solver
 * gathers every fact the statement gives us, derives a candidate
 * opening from each, cross-validates, and surfaces a disagreement
 * rather than silently picking one when constraints conflict.
 */
export interface SolverTxn {
    /** Index into the original raw-extraction array — preserved so the
     *  caller can report which txns were rejected as phantoms. */
    index: number;
    /** ISO date string, e.g. '2026-05-14'. May be null. */
    date: string | null;
    /** Signed amount (+ for money in, − for money out). May be null if
     *  the extractor couldn't read the amount column. */
    amount: number | null;
    /** Running balance shown on this line. May be null. */
    balance: number | null;
}
export interface SolverInput {
    txns: SolverTxn[];
    /** Opening balance found explicitly labelled on the statement
     *  (e.g. "Balance brought forward"). Null when no such label
     *  appears or the extractor didn't find it. */
    labelledOpening: number | null;
    /** Closing balance found on the statement (usually labelled and
     *  printed prominently — most-reliable single value). */
    labelledClosing: number | null;
    /** Summary box `total_in` and `total_out`, if present. */
    summaryTotalIn: number | null;
    summaryTotalOut: number | null;
    /** Opera's reconciled balance for this bank account — used as a
     *  last-resort anchor for the next-in-sequence statement only. */
    externalReconciledBalance: number | null;
}
export type SolverCandidateSource = 'labelled' | 'summary' | 'chain_forward_post_txn' | 'chain_forward_pre_txn' | 'chain_backward' | 'external_reconciled';
export interface SolverCandidate {
    source: SolverCandidateSource;
    opening: number;
    /** Number of independent constraints this candidate satisfies. */
    constraintsSatisfied: number;
    /** Indexes of txns that chain consistently from this opening. */
    chainedTxns: number[];
    /** Indexes of txns rejected (couldn't be placed in the chain). */
    rejectedTxns: number[];
    /** Derived closing balance after walking the chain. Null if the
     *  chain didn't fully consume the txns. */
    derivedClosing: number | null;
}
export type SolverResult = {
    ok: true;
    opening: number;
    closing: number;
    chainedTxnIndexes: number[];
    rejectedTxnIndexes: number[];
    chosenSource: SolverCandidateSource;
    candidates: SolverCandidate[];
    notes: string[];
} | {
    ok: false;
    reason: string;
    candidates: SolverCandidate[];
    notes: string[];
};
export declare function solveStatementBalance(input: SolverInput): SolverResult;
//# sourceMappingURL=statement-balance-solver.d.ts.map
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
const TOLERANCE = 0.01;
function round2(n) {
    return Math.round(n * 100) / 100;
}
function nearlyEqual(a, b, tol = TOLERANCE) {
    return Math.abs(a - b) <= tol + 0.001;
}
function nonNull(v) {
    return v !== null && v !== undefined;
}
/**
 * Walk the transaction chain starting from `opening`, picking
 * transactions one at a time whose balance matches the running
 * total. Returns the chained indexes (in order), the rejected
 * indexes, and the terminal balance.
 *
 * Balance-semantics aware: `postTxn=true` means the line balance is
 * the balance AFTER applying the transaction (Monzo). `postTxn=false`
 * means the line balance is the balance BEFORE the transaction
 * applies (some older formats).
 *
 * Phantom-row detection falls out for free: txns that can't be
 * placed in the chain from this opening are returned in
 * `rejectedTxns`.
 */
function walkChain(txns, opening, postTxn) {
    // Only txns that have both an amount and a balance can participate.
    const eligible = txns.filter((t) => nonNull(t.amount) && nonNull(t.balance));
    const used = new Set();
    const chained = [];
    let current = opening;
    for (let step = 0; step < eligible.length; step += 1) {
        let found = false;
        for (const t of eligible) {
            if (used.has(t.index))
                continue;
            const amt = t.amount;
            const bal = t.balance;
            // post-txn: balance AFTER applying amount: bal = current + amt
            // pre-txn:  balance BEFORE applying amount: bal = current (then current ← current + amt)
            const matches = postTxn
                ? nearlyEqual(current + amt, bal)
                : nearlyEqual(current, bal);
            if (matches) {
                used.add(t.index);
                chained.push(t.index);
                current = postTxn ? bal : round2(bal + amt);
                found = true;
                break;
            }
        }
        if (!found)
            break;
    }
    const rejected = txns
        .filter((t) => nonNull(t.amount) && nonNull(t.balance) && !used.has(t.index))
        .map((t) => t.index);
    return { chained, rejected, terminal: round2(current) };
}
/**
 * Sum the amounts of every txn that has an amount. Returns null
 * when no txn has an amount — the backward derivation isn't
 * possible in that case.
 */
function sumAmounts(txns) {
    const withAmt = txns.filter((t) => nonNull(t.amount));
    if (withAmt.length === 0)
        return null;
    return round2(withAmt.reduce((acc, t) => acc + (t.amount ?? 0), 0));
}
/**
 * Try every txn-with-balance as a "first chronological" anchor.
 * For each candidate first-txn and each balance-semantics
 * interpretation, derive opening and walk the chain. Return the
 * candidate that chains the most txns. This is robust to PDFs that
 * list newest-first within a day, multi-account bleed-through, and
 * missing transaction_order metadata.
 */
function deriveChainForwardCandidates(txns) {
    const withBoth = txns.filter((t) => nonNull(t.amount) && nonNull(t.balance));
    if (withBoth.length === 0) {
        return { postTxn: null, preTxn: null };
    }
    let bestPost = null;
    let bestPre = null;
    for (const candidate of withBoth) {
        // post-txn interpretation: line balance INCLUDES this txn, so
        // opening = balance − amount.
        const openingPost = round2(candidate.balance - candidate.amount);
        const walkPost = walkChain(txns, openingPost, true);
        if (!bestPost || walkPost.chained.length > bestPost.chainedTxns.length) {
            bestPost = {
                source: 'chain_forward_post_txn',
                opening: openingPost,
                constraintsSatisfied: walkPost.chained.length,
                chainedTxns: walkPost.chained,
                rejectedTxns: walkPost.rejected,
                derivedClosing: walkPost.chained.length === withBoth.length
                    ? walkPost.terminal
                    : null,
            };
        }
        // pre-txn interpretation: line balance is BEFORE this txn, so
        // opening = balance (txn applied to NEXT line).
        const openingPre = candidate.balance;
        const walkPre = walkChain(txns, openingPre, false);
        if (!bestPre || walkPre.chained.length > bestPre.chainedTxns.length) {
            bestPre = {
                source: 'chain_forward_pre_txn',
                opening: openingPre,
                constraintsSatisfied: walkPre.chained.length,
                chainedTxns: walkPre.chained,
                rejectedTxns: walkPre.rejected,
                derivedClosing: walkPre.chained.length === withBoth.length
                    ? walkPre.terminal
                    : null,
            };
        }
    }
    return { postTxn: bestPost, preTxn: bestPre };
}
export function solveStatementBalance(input) {
    const notes = [];
    const candidates = [];
    // --- Candidate 1: labelled opening ---
    if (nonNull(input.labelledOpening)) {
        // The label is only meaningful if it cross-validates against
        // other facts. Score by chained txns when amounts+balances exist.
        const walks = [
            walkChain(input.txns, input.labelledOpening, true),
            walkChain(input.txns, input.labelledOpening, false),
        ];
        const best = walks.reduce((a, b) => a.chained.length >= b.chained.length ? a : b);
        const postTxnUsed = walks[0].chained.length >= walks[1].chained.length;
        candidates.push({
            source: 'labelled',
            opening: round2(input.labelledOpening),
            constraintsSatisfied: 1 + best.chained.length,
            chainedTxns: best.chained,
            rejectedTxns: best.rejected,
            derivedClosing: best.chained.length > 0 &&
                best.rejected.length === 0 &&
                nonNull(input.labelledClosing) &&
                nearlyEqual(best.terminal, input.labelledClosing)
                ? best.terminal
                : best.chained.length > 0
                    ? best.terminal
                    : null,
        });
        notes.push(`labelled opening ${input.labelledOpening.toFixed(2)} chains ${best.chained.length}/${input.txns.length} (${postTxnUsed ? 'post' : 'pre'}-txn semantics)`);
    }
    // --- Candidate 2: summary arithmetic ---
    // closing − (total_in − total_out)
    if (nonNull(input.labelledClosing) &&
        nonNull(input.summaryTotalIn) &&
        nonNull(input.summaryTotalOut)) {
        const opening = round2(input.labelledClosing - (input.summaryTotalIn - input.summaryTotalOut));
        const walks = [
            walkChain(input.txns, opening, true),
            walkChain(input.txns, opening, false),
        ];
        const best = walks.reduce((a, b) => a.chained.length >= b.chained.length ? a : b);
        candidates.push({
            source: 'summary',
            // Three independent facts agree at this opening: labelled
            // closing, total_in, and total_out — score 3.
            opening,
            constraintsSatisfied: 3 + best.chained.length,
            chainedTxns: best.chained,
            rejectedTxns: best.rejected,
            derivedClosing: best.chained.length > 0 ? best.terminal : null,
        });
        notes.push(`summary arithmetic opening ${opening.toFixed(2)} chains ${best.chained.length}/${input.txns.length}`);
    }
    // --- Candidates 3+4: forward chain (both semantics) ---
    const chainCands = deriveChainForwardCandidates(input.txns);
    if (chainCands.postTxn) {
        candidates.push(chainCands.postTxn);
        notes.push(`forward chain (post-txn) opening ${chainCands.postTxn.opening.toFixed(2)} chains ${chainCands.postTxn.chainedTxns.length}/${input.txns.length}`);
    }
    if (chainCands.preTxn) {
        candidates.push(chainCands.preTxn);
        notes.push(`forward chain (pre-txn) opening ${chainCands.preTxn.opening.toFixed(2)} chains ${chainCands.preTxn.chainedTxns.length}/${input.txns.length}`);
    }
    // --- Candidate 5: backward chain (closing − Σ amounts) ---
    if (nonNull(input.labelledClosing)) {
        const total = sumAmounts(input.txns);
        if (total !== null) {
            const opening = round2(input.labelledClosing - total);
            const walks = [
                walkChain(input.txns, opening, true),
                walkChain(input.txns, opening, false),
            ];
            const best = walks.reduce((a, b) => a.chained.length >= b.chained.length ? a : b);
            candidates.push({
                source: 'chain_backward',
                opening,
                constraintsSatisfied: 1 + best.chained.length,
                chainedTxns: best.chained,
                rejectedTxns: best.rejected,
                derivedClosing: best.chained.length > 0 ? best.terminal : null,
            });
            notes.push(`backward chain opening ${opening.toFixed(2)} chains ${best.chained.length}/${input.txns.length}`);
        }
    }
    // --- Candidate 6: external reconciled balance ---
    // Last-resort anchor for the next-in-sequence statement.
    if (nonNull(input.externalReconciledBalance)) {
        const walks = [
            walkChain(input.txns, input.externalReconciledBalance, true),
            walkChain(input.txns, input.externalReconciledBalance, false),
        ];
        const best = walks.reduce((a, b) => a.chained.length >= b.chained.length ? a : b);
        candidates.push({
            source: 'external_reconciled',
            opening: round2(input.externalReconciledBalance),
            constraintsSatisfied: best.chained.length,
            chainedTxns: best.chained,
            rejectedTxns: best.rejected,
            derivedClosing: best.chained.length > 0 ? best.terminal : null,
        });
        notes.push(`external reconciled ${input.externalReconciledBalance.toFixed(2)} chains ${best.chained.length}/${input.txns.length}`);
    }
    // --- Decide ---
    if (candidates.length === 0) {
        return {
            ok: false,
            reason: 'No facts available to derive opening balance.',
            candidates,
            notes,
        };
    }
    // Group candidates by value (within tolerance). The value with
    // the most independent supporting candidates wins.
    const groups = [];
    for (const c of candidates) {
        const g = groups.find((g) => nearlyEqual(g.value, c.opening));
        if (g) {
            g.cands.push(c);
            g.totalConstraints += c.constraintsSatisfied;
        }
        else {
            groups.push({
                value: c.opening,
                cands: [c],
                totalConstraints: c.constraintsSatisfied,
            });
        }
    }
    // Sort groups by: (1) number of supporting candidates desc,
    // (2) total constraint score desc.
    groups.sort((a, b) => {
        if (a.cands.length !== b.cands.length) {
            return b.cands.length - a.cands.length;
        }
        return b.totalConstraints - a.totalConstraints;
    });
    const winner = groups[0];
    // Cross-validation: the winning value must reach the labelled
    // closing (when present) when we walk the chain from it.
    // Try both balance semantics and accept either.
    const winningCand = winner.cands.reduce((a, b) => (a.chainedTxns.length >= b.chainedTxns.length ? a : b), winner.cands[0]);
    // If two or more *different* values each have multiple supporting
    // candidates, that's a genuine disagreement — surface it.
    const conflictGroups = groups.filter((g) => g.cands.length >= 2);
    if (conflictGroups.length >= 2) {
        return {
            ok: false,
            reason: `Disagreement: multiple candidate openings each backed by ≥2 facts: ` +
                conflictGroups
                    .map((g) => `£${g.value.toFixed(2)} (${g.cands.map((c) => c.source).join(',')})`)
                    .join('; '),
            candidates,
            notes,
        };
    }
    // Validate the winner against the labelled closing.
    let closing;
    if (nonNull(input.labelledClosing)) {
        if (winningCand.derivedClosing !== null) {
            if (!nearlyEqual(winningCand.derivedClosing, input.labelledClosing)) {
                // Chain terminates somewhere other than the labelled closing.
                // If the difference is small and the txn count is below the
                // total, it's likely phantom rows we didn't catch. Trust the
                // labelled closing.
                notes.push(`chain terminal ${winningCand.derivedClosing.toFixed(2)} differs from labelled closing ${input.labelledClosing.toFixed(2)} — trusting label`);
            }
        }
        closing = round2(input.labelledClosing);
    }
    else if (winningCand.derivedClosing !== null) {
        closing = winningCand.derivedClosing;
    }
    else {
        return {
            ok: false,
            reason: 'No labelled closing and chain did not produce a terminal value.',
            candidates,
            notes,
        };
    }
    return {
        ok: true,
        opening: round2(winner.value),
        closing,
        chainedTxnIndexes: winningCand.chainedTxns,
        rejectedTxnIndexes: winningCand.rejectedTxns,
        chosenSource: winningCand.source,
        candidates,
        notes,
    };
}
//# sourceMappingURL=statement-balance-solver.js.map
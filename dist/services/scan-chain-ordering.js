/**
 * For each statement with no opening_balance and a file_path, look
 * up the PDF extraction cache and patch in cached opening/closing/
 * period balances. Legacy uses sql_rag.pdf_extraction_cache; SAM
 * port doesn't have a cache adapter yet, so this is a no-op until
 * `ctx.bankPdfExtractionCache` is wired. Mutates in place.
 */
export function fillMissingBalancesFromCache(_statements) {
    // No-op: matches legacy line 49-50 (`except Exception: return`)
    // when the cache module isn't available.
}
/**
 * Order statements by walking the balance chain forwards.
 *
 * Starting from `reconciledBalance`, find the statement whose
 * opening_balance matches (within £0.01) and pick it; advance to
 * its closing balance; repeat. If no exact match is found, sort the
 * remaining by opening balance and append.
 *
 * Falls back to a simple opening-balance sort (with sort_key
 * tiebreaker) if there's only one statement or no reconciled
 * balance.
 *
 * Faithful port of scan_chain_ordering.py:90.
 */
export function sortStatementsByChain(statements, reconciledBalance) {
    if (reconciledBalance === null || statements.length <= 1) {
        return [...statements].sort((a, b) => {
            const aHas = a.opening_balance != null ? 0 : 1;
            const bHas = b.opening_balance != null ? 0 : 1;
            if (aHas !== bHas)
                return aHas - bHas;
            const ao = a.opening_balance ?? 0;
            const bo = b.opening_balance ?? 0;
            if (ao !== bo)
                return ao - bo;
            // sort_key tiebreaker
            const ak = a.sort_key ?? [9999, 99, 99, 0];
            const bk = b.sort_key ?? [9999, 99, 99, 0];
            for (let i = 0; i < 4; i++) {
                const av = ak[i] ?? 9999;
                const bv = bk[i] ?? 9999;
                if (av !== bv)
                    return av - bv;
            }
            return 0;
        });
    }
    const ordered = [];
    const remaining = [...statements];
    let currentBal = reconciledBalance;
    while (remaining.length > 0) {
        let bestIdx = null;
        for (let i = 0; i < remaining.length; i++) {
            const opening = remaining[i]?.opening_balance;
            if (opening != null && Math.abs(opening - currentBal) <= 0.01) {
                bestIdx = i;
                break;
            }
        }
        if (bestIdx !== null) {
            const picked = remaining.splice(bestIdx, 1)[0];
            ordered.push(picked);
            const closing = picked.closing_balance;
            if (closing != null)
                currentBal = closing;
        }
        else {
            remaining.sort((a, b) => (a.opening_balance ?? Number.POSITIVE_INFINITY) -
                (b.opening_balance ?? Number.POSITIVE_INFINITY));
            ordered.push(...remaining);
            break;
        }
    }
    return ordered;
}
/**
 * Drop statements whose period is fully reconciled in Opera.
 *
 * Legacy uses sql_rag.period_reconciliation.check_period_reconciled
 * + OperaSEDataSource. Neither is ported to TS yet — so this is a
 * pass-through, mirroring legacy line 185-186
 * (`except Exception: return statements`) when the period_reconciliation
 * module isn't available.
 *
 * To activate full behaviour: port check_period_reconciled (228
 * lines) + OperaSEDataSource (61 lines) into TS, then call them
 * here. Until then the upstream Hub still works because already-
 * imported statements are dedup'd via `already_processed` flag in
 * the main orchestrator.
 */
export function filterFullyReconciledStatements(statements, _bankCode, _reconciledBalance) {
    return statements;
}
//# sourceMappingURL=scan-chain-ordering.js.map
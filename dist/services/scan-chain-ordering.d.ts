/**
 * Helpers for ordering and filtering scan-all-banks statement lists.
 *
 * Faithful port of `apps/bank_reconcile/logic/scan_chain_ordering.py`:
 *   - fillMissingBalancesFromCache
 *   - sortStatementsByChain
 *   - filterFullyReconciledStatements
 *
 * The cache + period-reconciliation deps don't exist in TS yet:
 *   - PDF extraction cache (sql_rag/pdf_extraction_cache.py) — relies
 *     on a per-app SHA256-keyed cache of Gemini-extracted statements.
 *   - check_period_reconciled (sql_rag/period_reconciliation*.py) —
 *     queries Opera anom/aentry/atran/njmemo to derive whether a
 *     period is fully reconciled.
 *
 * Legacy behaviour when those deps aren't available: the helpers
 * fall through to no-ops (see legacy lines 49-50 and 185-186 —
 * `except Exception: return` / `return statements`). Mirror that
 * here: when the optional adapters aren't wired, just pass through.
 */
import type { StatementCandidate } from './scan-all-banks-types.js';
/**
 * For each statement with no opening_balance and a file_path, look
 * up the PDF extraction cache and patch in cached opening/closing/
 * period balances. Legacy uses sql_rag.pdf_extraction_cache; SAM
 * port doesn't have a cache adapter yet, so this is a no-op until
 * `ctx.bankPdfExtractionCache` is wired. Mutates in place.
 */
export declare function fillMissingBalancesFromCache(_statements: StatementCandidate[]): void;
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
export declare function sortStatementsByChain(statements: StatementCandidate[], reconciledBalance: number | null): StatementCandidate[];
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
export declare function filterFullyReconciledStatements(statements: StatementCandidate[], _bankCode: string, _reconciledBalance: number | null): StatementCandidate[];
//# sourceMappingURL=scan-chain-ordering.d.ts.map
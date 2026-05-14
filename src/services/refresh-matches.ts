/**
 * Re-check a list of bank transactions against Opera to surface
 * which are already-posted (duplicates) and which still need posting.
 *
 * Faithful port of `refresh_statement_matches`
 * (apps/bank_reconcile/api/routes.py:1647-1716).
 *
 * The Python implementation calls `BankStatementImport._is_already_posted`
 * which delegates to the type-aware `check_for_duplicate`
 * (sql_rag/duplicate_check.py). That function distinguishes between
 *   - CASHBOOK_DUPLICATE     — already posted, skip
 *   - LEDGER_ALLOCATION_TARGET — exists in SL/PL but as an
 *     allocation target (so post + auto-allocate)
 * with a type-BLIND atran fallback for the cases the matcher couldn't
 * classify cleanly.
 *
 * This TS port reuses the deterministic `findDuplicates` from
 * `duplicate-detection.ts` (all 6 strategies). A candidate with
 * confidence ≥ `posted_threshold` (default 0.85) is treated as
 * already-posted; below that the transaction is left alone.
 *
 * LEDGER_ALLOCATION_TARGET (the type-aware refund advisory) is
 * surfaced separately by `pre-posting-duplicate-check.ts` at import
 * time, not here. refresh-matches is the "operator just posted
 * something in Opera, refresh the preview" path and the
 * threshold-based check on findDuplicates is correct for it:
 * fingerprint and exact-match cases are unambiguous, and the
 * matched_account / action fields the frontend already has cover the
 * discrimination between cashbook and ledger.
 */
import type { Knex } from 'knex';
import { findDuplicates } from './duplicate-detection.js';

export interface RefreshTransactionInput {
  name?: string | null;
  description?: string | null;
  amount: number;
  date?: string | null;
  reference?: string | null;
  matched_account?: string | null;
  fit_id?: string | null;
  action?: string | null;
  is_duplicate?: boolean;
  skip_reason?: string | null;
  /** Anything else the frontend wants preserved. */
  [key: string]: unknown;
}

export interface RefreshedTransaction extends RefreshTransactionInput {
  is_duplicate: boolean;
  skip_reason: string;
  action: string;
}

export interface RefreshMatchesResponse {
  success: boolean;
  transactions: RefreshedTransaction[];
  matched_count: number;
  total: number;
  message?: string;
  error?: string;
}

export interface RefreshMatchesOptions {
  /** Confidence threshold above which a candidate counts as posted. */
  posted_threshold?: number;
}

export async function refreshMatches(
  operaDb: Knex,
  bankCode: string,
  transactions: RefreshTransactionInput[],
  opts: RefreshMatchesOptions = {},
): Promise<RefreshMatchesResponse> {
  const threshold = opts.posted_threshold ?? 0.85;
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return {
      success: true,
      transactions: [],
      matched_count: 0,
      total: 0,
      message: 'no transactions',
    };
  }

  try {
    const out: RefreshedTransaction[] = [];
    let matched = 0;
    for (const t of transactions) {
      const name = (t.name ?? t.description ?? '') as string;
      const date = (t.date as string | null | undefined) ?? new Date().toISOString().slice(0, 10);
      const candidates = await findDuplicates(operaDb, {
        name,
        amount: Number(t.amount ?? 0),
        date,
        bank_code: bankCode,
        account: (t.matched_account ?? null) as string | null,
        fit_id: (t.fit_id ?? null) as string | null,
        reference: (t.reference ?? null) as string | null,
      });
      const top = candidates.find((c) => c.confidence >= threshold);
      const isPosted = !!top;
      if (isPosted) matched += 1;
      const skipReason = top
        ? `already posted: ${top.table}.${top.record_id} (${top.match_type})`
        : (t.skip_reason ?? '');
      const action = isPosted ? 'skip' : (t.action ?? '');
      out.push({
        ...t,
        is_duplicate: isPosted,
        skip_reason: String(skipReason ?? ''),
        action: String(action ?? ''),
      });
    }
    return {
      success: true,
      transactions: out,
      matched_count: matched,
      total: transactions.length,
      message: `${matched} transaction(s) now matched to Opera entries`,
    };
  } catch (err: any) {
    return {
      success: false,
      transactions: [],
      matched_count: 0,
      total: transactions.length,
      error: err?.message ?? String(err),
    };
  }
}

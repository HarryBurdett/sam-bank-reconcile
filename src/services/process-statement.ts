/**
 * Process a bank statement — extract + match in one pass.
 *
 * Faithful port of `process_bank_statement`
 * (apps/bank_reconcile/api/routes.py:1370-1645) and
 * `process_statement_unified` (1719+).
 *
 * Pipeline:
 *   1. Extract statement + transactions via ctx.llm
 *   2. Build a shared MatchContext (load customers, suppliers, other
 *      banks for transfer detection)
 *   3. For each transaction:
 *      - Run duplicate detection (six-strategy via findDuplicates)
 *      - Run the full _match_transaction flow:
 *           Stage 0    repeat-entry check (arhead/arline)
 *           Stage 0.5  bank-transfer detection (other Opera banks)
 *           Stage 1    alias lookup (per-bank → global)
 *           Stage 2    fuzzy match (BankMatcher, with payee-clean
 *                      fallback)
 *           Stage 3    ambiguity resolution + credit-note refund
 *                      detection (when payment matched customer or
 *                      receipt matched supplier)
 *           Stage 4    direction-based decision + alias learning at
 *                      score ≥ 0.85
 *      - Translate the matcher result back into the existing UI shape
 *        (suggested_account, ledger_type, action)
 *
 * Backwards-compatible response: matched_transactions[] retains the
 * legacy shape; new fields (refund_credit_note, bank_transfer_details,
 * repeat_entry_ref, etc.) are additive.
 */
import type { Knex } from 'knex';
import { findDuplicates } from './duplicate-detection.js';
import {
  previewBankImportFromPdf,
  type LlmService,
  type PreviewResponse,
} from './preview-from-pdf.js';
import { type TransactionType } from './suggest-account.js';
import {
  buildMatchContext,
  matchTransaction,
  type MatchContext,
  type MatchAction,
} from './match-transaction.js';
import {
  loadCustomerCandidates,
  loadSupplierCandidates,
} from './bank-matcher.js';
import {
  buildBankLineTracking,
  bankLineTrackingKey,
} from './bank-line-tracking.js';

export interface ProcessTransaction {
  date: string | null;
  name: string | null;
  memo: string | null;
  amount: number;
  type: string;
  balance?: number | null;
  line_number?: number;
  is_duplicate: boolean;
  duplicate_reason: string | null;
  suggested_account: {
    code: string;
    name: string;
    score: number;
    match_type: string;
  } | null;
  ledger_type: 'C' | 'S' | null;
  /**
   * Final matched action — extends the legacy TransactionType enum
   * with `bank_transfer` / `repeat_entry` / `defer` so the UI can
   * render the new categories.
   */
  action: TransactionType | MatchAction | 'skip';
  match_source?: string;
  match_score?: number;
  skip_reason?: string | null;
  /** When action = 'bank_transfer' */
  bank_transfer_details?: { dest_bank: string } | null;
  /** When action = 'repeat_entry' */
  repeat_entry?: {
    entry_ref: string;
    entry_desc: string;
    next_post_date: string | null;
    freq: string;
    every: number;
    posted: number;
    topost: number;
  } | null;
  /** When action = 'sales_refund' or 'purchase_refund' */
  refund_credit_note?: string | null;
  refund_credit_amount?: number;
}

export interface ProcessStatementResponse extends PreviewResponse {
  matched_transactions?: ProcessTransaction[];
  matched_count?: number;
  duplicate_count?: number;
}

function matchTypeFromAction(
  action: MatchAction,
): ProcessTransaction['suggested_account'] extends infer R ? string : never;
function matchTypeFromAction(action: MatchAction): string {
  switch (action) {
    case 'sales_receipt':
    case 'sales_refund':
      return 'customer';
    case 'purchase_payment':
    case 'purchase_refund':
      return 'supplier';
    case 'bank_transfer':
      return 'bank';
    case 'repeat_entry':
      return 'repeat_entry';
    default:
      return '';
  }
}

export async function processStatement(
  operaDb: Knex,
  llm: LlmService,
  input: {
    filePath?: string;
    pdfBytes?: Uint8Array;
    bankCode: string;
  },
  appDb?: Knex | null,
): Promise<ProcessStatementResponse> {
  const preview = await previewBankImportFromPdf(operaDb, llm, input);
  if (!preview.success || !preview.transactions) {
    return preview;
  }

  // Build the match context once for the whole statement — loading the
  // full customer + supplier set + other banks. Significant work, must
  // not happen per-row.
  let ctx: MatchContext | null = null;
  try {
    const [customers, suppliers] = await Promise.all([
      loadCustomerCandidates(operaDb),
      loadSupplierCandidates(operaDb),
    ]);
    ctx = await buildMatchContext(operaDb, input.bankCode, {
      customers,
      suppliers,
    });
  } catch {
    ctx = null;
  }

  // Load SAM's per-line tracking for this bank, scoped to imports
  // whose statement_date overlaps the preview window. Two facts come
  // back per (date, amount) key:
  //
  //   - posted_entry_number — authoritative "is this posted to Opera"
  //     signal; overrides Opera-side findDuplicates so orphan-clear /
  //     re-analysis flows don't re-flag lines as posted just because a
  //     same-amount Opera entry exists within ±14 days.
  //
  //   - is_reconciled — when set, the line has been definitively
  //     reconciled. We MUST NOT run the matcher (including the Stage-0
  //     repeat-entry check) on it. As the operator put it: "anything
  //     reconciled is correct". Reclassifying a reconciled line is a
  //     regression risk with no upside.
  //
  // Both are best-effort: any error returns an empty map and the
  // matcher falls back to the Opera-only path. See
  // ./bank-line-tracking.ts for the scoping/ambiguity guards.
  const info = preview.statement_info ?? null;
  const trackedByKey = await buildBankLineTracking({
    appDb: appDb ?? null,
    bankCode: input.bankCode,
    scopeAnchor:
      info?.statement_date ?? info?.period_end ?? info?.period_start ?? null,
  });

  const matched: ProcessTransaction[] = [];
  let duplicateCount = 0;
  let matchedCount = 0;

  for (const txn of preview.transactions) {
    const dateYmd = (txn.date ?? '').slice(0, 10);
    const tracked = trackedByKey.get(
      bankLineTrackingKey(dateYmd, Number(txn.amount ?? 0)),
    );

    // Reconciled gate — "anything reconciled is correct, leave it
    // alone". When the stored row carries is_reconciled=1 (and the
    // (date, amount) key isn't ambiguous), we treat the line as
    // skip/already-done and DO NOT run the matcher. This prevents the
    // Stage-0 repeat-entry check (and the customer/supplier matcher)
    // from re-classifying a line the operator already pinned. It also
    // catches edge cases the Opera-side findDuplicates probe misses
    // (entries archived to aentryh, cycle-merge preservation, etc.).
    const isReconciled = !!(tracked && tracked.count === 1 && tracked.is_reconciled);

    // Duplicate detection (preserved from prior implementation)
    const candidates = await findDuplicates(operaDb, {
      name: txn.name ?? '',
      amount: txn.amount,
      date: txn.date ?? new Date().toISOString().slice(0, 10),
      bank_code: input.bankCode,
    });
    const top = candidates.find((c) => c.confidence >= 0.85);
    // SAM-side per-line tracking is the source of truth when present
    // AND unambiguous (exactly one stored row matches this date+amount
    // within the statement scope). A tracked row with posted_entry_number
    // set → posted. A tracked row with it cleared (e.g. after orphan
    // recovery) → explicitly not posted, ignore the Opera-side
    // findDuplicates result. Multiple stored rows for the same
    // date+amount fall back to findDuplicates so we don't make a wrong
    // override.
    const isDup =
      isReconciled ||
      (tracked && tracked.count === 1
        ? !!(tracked.posted_entry_number && tracked.posted_entry_number.trim())
        : !!top);
    if (isDup) duplicateCount += 1;

    let suggestedAccount: ProcessTransaction['suggested_account'] = null;
    let ledgerType: 'C' | 'S' | null = null;
    let finalAction: ProcessTransaction['action'] = isDup
      ? 'skip'
      : txn.amount > 0
        ? 'sales_receipt'
        : 'purchase_payment';
    let matchSource = '';
    let matchScore = 0;
    let skipReason: string | null = isReconciled
      ? 'Already reconciled'
      : null;
    let bankTransferDetails: { dest_bank: string } | null = null;
    let repeatEntry: ProcessTransaction['repeat_entry'] = null;
    let refundCreditNote: string | null = null;
    let refundCreditAmount = 0;

    if (!isDup && ctx) {
      const matchResult = await matchTransaction(
        operaDb,
        appDb ?? null,
        ctx,
        {
          bankCode: input.bankCode,
          date: txn.date ?? new Date().toISOString().slice(0, 10),
          amount: txn.amount,
          name: (txn.name ?? '').trim(),
          reference: '', // Preview doesn't expose a separate ref column
          memo: (txn.memo ?? '').trim(),
        },
      );

      finalAction = matchResult.action;
      matchSource = matchResult.match_source;
      matchScore = matchResult.match_score;
      skipReason = matchResult.skip_reason;
      bankTransferDetails = matchResult.bank_transfer_details;
      refundCreditNote = matchResult.refund_credit_note;
      refundCreditAmount = matchResult.refund_credit_amount;
      if (matchResult.repeat_entry) {
        repeatEntry = {
          entry_ref: matchResult.repeat_entry.entry_ref,
          entry_desc: matchResult.repeat_entry.entry_desc,
          next_post_date: matchResult.repeat_entry.next_post_date,
          freq: matchResult.repeat_entry.freq,
          every: matchResult.repeat_entry.every,
          posted: matchResult.repeat_entry.posted,
          topost: matchResult.repeat_entry.topost,
        };
      }

      if (matchResult.matched_account) {
        suggestedAccount = {
          code: matchResult.matched_account,
          name: matchResult.matched_name ?? '',
          score: Math.round(matchResult.match_score * 100),
          match_type: matchResult.match_source || matchTypeFromAction(matchResult.action),
        };
        if (matchResult.match_type === 'customer') ledgerType = 'C';
        else if (matchResult.match_type === 'supplier') ledgerType = 'S';
        if (matchResult.match_score >= 0.6) matchedCount += 1;
      }
    }

    matched.push({
      date: txn.date,
      name: txn.name,
      memo: txn.memo,
      amount: txn.amount,
      type: txn.type ?? 'credit',
      balance: txn.balance ?? null,
      line_number: txn.line_number,
      is_duplicate: isDup,
      duplicate_reason: top
        ? `${top.table}.${top.record_id} (${top.match_type})`
        : null,
      suggested_account: suggestedAccount,
      ledger_type: ledgerType,
      action: finalAction,
      match_source: matchSource,
      match_score: matchScore,
      skip_reason: skipReason,
      bank_transfer_details: bankTransferDetails,
      repeat_entry: repeatEntry,
      refund_credit_note: refundCreditNote,
      refund_credit_amount: refundCreditAmount,
    });
  }

  return {
    ...preview,
    matched_transactions: matched,
    matched_count: matchedCount,
    duplicate_count: duplicateCount,
  };
}

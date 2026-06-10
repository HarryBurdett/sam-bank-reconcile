/**
 * `_match_transaction` orchestrator — the per-transaction matching
 * brain used during PDF import / preview.
 *
 * Faithful port of `BankImporter._match_transaction`
 * (sql_rag/bank_import.py:1297-1495). The legacy six-stage flow:
 *
 *   Stage 0  Repeat-entry check (handled by Opera auto-post)
 *   Stage 0.5 Bank-transfer detection (matches another Opera bank)
 *   Stage 1  Alias lookup (per-bank then global)
 *   Stage 2  Fuzzy match (BankMatcher) — full name, then payee-cleaned
 *   Stage 3  Ambiguity resolution + refund-detection-via-credit-note
 *   Stage 4  Save high-score alias for next time
 *
 * One `matchTransaction(...)` call returns the decided action +
 * matched account + match metadata. Caller (process-statement) uses
 * this to populate each row's `action`/`suggested_account`/
 * `ledger_type` before returning the preview to the frontend.
 *
 * Portable across Opera SE (MSSQL) and Opera 3 (FoxPro) — all queries
 * are routed through helper services that already use Knex builder.
 */
import type { Knex } from 'knex';
import { extractPayeeName } from './extract-payee-name.js';
import { BankMatcher, type MatchCandidate } from './bank-matcher.js';
import {
  lookupAlias,
  saveAlias,
  type LedgerType,
} from './bank-aliases.js';
import {
  checkBankTransfer,
  loadOtherBankAccounts,
  type OtherBank,
} from './check-bank-transfer.js';
import {
  checkRepeatEntry,
  type RepeatEntryMatch,
} from './check-repeat-entry.js';
import { checkCustomerRefund, checkPurchaseRefund } from './check-refund.js';

export type MatchAction =
  | 'sales_receipt'
  | 'purchase_payment'
  | 'sales_refund'
  | 'purchase_refund'
  | 'bank_transfer'
  | 'repeat_entry'
  | 'skip'
  | 'defer';

export interface MatchTransactionInput {
  bankCode: string;
  /** YYYY-MM-DD transaction date. */
  date: string;
  /** Signed amount in pounds — positive = receipt, negative = payment. */
  amount: number;
  /** Extracted payee/payer name from the bank line. */
  name: string;
  /** Bank reference (e.g. cheque number, faster-payment ref). */
  reference: string;
  /** Full memo as it appears on the statement. */
  memo: string;
  /** If user already deferred this row, preserve. */
  preDeferred?: boolean;
}

export interface MatchTransactionResult {
  action: MatchAction;
  match_type: 'customer' | 'supplier' | null;
  matched_account: string | null;
  matched_name: string | null;
  match_score: number;
  match_source: string;
  skip_reason: string | null;
  /** When action = 'bank_transfer' */
  bank_transfer_details: { dest_bank: string } | null;
  /** When action = 'repeat_entry' */
  repeat_entry: RepeatEntryMatch | null;
  /** When action = 'sales_refund' or 'purchase_refund' — credit note used. */
  refund_credit_note: string | null;
  refund_credit_amount: number;
}

/**
 * Loaded once per import, shared across all transactions in the run.
 * Significant work to build (loads sname + pname + nbank); reusing it
 * across rows is essential for batch performance.
 */
export interface MatchContext {
  bankCode: string;
  companyCode: string;
  matcher: BankMatcher;
  otherBanks: OtherBank[];
  /**
   * Score threshold above which to auto-save a learned alias. Defaults
   * to 0.85 per legacy `learn_threshold`.
   */
  learnThreshold: number;
}

export async function buildMatchContext(
  operaDb: Knex,
  bankCode: string,
  companyCode: string,
  opts: {
    customers: MatchCandidate[];
    suppliers: MatchCandidate[];
    minScore?: number;
    learnThreshold?: number;
  },
): Promise<MatchContext> {
  const matcher = new BankMatcher(opts.minScore ?? 0.6);
  matcher.loadCustomers(opts.customers);
  matcher.loadSuppliers(opts.suppliers);
  const otherBanks = await loadOtherBankAccounts(operaDb, bankCode);
  return {
    bankCode,
    companyCode,
    matcher,
    otherBanks,
    learnThreshold: opts.learnThreshold ?? 0.85,
  };
}

function emptyResult(): MatchTransactionResult {
  return {
    action: 'skip',
    match_type: null,
    matched_account: null,
    matched_name: null,
    match_score: 0,
    match_source: '',
    skip_reason: null,
    bank_transfer_details: null,
    repeat_entry: null,
    refund_credit_note: null,
    refund_credit_amount: 0,
  };
}

/**
 * Drives the legacy match flow. Returns a full result describing the
 * decision; never throws (errors fall through to skip with reason).
 */
export async function matchTransaction(
  operaDb: Knex,
  appDb: Knex | null,
  ctx: MatchContext,
  input: MatchTransactionInput,
): Promise<MatchTransactionResult> {
  const result = emptyResult();
  if (input.preDeferred) {
    result.action = 'defer';
    return result;
  }

  const isReceipt = input.amount > 0;
  const absAmount = Math.abs(input.amount);
  const expectedLedger: LedgerType = isReceipt ? 'C' : 'S';

  // === Stage 0: repeat entry ===
  try {
    const repeat = await checkRepeatEntry(operaDb, appDb, ctx.companyCode, {
      bankCode: ctx.bankCode,
      date: input.date,
      amountPounds: input.amount,
      name: input.name,
      reference: input.reference,
      memo: input.memo,
    });
    if (repeat.is_match) {
      result.action = 'repeat_entry';
      result.repeat_entry = repeat;
      result.match_source = `repeat_entry:${repeat.match_kind}`;
      return result;
    }
  } catch {
    // skip stage on error
  }

  // === Stage 0.5: bank transfer ===
  try {
    const transfer = checkBankTransfer(
      ctx.otherBanks,
      input.memo,
      input.name,
      input.reference,
    );
    if (transfer.is_transfer) {
      result.action = 'bank_transfer';
      result.matched_account = transfer.dest_bank_code;
      result.matched_name = transfer.dest_bank_description;
      result.match_score = transfer.match_score;
      result.match_source = transfer.match_source;
      result.bank_transfer_details = { dest_bank: transfer.dest_bank_code };
      return result;
    }
  } catch {
    // skip stage on error
  }

  const cleanName = extractPayeeName(input.name);

  // === Stage 1: alias lookup (per-bank → global) ===
  if (appDb) {
    try {
      let alias = await lookupAlias(
        appDb,
        ctx.companyCode,
        input.name,
        expectedLedger,
        ctx.bankCode,
      );
      if (!alias && cleanName && cleanName !== input.name) {
        alias = await lookupAlias(
          appDb,
          ctx.companyCode,
          cleanName,
          expectedLedger,
          ctx.bankCode,
        );
      }
      if (alias) {
        const candidate =
          expectedLedger === 'C'
            ? ctx.matcher.customers.get(alias.account)
            : ctx.matcher.suppliers.get(alias.account);
        if (candidate) {
          result.action = isReceipt ? 'sales_receipt' : 'purchase_payment';
          result.match_type = expectedLedger === 'C' ? 'customer' : 'supplier';
          result.matched_account = alias.account;
          result.matched_name = candidate.primary_name;
          result.match_score = 1.0;
          result.match_source = 'alias';
          return result;
        }
      }
    } catch {
      // skip stage on error
    }
  }

  // === Stage 2: fuzzy match (full name; fall back to clean name) ===
  let custResult = ctx.matcher.matchCustomer(input.name);
  let suppResult = ctx.matcher.matchSupplier(input.name);
  if (
    cleanName &&
    cleanName !== input.name &&
    !custResult.is_match &&
    !suppResult.is_match
  ) {
    const c2 = ctx.matcher.matchCustomer(cleanName);
    const s2 = ctx.matcher.matchSupplier(cleanName);
    if (c2.score > custResult.score) custResult = c2;
    if (s2.score > suppResult.score) suppResult = s2;
  }

  // === Stage 3: ambiguity resolution ===
  if (custResult.is_match && suppResult.is_match) {
    const scoreDiff = Math.abs(custResult.score - suppResult.score);

    // Very similar scores — flag for review but seat under the
    // direction-implied side.
    if (scoreDiff < 0.15) {
      if (isReceipt) {
        result.action = 'sales_receipt';
        result.match_type = 'customer';
        result.matched_account = custResult.account;
        result.matched_name = custResult.name;
        result.match_score = custResult.score;
      } else {
        result.action = 'purchase_payment';
        result.match_type = 'supplier';
        result.matched_account = suppResult.account;
        result.matched_name = suppResult.name;
        result.match_score = suppResult.score;
      }
      result.match_source = 'fuzzy_ambiguous';
      result.skip_reason = `Review: matches both customer (${custResult.name}) and supplier (${suppResult.name})`;
      return result;
    }

    // Direction-vs-score conflict: receipt scored higher on supplier,
    // or payment scored higher on customer — flag for review but
    // categorise per direction. Payment side also runs refund-detect.
    if (isReceipt) {
      if (custResult.score > suppResult.score) {
        // Fall through to receipt handling below — customer is best
        // match.
      } else {
        result.action = 'sales_receipt';
        result.match_type = 'customer';
        result.matched_account = custResult.account;
        result.matched_name = custResult.name;
        result.match_score = custResult.score;
        result.match_source = 'fuzzy_review';
        result.skip_reason = `Review: supplier score (${suppResult.score.toFixed(2)}) higher than customer (${custResult.score.toFixed(2)})`;
        return result;
      }
    } else {
      if (suppResult.score > custResult.score) {
        // Fall through to payment handling below — supplier is best
        // match.
      } else {
        // Customer scored higher on a payment — check credit note for
        // genuine sales refund.
        const refund = await checkCustomerRefund(
          operaDb,
          custResult.account ?? '',
          absAmount,
        );
        if (refund.is_refund) {
          result.action = 'sales_refund';
          result.match_type = 'customer';
          result.matched_account = custResult.account;
          result.matched_name = custResult.name;
          result.match_score = custResult.score;
          result.match_source = 'fuzzy';
          result.refund_credit_note = refund.credit_note_ref;
          result.refund_credit_amount = refund.credit_note_amount;
          return result;
        }
        // No credit note — fall through and treat as payment with
        // review flag.
        result.action = 'purchase_payment';
        result.match_type = 'supplier';
        result.matched_account = suppResult.account;
        result.matched_name = suppResult.name;
        result.match_score = suppResult.score;
        result.match_source = 'fuzzy_review';
        result.skip_reason = `Review: customer score (${custResult.score.toFixed(2)}) higher than supplier (${suppResult.score.toFixed(2)})`;
        return result;
      }
    }
  }

  // === Stage 4: direction-based decision + refund-detection ===
  if (isReceipt) {
    if (custResult.is_match) {
      result.action = 'sales_receipt';
      result.match_type = 'customer';
      result.matched_account = custResult.account;
      result.matched_name = custResult.name;
      result.match_score = custResult.score;
      result.match_source = 'fuzzy';

      // Save alias if score is high enough — bank-scoped.
      if (appDb && custResult.score >= ctx.learnThreshold && custResult.account) {
        await saveAlias(appDb, ctx.companyCode, {
          payeeName: input.name,
          ledger: 'C',
          operaAccount: custResult.account,
          matchScore: custResult.score,
          accountName: custResult.name,
          bankCode: ctx.bankCode,
          direction: 'receipt',
        }).catch(() => {});
      }
    } else if (suppResult.is_match) {
      // Receipt matches supplier — could be supplier refund (we paid
      // them and they refunded us)
      const refund = await checkPurchaseRefund(
        operaDb,
        suppResult.account ?? '',
        absAmount,
      );
      if (refund.is_refund) {
        result.action = 'purchase_refund';
        result.match_type = 'supplier';
        result.matched_account = suppResult.account;
        result.matched_name = suppResult.name;
        result.match_score = suppResult.score;
        result.match_source = 'fuzzy';
        result.refund_credit_note = refund.credit_note_ref;
        result.refund_credit_amount = refund.credit_note_amount;
      } else {
        result.action = 'skip';
        result.skip_reason = `Receipt matches supplier ${suppResult.name} but not a customer — assign manually`;
      }
    } else {
      result.action = 'skip';
      result.skip_reason = `No customer match found (best score: ${custResult.score.toFixed(2)})`;
    }
  } else {
    // Payment direction.
    if (suppResult.is_match) {
      result.action = 'purchase_payment';
      result.match_type = 'supplier';
      result.matched_account = suppResult.account;
      result.matched_name = suppResult.name;
      result.match_score = suppResult.score;
      result.match_source = 'fuzzy';

      if (appDb && suppResult.score >= ctx.learnThreshold && suppResult.account) {
        await saveAlias(appDb, ctx.companyCode, {
          payeeName: input.name,
          ledger: 'S',
          operaAccount: suppResult.account,
          matchScore: suppResult.score,
          accountName: suppResult.name,
          bankCode: ctx.bankCode,
          direction: 'payment',
        }).catch(() => {});
      }
    } else if (custResult.is_match) {
      // Payment matched customer — could be sales refund.
      const refund = await checkCustomerRefund(
        operaDb,
        custResult.account ?? '',
        absAmount,
      );
      if (refund.is_refund) {
        result.action = 'sales_refund';
        result.match_type = 'customer';
        result.matched_account = custResult.account;
        result.matched_name = custResult.name;
        result.match_score = custResult.score;
        result.match_source = 'fuzzy';
        result.refund_credit_note = refund.credit_note_ref;
        result.refund_credit_amount = refund.credit_note_amount;
      } else {
        result.action = 'skip';
        result.skip_reason = `Payment matches customer ${custResult.name} but not a supplier — assign manually`;
      }
    } else {
      result.action = 'skip';
      result.skip_reason = `No supplier match found (best score: ${suppResult.score.toFixed(2)})`;
    }
  }

  return result;
}

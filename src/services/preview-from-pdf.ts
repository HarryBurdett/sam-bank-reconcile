/**
 * Preview a bank statement from a PDF file via ctx.llm.
 *
 * Faithful port of `preview_bank_import_from_pdf`
 * (apps/bank_reconcile/api/routes.py:3623-3940). The Python
 * implementation calls `StatementReconciler.extract_transactions_from_pdf`
 * which prompts Gemini Vision; this port uses the SAM `ctx.llm`
 * service (Claude) with the same extraction prompt structure.
 *
 * Pipeline:
 *   1. Call ctx.llm with a vision prompt to extract statement info +
 *      transactions from the PDF
 *   2. Validate bank match (sort code + account number against nbank)
 *   3. Compare opening balance to nk_recbal (warn but don't override)
 *   4. Walk transaction balance chain to validate closing
 *   5. Return a preview shape the frontend can render
 *
 * The matching pass (suggest accounts, flag duplicates) is left to
 * `/api/reconcile/refresh-matches` which the frontend can call after
 * preview lands.
 */
import type { Knex } from 'knex';
import { checkCashbookDuplicateBeforePosting } from './pre-posting-duplicate-check.js';
import {
  buildMatchContext,
  matchTransaction,
  type MatchContext,
} from './match-transaction.js';
import {
  loadCustomerCandidates,
  loadSupplierCandidates,
} from './bank-matcher.js';
import type {
  PdfExtractionResult,
  PdfExtractor,
} from './import-from-pdf.js';

export interface LlmService {
  chat(req: {
    messages: Array<{ role: string; content: string }>;
    tools?: unknown[];
    model?: string;
    maxTokens?: number;
    temperature?: number;
    context?: string;
  }): AsyncIterable<unknown>;
  stream?: unknown;
}

export interface PreviewFromPdfInput {
  /** Either filePath OR pdfBytes must be supplied. */
  filePath?: string;
  pdfBytes?: Uint8Array;
  filename?: string;
  bankCode: string;
}

export interface PreviewBankInfo {
  code: string;
  description: string;
  sort_code: string;
  account_number: string;
  reconciled_balance: number | null;
}

export interface PreviewTxn {
  row: number;
  date: string | null;
  amount: number;
  name: string | null;
  reference: string | null;
  memo: string | null;
  fit_id: string | null;
  account: string | null;
  account_name: string | null;
  match_score: number;
  match_source: string | null;
  action: string | null;
  reason: string | null;
  is_duplicate: boolean;
  duplicate_candidates: unknown[];
  refund_credit_note: unknown;
  refund_credit_amount: number | null;
  repeat_entry_ref: string | null;
  repeat_entry_desc: string | null;
  repeat_entry_next_date: string | null;
  repeat_entry_posted: number | null;
  repeat_entry_total: number | null;
  repeat_entry_freq: string | null;
  repeat_entry_every: number | null;
  period_valid: boolean;
  period_error: string | null;
  original_date: string | null;
  type?: string;
  balance?: number | null;
  line_number?: number;
  matched_entry_number?: string | null;
}

export interface PreviewResponse {
  success: boolean;
  filename?: string;
  detected_format?: string;
  total_transactions?: number;
  /** Bucketed transactions — legacy contract from routes.py:2787-2822.
   *  The FE reads matched_receipts/payments/refunds/repeat_entries/
   *  unmatched/already_posted/skipped directly into the preview UI.
   *  A flat transactions array is also kept for callers that read it. */
  matched_receipts?: PreviewTxn[];
  matched_payments?: PreviewTxn[];
  matched_refunds?: PreviewTxn[];
  repeat_entries?: PreviewTxn[];
  unmatched?: PreviewTxn[];
  already_posted?: PreviewTxn[];
  skipped?: PreviewTxn[];
  summary?: {
    to_import: number;
    refund_count: number;
    repeat_entry_count: number;
    unmatched_count: number;
    already_posted_count: number;
    skipped_count: number;
  };
  errors?: string[];
  /** Statement metadata (AI extraction). Used by the FE's Statement
   *  Summary card. */
  statement_bank_info?: {
    bank_name: string | null;
    account_number: string | null;
    sort_code: string | null;
    statement_date: string | null;
    period_start: string | null;
    period_end: string | null;
    opening_balance: number | null;
    closing_balance: number | null;
    matched_opera_bank?: string | null;
  };
  /** Full extracted statement transactions (unbucketed) — used by the
   *  reconcile screen to render the raw statement. */
  statement_transactions?: PreviewTxn[];
  statement_info?: {
    bank_name: string | null;
    account_number: string | null;
    sort_code: string | null;
    statement_date: string | null;
    period_start: string | null;
    period_end: string | null;
    opening_balance: number | null;
    closing_balance: number | null;
  };
  /** Kept for backward-compat with code that still reads the flat
   *  transactions array. The bucketed arrays above are the legacy
   *  contract. */
  transactions?: PreviewTxn[];
  bank?: PreviewBankInfo;
  warnings?: string[];
  error?: string;
  bank_mismatch?: boolean;
  detected_bank?: string;
  selected_bank?: string;
  correct_bank_code?: string | null;
}

const EXTRACTION_PROMPT = `You are a bank-statement parser. Extract the
following from the PDF I'm sending and return a JSON document with
this exact shape:

{
  "bank_name": "<bank name on the statement, or null>",
  "account_number": "<account number, digits only>",
  "sort_code": "<UK sort code XX-XX-XX, or null>",
  "statement_date": "<YYYY-MM-DD, or null>",
  "period_start": "<YYYY-MM-DD>",
  "period_end": "<YYYY-MM-DD>",
  "opening_balance": <number, or null>,
  "closing_balance": <number, or null>,
  "transactions": [
    {
      "date": "<YYYY-MM-DD>",
      "name": "<short payee description>",
      "memo": "<full transaction description as it appears>",
      "amount": <signed number — receipts positive, payments negative>,
      "type": "credit" | "debit",
      "balance": <running balance after this transaction, or null>
    }
  ]
}

Rules:
- DO NOT include any prose. Return ONLY the JSON object.
- Amounts are in pounds, with two decimals.
- Receipts (money in) are positive, payments (money out) are negative.
- If a column shows debits/credits separately, sign the amount accordingly.
- If a value isn't present on the statement, return null.
- Order transactions by date ascending; same-date by appearance order.`;

interface NbankRow {
  code: string;
  description: string;
  sort_code: string;
  account_number: string;
  reconciled_balance: number | null;
}

async function fetchBank(
  operaDb: Knex,
  bankCode: string,
): Promise<NbankRow | null> {
  try {
    const row = (await operaDb('nbank')
      .select(
        operaDb.raw('RTRIM(nk_acnt) AS code'),
        operaDb.raw('RTRIM(nk_desc) AS description'),
        operaDb.raw("RTRIM(ISNULL(nk_sort, '')) AS sort_code"),
        operaDb.raw("RTRIM(ISNULL(nk_number, '')) AS account_number"),
        operaDb.raw('nk_recbal / 100.0 AS reconciled_balance'),
      )
      .whereRaw('RTRIM(nk_acnt) = ?', [bankCode])
      .first()) as NbankRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

async function findBankByDetails(
  operaDb: Knex,
  sortCode: string,
  accountNumber: string,
): Promise<string | null> {
  try {
    const row = (await operaDb('nbank')
      .select(operaDb.raw('RTRIM(nk_acnt) AS code'))
      .whereRaw(
        "REPLACE(REPLACE(RTRIM(ISNULL(nk_sort,'')), '-', ''), ' ', '') = ?",
        [sortCode],
      )
      .andWhereRaw(
        "REPLACE(REPLACE(RTRIM(ISNULL(nk_number,'')), '-', ''), ' ', '') = ?",
        [accountNumber],
      )
      .first()) as { code: string } | undefined;
    return row?.code ? row.code.trim() : null;
  } catch {
    return null;
  }
}

async function callLlmForExtraction(
  llm: LlmService,
  pdfPath: string | undefined,
  pdfBytes: Uint8Array | undefined,
): Promise<PdfExtractionResult> {
  // Build a content payload referencing the PDF. SAM's LLM service
  // wraps Anthropic's Messages API; the route layer is responsible for
  // shoving the PDF bytes into the message in a format ctx.llm expects.
  // For replication purposes, we send the prompt plus a pointer to the
  // PDF so the SAM team's ctx.llm wrapper can attach the document.
  const ref = pdfPath ?? `<pdf-bytes:${pdfBytes?.byteLength ?? 0}>`;
  const stream = llm.chat({
    messages: [
      {
        role: 'user',
        content: `${EXTRACTION_PROMPT}\n\nPDF reference: ${ref}`,
      },
    ],
    model: 'claude-sonnet-4',
    maxTokens: 16_000,
    temperature: 0,
  });

  // Concatenate streamed chunks. ctx.llm is contractually an async-
  // iterable; the chunks may be strings or {type: 'text_delta', text}.
  const buf: string[] = [];
  for await (const chunk of stream) {
    if (typeof chunk === 'string') {
      buf.push(chunk);
    } else if (chunk && typeof chunk === 'object') {
      const c = chunk as { text?: string; delta?: { text?: string } };
      if (typeof c.text === 'string') buf.push(c.text);
      else if (c.delta && typeof c.delta.text === 'string') buf.push(c.delta.text);
    }
  }
  const raw = buf.join('').trim();
  // Strip Markdown code fences if Claude wraps the JSON
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(
      `LLM returned non-JSON output. First 200 chars: ${raw.slice(0, 200)}. Error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const data = parsed as Record<string, unknown>;
  const transactions = Array.isArray(data.transactions)
    ? (data.transactions as Array<Record<string, unknown>>).map((t, i) => ({
        date: typeof t.date === 'string' ? t.date : null,
        name: typeof t.name === 'string' ? t.name : null,
        memo: typeof t.memo === 'string' ? t.memo : null,
        amount: Number(t.amount ?? 0),
        type: typeof t.type === 'string' ? t.type : 'credit',
        balance:
          typeof t.balance === 'number' || t.balance === null
            ? (t.balance as number | null)
            : null,
        line_number: typeof t.line_number === 'number' ? t.line_number : i + 1,
      }))
    : [];
  return {
    bank_name: typeof data.bank_name === 'string' ? data.bank_name : null,
    account_number:
      typeof data.account_number === 'string' ? data.account_number : null,
    sort_code: typeof data.sort_code === 'string' ? data.sort_code : null,
    statement_date:
      typeof data.statement_date === 'string' ? data.statement_date : null,
    period_start: typeof data.period_start === 'string' ? data.period_start : null,
    period_end: typeof data.period_end === 'string' ? data.period_end : null,
    opening_balance:
      typeof data.opening_balance === 'number' ? data.opening_balance : null,
    closing_balance:
      typeof data.closing_balance === 'number' ? data.closing_balance : null,
    transactions,
  };
}

function normaliseBankNumber(s: string | null | undefined): string {
  return (s ?? '').replace(/[\s-]/g, '').trim();
}

export async function previewBankImportFromPdf(
  operaDb: Knex,
  llm: LlmService | null,
  input: PreviewFromPdfInput,
  extractor: PdfExtractor | null = null,
  appDb: Knex | null = null,
): Promise<PreviewResponse> {
  if (!input.bankCode) {
    return { success: false, error: 'bank_code is required' };
  }
  if (!input.filePath && !input.pdfBytes) {
    return { success: false, error: 'filePath or pdfBytes is required' };
  }
  if (!extractor && !llm) {
    return {
      success: false,
      error:
        'No PDF extractor configured. Standalone host needs GEMINI_API_KEY to wire ctx.bankPdfExtractor, or SAM must provide ctx.llm.',
    };
  }

  const bank = await fetchBank(operaDb, input.bankCode);
  if (!bank) {
    return {
      success: false,
      error: `Bank account '${input.bankCode}' not found in Opera.`,
    };
  }

  let extracted: PdfExtractionResult;
  try {
    if (extractor) {
      // Preferred path: dedicated extractor (e.g. standalone host's
      // Gemini-backed adapter matching legacy behaviour).
      extracted = await extractor.extractFromPdf({
        filePath: input.filePath,
        bytes: input.pdfBytes,
        filename: input.filename,
      });
    } else {
      // Fallback: SAM-plugged mode where only ctx.llm is wired.
      extracted = await callLlmForExtraction(llm!, input.filePath, input.pdfBytes);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `PDF extraction failed: ${msg}` };
  }

  const warnings: string[] = [];

  // Bank match
  const stmtSort = normaliseBankNumber(extracted.sort_code);
  const stmtAcct = normaliseBankNumber(extracted.account_number);
  const operaSort = normaliseBankNumber(bank.sort_code);
  const operaAcct = normaliseBankNumber(bank.account_number);
  if (stmtSort && stmtAcct && operaSort && operaAcct) {
    if (stmtSort !== operaSort || stmtAcct !== operaAcct) {
      const correctBankCode = await findBankByDetails(
        operaDb,
        stmtSort,
        stmtAcct,
      );
      return {
        success: false,
        bank_mismatch: true,
        detected_bank: `${stmtSort} / ${stmtAcct}`,
        selected_bank: `${operaSort} / ${operaAcct} (${input.bankCode})`,
        correct_bank_code: correctBankCode,
        error: 'Bank account mismatch',
      };
    }
  }

  // Opening balance vs reconciled — warn, don't override
  if (
    extracted.opening_balance !== null &&
    bank.reconciled_balance !== null &&
    Math.abs(extracted.opening_balance - bank.reconciled_balance) > 0.02
  ) {
    warnings.push(
      `Opening balance mismatch: extracted £${extracted.opening_balance.toFixed(
        2,
      )} vs Opera reconciled £${bank.reconciled_balance.toFixed(2)}.`,
    );
  } else if (
    extracted.opening_balance === null &&
    bank.reconciled_balance !== null
  ) {
    extracted.opening_balance = bank.reconciled_balance;
    warnings.push(
      `Used Opera reconciled balance £${bank.reconciled_balance.toFixed(
        2,
      )} as opening balance (LLM did not extract one).`,
    );
  }

  // Closing balance via transaction-chain walk
  if (extracted.opening_balance !== null && extracted.transactions.length > 0) {
    let current = extracted.opening_balance;
    const used = new Set<number>();
    for (let _ = 0; _ < extracted.transactions.length; _++) {
      let found = false;
      for (let i = 0; i < extracted.transactions.length; i++) {
        if (used.has(i)) continue;
        const st = extracted.transactions[i]!;
        const expected = Math.round((current + st.amount) * 100) / 100;
        if (
          st.balance !== null &&
          st.balance !== undefined &&
          Math.abs(expected - st.balance) < 0.02
        ) {
          current = st.balance;
          used.add(i);
          found = true;
          break;
        }
      }
      if (!found) break;
    }
    if (used.size > 0) {
      extracted.closing_balance = current;
      const excluded = extracted.transactions.length - used.size;
      if (excluded > 0) {
        warnings.push(
          `Balance chain excluded ${excluded} transaction(s) that didn't fit the running total — likely from a different account on the same PDF.`,
        );
      }
    }
  }

  // process_transactions duplicate-candidate enrichment. Faithful
  // port of bank_import.py:1910-1969. Each transaction is checked
  // against Opera's cashbook (atran/aentry) at preview time so the
  // UI can render "already posted" badges and pre-deselect the row
  // for the operator. Identical to the just-in-time check the
  // import-from-pdf executor runs, but at preview time and across
  // ALL at_types (the matcher doesn't yet know the action).
  //
  // We thread a `consumedEntries` set across the loop so two
  // identical-amount lines on the same statement match distinct
  // existing aentries — preserving legacy's multi-occurrence
  // handling (bank_import.py:1919-1923).
  const consumedEntries = new Set<string>();
  const txnsForUi = extracted.transactions as Array<
    PdfExtractionResult['transactions'][number] & {
      is_duplicate?: boolean;
      action?: string;
      skip_reason?: string | null;
      matched_entry_number?: string | null;
      matched_account?: string | null;
      matched_name?: string | null;
      match_confidence?: number | null;
    }
  >;
  for (const txn of txnsForUi) {
    if (!txn.date) continue;
    // Probe all four possible at_types whose magnitude matches.
    // Sign-aware: receipts (+) only match at_type 4 (sales_receipt) /
    // 2 (nominal_receipt) / 6 (purchase_refund) / 8 (transfer); payments
    // (-) only match 5 / 1 / 3 / 8.
    const candidateActions =
      txn.amount < 0
        ? ['purchase_payment', 'nominal_payment', 'sales_refund', 'bank_transfer']
        : ['sales_receipt', 'nominal_receipt', 'purchase_refund', 'bank_transfer'];
    for (const probeAction of candidateActions) {
      try {
        const dup = await checkCashbookDuplicateBeforePosting({
          operaDb,
          bankCode: bank.code,
          transactionDate: String(txn.date).slice(0, 10),
          signedAmountPounds: Number(txn.amount),
          action: probeAction,
          excludeEntryNumbers: consumedEntries,
          description: (txn.name ?? txn.memo ?? '') as string,
        });
        if (dup.isDuplicate) {
          txn.is_duplicate = true;
          txn.action = 'skip';
          txn.skip_reason = `Already posted: ${dup.reason}`;
          txn.matched_entry_number = dup.entryNumber;
          if (dup.entryNumber) consumedEntries.add(dup.entryNumber);
          break;
        }
      } catch {
        // Tolerate per-row probe errors — matches the JIT check's
        // policy of degrading to "not a duplicate" on lookup failure.
        break;
      }
    }
    // NOTE: No type-blind safety net at preview time. Legacy only
    // runs `_is_already_posted_typeblind` inside the matcher's
    // per-txn `_is_already_posted` after an action has been
    // assigned (bank_import.py:1582). At preview time, running a
    // ±7d sign-aware atran probe against every row was producing
    // false positives — any unrelated same-amount entry in Opera
    // within 14 days would flag a legitimate statement line as
    // "Already posted" and block the operator. The pre-posting
    // executor still calls the type-blind helper as a safety net
    // at import time, where the action is known and the false-
    // positive risk is lower.
  }

  // Full _match_transaction pipeline. Faithful port of
  // bank_import.py:1297-1495 (the function _match_transaction).
  // Stages run in legacy order, each terminating on a successful match:
  //
  //   Stage 0    repeat-entry check (arhead/arline)
  //   Stage 0.5  bank-transfer detection (other Opera banks)
  //   Stage 1    alias lookup (per-bank → global)
  //   Stage 2    fuzzy match (BankMatcher) with extract_payee_name
  //              fallback
  //   Stage 3    ambiguity resolution + credit-note refund detection
  //   Stage 4    direction-based decision + alias learning at score
  //              >= 0.85
  //
  // Reuses the same service `processStatement` calls so the matcher
  // is consistent across both paths.
  let matchCtx: MatchContext | null = null;
  try {
    const [customers, suppliers] = await Promise.all([
      loadCustomerCandidates(operaDb),
      loadSupplierCandidates(operaDb),
    ]);
    matchCtx = await buildMatchContext(operaDb, bank.code, {
      customers,
      suppliers,
    });
  } catch {
    // Matcher unavailable (e.g. customer/supplier load failed) — we
    // skip per-row matching but the preview still surfaces dup info
    // and the operator can manually pick accounts.
    matchCtx = null;
  }

  if (matchCtx) {
    for (const txn of txnsForUi) {
      if (txn.is_duplicate) continue;
      try {
        const dateAny: unknown = txn.date;
        const dateYmd =
          dateAny != null && typeof dateAny === 'object' && 'toISOString' in (dateAny as object)
            ? (dateAny as Date).toISOString().slice(0, 10)
            : String(dateAny ?? '').slice(0, 10);
        const res = await matchTransaction(operaDb, appDb, matchCtx, {
          bankCode: bank.code,
          date: dateYmd,
          amount: Number(txn.amount ?? 0),
          name: (txn.name ?? '').toString(),
          memo: (txn.memo ?? '').toString(),
          reference:
            ((txn as unknown as { reference?: string | null }).reference ?? '') as string,
          preDeferred: false,
        });
        if (res.matched_account) {
          txn.matched_account = res.matched_account;
          txn.matched_name = res.matched_name ?? null;
          txn.match_confidence = res.match_score;
        }
        if (res.action && res.action !== 'skip') {
          txn.action = res.action;
        }
        if (res.skip_reason) txn.skip_reason = res.skip_reason;
      } catch {
        // Per-row matcher failures degrade silently — operator
        // can pick manually.
      }
    }
  }

  // Bucket transactions for the FE. Faithful port of
  // routes.py:2663-2787. The FE's preview UI reads
  // matched_receipts / matched_payments / matched_refunds /
  // repeat_entries / unmatched / already_posted / skipped directly;
  // it does not consume a flat transactions array. We keep the
  // flat array on the response too (statement_transactions +
  // transactions) for callers that need it.
  const matchedReceipts: PreviewTxn[] = [];
  const matchedPayments: PreviewTxn[] = [];
  const matchedRefunds: PreviewTxn[] = [];
  const repeatEntries: PreviewTxn[] = [];
  const unmatched: PreviewTxn[] = [];
  const alreadyPosted: PreviewTxn[] = [];
  const skipped: PreviewTxn[] = [];

  const flatTxns: PreviewTxn[] = txnsForUi.map((t, i) => {
    const dateAny: unknown = t.date;
    const dateStr =
      dateAny != null && typeof dateAny === 'object' && 'toISOString' in (dateAny as object)
        ? (dateAny as Date).toISOString().slice(0, 10)
        : String(dateAny ?? '').slice(0, 10) || null;
    const tu = t as unknown as {
      reference?: string | null;
      fit_id?: string | null;
      matched_account?: string | null;
      matched_name?: string | null;
      match_confidence?: number | null;
      action?: string | null;
      skip_reason?: string | null;
      is_duplicate?: boolean;
      matched_entry_number?: string | null;
    };
    return {
      row: i + 1,
      date: dateStr,
      amount: Number(t.amount ?? 0),
      name: (t.name ?? '') as string,
      reference: tu.reference ?? null,
      memo: (t.memo ?? '') as string,
      fit_id: tu.fit_id ?? null,
      account: tu.matched_account ?? null,
      account_name: tu.matched_name ?? null,
      match_score:
        tu.match_confidence != null ? Math.round(tu.match_confidence * 100) : 0,
      match_source: null,
      action: tu.action ?? null,
      reason: tu.skip_reason ?? null,
      is_duplicate: !!tu.is_duplicate,
      duplicate_candidates: [],
      refund_credit_note: null,
      refund_credit_amount: null,
      repeat_entry_ref: null,
      repeat_entry_desc: null,
      repeat_entry_next_date: null,
      repeat_entry_posted: null,
      repeat_entry_total: null,
      repeat_entry_freq: null,
      repeat_entry_every: null,
      period_valid: true,
      period_error: null,
      original_date: dateStr,
      type: t.type as string | undefined,
      balance: (t.balance ?? null) as number | null,
      line_number: i + 1,
      matched_entry_number: tu.matched_entry_number ?? null,
    };
  });

  for (const t of flatTxns) {
    if (t.is_duplicate) {
      alreadyPosted.push(t);
      continue;
    }
    switch (t.action) {
      case 'sales_receipt':
        matchedReceipts.push(t);
        break;
      case 'purchase_payment':
        matchedPayments.push(t);
        break;
      case 'sales_refund':
      case 'purchase_refund':
        matchedRefunds.push(t);
        break;
      case 'repeat_entry':
        repeatEntries.push(t);
        break;
      case 'skip':
      case 'defer':
        skipped.push(t);
        break;
      default:
        // Anything unclassified (no action set, or unknown) goes to
        // unmatched so the operator can assign manually. Matches
        // legacy line 2785 "All non-matched, non-duplicate
        // transactions go to unmatched".
        unmatched.push(t);
    }
  }

  return {
    success: true,
    filename: input.filename ?? input.filePath?.split('/').pop() ?? undefined,
    detected_format: 'PDF',
    total_transactions: flatTxns.length,
    matched_receipts: matchedReceipts,
    matched_payments: matchedPayments,
    matched_refunds: matchedRefunds,
    repeat_entries: repeatEntries,
    unmatched,
    already_posted: alreadyPosted,
    skipped,
    summary: {
      to_import:
        matchedReceipts.length + matchedPayments.length + matchedRefunds.length,
      refund_count: matchedRefunds.length,
      repeat_entry_count: repeatEntries.length,
      unmatched_count: unmatched.length,
      already_posted_count: alreadyPosted.length,
      skipped_count: skipped.length,
    },
    errors: [],
    statement_bank_info: {
      bank_name: extracted.bank_name,
      account_number: extracted.account_number,
      sort_code: extracted.sort_code,
      statement_date: extracted.statement_date,
      period_start: extracted.period_start,
      period_end: extracted.period_end,
      opening_balance: extracted.opening_balance,
      closing_balance: extracted.closing_balance,
      matched_opera_bank: bank.code,
    },
    statement_transactions: flatTxns,
    statement_info: {
      bank_name: extracted.bank_name,
      account_number: extracted.account_number,
      sort_code: extracted.sort_code,
      statement_date: extracted.statement_date,
      period_start: extracted.period_start,
      period_end: extracted.period_end,
      opening_balance: extracted.opening_balance,
      closing_balance: extracted.closing_balance,
    },
    transactions: flatTxns,
    bank: {
      code: bank.code,
      description: bank.description,
      sort_code: bank.sort_code,
      account_number: bank.account_number,
      reconciled_balance: bank.reconciled_balance,
    },
    warnings,
  };
}

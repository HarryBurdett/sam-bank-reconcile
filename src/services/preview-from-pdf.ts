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
import { lookupAlias } from './bank-aliases.js';
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

export interface PreviewResponse {
  success: boolean;
  filename?: string;
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
  transactions?: Array<{
    date: string | null;
    name: string | null;
    memo: string | null;
    amount: number;
    type: string;
    balance?: number | null;
    line_number?: number;
    /** Set when the matcher's process_transactions pass found the row
     *  already exists in Opera's cashbook. Faithful port of
     *  bank_import.py:1946. The UI uses this to render the "already
     *  posted" badge and pre-deselect the row. */
    is_duplicate?: boolean;
    /** Skip flag — when set, the import-from-pdf orchestration
     *  shell will route this row through the executor's skip path
     *  (no cashbook write). Set by the duplicate-detection pass at
     *  preview time. */
    action?: string;
    /** Human-readable explanation for the skip, surfaced in the
     *  preview UI alongside is_duplicate. Mirrors
     *  BankTransaction.skip_reason in bank_import.py:252. */
    skip_reason?: string | null;
    /** The Opera entry_number that already holds this posting. Used
     *  by the FE's duplicate-override modal and by the import loop's
     *  consumed-entries seeding. */
    matched_entry_number?: string | null;
    /** Customer or supplier account code that the alias matcher
     *  resolved this row to. Mirrors BankTransaction.matched_account
     *  in bank_import.py:252. */
    matched_account?: string | null;
    /** Display name for the matched account, surfaced as the
     *  "matched to" badge in the preview UI. */
    matched_name?: string | null;
    /** Confidence (0..1) of the alias match. */
    match_confidence?: number | null;
  }>;
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
  }

  // Alias-matcher pass. Faithful port of _match_transaction
  // (bank_import.py:1430-1650), narrowed to the alias-table lookup
  // — the matching surface available in standalone today. For each
  // non-duplicate row, look up by payee name with sign-derived
  // ledger ('C' for receipts, 'S' for payments); when an alias hits,
  // set matched_account/matched_name/action so the FE can render the
  // green tick and pre-select the row.
  if (appDb) {
    for (const txn of txnsForUi) {
      if (txn.is_duplicate) continue;
      const payeeName = ((txn.name ?? txn.memo) ?? '').toString().trim();
      if (!payeeName) continue;
      const ledger = Number(txn.amount ?? 0) >= 0 ? 'C' : 'S';
      try {
        const alias = await lookupAlias(appDb, payeeName, ledger, bank.code);
        if (alias && alias.account) {
          txn.matched_account = alias.account;
          txn.matched_name = payeeName;
          txn.match_confidence = alias.confidence;
          txn.action = ledger === 'C' ? 'sales_receipt' : 'purchase_payment';
        }
      } catch {
        // Tolerate per-row lookup failures — the alias matcher is
        // advisory at preview time. Operator can still pick manually.
      }
    }
  }

  return {
    success: true,
    filename: input.filename ?? input.filePath?.split('/').pop() ?? undefined,
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
    transactions: extracted.transactions,
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

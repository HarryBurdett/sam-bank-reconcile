/**
 * Gemini-backed PDF extractor for the standalone host.
 *
 * Faithful port of the legacy Python `StatementReconciler.extract_transactions_from_pdf`
 * (sql_rag/statement_reconcile.py:661) — uses Gemini Vision (`gemini-2.5-flash`
 * by default) with the same extraction prompt as legacy, returns the same
 * shape the plugin's preview-from-pdf service expects.
 *
 * All faithful ports landed; see commit history.
 *
 * The standalone wires this as a `bankPdfExtractor` adapter on every
 * company's ctx. SAM-plugged mode provides its own implementation via
 * ctx.llm, so this file is never imported in SAM mode.
 */
import { GoogleGenAI } from '@google/genai';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Knex } from 'knex';
import type { AppLogger } from '../src/app-context.js';
import type {
  PdfExtractionResult,
  PdfExtractor,
} from '../src/services/import-from-pdf.js';
import { callGeminiWithThrottle } from './gemini-throttle.js';

const DEFAULT_MODEL = 'gemini-2.5-flash';

/**
 * Repair common JSON issues from LLM responses. Faithful port of
 * `_repair_json` (sql_rag/statement_reconcile.py:1132).
 *
 *   - Strip trailing commas before ] or }.
 *   - Replace single-quoted JSON-style string delimiters with double
 *     quotes (taking care to leave apostrophes inside strings alone).
 *   - Trim anything after the last closing brace.
 *   - If braces/brackets remain unbalanced, find the last complete
 *     transaction object inside the "transactions" array and truncate
 *     there; otherwise pad with ] and } to close.
 */
export function repairJson(jsonText: string): string {
  let text = jsonText;

  // Trailing commas before ] or }
  text = text.replace(/,(\s*[}\]])/g, '$1');

  // Single-quoted JSON delimiters → double quotes. Lookbehind ensures
  // we only match where a JSON delimiter is expected (after { , : [).
  text = text.replace(
    /(?<=[{,:\[])\s*'([^']*?)'\s*(?=[,}\]:])/g,
    '"$1"',
  );

  // Trim trailing content after the last }
  const lastBrace = text.lastIndexOf('}');
  if (lastBrace !== -1) {
    text = text.slice(0, lastBrace + 1);
  }

  // Re-balance: if unclosed structures remain, find the last complete
  // transaction entry and truncate there; otherwise close the brackets.
  const openBraces =
    (text.match(/\{/g)?.length ?? 0) - (text.match(/\}/g)?.length ?? 0);
  const openBrackets =
    (text.match(/\[/g)?.length ?? 0) - (text.match(/\]/g)?.length ?? 0);

  if (openBrackets > 0 || openBraces > 0) {
    const match = text.match(
      /("transactions"\s*:\s*\[[\s\S]*?)(\{[^{}]*\})\s*,?\s*(\{[^}]*$)/,
    );
    if (match) {
      text = `${match[1]}${match[2]}]}`;
    } else {
      text += ']'.repeat(Math.max(0, openBrackets));
      text += '}'.repeat(Math.max(0, openBraces));
    }
  }

  return text;
}

/** Legacy extraction prompt, copied verbatim from
 *  sql_rag/statement_reconcile.py:695-785 to preserve behaviour. */
const EXTRACTION_PROMPT = `You are extracting data from a bank statement PDF. Process ALL pages.

STEP 1 — IDENTIFY STATEMENT FORMAT:
Scan the entire document FIRST before extracting anything. Determine:

a) FORMAT — how balances are presented:
   - "running_balance": Each transaction line has a running balance column
   - "summary_and_transactions": A summary section (opening/closing/totals) PLUS transaction list with balances
   - "summary_only": Only summary totals, no individual transactions with balances
   - "no_balance": Transactions have amounts but no running balance column and no summary

b) TRANSACTION ORDER — are transactions listed:
   - "oldest_first": Earliest date at top (most common)
   - "newest_first": Latest date at top (some online/fintech banks)

c) SUMMARY — if there is a summary section on the statement showing any of:
   opening balance, closing balance, total money in, total money out

STEP 2 — EXTRACT ACCOUNT DETAILS:
Find these wherever they appear in the document:
- Bank name (logo, header, or watermark)
- Account number and sort code
- Statement date or period dates

STEP 3 — EXTRACT EVERY TRANSACTION:
Go through every page systematically and extract every transaction row.
Each transaction has: date, description, amount (in or out), and possibly a running balance.
Do NOT stop after the first page. Continue until no more transactions remain.

STEP 4 — REPORT BALANCES (DO NOT CALCULATE):
- opening_balance: ONLY set this if the statement EXPLICITLY labels an opening balance
  (e.g. "Balance brought forward", "Opening balance", "Previous balance").
  If no explicit label exists, set to null — the code will calculate it.
- closing_balance: If labelled ("Balance carried forward", "Closing balance") use it.
  Otherwise use the running balance on the very last transaction.
- summary: If a summary section exists, report its values. Otherwise set all to null.

Return this JSON structure:
{
    "statement_info": {
        "bank_name": "Bank name",
        "account_number": "Account number",
        "sort_code": "Sort code",
        "statement_date": "YYYY-MM-DD",
        "period_start": "YYYY-MM-DD",
        "period_end": "YYYY-MM-DD",
        "format": "running_balance",
        "transaction_order": "oldest_first",
        "summary": {
            "opening_balance": null,
            "closing_balance": null,
            "total_in": null,
            "total_out": null
        },
        "opening_balance": null,
        "closing_balance": 12345.67
    },
    "transactions": [
        {
            "date": "YYYY-MM-DD",
            "description": "Full description text",
            "money_out": null,
            "money_in": null,
            "balance": null,
            "type": "DD|STO|Giro|Card|FP|BGC|Transfer|BACS|CHQ|Other",
            "reference": null
        }
    ]
}

RULES:
- Extract ACTUAL values from this document — never use placeholder values
- opening_balance in statement_info: ONLY if explicitly labelled on statement, otherwise null
- summary: report what the statement shows, null for anything not present
- money_out = payments/debits leaving the account, money_in = receipts/credits entering
- Amounts as numbers without currency symbols (e.g. 1234.56 not £1,234.56)
- Use the year from the statement period if transaction dates show only day/month
- Include running balance for each transaction if shown on the statement
- Return ONLY valid JSON — no other text
- CRITICAL: Extract EVERY transaction from EVERY page. Do not truncate or summarise.

MULTI-ACCOUNT STATEMENTS (IMPORTANT):
Some banks (e.g. Monzo, Starling) include MULTIPLE accounts on one PDF — current account,
savings pots, fixed savings etc. Each account has its own section with its own transactions
and balances. You MUST:
- Extract transactions ONLY from the MAIN CURRENT ACCOUNT section
- IGNORE savings accounts, pots, fixed savings, or any other account sections
- The account_number and sort_code refer to the main current account only
- The closing_balance must be for the main current account ONLY, not a combined total
- If the statement shows a total across all accounts, DO NOT use that as closing_balance
- Look for section headers like "Current account", "Account transactions" to identify the right section`;

export interface GeminiExtractorOptions {
  apiKey: string;
  model?: string;
  logger?: AppLogger;
  /**
   * Optional per-company per-app DB; when provided, extraction
   * results are cached in the `extraction_cache` table keyed by
   * SHA256 of the PDF bytes. Matches legacy
   * sql_rag/pdf_extraction_cache.py (singleton per company).
   */
  appDb?: Knex | null;
}

interface CachedExtraction {
  statement_info: Record<string, unknown>;
  transactions: Array<Record<string, unknown>>;
  model_name?: string;
  file_size?: number;
  transaction_count?: number;
  extracted_at?: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function cacheGet(
  appDb: Knex | null | undefined,
  hash: string,
  logger: AppLogger | undefined,
): Promise<CachedExtraction | null> {
  if (!appDb) return null;
  try {
    const row = (await appDb('extraction_cache')
      .where({ content_hash: hash })
      .first()) as { extraction_json?: string } | undefined;
    if (!row?.extraction_json) return null;
    const parsed = JSON.parse(row.extraction_json) as CachedExtraction;
    const txCount = parsed.transactions?.length ?? 0;
    logger?.info(`[gemini] cache HIT for ${hash.slice(0, 12)}… (${txCount} transactions)`);
    return parsed;
  } catch (err) {
    logger?.warn(`[gemini] cache lookup error: ${(err as Error).message}`);
    return null;
  }
}

async function cachePut(
  appDb: Knex | null | undefined,
  hash: string,
  data: CachedExtraction,
  logger: AppLogger | undefined,
): Promise<void> {
  if (!appDb) return;
  try {
    const value = JSON.stringify(data);
    // INSERT OR REPLACE — legacy semantics.
    await appDb.raw(
      `INSERT INTO extraction_cache (content_hash, extraction_json, created_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(content_hash) DO UPDATE SET extraction_json = excluded.extraction_json, created_at = CURRENT_TIMESTAMP`,
      [hash, value],
    );
    logger?.info(
      `[gemini] cache STORE for ${hash.slice(0, 12)}… (${data.transactions?.length ?? 0} transactions)`,
    );
  } catch (err) {
    logger?.warn(`[gemini] cache store error: ${(err as Error).message}`);
  }
}

function safeFloat(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const cleaned = v.replace(/,|£|\$/g, '').trim();
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

interface RawTxn {
  date?: unknown;
  money_in?: unknown;
  money_out?: unknown;
  balance?: unknown;
}

/**
 * Faithful port of `_calculate_opening_balance` from
 * sql_rag/statement_reconcile.py:878. Dual-interpretation chain
 * validation: tries opening = (balance + out - in) [interpretation A —
 * balance includes txn] and opening = balance [interpretation B —
 * balance is opening]. Whichever chain reaches `closingBalance` wins.
 * Falls back to summary opening, then to interpretation A as best-guess.
 */
function calculateOpeningBalance(
  rawTransactions: RawTxn[],
  closingBalance: number | null,
  summaryOpening: number | null,
  logger?: AppLogger,
): number | null {
  if (!rawTransactions.length) return null;

  const sorted = [...rawTransactions].sort((a, b) => {
    const da = typeof a.date === 'string' ? a.date : '9999';
    const db_ = typeof b.date === 'string' ? b.date : '9999';
    return da < db_ ? -1 : da > db_ ? 1 : 0;
  });

  let firstReal: RawTxn | null = null;
  let firstIdx = 0;
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i]!;
    const mi = Math.abs(safeFloat(t.money_in) ?? 0);
    const mo = Math.abs(safeFloat(t.money_out) ?? 0);
    const bal = safeFloat(t.balance);
    if (bal !== null && (mi > 0 || mo > 0)) {
      firstReal = t;
      firstIdx = i;
      break;
    }
  }

  if (firstReal === null) {
    // No transaction with both amount and balance — use first balance line.
    for (const t of sorted) {
      const bal = safeFloat(t.balance);
      if (bal !== null) {
        logger?.info(
          `[gemini] opening balance: no real txns with balance, using first balance line = ${bal}`,
        );
        return bal;
      }
    }
    return null;
  }

  const firstBal = safeFloat(firstReal.balance) ?? 0;
  const firstIn = Math.abs(safeFloat(firstReal.money_in) ?? 0);
  const firstOut = Math.abs(safeFloat(firstReal.money_out) ?? 0);

  // Interpretation A: balance INCLUDES the transaction.
  const openingA = Math.round((firstBal + firstOut - firstIn) * 100) / 100;
  // Interpretation B: balance IS the opening (txn applied to next line).
  const openingB = firstBal;

  const chainValidates = (opening: number, txns: RawTxn[]): boolean => {
    let current = opening;
    for (const t of txns) {
      const mi = Math.abs(safeFloat(t.money_in) ?? 0);
      const mo = Math.abs(safeFloat(t.money_out) ?? 0);
      const bal = safeFloat(t.balance);
      if (bal === null) continue;
      if (mi === 0 && mo === 0) continue;
      const expected = Math.round((current + mi - mo) * 100) / 100;
      if (Math.abs(expected - bal) > 0.02) return false;
      current = bal;
    }
    if (closingBalance !== null) {
      return Math.abs(current - closingBalance) < 0.02;
    }
    return true;
  };

  const testTxns = sorted.slice(firstIdx);
  const aValid = chainValidates(openingA, testTxns);
  const bValid = chainValidates(openingB, testTxns);

  if (aValid && !bValid) {
    logger?.info(`[gemini] opening balance: interpretation A (includes txn) = ${openingA}`);
    return openingA;
  }
  if (bValid && !aValid) {
    logger?.info(`[gemini] opening balance: interpretation B (is opening) = ${openingB}`);
    return openingB;
  }
  if (aValid && bValid) {
    logger?.info(`[gemini] opening balance: both valid, using A = ${openingA}`);
    return openingA;
  }

  logger?.warn(
    `[gemini] opening balance: neither interpretation chains. A=${openingA}, B=${openingB}`,
  );
  if (summaryOpening !== null) {
    logger?.info(`[gemini] opening balance: falling back to summary opening = ${summaryOpening}`);
    return summaryOpening;
  }
  return openingA;
}

function parseResultJson(
  parsed: Record<string, unknown>,
  logger?: AppLogger,
): PdfExtractionResult {
  const info = (parsed.statement_info ?? {}) as Record<string, unknown>;
  const rawTransactions = Array.isArray(parsed.transactions)
    ? (parsed.transactions as Array<Record<string, unknown>>)
    : [];

  const transactions = rawTransactions.map((t, i) => {
    const moneyOut = typeof t.money_out === 'number' ? t.money_out : null;
    const moneyIn = typeof t.money_in === 'number' ? t.money_in : null;
    const amount =
      moneyOut !== null && moneyOut !== 0
        ? -Math.abs(moneyOut)
        : moneyIn !== null
          ? moneyIn
          : 0;
    const type =
      moneyOut !== null && moneyOut !== 0
        ? 'debit'
        : moneyIn !== null && moneyIn !== 0
          ? 'credit'
          : typeof t.type === 'string'
            ? t.type
            : 'credit';
    return {
      date: typeof t.date === 'string' ? t.date : null,
      name: typeof t.description === 'string' ? t.description : null,
      memo: typeof t.description === 'string' ? t.description : null,
      amount,
      type,
      balance: typeof t.balance === 'number' ? t.balance : null,
      line_number: i + 1,
    };
  });

  // Legacy: never trust AI's opening_balance. Derive from chain.
  // Faithful port of _parse_extraction_result @ statement_reconcile.py:1002.
  const aiOpening = safeFloat(info.opening_balance);
  const aiClosing = safeFloat(info.closing_balance);
  const summary = (info.summary ?? {}) as Record<string, unknown>;
  const summaryOpening = safeFloat(summary.opening_balance);
  const chainOpening = calculateOpeningBalance(
    rawTransactions as RawTxn[],
    aiClosing,
    summaryOpening,
    logger,
  );

  let opening: number | null = aiOpening;
  if (chainOpening !== null) {
    if (aiOpening !== null && Math.abs(aiOpening - chainOpening) > 0.01) {
      logger?.info(
        `[gemini] opening balance overridden: AI=${aiOpening}, calculated=${chainOpening}`,
      );
    } else if (aiOpening === null) {
      logger?.info(`[gemini] opening balance calculated (AI had none): ${chainOpening}`);
    }
    opening = chainOpening;
  }

  return {
    bank_name: typeof info.bank_name === 'string' ? info.bank_name : null,
    account_number:
      typeof info.account_number === 'string' ? info.account_number : null,
    sort_code: typeof info.sort_code === 'string' ? info.sort_code : null,
    statement_date:
      typeof info.statement_date === 'string' ? info.statement_date : null,
    period_start:
      typeof info.period_start === 'string' ? info.period_start : null,
    period_end: typeof info.period_end === 'string' ? info.period_end : null,
    opening_balance: opening,
    closing_balance: aiClosing,
    transactions,
  };
}

export function buildGeminiPdfExtractor(
  opts: GeminiExtractorOptions,
): PdfExtractor {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey });
  const model = opts.model ?? DEFAULT_MODEL;
  const logger = opts.logger;
  const appDb = opts.appDb ?? null;

  return {
    async extractFromPdf({ filePath, bytes, filename }) {
      let pdfBytes: Uint8Array | undefined = bytes;
      if (!pdfBytes && filePath) {
        pdfBytes = readFileSync(filePath);
      }
      if (!pdfBytes) {
        throw new Error('Gemini extractor: no PDF bytes supplied');
      }

      const name = filename ?? filePath?.split('/').pop() ?? '<unnamed>.pdf';
      const hash = sha256(pdfBytes);

      // Cache lookup. Legacy invalidates entries with <5 transactions
      // for PDFs > 50KB (suspected truncation). Mirror that here.
      const cached = await cacheGet(appDb, hash, logger);
      if (cached) {
        const txCount = cached.transactions?.length ?? 0;
        if (txCount >= 5 || pdfBytes.byteLength <= 50_000) {
          return parseResultJson(
            {
              statement_info: cached.statement_info ?? {},
              transactions: cached.transactions ?? [],
            },
            logger,
          );
        }
        logger?.warn(
          `[gemini] cache had ${txCount} transactions for ${pdfBytes.byteLength} byte PDF — invalidating and re-extracting`,
        );
        try {
          if (appDb) await appDb('extraction_cache').where({ content_hash: hash }).delete();
        } catch { /* tolerated */ }
      }

      logger?.info(`[gemini] extracting ${name} (${pdfBytes.byteLength} bytes)`);
      const base64 = Buffer.from(pdfBytes).toString('base64');

      // Retry-on-truncation. Faithful port of statement_reconcile.py:
      // 794-852. Two attempts max; retry when the response was
      // truncated by MAX_TOKENS (finishReason 2) OR fewer than 5
      // transactions came back (likely truncated mid-array). The
      // second attempt prefixes a more explicit instruction.
      const MAX_ATTEMPTS = 2;
      let parsed: Record<string, unknown> | null = null;
      let lastResponseText = '';
      let prompt = EXTRACTION_PROMPT;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        // Throttle + 429 retry wrapper, faithful port of
        // sql_rag/gemini_throttle.py:call_gemini_with_throttle.
        const response = await callGeminiWithThrottle(
          () =>
            ai.models.generateContent({
              model,
              contents: [
                {
                  role: 'user',
                  parts: [
                    { inlineData: { mimeType: 'application/pdf', data: base64 } },
                    { text: prompt },
                  ],
                },
              ],
            }),
          {
            filename: name,
            logger: {
              warn: (m) => logger?.warn(m),
              info: (m) => logger?.info(m),
            },
          },
        );

        const text = response.text ?? '';
        lastResponseText = text;
        // finishReason: 1=STOP normal, 2=MAX_TOKENS truncated, 3=SAFETY etc.
        const finishReason =
          (response as { candidates?: Array<{ finishReason?: number }> })
            .candidates?.[0]?.finishReason ?? null;
        logger?.info(
          `[gemini] response ${text.length} chars, finishReason=${finishReason ?? '?'} (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
        );

        // JSON extraction — match legacy line 819 (`re.search(r'\{[\s\S]*\}'`)).
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) {
          if (attempt < MAX_ATTEMPTS - 1) {
            logger?.warn(
              `[gemini] no JSON in response (attempt ${attempt + 1}) — retrying`,
            );
            continue;
          }
          throw new Error(
            `Could not extract JSON from Gemini response: ${text.slice(0, 500)}`,
          );
        }
        let candidateParsed: Record<string, unknown>;
        try {
          candidateParsed = JSON.parse(match[0]) as Record<string, unknown>;
        } catch (err) {
          // Faithful port of statement_reconcile.py:828-836: try the
          // repair-then-parse fallback. If even that fails on the
          // final attempt, surface a clean error.
          logger?.warn(
            `[gemini] JSON parse error: ${
              err instanceof Error ? err.message : String(err)
            } — attempting repair...`,
          );
          const repaired = repairJson(match[0]);
          try {
            candidateParsed = JSON.parse(repaired) as Record<string, unknown>;
            logger?.info('[gemini] JSON repair successful');
          } catch (err2) {
            if (attempt < MAX_ATTEMPTS - 1) {
              logger?.warn(`[gemini] repair failed on attempt ${attempt + 1} — retrying`);
              continue;
            }
            throw new Error(
              `Could not parse JSON even after repair: ${
                err2 instanceof Error ? err2.message : String(err2)
              }. Original error: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        const rawTxns = Array.isArray(candidateParsed.transactions)
          ? (candidateParsed.transactions as unknown[])
          : [];
        const looksTruncated = finishReason === 2 || rawTxns.length < 5;
        if (looksTruncated && attempt < MAX_ATTEMPTS - 1) {
          logger?.warn(
            `[gemini] only ${rawTxns.length} transactions extracted (attempt ${attempt + 1}, finishReason=${finishReason ?? '?'}) — retrying with explicit instruction`,
          );
          prompt =
            `The previous extraction attempt only returned ${rawTxns.length} transactions.\n` +
            `This bank statement has MANY MORE transactions than that across multiple pages.\n\n` +
            `CRITICAL: You MUST extract EVERY SINGLE transaction from ALL pages of this PDF.\n` +
            `Go through page by page systematically. Do not stop after the first page.\n` +
            `A typical business bank statement has 20-100+ transactions.\n\n` +
            EXTRACTION_PROMPT;
          continue;
        }

        parsed = candidateParsed;
        break;
      }

      if (parsed === null) {
        throw new Error(
          `Failed to extract transactions from PDF after ${MAX_ATTEMPTS} attempts: ${lastResponseText.slice(0, 300)}`,
        );
      }

      const result = parseResultJson(parsed, logger);

      // Persist to cache. Store the raw legacy shape so future SAM
      // changes to parseResultJson() can re-derive without re-paying
      // for the Gemini call.
      await cachePut(
        appDb,
        hash,
        {
          statement_info: (parsed.statement_info ?? {}) as Record<string, unknown>,
          transactions: Array.isArray(parsed.transactions)
            ? (parsed.transactions as Array<Record<string, unknown>>)
            : [],
          model_name: model,
          file_size: pdfBytes.byteLength,
          transaction_count: result.transactions.length,
          extracted_at: new Date().toISOString(),
        },
        logger,
      );
      return result;
    },
  };
}

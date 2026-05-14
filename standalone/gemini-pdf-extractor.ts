/**
 * Gemini-backed PDF extractor for the standalone host.
 *
 * Faithful port of the legacy Python `StatementReconciler.extract_transactions_from_pdf`
 * (sql_rag/statement_reconcile.py:661) — uses Gemini Vision (`gemini-2.5-flash`
 * by default) with the same extraction prompt as legacy, returns the same
 * shape the plugin's preview-from-pdf service expects.
 *
 * Not yet ported from legacy (deferred to follow-up sessions, but the
 * shim degrades gracefully without them):
 *   - PDF extraction cache (sql_rag/pdf_extraction_cache.py)
 *   - Throttle / 429 retry wrapper (sql_rag/gemini_throttle.py)
 *   - JSON repair fallback (legacy uses _repair_json on parse failure)
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

const DEFAULT_MODEL = 'gemini-2.5-flash';

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

function parseResultJson(parsed: Record<string, unknown>): PdfExtractionResult {
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
    opening_balance:
      typeof info.opening_balance === 'number' ? info.opening_balance : null,
    closing_balance:
      typeof info.closing_balance === 'number' ? info.closing_balance : null,
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
          return parseResultJson({
            statement_info: cached.statement_info ?? {},
            transactions: cached.transactions ?? [],
          });
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
      const response = await ai.models.generateContent({
        model,
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { mimeType: 'application/pdf', data: base64 } },
              { text: EXTRACTION_PROMPT },
            ],
          },
        ],
      });

      const text = response.text ?? '';
      logger?.info(`[gemini] response ${text.length} chars`);

      // JSON extraction — match legacy line 819 (`re.search(r'\{[\s\S]*\}'`)).
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) {
        throw new Error(
          `Could not extract JSON from Gemini response: ${text.slice(0, 500)}`,
        );
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(match[0]) as Record<string, unknown>;
      } catch (err) {
        // Legacy attempts _repair_json fallback; not yet ported. Surface
        // a clean error so the operator can re-trigger extraction.
        throw new Error(
          `Gemini returned non-parseable JSON: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      const result = parseResultJson(parsed);

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

/**
 * Default LLM-driven PdfExtractor.
 *
 * Wraps `ctx.llm` (or any compatible `LlmService`) to extract bank
 * statement data from a PDF. The implementation mirrors the inline
 * `callLlmForExtraction` helper in `preview-from-pdf.ts` so import
 * routes (`/api/import/from-pdf`) gain a working extractor by default.
 *
 * Reads PDF bytes off disk when only `filePath` is supplied; otherwise
 * uses the bytes the caller passes in.
 */
import { promises as fs } from 'node:fs';
import type {
  PdfExtractionResult,
  PdfExtractor,
} from './import-from-pdf.js';
import type { LlmService } from './preview-from-pdf.js';

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

interface ExtractorOptions {
  llm: LlmService;
  model?: string;
  maxTokens?: number;
}

async function joinStream(stream: AsyncIterable<unknown>): Promise<string> {
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
  return buf.join('');
}

function stripFences(s: string): string {
  return s
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function normaliseExtraction(raw: unknown): PdfExtractionResult {
  const data = (raw ?? {}) as Record<string, unknown>;
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
    period_start:
      typeof data.period_start === 'string' ? data.period_start : null,
    period_end: typeof data.period_end === 'string' ? data.period_end : null,
    opening_balance:
      typeof data.opening_balance === 'number' ? data.opening_balance : null,
    closing_balance:
      typeof data.closing_balance === 'number' ? data.closing_balance : null,
    transactions,
  };
}

export function createDefaultBankPdfExtractor(
  options: ExtractorOptions,
): PdfExtractor {
  const { llm, model = 'claude-sonnet-4', maxTokens = 16_000 } = options;
  return {
    async extractFromPdf({ filePath, bytes, filename }) {
      let pdfBytes = bytes;
      if (!pdfBytes && filePath) {
        try {
          const buf = await fs.readFile(filePath);
          pdfBytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`Failed to read PDF: ${msg}`);
        }
      }
      const ref = filePath ?? filename ?? `<pdf-bytes:${pdfBytes?.byteLength ?? 0}>`;
      const stream = llm.chat({
        messages: [
          {
            role: 'user',
            content: `${EXTRACTION_PROMPT}\n\nPDF reference: ${ref}`,
          },
        ],
        model,
        maxTokens,
        temperature: 0,
      });
      const raw = (await joinStream(stream)).trim();
      const cleaned = stripFences(raw);
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
      return normaliseExtraction(parsed);
    },
  };
}

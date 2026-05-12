import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createDefaultBankPdfExtractor } from '../src/services/default-bank-pdf-extractor.js';
import type { LlmService } from '../src/services/preview-from-pdf.js';

function makeLlm(text: string): LlmService {
  return {
    chat() {
      async function* gen(): AsyncIterable<unknown> {
        yield text;
      }
      return gen();
    },
  };
}

describe('createDefaultBankPdfExtractor', () => {
  it('parses JSON payload returned by the LLM', async () => {
    const payload = JSON.stringify({
      bank_name: 'Acme Bank',
      account_number: '12345678',
      sort_code: '12-34-56',
      statement_date: '2026-04-30',
      period_start: '2026-04-01',
      period_end: '2026-04-30',
      opening_balance: 1000,
      closing_balance: 1100,
      transactions: [
        { date: '2026-04-15', name: 'Acme', memo: 'Pay', amount: 100, type: 'credit', balance: 1100 },
      ],
    });
    const extractor = createDefaultBankPdfExtractor({ llm: makeLlm(payload) });
    const r = await extractor.extractFromPdf({
      bytes: new Uint8Array([1, 2, 3]),
      filename: 'a.pdf',
    });
    expect(r.bank_name).toBe('Acme Bank');
    expect(r.account_number).toBe('12345678');
    expect(r.transactions.length).toBe(1);
    expect(r.transactions[0]?.amount).toBe(100);
    expect(r.transactions[0]?.line_number).toBe(1);
  });

  it('strips ```json fences', async () => {
    const payload = '```json\n{"transactions": []}\n```';
    const extractor = createDefaultBankPdfExtractor({ llm: makeLlm(payload) });
    const r = await extractor.extractFromPdf({ bytes: new Uint8Array(), filename: 'x.pdf' });
    expect(r.transactions).toEqual([]);
  });

  it('throws when LLM returns non-JSON', async () => {
    const extractor = createDefaultBankPdfExtractor({ llm: makeLlm('sorry, cannot parse') });
    await expect(
      extractor.extractFromPdf({ bytes: new Uint8Array(), filename: 'x.pdf' }),
    ).rejects.toThrow(/non-JSON/i);
  });

  it('reads bytes from filePath when bytes not given', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bank-ext-'));
    const file = path.join(tmp, 'stmt.pdf');
    await fs.writeFile(file, 'fake-pdf');
    try {
      const extractor = createDefaultBankPdfExtractor({
        llm: makeLlm('{"transactions":[]}'),
      });
      const r = await extractor.extractFromPdf({ filePath: file });
      expect(r.transactions).toEqual([]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('coerces transaction fields to expected types', async () => {
    const payload = JSON.stringify({
      transactions: [
        { date: '2026-04-15', name: null, memo: null, amount: '50.5', type: 'debit' },
      ],
    });
    const extractor = createDefaultBankPdfExtractor({ llm: makeLlm(payload) });
    const r = await extractor.extractFromPdf({ bytes: new Uint8Array(), filename: 'x.pdf' });
    expect(r.transactions[0]?.amount).toBe(50.5);
    expect(r.transactions[0]?.type).toBe('debit');
    expect(r.transactions[0]?.balance).toBeNull();
  });
});

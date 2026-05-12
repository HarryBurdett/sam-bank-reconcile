import { describe, it, expect } from 'vitest';
import {
  previewBankImportFromPdf,
  type LlmService,
} from '../src/services/preview-from-pdf.js';

interface State {
  banks: Array<{
    code: string;
    description: string;
    sort_code: string;
    account_number: string;
    reconciled_balance: number | null;
  }>;
}

function makeOperaDb(state: State): any {
  const tableBuilder = (table: string) => {
    let codeFilter: string | null = null;
    let sortFilter: string | null = null;
    let acctFilter: string | null = null;
    const builder: any = {
      select: () => builder,
      whereRaw: (sql: string, params: any[]) => {
        if (sql.includes('RTRIM(nk_acnt)')) codeFilter = params?.[0] ?? null;
        if (sql.includes('nk_sort')) sortFilter = params?.[0] ?? null;
        return builder;
      },
      andWhereRaw: (sql: string, params: any[]) => {
        if (sql.includes('nk_number')) acctFilter = params?.[0] ?? null;
        return builder;
      },
      first: async () => {
        if (table !== 'nbank') return undefined;
        if (codeFilter) {
          return state.banks.find((b) => b.code.trim() === codeFilter);
        }
        if (sortFilter && acctFilter) {
          return state.banks.find(
            (b) =>
              b.sort_code.replace(/[\s-]/g, '') === sortFilter &&
              b.account_number.replace(/[\s-]/g, '') === acctFilter,
          );
        }
        return undefined;
      },
    };
    return builder;
  };
  const db: any = (table: string) => tableBuilder(table);
  db.raw = (s: string) => s;
  return db;
}

function makeLlm(jsonResponse: string): LlmService {
  return {
    chat() {
      async function* gen(): AsyncIterable<unknown> {
        yield jsonResponse;
      }
      return gen();
    },
  };
}

describe('previewBankImportFromPdf', () => {
  const state: State = {
    banks: [
      {
        code: 'BC010',
        description: 'Barclays Current',
        sort_code: '20-00-00',
        account_number: '12345678',
        reconciled_balance: 1000,
      },
    ],
  };

  it('rejects when bank_code missing', async () => {
    const result = await previewBankImportFromPdf(
      makeOperaDb(state),
      makeLlm('{}'),
      { filePath: '/tmp/x.pdf', bankCode: '' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/bank_code/);
  });

  it('rejects when no PDF input', async () => {
    const result = await previewBankImportFromPdf(
      makeOperaDb(state),
      makeLlm('{}'),
      { bankCode: 'BC010' },
    );
    expect(result.success).toBe(false);
  });

  it('rejects when bank not in Opera', async () => {
    const result = await previewBankImportFromPdf(
      makeOperaDb({ banks: [] }),
      makeLlm('{}'),
      { filePath: '/tmp/x.pdf', bankCode: 'GHOST' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it('parses LLM JSON and returns transactions', async () => {
    const json = JSON.stringify({
      bank_name: 'Barclays',
      account_number: '12345678',
      sort_code: '20-00-00',
      statement_date: '2026-04-30',
      period_start: '2026-04-01',
      period_end: '2026-04-30',
      opening_balance: 1000,
      closing_balance: 1500,
      transactions: [
        {
          date: '2026-04-15',
          name: 'Acme',
          memo: 'Customer payment',
          amount: 500,
          type: 'credit',
          balance: 1500,
        },
      ],
    });
    const result = await previewBankImportFromPdf(
      makeOperaDb(state),
      makeLlm(json),
      { filePath: '/tmp/x.pdf', bankCode: 'BC010' },
    );
    expect(result.success).toBe(true);
    expect(result.transactions?.length).toBe(1);
    expect(result.statement_info?.opening_balance).toBe(1000);
    expect(result.bank?.code).toBe('BC010');
  });

  it('strips Markdown code fences from LLM response', async () => {
    const fenced = '```json\n{"bank_name":"Barclays","transactions":[]}\n```';
    const result = await previewBankImportFromPdf(
      makeOperaDb(state),
      makeLlm(fenced),
      { filePath: '/tmp/x.pdf', bankCode: 'BC010' },
    );
    expect(result.success).toBe(true);
    expect(result.statement_info?.bank_name).toBe('Barclays');
  });

  it('flags bank mismatch with correct_bank_code suggestion', async () => {
    const stateMulti: State = {
      banks: [
        {
          code: 'BC010',
          description: 'Barclays',
          sort_code: '20-00-00',
          account_number: '11111111',
          reconciled_balance: 0,
        },
        {
          code: 'BC020',
          description: 'Barclays Savings',
          sort_code: '20-00-00',
          account_number: '22222222',
          reconciled_balance: 0,
        },
      ],
    };
    const json = JSON.stringify({
      bank_name: 'Barclays',
      account_number: '22222222',
      sort_code: '20-00-00',
      transactions: [],
    });
    const result = await previewBankImportFromPdf(
      makeOperaDb(stateMulti),
      makeLlm(json),
      { filePath: '/tmp/x.pdf', bankCode: 'BC010' },
    );
    expect(result.success).toBe(false);
    expect(result.bank_mismatch).toBe(true);
    expect(result.correct_bank_code).toBe('BC020');
  });

  it('warns on opening-balance mismatch but proceeds', async () => {
    const json = JSON.stringify({
      account_number: '12345678',
      sort_code: '20-00-00',
      opening_balance: 999,
      transactions: [],
    });
    const result = await previewBankImportFromPdf(
      makeOperaDb(state),
      makeLlm(json),
      { filePath: '/tmp/x.pdf', bankCode: 'BC010' },
    );
    expect(result.success).toBe(true);
    expect(
      result.warnings?.some((w) => w.includes('Opening balance mismatch')),
    ).toBe(true);
  });

  it('falls back to Opera reconciled balance when LLM extracts no opening', async () => {
    const json = JSON.stringify({
      account_number: '12345678',
      sort_code: '20-00-00',
      opening_balance: null,
      transactions: [],
    });
    const result = await previewBankImportFromPdf(
      makeOperaDb(state),
      makeLlm(json),
      { filePath: '/tmp/x.pdf', bankCode: 'BC010' },
    );
    expect(result.success).toBe(true);
    expect(result.statement_info?.opening_balance).toBe(1000);
  });

  it('returns extraction error on non-JSON LLM output', async () => {
    const result = await previewBankImportFromPdf(
      makeOperaDb(state),
      makeLlm('not json at all'),
      { filePath: '/tmp/x.pdf', bankCode: 'BC010' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/extraction failed|non-JSON/i);
  });
});

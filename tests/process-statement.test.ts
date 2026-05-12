import { describe, it, expect } from 'vitest';
import { processStatement } from '../src/services/process-statement.js';
import type { LlmService } from '../src/services/preview-from-pdf.js';

function makeOperaDb(): any {
  // Bank lookup + sname/pname suggestions return Acme; no duplicates.
  const tableBuilder = (table: string) => {
    const builder: any = {
      select: () => builder,
      where: () => builder,
      whereRaw: () => builder,
      andWhereRaw: () => builder,
      andWhere: () => builder,
      andWhereBetween: () => builder,
      orderBy: () => builder,
      limit: () => builder,
      orWhereNull: () => builder,
      first: async () => {
        if (table === 'nbank')
          return {
            code: 'BC010',
            description: 'Barclays',
            sort_code: '20-00-00',
            account_number: '12345678',
            reconciled_balance: 1000,
          };
        return undefined;
      },
      then: async (resolve: any) => {
        if (table === 'sname') {
          return resolve([
            { code: 'A001', name: 'Acme Ltd' },
          ]);
        }
        if (table === 'pname') {
          return resolve([
            { code: 'B001', name: 'Energy Co' },
          ]);
        }
        // duplicate-detection lookups — no rows
        return resolve([]);
      },
    };
    return builder;
  };
  const db: any = (table: string) => tableBuilder(table);
  db.raw = (s: string) => s;
  return db;
}

function makeLlm(json: string): LlmService {
  return {
    chat() {
      async function* gen(): AsyncIterable<unknown> {
        yield json;
      }
      return gen();
    },
  };
}

describe('processStatement', () => {
  it('extracts + matches transactions in one pass', async () => {
    const json = JSON.stringify({
      account_number: '12345678',
      sort_code: '20-00-00',
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
    const result = await processStatement(makeOperaDb(), makeLlm(json), {
      filePath: '/tmp/x.pdf',
      bankCode: 'BC010',
    });
    expect(result.success).toBe(true);
    expect(result.matched_transactions?.length).toBe(1);
    const m = result.matched_transactions?.[0];
    expect(m?.is_duplicate).toBe(false);
    expect(m?.action).toBe('sales_receipt');
    expect(m?.suggested_account?.code).toBe('A001');
  });

  it('routes negative-amount transactions to purchase_payment', async () => {
    const json = JSON.stringify({
      account_number: '12345678',
      sort_code: '20-00-00',
      transactions: [
        {
          date: '2026-04-15',
          name: 'Energy',
          memo: 'DD',
          amount: -100,
          type: 'debit',
        },
      ],
    });
    const result = await processStatement(makeOperaDb(), makeLlm(json), {
      filePath: '/tmp/x.pdf',
      bankCode: 'BC010',
    });
    expect(result.matched_transactions?.[0]?.action).toBe('purchase_payment');
    expect(result.matched_transactions?.[0]?.suggested_account?.code).toBe(
      'B001',
    );
  });

  it('preserves preview-from-pdf errors (passthrough)', async () => {
    const result = await processStatement(makeOperaDb(), makeLlm('not json'), {
      filePath: '/tmp/x.pdf',
      bankCode: 'BC010',
    });
    expect(result.success).toBe(false);
  });
});

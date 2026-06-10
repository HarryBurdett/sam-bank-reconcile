import { describe, it, expect } from 'vitest';
import {
  getBankReconciliationStatus,
  getUnreconciledEntriesForBank,
  getStatementTransactionsForImport,
} from '../src/services/bank-reconciliation-status.js';

const TEST_COMPANY = 'C';

interface NbankRow {
  bank_code: string;
  description: string;
  reconciled_balance: number;
  current_balance: number;
}

interface State {
  banks: NbankRow[];
  unreconciledByBank: Record<string, { cnt: number; total: number }>;
  unreconciledRows?: Array<{
    bank_code: string;
    date: string;
    reference: string;
    amount: number;
    comment: string;
    entry_number: string;
  }>;
  statementTransactions?: Array<{
    line_number: number;
    post_date: string;
    description: string;
    amount: number;
    transaction_type: string;
    matched_entry: string | null;
    is_reconciled: boolean;
  }>;
}

function makeOperaDb(state: State): any {
  const raw = async (sql: string, params: any[] = []) => {
    const lower = sql.toLowerCase();
    if (lower.includes('from nbank')) return state.banks;
    if (lower.includes('from atran') && lower.includes('count(*)')) {
      const code = (params[0] ?? '').toString();
      const c = state.unreconciledByBank[code] ?? { cnt: 0, total: 0 };
      return [{ cnt: c.cnt, total: c.total }];
    }
    if (lower.includes('from atran') && lower.includes('aentry')) {
      const code = (params[0] ?? '').toString().toUpperCase();
      const rows = state.unreconciledRows ?? [];
      return code
        ? rows.filter((r) => r.bank_code.toUpperCase() === code)
        : rows;
    }
    return [];
  };
  const db: any = (table: string) => ({
    where: () => ({
      orderBy: () => ({
        then: async (resolve: any) => {
          if (table === 'bank_statement_transactions') {
            return resolve(state.statementTransactions ?? []);
          }
          return resolve([]);
        },
      }),
    }),
  });
  db.raw = raw;
  return db;
}

describe('getBankReconciliationStatus', () => {
  it('returns empty when no banks', async () => {
    const result = await getBankReconciliationStatus(
      makeOperaDb({ banks: [], unreconciledByBank: {} }),
    );
    expect(result.success).toBe(true);
    expect(result.banks).toEqual([]);
  });

  it('returns each bank with unreconciled count + total', async () => {
    const result = await getBankReconciliationStatus(
      makeOperaDb({
        banks: [
          { bank_code: 'BC010', description: 'Barclays', reconciled_balance: 1000, current_balance: 1500 },
        ],
        unreconciledByBank: { BC010: { cnt: 5, total: 500 } },
      }),
    );
    expect(result.success).toBe(true);
    expect(result.banks.length).toBe(1);
    expect(result.banks[0]?.unreconciled_count).toBe(5);
    expect(result.banks[0]?.unreconciled_total).toBe(500);
  });
});

describe('getUnreconciledEntriesForBank', () => {
  it('returns rows for given bank', async () => {
    const state: State = {
      banks: [],
      unreconciledByBank: {},
      unreconciledRows: [
        {
          bank_code: 'BC010',
          date: '2026-04-15',
          reference: 'TEST',
          amount: 100,
          comment: 'test',
          entry_number: 'R100000001',
        },
      ],
    };
    const result = await getUnreconciledEntriesForBank(makeOperaDb(state), 'BC010');
    expect(result.success).toBe(true);
    expect(result.entries.length).toBe(1);
  });

  it('returns empty when no bank_code filter and no rows', async () => {
    const result = await getUnreconciledEntriesForBank(
      makeOperaDb({ banks: [], unreconciledByBank: {} }),
      null,
    );
    expect(result.success).toBe(true);
    expect(result.entries).toEqual([]);
  });
});

describe('getStatementTransactionsForImport', () => {
  it('rejects invalid import_id', async () => {
    const result = await getStatementTransactionsForImport(
      makeOperaDb({ banks: [], unreconciledByBank: {} }),
      TEST_COMPANY,
      0,
    );
    expect(result.success).toBe(false);
  });

  it('returns mapped rows for valid import_id', async () => {
    const result = await getStatementTransactionsForImport(
      makeOperaDb({
        banks: [],
        unreconciledByBank: {},
        statementTransactions: [
          {
            line_number: 1,
            post_date: '2026-04-15',
            description: 'Acme memo',
            amount: 100,
            transaction_type: 'credit',
            matched_entry: 'A001',
            is_reconciled: false,
          },
        ],
      }),
      TEST_COMPANY,
      42,
    );
    expect(result.success).toBe(true);
    expect(result.transactions.length).toBe(1);
    expect(result.transactions[0]?.matched_entry).toBe('A001');
  });
});

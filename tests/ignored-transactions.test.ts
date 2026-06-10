import { describe, it, expect } from 'vitest';
import {
  ignoreTransaction,
  listIgnoredTransactions,
  unignoreTransactionById,
  unignoreTransactionByMatch,
} from '../src/services/ignored-transactions.js';

const TEST_COMPANY = 'C';

interface MockState {
  rows: Array<Record<string, unknown> & { id: number }>;
  nextId: number;
}

function makeAppDb(state: MockState): any {
  const db: any = (table: string) => {
    if (table !== 'ignored_bank_transactions') {
      throw new Error(`Unexpected table: ${table}`);
    }
    let filters: Record<string, unknown> = {};
    let limitN = Infinity;
    const builder: any = {
      where: (col: Record<string, unknown> | string, val?: unknown) => {
        if (typeof col === 'object') Object.assign(filters, col);
        else if (val !== undefined) filters[col] = val;
        return builder;
      },
      orderBy: () => builder,
      limit: (n: number) => {
        limitN = n;
        return builder;
      },
      then: (cb: (rows: unknown[]) => unknown) => {
        const filtered = state.rows.filter((r) =>
          Object.keys(filters).every((k) => r[k] === filters[k]),
        );
        return Promise.resolve(cb(filtered.slice(0, limitN)));
      },
      delete: async () => {
        const before = state.rows.length;
        state.rows = state.rows.filter(
          (r) => !Object.keys(filters).every((k) => r[k] === filters[k]),
        );
        return before - state.rows.length;
      },
      insert: (row: Record<string, unknown>) => {
        const id = state.nextId++;
        const fullRow = { id, ...row };
        state.rows.push(fullRow as any);
        return {
          returning: () => Promise.resolve([{ id }]),
        };
      },
    };
    return builder;
  };
  db.fn = { now: () => new Date() };
  return db;
}

describe('ignoreTransaction', () => {
  it('inserts a row and returns the new record id', async () => {
    const state: MockState = { rows: [], nextId: 1 };
    const db = makeAppDb(state);
    const result = await ignoreTransaction(db, TEST_COMPANY, {
      bankCode: 'BC010',
      transactionDate: '2026-04-15',
      amount: 1500,
      description: 'GoCardless',
      reference: 'GC-123',
      reason: 'already-in-opera',
    });
    expect(result.success).toBe(true);
    expect(result.record_id).toBe(1);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]?.bank_code).toBe('BC010');
    expect(result.message).toMatch(/£1500\.00 on 2026-04-15/);
  });
});

describe('listIgnoredTransactions', () => {
  it('returns rows for the given bank up to limit', async () => {
    const state: MockState = {
      rows: [
        {
          id: 1,
          company_code: TEST_COMPANY,
          bank_code: 'BC010',
          transaction_date: '2026-04-15',
          amount: 100,
          description: 'A',
          reference: 'R1',
          reason: '',
          ignored_by: 'admin',
          ignored_at: '2026-04-15T10:00:00Z',
        },
        {
          id: 2,
          company_code: TEST_COMPANY,
          bank_code: 'BC010',
          transaction_date: '2026-04-16',
          amount: 200,
          description: 'B',
          reference: 'R2',
          reason: '',
          ignored_by: 'admin',
          ignored_at: '2026-04-16T10:00:00Z',
        },
        {
          id: 3,
          company_code: TEST_COMPANY,
          bank_code: 'BC020',
          transaction_date: '2026-04-15',
          amount: 50,
          description: 'C',
          reference: 'R3',
          reason: '',
          ignored_by: 'admin',
          ignored_at: '2026-04-15T10:00:00Z',
        },
      ],
      nextId: 4,
    };
    const db = makeAppDb(state);
    const result = await listIgnoredTransactions(db, TEST_COMPANY, 'BC010');
    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    expect(result.transactions.every((t) => t.bank_code === 'BC010')).toBe(true);
  });

  it('respects limit parameter', async () => {
    const state: MockState = {
      rows: Array.from({ length: 5 }, (_, i) => ({
        id: i + 1,
        company_code: TEST_COMPANY,
        bank_code: 'BC010',
        transaction_date: '2026-04-15',
        amount: 100 + i,
        description: '',
        reference: '',
        reason: '',
        ignored_by: '',
        ignored_at: '2026-04-15T10:00:00Z',
      })),
      nextId: 6,
    };
    const db = makeAppDb(state);
    const result = await listIgnoredTransactions(db, TEST_COMPANY, 'BC010', 3);
    expect(result.count).toBe(3);
  });
});

describe('unignoreTransactionById', () => {
  it('returns success when record exists', async () => {
    const state: MockState = {
      rows: [
        {
          id: 1,
          company_code: TEST_COMPANY,
          bank_code: 'BC010',
          transaction_date: '2026-04-15',
          amount: 100,
        } as any,
      ],
      nextId: 2,
    };
    const db = makeAppDb(state);
    const result = await unignoreTransactionById(db, TEST_COMPANY,1);
    expect(result.success).toBe(true);
    expect(state.rows).toHaveLength(0);
  });

  it('returns error when record not found', async () => {
    const state: MockState = { rows: [], nextId: 1 };
    const db = makeAppDb(state);
    const result = await unignoreTransactionById(db, TEST_COMPANY,999);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });
});

describe('unignoreTransactionByMatch', () => {
  it('matches on bank+date+amount', async () => {
    const state: MockState = {
      rows: [
        {
          id: 1,
          company_code: TEST_COMPANY,
          bank_code: 'BC010',
          transaction_date: '2026-04-15',
          amount: 100,
        } as any,
        {
          id: 2,
          company_code: TEST_COMPANY,
          bank_code: 'BC010',
          transaction_date: '2026-04-16',
          amount: 200,
        } as any,
      ],
      nextId: 3,
    };
    const db = makeAppDb(state);
    const result = await unignoreTransactionByMatch(db, TEST_COMPANY, 'BC010', '2026-04-15', 100);
    expect(result.success).toBe(true);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]?.id).toBe(2);
  });

  it('returns error when no match', async () => {
    const state: MockState = { rows: [], nextId: 1 };
    const db = makeAppDb(state);
    const result = await unignoreTransactionByMatch(db, TEST_COMPANY, 'BC010', '2026-04-15', 100);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No matching/);
  });
});

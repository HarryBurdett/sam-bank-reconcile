import { describe, it, expect } from 'vitest';
import {
  recordDeferredTransaction,
  listDeferredItems,
  deleteDeferredItems,
  deleteIgnoredTransactionByRecordId,
} from '../src/services/deferred-items.js';

const TEST_COMPANY = 'C';

interface DeferredRow {
  id: number;
  company_code: string;
  bank_code: string;
  statement_date: string;
  amount: number;
  description: string;
  deferred_by: string;
  deferred_at: string;
}

interface State {
  deferred: DeferredRow[];
  ignored: Array<{ id: number }>;
  nextId: number;
}

function makeAppDb(state: State): any {
  function tableBuilder(table: string) {
    let bankFilter: string | null = null;
    let companyFilter: string | null = null;
    let idFilter: number | null = null;
    let idsFilter: number[] | null = null;

    const builder: any = {
      where: (cond: any) => {
        if (typeof cond === 'object') {
          if (cond.bank_code) bankFilter = cond.bank_code;
          if (cond.id) idFilter = cond.id;
          if (cond.company_code) companyFilter = cond.company_code;
        }
        return builder;
      },
      whereIn: (col: string, vals: number[]) => {
        if (col === 'id') idsFilter = vals;
        return builder;
      },
      orderBy: () => builder,
      insert: (payload: any) => ({
        returning: async () => {
          const id = state.nextId++;
          if (table === 'deferred_transactions') {
            state.deferred.push({
              id,
              company_code: String(payload.company_code ?? ''),
              bank_code: payload.bank_code,
              statement_date: payload.statement_date,
              amount: payload.amount,
              description: payload.description,
              deferred_by: payload.deferred_by,
              deferred_at: new Date().toISOString(),
            });
          }
          return [id];
        },
      }),
      delete: async () => {
        if (table === 'deferred_transactions' && bankFilter) {
          const before = state.deferred.length;
          state.deferred = state.deferred.filter((d) => {
            if (d.bank_code !== bankFilter) return true;
            if (companyFilter && d.company_code !== companyFilter) return true;
            if (idsFilter && !idsFilter.includes(d.id)) return true;
            return false;
          });
          return before - state.deferred.length;
        }
        if (table === 'ignored_transactions' && idFilter !== null) {
          const before = state.ignored.length;
          state.ignored = state.ignored.filter((r) => r.id !== idFilter);
          return before - state.ignored.length;
        }
        return 0;
      },
      then: async (resolve: any) => {
        if (table === 'deferred_transactions') {
          let rows = state.deferred;
          if (bankFilter) rows = rows.filter((d) => d.bank_code === bankFilter);
          if (companyFilter)
            rows = rows.filter((d) => d.company_code === companyFilter);
          return resolve(rows);
        }
        return resolve([]);
      },
    };
    return builder;
  }
  const db: any = (table: string) => tableBuilder(table);
  db.fn = { now: () => '__NOW__' };
  return db;
}

describe('recordDeferredTransaction', () => {
  it('rejects empty bank_code', async () => {
    const state: State = { deferred: [], ignored: [], nextId: 1 };
    const r = await recordDeferredTransaction(makeAppDb(state), TEST_COMPANY, {
      bankCode: '',
      statementDate: '2026-04-15',
      amount: 100,
      description: 'test',
      deferredBy: 'admin',
    });
    expect(r.success).toBe(false);
  });
  it('inserts a row and returns id', async () => {
    const state: State = { deferred: [], ignored: [], nextId: 1 };
    const r = await recordDeferredTransaction(makeAppDb(state), TEST_COMPANY, {
      bankCode: 'BC010',
      statementDate: '2026-04-15',
      amount: 100,
      description: 'test',
      deferredBy: 'admin',
    });
    expect(r.success).toBe(true);
    expect(state.deferred.length).toBe(1);
  });
});

describe('listDeferredItems', () => {
  it('filters by bank code', async () => {
    const state: State = {
      deferred: [
        {
          id: 1,
          company_code: TEST_COMPANY,
          bank_code: 'BC010',
          statement_date: '2026-04-15',
          amount: 100,
          description: 't',
          deferred_by: 'a',
          deferred_at: '2026-04-15T00:00:00Z',
        },
        {
          id: 2,
          company_code: TEST_COMPANY,
          bank_code: 'BC020',
          statement_date: '2026-04-15',
          amount: 50,
          description: 'u',
          deferred_by: 'b',
          deferred_at: '2026-04-15T00:00:00Z',
        },
      ],
      ignored: [],
      nextId: 3,
    };
    const r = await listDeferredItems(makeAppDb(state), TEST_COMPANY, 'BC010');
    expect(r.items.length).toBe(1);
    expect(r.items[0]?.bank_code).toBe('BC010');
  });
});

describe('deleteDeferredItems', () => {
  it('deletes only matching ids', async () => {
    const state: State = {
      deferred: [
        {
          id: 1,
          company_code: TEST_COMPANY,
          bank_code: 'BC010',
          statement_date: '2026-04-15',
          amount: 100,
          description: 't',
          deferred_by: 'a',
          deferred_at: '2026-04-15T00:00:00Z',
        },
        {
          id: 2,
          company_code: TEST_COMPANY,
          bank_code: 'BC010',
          statement_date: '2026-04-15',
          amount: 50,
          description: 'u',
          deferred_by: 'b',
          deferred_at: '2026-04-15T00:00:00Z',
        },
      ],
      ignored: [],
      nextId: 3,
    };
    const r = await deleteDeferredItems(makeAppDb(state), TEST_COMPANY, 'BC010', [1]);
    expect(r.success).toBe(true);
    expect(r.deleted).toBe(1);
    expect(state.deferred.length).toBe(1);
  });
});

describe('deleteIgnoredTransactionByRecordId', () => {
  it('rejects invalid id', async () => {
    const state: State = { deferred: [], ignored: [], nextId: 1 };
    const r = await deleteIgnoredTransactionByRecordId(makeAppDb(state), 0);
    expect(r.success).toBe(false);
  });
  it('deletes valid id', async () => {
    const state: State = {
      deferred: [],
      ignored: [{ id: 5 }],
      nextId: 6,
    };
    const r = await deleteIgnoredTransactionByRecordId(makeAppDb(state), 5);
    expect(r.success).toBe(true);
    expect(state.ignored.length).toBe(0);
  });
});

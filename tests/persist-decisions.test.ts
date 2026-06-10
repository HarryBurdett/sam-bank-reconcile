import { describe, it, expect } from 'vitest';
import { persistImportDecisions } from '../src/services/persist-decisions.js';

const TEST_COMPANY = 'C';

interface ImportRow {
  id: number;
  company_code: string;
  bank_code: string;
  filename: string;
  source: string;
  target_system: string;
  transactions_imported: number;
  is_reconciled: boolean;
  period_start: string | null;
  period_end: string | null;
  imported_by: string | null;
}

interface DeferredRow {
  id: number;
  company_code: string;
  bank_code: string;
  post_date: string | null;
  amount: number;
  description: string;
  reason: string | null;
}

interface MockState {
  imports: ImportRow[];
  deferred: DeferredRow[];
  nextImportId: number;
  nextDeferredId: number;
}

function makeAppDb(state: MockState): any {
  const db: any = (table: string) => {
    let conds: Record<string, unknown> = {};
    let notInCol: string | null = null;
    let notInVals: unknown[] | null = null;
    let dateFrom: string | null = null;
    let dateTo: string | null = null;
    let order: { col: string; dir: 'asc' | 'desc' } | null = null;
    if (table === 'bank_statement_imports') {
      const builder: any = {
        where: (cond: Record<string, unknown>) => {
          Object.assign(conds, cond);
          return builder;
        },
        whereNotIn: (col: string, vals: unknown[]) => {
          notInCol = col;
          notInVals = vals;
          return builder;
        },
        orderBy: (col: string, dir: 'asc' | 'desc' = 'asc') => {
          order = { col, dir };
          return builder;
        },
        first: () => {
          let rows = state.imports.filter((r) =>
            Object.entries(conds).every(([k, v]) => (r as any)[k] === v),
          );
          if (notInCol && notInVals) {
            rows = rows.filter((r) => !notInVals!.includes((r as any)[notInCol!]));
          }
          if (order) {
            rows = [...rows].sort((a, b) => {
              const cmp = String((a as any)[order!.col]).localeCompare(
                String((b as any)[order!.col]),
              );
              return order!.dir === 'desc' ? -cmp : cmp;
            });
          }
          return Promise.resolve(rows[0]);
        },
        insert: (row: Partial<ImportRow>) => ({
          returning: (_: string) => {
            const id = state.nextImportId++;
            state.imports.push({
              id,
              company_code: String((row as any).company_code ?? ''),
              bank_code: String(row.bank_code ?? ''),
              filename: String(row.filename ?? ''),
              source: String(row.source ?? 'file'),
              target_system: String(row.target_system ?? 'opera_se'),
              transactions_imported: Number(row.transactions_imported ?? 0),
              is_reconciled: !!row.is_reconciled,
              period_start: (row.period_start as string) ?? null,
              period_end: (row.period_end as string) ?? null,
              imported_by: (row.imported_by as string) ?? null,
            });
            return Promise.resolve([{ id }]);
          },
        }),
      };
      return builder;
    }
    if (table === 'deferred_transactions') {
      const builder: any = {
        where: (cond: Record<string, unknown>) => {
          Object.assign(conds, cond);
          return builder;
        },
        andWhere: (col: string, op: string, val: string) => {
          if (col === 'post_date') {
            if (op === '>=') dateFrom = val;
            if (op === '<=') dateTo = val;
          }
          return builder;
        },
        delete: () => {
          const before = state.deferred.length;
          state.deferred = state.deferred.filter((r) => {
            if (!Object.entries(conds).every(([k, v]) => (r as any)[k] === v)) {
              return true;
            }
            if (dateFrom && (r.post_date ?? '') < dateFrom) return true;
            if (dateTo && (r.post_date ?? '') > dateTo) return true;
            return false;
          });
          return Promise.resolve(before - state.deferred.length);
        },
        insert: (row: Partial<DeferredRow>) => {
          const id = state.nextDeferredId++;
          state.deferred.push({
            id,
            company_code: String((row as any).company_code ?? ''),
            bank_code: String(row.bank_code ?? ''),
            post_date: (row.post_date as string) ?? null,
            amount: Number(row.amount ?? 0),
            description: String(row.description ?? ''),
            reason: (row.reason as string) ?? null,
          });
          return Promise.resolve([id]);
        },
      };
      return builder;
    }
    throw new Error(`Unexpected table: ${table}`);
  };
  db.fn = { now: () => new Date() };
  return db;
}

describe('persistImportDecisions - validation', () => {
  it('rejects missing bank_code', async () => {
    const result = await persistImportDecisions(
      makeAppDb({ imports: [], deferred: [], nextImportId: 1, nextDeferredId: 1 }),
      TEST_COMPANY,
      { bankCode: '', filename: 'x.pdf', source: 'pdf' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/required/);
  });

  it('rejects missing filename', async () => {
    const result = await persistImportDecisions(
      makeAppDb({ imports: [], deferred: [], nextImportId: 1, nextDeferredId: 1 }),
      TEST_COMPANY,
      { bankCode: 'BC010', filename: '', source: 'pdf' },
    );
    expect(result.success).toBe(false);
  });
});

describe('persistImportDecisions - happy path', () => {
  it('inserts a new tracking row + deferred entries', async () => {
    const state: MockState = {
      imports: [],
      deferred: [],
      nextImportId: 1,
      nextDeferredId: 1,
    };
    const result = await persistImportDecisions(makeAppDb(state), TEST_COMPANY, {
      bankCode: 'BC010',
      filename: 'Statement-Apr.pdf',
      source: 'pdf',
      statementInfo: {
        opening_balance: 91879.8,
        closing_balance: 119822.4,
        statement_date: '2026-04-17',
        period_start: '2026-04-11',
        period_end: '2026-04-17',
      },
      deferredTransactions: [
        { date: '2026-04-13', amount: 883.31, description: 'NOT IN OPERA' },
        { date: '2026-04-14', amount: 100, description: '' },
      ],
      importedBy: 'admin',
    });
    expect(result.success).toBe(true);
    expect(result.import_id).toBe(1);
    expect(result.deferred_count).toBe(2);
    expect(state.imports).toHaveLength(1);
    expect(state.imports[0]?.source).toBe('file'); // pdf → file
    expect(state.imports[0]?.target_system).toBe('opera_se');
    expect(state.deferred).toHaveLength(2);
  });

  it('does NOT overwrite an existing import row', async () => {
    const state: MockState = {
      imports: [
        {
          id: 99,
          company_code: TEST_COMPANY,
          bank_code: 'BC010',
          filename: 'Statement-Apr.pdf',
          source: 'file',
          target_system: 'opera_se',
          transactions_imported: 5,
          is_reconciled: true,
          period_start: '2026-04-11',
          period_end: '2026-04-17',
          imported_by: 'previous',
        },
      ],
      deferred: [],
      nextImportId: 100,
      nextDeferredId: 1,
    };
    const result = await persistImportDecisions(makeAppDb(state), TEST_COMPANY, {
      bankCode: 'BC010',
      filename: 'Statement-Apr.pdf',
      source: 'pdf',
      deferredTransactions: [],
    });
    expect(result.success).toBe(true);
    expect(result.import_id).toBe(99);
    // Existing row's fields untouched
    expect(state.imports[0]?.transactions_imported).toBe(5);
    expect(state.imports[0]?.imported_by).toBe('previous');
  });

  it('replaces the bank+period defer set on repeat clicks (idempotent)', async () => {
    const state: MockState = {
      imports: [],
      deferred: [
        {
          id: 1,
          company_code: TEST_COMPANY,
          bank_code: 'BC010',
          post_date: '2026-04-12',
          amount: 50,
          description: 'old',
          reason: 'persist-decisions',
        },
      ],
      nextImportId: 1,
      nextDeferredId: 2,
    };
    await persistImportDecisions(makeAppDb(state), TEST_COMPANY, {
      bankCode: 'BC010',
      filename: 'X.pdf',
      source: 'pdf',
      statementInfo: {
        period_start: '2026-04-11',
        period_end: '2026-04-17',
      },
      deferredTransactions: [
        { date: '2026-04-13', amount: 100, description: 'new' },
      ],
    });
    // Old defer in the same period removed; new one added; total=1
    expect(state.deferred).toHaveLength(1);
    expect(state.deferred[0]?.amount).toBe(100);
    expect(state.deferred[0]?.description).toBe('new');
  });

  it('only clears defers within supplied period bounds (other periods untouched)', async () => {
    const state: MockState = {
      imports: [],
      deferred: [
        {
          id: 1,
          company_code: TEST_COMPANY,
          bank_code: 'BC010',
          post_date: '2026-03-15', // outside Apr period
          amount: 50,
          description: 'march',
          reason: null,
        },
        {
          id: 2,
          company_code: TEST_COMPANY,
          bank_code: 'BC010',
          post_date: '2026-04-12', // inside
          amount: 60,
          description: 'april',
          reason: null,
        },
      ],
      nextImportId: 1,
      nextDeferredId: 3,
    };
    await persistImportDecisions(makeAppDb(state), TEST_COMPANY, {
      bankCode: 'BC010',
      filename: 'X.pdf',
      source: 'pdf',
      statementInfo: {
        period_start: '2026-04-11',
        period_end: '2026-04-17',
      },
      deferredTransactions: [],
    });
    expect(state.deferred).toHaveLength(1);
    expect(state.deferred[0]?.description).toBe('march');
  });

  it('clears ALL defers for the bank when period bounds omitted', async () => {
    const state: MockState = {
      imports: [],
      deferred: [
        {
          id: 1,
          company_code: TEST_COMPANY,
          bank_code: 'BC010',
          post_date: '2026-03-15',
          amount: 50,
          description: '',
          reason: null,
        },
        {
          id: 2,
          company_code: TEST_COMPANY,
          bank_code: 'BC010',
          post_date: '2026-04-12',
          amount: 60,
          description: '',
          reason: null,
        },
      ],
      nextImportId: 1,
      nextDeferredId: 3,
    };
    await persistImportDecisions(makeAppDb(state), TEST_COMPANY, {
      bankCode: 'BC010',
      filename: 'X.pdf',
      source: 'pdf',
      deferredTransactions: [],
    });
    expect(state.deferred).toHaveLength(0);
  });
});

import { describe, it, expect } from 'vitest';
import {
  listImportHistory,
  deleteImportRecord,
  clearImportHistory,
} from '../src/services/import-history.js';

interface ImportRow {
  id: number;
  bank_code: string;
  filename: string | null;
  statement_date: string | null;
  opening_balance: number | null;
  closing_balance: number | null;
  source: string | null;
  source_ref: string | null;
  imported_by: string | null;
  imported_at: string;
  is_reconciled: number; // sqlite-style 0/1
  reconciled_count: number;
  reconciled_at: string | null;
  target_system: string;
  transactions_imported: number;
  total_receipts: number;
  total_payments: number;
  account_number: string | null;
  sort_code: string | null;
  period_start: string | null;
  period_end: string | null;
  reconciled_by: string | null;
}

interface MockState {
  rows: ImportRow[];
}

function makeAppDb(state: MockState): any {
  const db: any = (table: string) => {
    if (table !== 'bank_statement_imports') {
      throw new Error(`Unexpected table: ${table}`);
    }
    let conds: Record<string, unknown> = {};
    let cmpConds: Array<{ col: string; op: string; val: unknown }> = [];
    let order: { col: keyof ImportRow; dir: 'asc' | 'desc' } | null = null;
    let limitN = Infinity;
    const matches = () =>
      state.rows.filter(
        (r) =>
          Object.entries(conds).every(([k, v]) => (r as any)[k] === v) &&
          cmpConds.every((c) => {
            const lhs = (r as any)[c.col];
            if (c.op === '>=') return lhs >= (c.val as any);
            if (c.op === '<=') return lhs <= (c.val as any);
            return true;
          }),
      );
    const builder: any = {
      where: (col: any, op?: any, val?: any) => {
        if (typeof col === 'string') {
          if (op !== undefined && val !== undefined) {
            cmpConds.push({ col, op, val });
          } else {
            conds[col] = op;
          }
        } else {
          Object.assign(conds, col);
        }
        return builder;
      },
      orderBy: (col: keyof ImportRow, dir: 'asc' | 'desc' = 'asc') => {
        order = { col, dir };
        return builder;
      },
      limit: (n: number) => {
        limitN = n;
        return builder;
      },
      delete: async () => {
        const targets = matches();
        const before = state.rows.length;
        state.rows = state.rows.filter((r) => !targets.includes(r));
        return before - state.rows.length;
      },
      then: (cb: (rows: ImportRow[]) => unknown) => {
        let result = matches();
        if (order) {
          const o = order;
          result = [...result].sort((a, b) => {
            const av = String(a[o.col]);
            const bv = String(b[o.col]);
            const cmp = av.localeCompare(bv);
            return o.dir === 'desc' ? -cmp : cmp;
          });
        }
        return Promise.resolve(cb(result.slice(0, limitN)));
      },
    };
    return builder;
  };
  db.fn = { now: () => '__NOW__' };
  return db;
}

function emptyRow(over: Partial<ImportRow> = {}): ImportRow {
  return {
    id: 1,
    bank_code: 'BANK01',
    filename: 'stmt.pdf',
    statement_date: '2026-04-01',
    opening_balance: 1000,
    closing_balance: 1500,
    source: 'email',
    source_ref: null,
    imported_by: 'user',
    imported_at: '2026-04-15T10:00:00Z',
    is_reconciled: 0,
    reconciled_count: 0,
    reconciled_at: null,
    target_system: 'opera_se',
    transactions_imported: 5,
    total_receipts: 1500,
    total_payments: 0,
    account_number: '12345678',
    sort_code: '12-34-56',
    period_start: null,
    period_end: null,
    reconciled_by: null,
    ...over,
  };
}

// ---------------------------------------------------------------------
// listImportHistory
// ---------------------------------------------------------------------

describe('listImportHistory', () => {
  it('returns rows in imported_at desc order', async () => {
    const state: MockState = {
      rows: [
        emptyRow({ id: 1, imported_at: '2026-04-10T10:00:00Z' }),
        emptyRow({ id: 2, imported_at: '2026-04-15T10:00:00Z' }),
      ],
    };
    const result = await listImportHistory(makeAppDb(state));
    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    expect(result.imports[0]?.id).toBe(2);
  });

  it('filters by bank_code', async () => {
    const state: MockState = {
      rows: [
        emptyRow({ id: 1, bank_code: 'BANK01' }),
        emptyRow({ id: 2, bank_code: 'BANK02' }),
      ],
    };
    const result = await listImportHistory(makeAppDb(state), {
      bankCode: 'BANK02',
    });
    expect(result.count).toBe(1);
    expect(result.imports[0]?.bank_code).toBe('BANK02');
  });

  it('filters by date range (statement_date)', async () => {
    const state: MockState = {
      rows: [
        emptyRow({ id: 1, statement_date: '2026-03-15' }),
        emptyRow({ id: 2, statement_date: '2026-04-15' }),
        emptyRow({ id: 3, statement_date: '2026-05-15' }),
      ],
    };
    const result = await listImportHistory(makeAppDb(state), {
      fromDate: '2026-04-01',
      toDate: '2026-04-30',
    });
    expect(result.count).toBe(1);
    expect(result.imports[0]?.id).toBe(2);
  });

  it('respects limit', async () => {
    const state: MockState = {
      rows: Array.from({ length: 10 }, (_, i) =>
        emptyRow({
          id: i + 1,
          imported_at: `2026-04-${10 + i}T00:00:00Z`,
        }),
      ),
    };
    const result = await listImportHistory(makeAppDb(state), { limit: 3 });
    expect(result.count).toBe(3);
  });

  it('defaults target_system to opera_se and excludes other systems', async () => {
    const state: MockState = {
      rows: [
        emptyRow({ id: 1, target_system: 'opera_se' }),
        emptyRow({ id: 2, target_system: 'opera3' }),
      ],
    };
    const result = await listImportHistory(makeAppDb(state));
    expect(result.count).toBe(1);
    expect(result.imports[0]?.target_system).toBe('opera_se');
  });

  it('honours custom target_system filter', async () => {
    const state: MockState = {
      rows: [
        emptyRow({ id: 1, target_system: 'opera_se' }),
        emptyRow({ id: 2, target_system: 'opera3' }),
      ],
    };
    const result = await listImportHistory(makeAppDb(state), {
      targetSystem: 'opera3',
    });
    expect(result.count).toBe(1);
    expect(result.imports[0]?.target_system).toBe('opera3');
  });

  it('coerces is_reconciled int to boolean', async () => {
    const state: MockState = {
      rows: [
        emptyRow({ id: 1, is_reconciled: 1 }),
        emptyRow({ id: 2, is_reconciled: 0 }),
      ],
    };
    const result = await listImportHistory(makeAppDb(state));
    const map = Object.fromEntries(
      result.imports.map((r) => [r.id, r.is_reconciled]),
    );
    expect(map[1]).toBe(true);
    expect(map[2]).toBe(false);
  });
});

// ---------------------------------------------------------------------
// deleteImportRecord
// ---------------------------------------------------------------------

describe('deleteImportRecord', () => {
  it('deletes the row and returns success', async () => {
    const state: MockState = { rows: [emptyRow({ id: 42 })] };
    const result = await deleteImportRecord(makeAppDb(state), 42);
    expect(result.success).toBe(true);
    expect(state.rows).toHaveLength(0);
  });

  it('returns 404-style error when record_id missing', async () => {
    const state: MockState = { rows: [] };
    const result = await deleteImportRecord(makeAppDb(state), 99);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it('rejects invalid record_id', async () => {
    const state: MockState = { rows: [] };
    const result = await deleteImportRecord(makeAppDb(state), NaN);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid/);
  });
});

// ---------------------------------------------------------------------
// clearImportHistory
// ---------------------------------------------------------------------

describe('clearImportHistory', () => {
  it('clears all rows when no filters supplied', async () => {
    const state: MockState = {
      rows: [emptyRow({ id: 1 }), emptyRow({ id: 2 })],
    };
    const result = await clearImportHistory(makeAppDb(state));
    expect(result.success).toBe(true);
    expect(result.deleted_count).toBe(2);
    expect(state.rows).toHaveLength(0);
  });

  it('respects bank_code filter', async () => {
    const state: MockState = {
      rows: [
        emptyRow({ id: 1, bank_code: 'BANK01' }),
        emptyRow({ id: 2, bank_code: 'BANK02' }),
      ],
    };
    const result = await clearImportHistory(makeAppDb(state), {
      bankCode: 'BANK01',
    });
    expect(result.deleted_count).toBe(1);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]?.bank_code).toBe('BANK02');
  });

  it('respects date range', async () => {
    const state: MockState = {
      rows: [
        emptyRow({ id: 1, statement_date: '2026-03-15' }),
        emptyRow({ id: 2, statement_date: '2026-04-15' }),
        emptyRow({ id: 3, statement_date: '2026-05-15' }),
      ],
    };
    const result = await clearImportHistory(makeAppDb(state), {
      fromDate: '2026-04-01',
      toDate: '2026-04-30',
    });
    expect(result.deleted_count).toBe(1);
    expect(state.rows.map((r) => r.id).sort()).toEqual([1, 3]);
  });
});

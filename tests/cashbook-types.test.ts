import { describe, it, expect } from 'vitest';
import { listCashbookTypes } from '../src/services/cashbook-types.js';

interface MockState {
  rows: Array<{
    ay_cbtype: string | null;
    ay_desc: string | null;
    ay_type: string | null;
    ay_batched: number | boolean | null;
  }>;
  // Last raw SQL + bindings captured for assertions
  lastSql?: string;
  lastBindings?: unknown[];
}

function makeOperaDb(state: MockState): any {
  const db: any = {};
  db.raw = (sql: string, bindings?: unknown[]) => {
    state.lastSql = sql;
    state.lastBindings = bindings;
    let rows = state.rows;
    // If a category filter was provided, simulate the WHERE clause
    if (sql.includes('RTRIM(ay_type) = ?') && bindings && bindings[0]) {
      rows = rows.filter((r) => (r.ay_type ?? '').trim() === bindings[0]);
    }
    return Promise.resolve(rows);
  };
  return db;
}

describe('listCashbookTypes', () => {
  it('returns all types when no category provided', async () => {
    const state: MockState = {
      rows: [
        { ay_cbtype: '01', ay_desc: 'Sales receipt', ay_type: 'R', ay_batched: 0 },
        { ay_cbtype: '02', ay_desc: 'Purchase payment', ay_type: 'P', ay_batched: 0 },
        { ay_cbtype: '03', ay_desc: 'GoCardless batch', ay_type: 'R', ay_batched: 1 },
      ],
    };
    const db = makeOperaDb(state);
    const result = await listCashbookTypes(db);

    expect(result.success).toBe(true);
    expect(result.types).toHaveLength(3);
    expect(result.types[0]).toEqual({
      code: '01',
      description: 'Sales receipt',
      category: 'R',
      batched: false,
    });
    expect(result.types[2]?.batched).toBe(true);
    // No WHERE clause should have been added
    expect(state.lastSql).not.toMatch(/RTRIM\(ay_type\) = \?/);
    // NOLOCK present
    expect(state.lastSql).toMatch(/atype WITH \(NOLOCK\)/);
  });

  it('filters by category when provided', async () => {
    const state: MockState = {
      rows: [
        { ay_cbtype: '01', ay_desc: 'Sales receipt', ay_type: 'R', ay_batched: 0 },
        { ay_cbtype: '02', ay_desc: 'Purchase payment', ay_type: 'P', ay_batched: 0 },
      ],
    };
    const db = makeOperaDb(state);
    const result = await listCashbookTypes(db, 'P');

    expect(result.success).toBe(true);
    expect(result.types).toHaveLength(1);
    expect(result.types[0]?.code).toBe('02');
    expect(state.lastSql).toMatch(/RTRIM\(ay_type\) = \?/);
    expect(state.lastBindings).toEqual(['P']);
  });

  it('handles empty result', async () => {
    const state: MockState = { rows: [] };
    const db = makeOperaDb(state);
    const result = await listCashbookTypes(db);

    expect(result.success).toBe(true);
    expect(result.types).toEqual([]);
  });

  it('trims whitespace in code/description/category', async () => {
    const state: MockState = {
      rows: [
        { ay_cbtype: '  01  ', ay_desc: '  Sales receipt  ',
          ay_type: '  R  ', ay_batched: 0 },
      ],
    };
    const db = makeOperaDb(state);
    const result = await listCashbookTypes(db);

    expect(result.types[0]).toEqual({
      code: '01',
      description: 'Sales receipt',
      category: 'R',
      batched: false,
    });
  });

  it('returns error on DB failure', async () => {
    const db: any = {
      raw: () => Promise.reject(new Error('connection lost')),
    };
    const result = await listCashbookTypes(db);

    expect(result.success).toBe(false);
    expect(result.types).toEqual([]);
    expect(result.error).toMatch(/connection lost/);
  });
});

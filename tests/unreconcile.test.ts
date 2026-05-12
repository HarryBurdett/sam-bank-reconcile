import { describe, it, expect } from 'vitest';
import { unreconcileEntries } from '../src/services/unreconcile.js';

interface AppLockRow {
  id: number;
  bank_code: string;
  locked_at: Date;
  locked_by: string;
  endpoint: string;
  description: string;
}

interface AppMockState {
  lockRows: AppLockRow[];
  nextId: number;
}

function makeAppDb(state: AppMockState): any {
  const db: any = (table: string) => {
    if (table !== 'import_locks') {
      throw new Error(`Unexpected app table: ${table}`);
    }
    let conds: any = {};
    let lessThanCol: any = null;
    let lessThanVal: any = null;
    const builder: any = {
      where: (cond: any, op?: any, val?: any) => {
        if (typeof cond === 'string' && op === '<') {
          lessThanCol = cond;
          lessThanVal = val;
        } else if (typeof cond === 'object') {
          conds = { ...conds, ...cond };
        }
        return builder;
      },
      first: () => {
        const found = state.lockRows.find((r) =>
          Object.entries(conds).every(([k, v]) => (r as any)[k] === v),
        );
        return Promise.resolve(found);
      },
      delete: () => {
        if (lessThanCol && lessThanVal) {
          const before = state.lockRows.length;
          state.lockRows = state.lockRows.filter(
            (r) => (r as any)[lessThanCol].getTime() >= lessThanVal.getTime(),
          );
          return Promise.resolve(before - state.lockRows.length);
        }
        const before = state.lockRows.length;
        state.lockRows = state.lockRows.filter(
          (r) =>
            !Object.entries(conds).every(([k, v]) => (r as any)[k] === v),
        );
        return Promise.resolve(before - state.lockRows.length);
      },
      insert: (row: any) => {
        if (state.lockRows.some((r) => r.bank_code === row.bank_code)) {
          return Promise.reject(new Error('UNIQUE constraint'));
        }
        state.lockRows.push({
          id: state.nextId++,
          bank_code: row.bank_code,
          locked_at: new Date(),
          locked_by: row.locked_by ?? 'unknown',
          endpoint: row.endpoint ?? 'unknown',
          description: row.description ?? '',
        });
        return Promise.resolve([state.nextId - 1]);
      },
    };
    return builder;
  };
  db.fn = { now: () => new Date() };
  return db;
}

interface OperaState {
  resetRowsAffected: number;
  reconciledTotalPence: number;
  prior: {
    lststno?: number;
    lstrecdate?: Date | string;
    reclnum?: number;
    statln?: number;
    recbal?: number;
  } | null;
  capturedSql: string[];
  capturedParams: unknown[][];
  rollbackOnSecondQuery?: boolean;
  queryCount?: number;
}

function makeOperaDb(state: OperaState): any {
  state.queryCount = state.queryCount ?? 0;
  const txRaw = (sql: string, params?: unknown[]) => {
    state.queryCount = (state.queryCount ?? 0) + 1;
    state.capturedSql.push(sql);
    state.capturedParams.push(params ?? []);
    if (
      state.rollbackOnSecondQuery &&
      state.queryCount === 2 // throw on second query
    ) {
      return Promise.reject(new Error('forced rollback'));
    }
    if (sql.includes('UPDATE aentry')) {
      return Promise.resolve({ rowCount: state.resetRowsAffected });
    }
    if (sql.includes('SUM(ae_value)')) {
      return Promise.resolve([
        { reconciled_total: state.reconciledTotalPence },
      ]);
    }
    if (sql.includes('FROM aentry') && sql.includes('ORDER BY')) {
      return Promise.resolve(state.prior ? [state.prior] : []);
    }
    if (sql.includes('UPDATE nbank')) {
      return Promise.resolve({ rowCount: 1 });
    }
    return Promise.resolve([]);
  };

  const operaDb: any = {
    transaction: async (cb: (trx: unknown) => Promise<unknown>) => {
      // The transaction object only needs a `.raw` method for our service.
      const trx = { raw: txRaw };
      return cb(trx);
    },
    raw: txRaw, // also support direct calls (not used here, but defensive)
  };
  return operaDb;
}

describe('unreconcileEntries', () => {
  it('rejects bad bank_code', async () => {
    const result = await unreconcileEntries(
      makeAppDb({ lockRows: [], nextId: 1 }),
      makeOperaDb({
        resetRowsAffected: 0,
        reconciledTotalPence: 0,
        prior: null,
        capturedSql: [],
        capturedParams: [],
      }),
      { bankCode: "BC';--", entryNumbers: ['P100008036'] },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/bank_code/);
  });

  it('rejects bad entry_number in the list', async () => {
    const result = await unreconcileEntries(
      makeAppDb({ lockRows: [], nextId: 1 }),
      makeOperaDb({
        resetRowsAffected: 0,
        reconciledTotalPence: 0,
        prior: null,
        capturedSql: [],
        capturedParams: [],
      }),
      { bankCode: 'BC010', entryNumbers: ["P1';DROP--"] },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/entry number/);
  });

  it('rejects empty entry_numbers', async () => {
    const result = await unreconcileEntries(
      makeAppDb({ lockRows: [], nextId: 1 }),
      makeOperaDb({
        resetRowsAffected: 0,
        reconciledTotalPence: 0,
        prior: null,
        capturedSql: [],
        capturedParams: [],
      }),
      { bankCode: 'BC010', entryNumbers: [] },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/entry_numbers/);
  });

  it('refuses when bank already locked', async () => {
    const appState: AppMockState = {
      lockRows: [
        {
          id: 1,
          bank_code: 'BC010',
          locked_at: new Date(),
          locked_by: 'other',
          endpoint: 'other',
          description: '',
        },
      ],
      nextId: 2,
    };
    const result = await unreconcileEntries(
      makeAppDb(appState),
      makeOperaDb({
        resetRowsAffected: 0,
        reconciledTotalPence: 0,
        prior: null,
        capturedSql: [],
        capturedParams: [],
      }),
      { bankCode: 'BC010', entryNumbers: ['P100008036'] },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/being imported/);
  });

  it('happy path with prior batch — updates nbank to prior state', async () => {
    const appState: AppMockState = { lockRows: [], nextId: 1 };
    const operaState: OperaState = {
      resetRowsAffected: 2,
      reconciledTotalPence: 4500000, // £45,000.00 in pence
      prior: {
        lststno: 86940,
        lstrecdate: '2026-04-15',
        reclnum: 5,
        statln: 12,
        recbal: 4500000,
      },
      capturedSql: [],
      capturedParams: [],
    };
    const result = await unreconcileEntries(
      makeAppDb(appState),
      makeOperaDb(operaState),
      {
        bankCode: 'BC010',
        entryNumbers: ['P100008036', 'PR00000534'],
      },
    );
    expect(result.success).toBe(true);
    expect(result.entries_unreconciled).toBe(2);
    expect(result.new_reconciled_balance).toBe(45000);
    // Released the lock (no rows left)
    expect(appState.lockRows).toHaveLength(0);

    // Reset SQL has ROWLOCK + IN(...) clause
    const resetSql = operaState.capturedSql.find((s) =>
      s.includes('UPDATE aentry'),
    );
    expect(resetSql).toMatch(/UPDATE aentry WITH \(ROWLOCK\)/);
    expect(resetSql).toMatch(/ae_entry IN \(\?,\?\)/);
    // nbank update used prior state values
    const nbankSql = operaState.capturedSql.find((s) =>
      s.includes('UPDATE nbank'),
    );
    expect(nbankSql).toMatch(/UPDATE nbank WITH \(ROWLOCK\)/);
    const nbankParams =
      operaState.capturedParams[
        operaState.capturedSql.findIndex((s) => s.includes('UPDATE nbank'))
      ];
    expect(nbankParams).toEqual([
      4500000, // recbal in pence
      86940, // prior_lststno
      6, // prior_reclnum + 1
      6, // also prior_reclnum + 1
      '2026-04-15', // prior_recdate
      12, // prior_statln
      'BC010',
    ]);
  });

  it('happy path with NO prior — fresh-bank reset', async () => {
    const operaState: OperaState = {
      resetRowsAffected: 1,
      reconciledTotalPence: 0,
      prior: null,
      capturedSql: [],
      capturedParams: [],
    };
    const result = await unreconcileEntries(
      makeAppDb({ lockRows: [], nextId: 1 }),
      makeOperaDb(operaState),
      { bankCode: 'BC010', entryNumbers: ['P100008036'] },
    );
    expect(result.success).toBe(true);
    expect(result.new_reconciled_balance).toBe(0);
    const nbankSql = operaState.capturedSql.find((s) =>
      s.includes('UPDATE nbank'),
    );
    expect(nbankSql).toMatch(/nk_lststno  = 0/);
    expect(nbankSql).toMatch(/nk_lstrecl  = 1/);
  });

  it('releases lock on opera transaction error', async () => {
    const appState: AppMockState = { lockRows: [], nextId: 1 };
    const operaState: OperaState = {
      resetRowsAffected: 0,
      reconciledTotalPence: 0,
      prior: null,
      capturedSql: [],
      capturedParams: [],
      rollbackOnSecondQuery: true,
    };
    const result = await unreconcileEntries(
      makeAppDb(appState),
      makeOperaDb(operaState),
      { bankCode: 'BC010', entryNumbers: ['P100008036'] },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/forced rollback/);
    expect(appState.lockRows).toHaveLength(0); // lock released
  });
});

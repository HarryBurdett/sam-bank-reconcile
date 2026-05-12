import { describe, it, expect } from 'vitest';
import { markEntriesReconciled } from '../src/services/mark-reconciled.js';

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
  // initial nbank state
  nk_lstrecl: number;
  nk_recbal: number; // pence
  nk_curbal: number; // pence
  nk_lststno: number;
  // entries that exist in aentry (key: ae_entry → {value, reclnum})
  aentries: Map<string, { value: number; reclnum: number }>;
  // After UPDATE we capture the SQL strings + params for assertions
  capturedSql: string[];
  capturedParams: unknown[][];
  // Final nk_recbal returned by the verify SELECT
  finalRecBal?: number;
}

function makeOperaDb(state: OperaState): any {
  const txRaw = (sql: string, params?: unknown[]) => {
    state.capturedSql.push(sql);
    state.capturedParams.push(params ?? []);

    if (sql.includes('FROM nbank') && sql.includes('UPDLOCK')) {
      return Promise.resolve([
        {
          nk_lstrecl: state.nk_lstrecl,
          nk_recbal: state.nk_recbal,
          nk_curbal: state.nk_curbal,
          nk_lststno: state.nk_lststno,
        },
      ]);
    }
    if (sql.includes('UPDATE nbank') && sql.includes('nk_lstrecl < 1')) {
      // Auto-recover bump
      state.nk_lstrecl = 1;
      return Promise.resolve({ rowCount: 1 });
    }
    if (sql.includes('FROM aentry') && sql.includes('UPDLOCK')) {
      const entryNumbers = (params ?? []).slice(1) as string[];
      const rows = entryNumbers
        .map((e) => {
          const found = state.aentries.get(e);
          if (!found) return null;
          return {
            ae_entry: e,
            ae_value: found.value,
            ae_reclnum: found.reclnum,
          };
        })
        .filter((r) => r !== null);
      return Promise.resolve(rows);
    }
    if (sql.includes('UPDATE aentry')) {
      return Promise.resolve({ rowCount: 1 });
    }
    if (sql.includes('UPDATE nbank')) {
      // Final nbank update
      state.finalRecBal = Number((params ?? [])[0] ?? state.nk_recbal);
      return Promise.resolve({ rowCount: 1 });
    }
    if (sql.includes('SELECT nk_recbal') && sql.includes('NOLOCK')) {
      return Promise.resolve([{ nk_recbal: state.finalRecBal ?? state.nk_recbal }]);
    }
    return Promise.resolve([]);
  };

  const operaDb: any = {
    transaction: async (cb: (trx: unknown) => Promise<unknown>) => {
      const trx = { raw: txRaw };
      try {
        return await cb(trx);
      } catch (e) {
        // Caller's error propagates; nothing else to do in mock
        throw e;
      }
    },
  };
  return operaDb;
}

describe('markEntriesReconciled - validation', () => {
  it('rejects bad bank_code', async () => {
    const result = await markEntriesReconciled(
      makeAppDb({ lockRows: [], nextId: 1 }),
      makeOperaDb({
        nk_lstrecl: 0,
        nk_recbal: 0,
        nk_curbal: 0,
        nk_lststno: 0,
        aentries: new Map(),
        capturedSql: [],
        capturedParams: [],
      }),
      {
        bankCode: "BC';--",
        entries: [{ entry_number: 'P100008036', statement_line: 10 }],
        statementNumber: 1,
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/bank_code/);
  });

  it('rejects empty entries', async () => {
    const result = await markEntriesReconciled(
      makeAppDb({ lockRows: [], nextId: 1 }),
      makeOperaDb({
        nk_lstrecl: 0,
        nk_recbal: 0,
        nk_curbal: 0,
        nk_lststno: 0,
        aentries: new Map(),
        capturedSql: [],
        capturedParams: [],
      }),
      { bankCode: 'BC010', entries: [], statementNumber: 1 },
    );
    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toMatch(/No entries provided/);
  });

  it('returns errors when an entry is already reconciled', async () => {
    const operaState: OperaState = {
      nk_lstrecl: 5,
      nk_recbal: 100000,
      nk_curbal: 200000,
      nk_lststno: 80000,
      aentries: new Map([
        ['P100008036', { value: 50000, reclnum: 0 }],
        ['PR00000534', { value: 25000, reclnum: 4 }], // already reconciled
      ]),
      capturedSql: [],
      capturedParams: [],
    };
    const result = await markEntriesReconciled(
      makeAppDb({ lockRows: [], nextId: 1 }),
      makeOperaDb(operaState),
      {
        bankCode: 'BC010',
        entries: [
          { entry_number: 'P100008036', statement_line: 10 },
          { entry_number: 'PR00000534', statement_line: 20 },
        ],
        statementNumber: 86918,
      },
    );
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors?.[0]).toMatch(/PR00000534 already reconciled/);
  });

  it('returns errors when entry not found', async () => {
    const operaState: OperaState = {
      nk_lstrecl: 5,
      nk_recbal: 0,
      nk_curbal: 0,
      nk_lststno: 0,
      aentries: new Map(),
      capturedSql: [],
      capturedParams: [],
    };
    const result = await markEntriesReconciled(
      makeAppDb({ lockRows: [], nextId: 1 }),
      makeOperaDb(operaState),
      {
        bankCode: 'BC010',
        entries: [{ entry_number: 'P100008036', statement_line: 10 }],
        statementNumber: 1,
      },
    );
    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toMatch(/not found/);
  });
});

describe('markEntriesReconciled - happy path full', () => {
  it('marks all entries with running balance + advances nk_recbal', async () => {
    const operaState: OperaState = {
      nk_lstrecl: 5,
      nk_recbal: 1000000, // £10,000.00
      nk_curbal: 5000000,
      nk_lststno: 80000,
      aentries: new Map([
        ['P100008036', { value: 50000, reclnum: 0 }], // £500
        ['PR00000534', { value: 25000, reclnum: 0 }], // £250
      ]),
      capturedSql: [],
      capturedParams: [],
    };
    const result = await markEntriesReconciled(
      makeAppDb({ lockRows: [], nextId: 1 }),
      makeOperaDb(operaState),
      {
        bankCode: 'BC010',
        entries: [
          { entry_number: 'P100008036', statement_line: 10 },
          { entry_number: 'PR00000534', statement_line: 20 },
        ],
        statementNumber: 86918,
        statementDate: '2026-04-15',
        reconciliationDate: '2026-04-15',
      },
    );

    expect(result.success).toBe(true);
    expect(result.records_reconciled).toBe(2);
    expect(result.new_reconciled_balance).toBe(10750); // (1000000 + 50000 + 25000) / 100

    // Confirm the rec_batch_number = 5 was used
    const aentryUpdates = operaState.capturedSql.filter((s) =>
      s.includes('UPDATE aentry') && s.includes('ae_reclnum'),
    );
    expect(aentryUpdates).toHaveLength(2);

    // Find the params passed to nbank update; first arg is new nk_recbal
    const nbankUpdateIdx = operaState.capturedSql.findIndex((s) =>
      s.includes('UPDATE nbank') && s.includes('nk_recbal = ?'),
    );
    const nbankParams = operaState.capturedParams[nbankUpdateIdx]!;
    expect(nbankParams[0]).toBe(1075000); // pence
    // newRecLine = recBatchNumber (5) + 1 = 6
    expect(nbankParams[1]).toBe(6);
  });

  it('auto-recovers fresh-bank state (nk_lstrecl < 1)', async () => {
    const operaState: OperaState = {
      nk_lstrecl: 0,
      nk_recbal: 0,
      nk_curbal: 100000,
      nk_lststno: 0,
      aentries: new Map([
        ['P100008036', { value: 50000, reclnum: 0 }],
      ]),
      capturedSql: [],
      capturedParams: [],
    };
    const result = await markEntriesReconciled(
      makeAppDb({ lockRows: [], nextId: 1 }),
      makeOperaDb(operaState),
      {
        bankCode: 'BC010',
        entries: [{ entry_number: 'P100008036', statement_line: 10 }],
        statementNumber: 1,
      },
    );
    expect(result.success).toBe(true);
    // Should have auto-bumped nk_lstrecl to 1 BEFORE the aentry update
    const bumpIdx = operaState.capturedSql.findIndex((s) =>
      s.includes('UPDATE nbank') && s.includes('nk_lstrecl < 1'),
    );
    expect(bumpIdx).toBeGreaterThanOrEqual(0);
  });

  it('sorts entries by statement_line for running balance', async () => {
    const operaState: OperaState = {
      nk_lstrecl: 1,
      nk_recbal: 0,
      nk_curbal: 100000,
      nk_lststno: 0,
      aentries: new Map([
        ['ENT_A', { value: 30000, reclnum: 0 }],
        ['ENT_B', { value: 20000, reclnum: 0 }],
        ['ENT_C', { value: 10000, reclnum: 0 }],
      ]),
      capturedSql: [],
      capturedParams: [],
    };
    await markEntriesReconciled(
      makeAppDb({ lockRows: [], nextId: 1 }),
      makeOperaDb(operaState),
      {
        bankCode: 'BC010',
        entries: [
          { entry_number: 'ENT_A', statement_line: 30 },
          { entry_number: 'ENT_B', statement_line: 10 },
          { entry_number: 'ENT_C', statement_line: 20 },
        ],
        statementNumber: 1,
      },
    );

    // Find the aentry updates in order — the running balance should
    // be 20000, 30000 (20000+10000), 60000 (30000+10000+20000+0)
    // sorted by statement_line: ENT_B(10), ENT_C(20), ENT_A(30)
    const aentryUpdates = operaState.capturedParams.filter((p, i) =>
      operaState.capturedSql[i]?.includes('UPDATE aentry') &&
      operaState.capturedSql[i]?.includes('ae_recbal'),
    );
    expect(aentryUpdates).toHaveLength(3);
    // Each update's params include ae_recbal at position 5 (after
    // ae_reclnum, ae_recdate, ae_statln, ae_frstat, ae_tostat).
    expect(aentryUpdates[0]?.[5]).toBe(20000); // B
    expect(aentryUpdates[1]?.[5]).toBe(30000); // B+C
    expect(aentryUpdates[2]?.[5]).toBe(60000); // B+C+A
  });
});

describe('markEntriesReconciled - partial mode', () => {
  it('sets ae_tmpstat without advancing nk_recbal', async () => {
    const operaState: OperaState = {
      nk_lstrecl: 5,
      nk_recbal: 100000,
      nk_curbal: 200000,
      nk_lststno: 0,
      aentries: new Map([
        ['ENT_A', { value: 50000, reclnum: 0 }],
      ]),
      capturedSql: [],
      capturedParams: [],
    };
    const result = await markEntriesReconciled(
      makeAppDb({ lockRows: [], nextId: 1 }),
      makeOperaDb(operaState),
      {
        bankCode: 'BC010',
        entries: [{ entry_number: 'ENT_A', statement_line: 10 }],
        statementNumber: 86918,
        partial: true,
      },
    );
    expect(result.success).toBe(true);
    const aentryUpdate = operaState.capturedSql.find((s) =>
      s.includes('UPDATE aentry') && s.includes('ae_tmpstat = ?'),
    );
    expect(aentryUpdate).toBeDefined();
    // nbank update should NOT include nk_recbal in partial mode
    const nbankUpdate = operaState.capturedSql.find((s) =>
      s.includes('UPDATE nbank') && s.includes('nk_lststno'),
    );
    expect(nbankUpdate).toBeDefined();
    expect(nbankUpdate).not.toMatch(/nk_recbal = \?/);
  });
});

describe('markEntriesReconciled - locking', () => {
  it('refuses when bank already locked', async () => {
    const appState: AppMockState = {
      lockRows: [
        {
          id: 1, bank_code: 'BC010', locked_at: new Date(),
          locked_by: 'other', endpoint: 'other', description: '',
        },
      ],
      nextId: 2,
    };
    const result = await markEntriesReconciled(
      makeAppDb(appState),
      makeOperaDb({
        nk_lstrecl: 0, nk_recbal: 0, nk_curbal: 0, nk_lststno: 0,
        aentries: new Map(), capturedSql: [], capturedParams: [],
      }),
      {
        bankCode: 'BC010',
        entries: [{ entry_number: 'P100008036', statement_line: 10 }],
        statementNumber: 1,
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/being imported/);
  });
});

import { describe, it, expect } from 'vitest';
import { completeBatch } from '../src/services/complete-batch.js';

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
  aentry: Array<{
    ae_entry: string;
    ae_acnt: string;
    ae_complet: number;
    ae_value: number;
    ae_lstdate: string;
    ae_cbtype: string;
  }>;
  atran: Array<{ at_unique: string; ae_entry: string; ae_acnt: string }>;
  anoml: Array<{
    ax_unique: string;
    ax_nacnt: string;
    ax_value: number;
    ax_source: string;
    ax_tref: string;
    ax_comment: string;
    ax_date: string;
    ax_done: string;
  }>;
  nacntTypes: Record<string, { na_type: string; na_subt: string }>;
  nbank: Record<string, { nk_curbal: number }>;
  nparmYear?: number;
  nclnddPeriod?: { ncd_period: number; ncd_year: number };
  // sequences
  nextidValues: Record<string, number>;
  // capture
  capturedSql: string[];
}

function makeOperaDb(state: OperaState): any {
  const txRaw = (sql: string, params?: unknown[]) => {
    state.capturedSql.push(sql);
    if (sql.includes('FROM aentry')) {
      const entry = String((params ?? [])[0]);
      const bank = String((params ?? [])[1]).trim();
      const found = state.aentry.find(
        (a) => a.ae_entry === entry && a.ae_acnt.trim() === bank,
      );
      return Promise.resolve(found ? [found] : []);
    }
    if (sql.includes('FROM nclndd') && !sql.includes('ncd_nlstat')) {
      return Promise.resolve(
        state.nclnddPeriod ? [state.nclnddPeriod] : [],
      );
    }
    if (sql.includes('FROM atran')) {
      const entry = String((params ?? [])[0]);
      const bank = String((params ?? [])[1]).trim();
      const rows = state.atran.filter(
        (a) => a.ae_entry === entry && a.ae_acnt.trim() === bank,
      );
      return Promise.resolve(rows);
    }
    if (sql.includes('FROM anoml')) {
      const uniqueIds = (params ?? []).map(String);
      const rows = state.anoml.filter(
        (a) => uniqueIds.includes(a.ax_unique.trim()) && a.ax_done === 'N',
      );
      return Promise.resolve(rows);
    }
    if (sql.includes('UPDATE aentry')) {
      const entry = String((params ?? [])[0]);
      const bank = String((params ?? [])[1]).trim();
      const found = state.aentry.find(
        (a) => a.ae_entry === entry && a.ae_acnt.trim() === bank,
      );
      if (found) found.ae_complet = 1;
      return Promise.resolve({ rowCount: found ? 1 : 0 });
    }
    if (sql.includes('SELECT np_nexjrnl')) {
      return Promise.resolve([{ np_nexjrnl: 100 }]);
    }
    if (sql.includes('UPDATE nparm')) {
      return Promise.resolve({ rowCount: 1 });
    }
    if (sql.includes('SELECT na_type, na_subt FROM nacnt')) {
      const acnt = String((params ?? [])[0]).trim();
      const t = state.nacntTypes[acnt];
      return Promise.resolve(t ? [t] : []);
    }
    if (sql.includes('FROM nextid')) {
      const tn = String((params ?? [])[0]);
      const v = state.nextidValues[tn];
      return Promise.resolve(v != null ? [{ nextid: v }] : []);
    }
    if (sql.includes('UPDATE nextid')) {
      const newVal = Number((params ?? [])[0]);
      const tn = String((params ?? [])[1]);
      state.nextidValues[tn] = newVal;
      return Promise.resolve({ rowCount: 1 });
    }
    if (sql.includes('INSERT INTO ntran')) {
      return Promise.resolve({ rowCount: 1 });
    }
    if (sql.includes('UPDATE nacnt')) {
      return Promise.resolve({ rowCount: 1 });
    }
    if (sql.includes('FROM nhist')) {
      return Promise.resolve([]);
    }
    if (sql.includes('INSERT INTO nhist')) {
      return Promise.resolve({ rowCount: 1 });
    }
    if (sql.includes('UPDATE nsubt') || sql.includes('UPDATE ntype')) {
      return Promise.resolve({ rowCount: 1 });
    }
    if (sql.includes('UPDATE anoml')) {
      // params: [journal, ax_unique, ax_nacnt]
      const ax_unique = String((params ?? [])[1]).trim();
      const ax_nacnt = String((params ?? [])[2]).trim();
      const row = state.anoml.find(
        (a) =>
          a.ax_unique.trim() === ax_unique &&
          a.ax_nacnt.trim() === ax_nacnt &&
          a.ax_done === 'N',
      );
      if (row) row.ax_done = 'Y';
      return Promise.resolve({ rowCount: row ? 1 : 0 });
    }
    if (sql.includes('UPDATE nbank') && sql.includes('nk_curbal')) {
      const delta = Number((params ?? [])[0]);
      const acnt = String((params ?? [])[1]).trim();
      const row = state.nbank[acnt];
      if (row) row.nk_curbal += delta;
      return Promise.resolve({ rowCount: row ? 1 : 0 });
    }
    if (sql.includes('INSERT INTO njmemo')) {
      return Promise.resolve({ rowCount: 1 });
    }
    return Promise.resolve([]);
  };

  const operaDb: any = {
    raw: txRaw,
    transaction: async (cb: (trx: unknown) => Promise<unknown>) => {
      const trx = { raw: txRaw };
      return cb(trx);
    },
  };
  return operaDb;
}

function emptyOpera(): OperaState {
  return {
    aentry: [],
    atran: [],
    anoml: [],
    nacntTypes: {},
    nbank: {},
    nclnddPeriod: { ncd_period: 4, ncd_year: 2026 },
    nextidValues: { ntran: 1000, njmemo: 2000, nhist: 3000 },
    capturedSql: [],
  };
}

describe('completeBatch - validation', () => {
  it('rejects bad bank_code', async () => {
    const result = await completeBatch(
      makeAppDb({ lockRows: [], nextId: 1 }),
      makeOperaDb(emptyOpera()),
      { bankCode: "BC';--", entryNumber: 'R200001234' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/bank_code/);
  });

  it('rejects bad entry_number', async () => {
    const result = await completeBatch(
      makeAppDb({ lockRows: [], nextId: 1 }),
      makeOperaDb(emptyOpera()),
      { bankCode: 'BC010', entryNumber: "R'1;--" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/entry/);
  });

  it('returns errors when entry not found', async () => {
    const result = await completeBatch(
      makeAppDb({ lockRows: [], nextId: 1 }),
      makeOperaDb(emptyOpera()),
      { bankCode: 'BC010', entryNumber: 'R200001234' },
    );
    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toMatch(/not found/);
  });

  it('returns error when entry is already complete', async () => {
    const opera = emptyOpera();
    opera.aentry.push({
      ae_entry: 'R200001234',
      ae_acnt: 'BC010',
      ae_complet: 1,
      ae_value: 100000,
      ae_lstdate: '2026-04-15',
      ae_cbtype: 'GC',
    });
    const result = await completeBatch(
      makeAppDb({ lockRows: [], nextId: 1 }),
      makeOperaDb(opera),
      { bankCode: 'BC010', entryNumber: 'R200001234' },
    );
    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toMatch(/already complete/);
  });
});

describe('completeBatch - happy paths', () => {
  it('marks complete with no detail when no anoml found', async () => {
    const opera = emptyOpera();
    opera.aentry.push({
      ae_entry: 'R200001234',
      ae_acnt: 'BC010',
      ae_complet: 0,
      ae_value: 100000,
      ae_lstdate: '2026-04-15',
      ae_cbtype: 'GC',
    });
    opera.atran.push({
      at_unique: '_AAA000001',
      ae_entry: 'R200001234',
      ae_acnt: 'BC010',
    });
    // No anoml rows — fast path
    const result = await completeBatch(
      makeAppDb({ lockRows: [], nextId: 1 }),
      makeOperaDb(opera),
      { bankCode: 'BC010', entryNumber: 'R200001234' },
    );
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/marked complete/);
    expect(opera.aentry[0]?.ae_complet).toBe(1);
  });

  it('full posting flow creates ntran and updates anoml + aentry', async () => {
    const opera = emptyOpera();
    opera.aentry.push({
      ae_entry: 'R200001234',
      ae_acnt: 'BC010',
      ae_complet: 0,
      ae_value: 75000, // £750
      ae_lstdate: '2026-04-15',
      ae_cbtype: 'GC',
    });
    opera.atran.push({
      at_unique: '_AAA000001',
      ae_entry: 'R200001234',
      ae_acnt: 'BC010',
    });
    // Two unposted anoml rows: one debit to bank, one credit to fees
    opera.anoml.push(
      {
        ax_unique: '_AAA000001',
        ax_nacnt: 'BC010',
        ax_value: 750,
        ax_source: 'A',
        ax_tref: 'GC',
        ax_comment: 'GoCardless batch',
        ax_date: '2026-04-15',
        ax_done: 'N',
      },
      {
        ax_unique: '_AAA000001',
        ax_nacnt: '7770',
        ax_value: -750,
        ax_source: 'A',
        ax_tref: 'GC',
        ax_comment: 'GoCardless batch',
        ax_date: '2026-04-15',
        ax_done: 'N',
      },
    );
    opera.nacntTypes.BC010 = { na_type: 'A', na_subt: 'CB' };
    opera.nacntTypes['7770'] = { na_type: 'P', na_subt: 'PL' };
    opera.nbank.BC010 = { nk_curbal: 0 };
    const result = await completeBatch(
      makeAppDb({ lockRows: [], nextId: 1 }),
      makeOperaDb(opera),
      { bankCode: 'BC010', entryNumber: 'R200001234' },
    );
    expect(result.success).toBe(true);
    expect(result.details?.[0]).toMatch(/Posted 2 nominal entries/);
    expect(opera.aentry[0]?.ae_complet).toBe(1);
    expect(opera.anoml.every((a) => a.ax_done === 'Y')).toBe(true);
    // Bank balance updated by +£750 (BC010 had ax_value=+750)
    expect(opera.nbank.BC010?.nk_curbal).toBe(75000); // pence
  });
});

describe('completeBatch - locking', () => {
  it('refuses when bank already locked', async () => {
    const result = await completeBatch(
      makeAppDb({
        lockRows: [
          {
            id: 1, bank_code: 'BC010', locked_at: new Date(),
            locked_by: 'other', endpoint: 'other', description: '',
          },
        ],
        nextId: 2,
      }),
      makeOperaDb(emptyOpera()),
      { bankCode: 'BC010', entryNumber: 'R200001234' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/being imported/);
  });
});

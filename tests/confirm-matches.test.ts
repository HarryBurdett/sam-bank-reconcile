import { describe, it, expect } from 'vitest';
import { confirmStatementMatches } from '../src/services/confirm-matches.js';

const TEST_COMPANY = 'C';

interface AppLockRow {
  id: number;
  company_code: string;
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
      andWhere: (cond: any, op?: any, val?: any) => builder.where(cond, op, val),
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
          (r) => !Object.entries(conds).every(([k, v]) => (r as any)[k] === v),
        );
        return Promise.resolve(before - state.lockRows.length);
      },
      insert: (row: any) => {
        state.lockRows.push({
          id: state.nextId++,
          company_code: String(row.company_code ?? ''),
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
  lststno: number;
  // Capture the markEntriesReconciled SQL so we can assert the
  // delegation worked correctly.
  capturedSql: string[];
  capturedParams: unknown[][];
}

function makeOperaDb(state: OperaState): any {
  const txRaw = (sql: string, params?: unknown[]) => {
    state.capturedSql.push(sql);
    state.capturedParams.push(params ?? []);
    if (sql.includes('SELECT ISNULL(nk_lststno') && sql.includes('NOLOCK')) {
      return Promise.resolve([{ lststno: state.lststno }]);
    }
    if (sql.includes('SELECT nk_lstrecl') && sql.includes('UPDLOCK')) {
      return Promise.resolve([
        { nk_lstrecl: 5, nk_recbal: 0, nk_curbal: 0, nk_lststno: state.lststno },
      ]);
    }
    if (sql.includes('FROM aentry') && sql.includes('UPDLOCK')) {
      // Return one entry per requested entry_number (skipping the
      // bank_code at index 0)
      const entryNumbers = (params ?? []).slice(1) as string[];
      const rows = entryNumbers.map((e) => ({
        ae_entry: e,
        ae_value: 100,
        ae_reclnum: 0,
      }));
      return Promise.resolve(rows);
    }
    if (sql.includes('UPDATE aentry')) {
      return Promise.resolve({ rowCount: 1 });
    }
    if (sql.includes('UPDATE nbank')) {
      return Promise.resolve({ rowCount: 1 });
    }
    if (sql.includes('SELECT nk_recbal') && sql.includes('NOLOCK')) {
      return Promise.resolve([{ nk_recbal: 0 }]);
    }
    return Promise.resolve([]);
  };
  return {
    raw: txRaw,
    transaction: async (cb: (trx: unknown) => Promise<unknown>) => {
      const trx = { raw: txRaw };
      return cb(trx);
    },
  };
}

describe('confirmStatementMatches', () => {
  it('rejects bad bank_code', async () => {
    const result = await confirmStatementMatches(
      makeAppDb({ lockRows: [], nextId: 1 }),
      TEST_COMPANY,
      makeOperaDb({ lststno: 0, capturedSql: [], capturedParams: [] }),
      {
        bankCode: "BC';--",
        matches: [],
        statementBalance: 1000,
        statementDate: '2026-04-15',
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/bank_code/);
  });

  it('rejects empty matches', async () => {
    const result = await confirmStatementMatches(
      makeAppDb({ lockRows: [], nextId: 1 }),
      TEST_COMPANY,
      makeOperaDb({ lststno: 0, capturedSql: [], capturedParams: [] }),
      {
        bankCode: 'BC010',
        matches: [],
        statementBalance: 1000,
        statementDate: '2026-04-15',
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No valid entry/);
  });

  it('rejects bank not in nbank', async () => {
    const opera = {
      raw: () => Promise.resolve([]),
      transaction: async () => null,
    };
    const result = await confirmStatementMatches(
      makeAppDb({ lockRows: [], nextId: 1 }),
      TEST_COMPANY,
      opera as any,
      {
        bankCode: 'BC999',
        matches: [{ ae_entry: 'P100008036' }],
        statementBalance: 1000,
        statementDate: '2026-04-15',
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found in nbank/);
  });

  it('happy path: assigns 10/20/30 statement lines + uses nk_lststno+1', async () => {
    const operaState: OperaState = {
      lststno: 86918,
      capturedSql: [],
      capturedParams: [],
    };
    const result = await confirmStatementMatches(
      makeAppDb({ lockRows: [], nextId: 1 }),
      TEST_COMPANY,
      makeOperaDb(operaState),
      {
        bankCode: 'BC010',
        matches: [
          { ae_entry: 'P100008036' },
          { opera_entry: { ae_entry: 'PR00000534' } }, // legacy nested shape
          { ae_entry: 'P100008037' },
        ],
        statementBalance: 5000,
        statementDate: '2026-04-15',
      },
    );

    expect(result.success).toBe(true);
    expect(result.reconciled_count).toBe(3);
    // batch_number = nextStatementNumber - 1 = (lststno+1) - 1 = lststno
    expect(result.batch_number).toBe(86918);

    // Check mark-reconciled was called with statement_number = lststno+1
    const aentryUpdates = operaState.capturedSql.filter(
      (s) =>
        s.includes('UPDATE aentry') &&
        s.includes('ae_reclnum = ?') &&
        s.includes('ae_statln = ?'),
    );
    expect(aentryUpdates).toHaveLength(3);
    // Verify statement_lines are 10, 20, 30 — they appear at index 2 of
    // the params (after ae_reclnum, ae_recdate)
    const lineParams = operaState.capturedParams
      .filter((_, i) => operaState.capturedSql[i]?.includes('UPDATE aentry') && operaState.capturedSql[i]?.includes('ae_reclnum'))
      .map((p) => p[2]); // ae_statln
    expect(lineParams).toEqual([10, 20, 30]);
  });
});

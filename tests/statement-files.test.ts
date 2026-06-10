import { describe, it, expect } from 'vitest';
import {
  markStatementReconciled,
  listImportedStatements,
} from '../src/services/statement-files.js';

const TEST_COMPANY = 'C';

interface MockState {
  rows: Array<Record<string, unknown> & { id: number }>;
}

function makeAppDb(state: MockState): any {
  const db: any = (table: string) => {
    if (table !== 'bank_statement_imports') {
      throw new Error(`Unexpected table: ${table}`);
    }
    let filters: Record<string, unknown> = {};
    let orFilters: Array<Record<string, unknown>> = [];
    let nullChecks: string[] = [];
    let limitN = Infinity;
    const builder: any = {
      where: (col: Record<string, unknown> | string | ((this: any) => void), val?: unknown) => {
        if (typeof col === 'function') {
          // Subquery-style: invoke with a sub-builder
          const sub: any = {
            where: (k: string, v: unknown) => {
              orFilters.push({ [k]: v });
              return sub;
            },
            orWhereNull: (k: string) => {
              nullChecks.push(k);
              return sub;
            },
          };
          col.call(sub);
          return builder;
        }
        if (typeof col === 'object') Object.assign(filters, col);
        else if (val !== undefined) filters[col] = val;
        return builder;
      },
      andWhere: (col: Record<string, unknown> | string | ((this: any) => void), val?: unknown) =>
        builder.where(col, val),
      orderBy: () => builder,
      limit: (n: number) => {
        limitN = n;
        return builder;
      },
      then: (cb: (rows: unknown[]) => unknown) => {
        const rows = state.rows.filter((r) => {
          const baseMatch = Object.keys(filters).every((k) => r[k] === filters[k]);
          if (!baseMatch) return false;
          // OR-group: at least one orFilter or nullCheck must match
          if (orFilters.length === 0 && nullChecks.length === 0) return true;
          const orMatch = orFilters.some((f) =>
            Object.keys(f).every((k) => r[k] === f[k]),
          );
          const nullMatch = nullChecks.some((k) => r[k] === null || r[k] === undefined);
          return orMatch || nullMatch;
        });
        return Promise.resolve(cb(rows.slice(0, limitN)));
      },
      update: async (patch: Record<string, unknown>) => {
        let count = 0;
        for (const r of state.rows) {
          if (Object.keys(filters).every((k) => r[k] === filters[k])) {
            Object.assign(r, patch);
            count++;
          }
        }
        return count;
      },
    };
    return builder;
  };
  db.fn = { now: () => new Date() };
  return db;
}

describe('markStatementReconciled', () => {
  it('marks the matching statement and returns success', async () => {
    const state: MockState = {
      rows: [
        {
          id: 1,
          company_code: TEST_COMPANY,
          bank_code: 'BC010',
          filename: 'statement-2026-04.pdf',
          is_reconciled: false,
        },
      ],
    };
    const db = makeAppDb(state);
    const result = await markStatementReconciled(db, TEST_COMPANY, {
      filename: 'statement-2026-04.pdf',
      bankCode: 'BC010',
      reconciledCount: 25,
    });
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/marked as reconciled/);
    expect(state.rows[0]?.is_reconciled).toBe(true);
    expect(state.rows[0]?.reconciled_count).toBe(25);
  });

  it('returns success=false when no match', async () => {
    const state: MockState = { rows: [] };
    const db = makeAppDb(state);
    const result = await markStatementReconciled(db, TEST_COMPANY, {
      filename: 'ghost.pdf',
    });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/No matching/);
  });
});

describe('listImportedStatements', () => {
  it('returns unreconciled statements by default', async () => {
    const state: MockState = {
      rows: [
        {
          id: 1,
          company_code: TEST_COMPANY,
          bank_code: 'BC010',
          filename: 'a.pdf',
          target_system: 'opera_se',
          is_reconciled: false,
          imported_at: '2026-04-15T10:00:00Z',
        },
        {
          id: 2,
          company_code: TEST_COMPANY,
          bank_code: 'BC010',
          filename: 'b.pdf',
          target_system: 'opera_se',
          is_reconciled: true,
          imported_at: '2026-04-16T10:00:00Z',
        },
      ],
    };
    const db = makeAppDb(state);
    const result = await listImportedStatements(db, TEST_COMPANY, { bankCode: 'BC010' });
    expect(result.count).toBe(1);
    expect(result.statements[0]?.id).toBe(1);
  });

  it('includes reconciled statements when includeReconciled=true', async () => {
    const state: MockState = {
      rows: [
        {
          id: 1,
          company_code: TEST_COMPANY,
          bank_code: 'BC010',
          filename: 'a.pdf',
          target_system: 'opera_se',
          is_reconciled: true,
          imported_at: '2026-04-15T10:00:00Z',
        },
      ],
    };
    const db = makeAppDb(state);
    const result = await listImportedStatements(db, TEST_COMPANY, {
      bankCode: 'BC010',
      includeReconciled: true,
    });
    expect(result.count).toBe(1);
  });

  it('filters to target_system=opera_se by default', async () => {
    const state: MockState = {
      rows: [
        {
          id: 1,
          company_code: TEST_COMPANY,
          bank_code: 'BC010',
          target_system: 'opera_se',
          is_reconciled: false,
          imported_at: '2026-04-15T10:00:00Z',
        },
        {
          id: 2,
          company_code: TEST_COMPANY,
          bank_code: 'BC010',
          target_system: 'opera_3',
          is_reconciled: false,
          imported_at: '2026-04-16T10:00:00Z',
        },
      ],
    };
    const db = makeAppDb(state);
    const result = await listImportedStatements(db, TEST_COMPANY);
    expect(result.count).toBe(1);
    expect(result.statements[0]?.target_system).toBe('opera_se');
  });
});

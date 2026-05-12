import { describe, it, expect } from 'vitest';
import {
  archiveStatement,
  listArchivedStatements,
  restoreStatement,
  deleteArchivedStatement,
  manageStatements,
} from '../src/services/statement-archive.js';

interface Row {
  id: number;
  bank_code: string;
  source_ref: string;
  source: string;
  opening_balance: number;
  closing_balance: number;
  imported_at: string;
  import_status: string;
  archived_at: string | null;
}

interface State {
  rows: Row[];
}

function makeAppDb(state: State): any {
  function tableBuilder(_table: string) {
    let idFilter: number | null = null;
    let statusFilter: string[] | null = null;
    let bankFilter: string | null = null;
    let limitN: number | null = null;
    let notArchived = false;

    const builder: any = {
      where: (cond: any) => {
        if (typeof cond === 'object') {
          if (cond.id) idFilter = cond.id;
          if (cond.import_status) statusFilter = [cond.import_status];
          if (cond.bank_code) bankFilter = cond.bank_code;
        }
        if (typeof cond === 'string' && cond === 'bank_code') {
          // legacy 2-arg form
        }
        return builder;
      },
      andWhere: (col: any, _op?: any, val?: any) => {
        if (col === 'bank_code') bankFilter = val;
        return builder;
      },
      whereNot: (col: any, val?: any) => {
        if (col === 'import_status') notArchived = val === 'archived';
        return builder;
      },
      orderBy: () => builder,
      limit: (n: number) => {
        limitN = n;
        return builder;
      },
      first: async () => {
        if (idFilter !== null) {
          return state.rows.find((r) => r.id === idFilter);
        }
        return undefined;
      },
      update: async (payload: any) => {
        if (idFilter === null) return 0;
        const idx = state.rows.findIndex((r) => r.id === idFilter);
        if (idx < 0) return 0;
        if (statusFilter && !statusFilter.includes(state.rows[idx]!.import_status)) {
          return 0;
        }
        state.rows[idx] = { ...state.rows[idx]!, ...payload };
        return 1;
      },
      delete: async () => {
        if (idFilter === null) return 0;
        const before = state.rows.length;
        state.rows = state.rows.filter((r) => {
          if (r.id !== idFilter) return true;
          if (statusFilter && !statusFilter.includes(r.import_status)) return true;
          return false;
        });
        return before - state.rows.length;
      },
      then: async (resolve: any) => {
        let rows = state.rows;
        if (statusFilter) {
          rows = rows.filter((r) => statusFilter!.includes(r.import_status));
        }
        if (notArchived) {
          rows = rows.filter((r) => r.import_status !== 'archived');
        }
        if (bankFilter) {
          rows = rows.filter((r) => r.bank_code === bankFilter);
        }
        if (limitN) rows = rows.slice(0, limitN);
        return resolve(rows);
      },
    };
    return builder;
  }
  const db: any = (table: string) => tableBuilder(table);
  db.fn = { now: () => '__NOW__' };
  return db;
}

const baseRow = (overrides: Partial<Row> = {}): Row => ({
  id: 1,
  bank_code: 'BC010',
  source_ref: '/tmp/statement.pdf',
  source: 'file',
  opening_balance: 1000,
  closing_balance: 1500,
  imported_at: '2026-04-15T00:00:00Z',
  import_status: 'imported',
  archived_at: null,
  ...overrides,
});

describe('archiveStatement', () => {
  it('rejects invalid id', async () => {
    const r = await archiveStatement(makeAppDb({ rows: [] }), 0, 'admin');
    expect(r.success).toBe(false);
  });

  it('flips status to archived', async () => {
    const state: State = { rows: [baseRow()] };
    const r = await archiveStatement(makeAppDb(state), 1, 'admin');
    expect(r.success).toBe(true);
    expect(state.rows[0]?.import_status).toBe('archived');
  });
});

describe('listArchivedStatements', () => {
  it('returns archived rows only', async () => {
    const state: State = {
      rows: [
        baseRow({ id: 1, import_status: 'archived' }),
        baseRow({ id: 2, import_status: 'imported' }),
      ],
    };
    const r = await listArchivedStatements(makeAppDb(state));
    expect(r.count).toBe(1);
    expect(r.statements[0]?.id).toBe(1);
  });
});

describe('restoreStatement', () => {
  it('flips archived → imported', async () => {
    const state: State = {
      rows: [baseRow({ id: 1, import_status: 'archived' })],
    };
    const r = await restoreStatement(makeAppDb(state), 1);
    expect(r.success).toBe(true);
    expect(state.rows[0]?.import_status).toBe('imported');
  });
  it('errors when not archived', async () => {
    const state: State = { rows: [baseRow({ id: 1, import_status: 'imported' })] };
    const r = await restoreStatement(makeAppDb(state), 1);
    expect(r.success).toBe(false);
  });
});

describe('deleteArchivedStatement', () => {
  it('removes archived row', async () => {
    const state: State = {
      rows: [baseRow({ id: 1, import_status: 'archived' })],
    };
    const r = await deleteArchivedStatement(makeAppDb(state), 1);
    expect(r.success).toBe(true);
    expect(state.rows.length).toBe(0);
  });
});

describe('manageStatements', () => {
  it('excludes archived by default', async () => {
    const state: State = {
      rows: [
        baseRow({ id: 1, import_status: 'imported' }),
        baseRow({ id: 2, import_status: 'archived' }),
      ],
    };
    const r = await manageStatements(makeAppDb(state), null, false);
    expect(r.count).toBe(1);
  });
  it('includes archived when flag true', async () => {
    const state: State = {
      rows: [
        baseRow({ id: 1, import_status: 'imported' }),
        baseRow({ id: 2, import_status: 'archived' }),
      ],
    };
    const r = await manageStatements(makeAppDb(state), null, true);
    expect(r.count).toBe(2);
  });
});

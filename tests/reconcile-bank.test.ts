import { describe, it, expect } from 'vitest';
import { reconcileBank } from '../src/services/reconcile-bank.js';

interface MockState {
  nbank: Record<string, {
    nk_acnt: string;
    description: string;
    nk_sort: string;
    nk_number: string;
    nk_curbal: number;
  }>;
  current_year_max: number | null;
  atran_cy: Record<string, {
    entry_count: number;
    transaction_count: number;
    receipts_pence: number;
    payments_pence: number;
    net_pence: number;
  }>;
  atran_all: Record<string, {
    entry_count: number;
    transaction_count?: number;
    net_pence: number;
  }>;
  nacnt: Record<string, {
    description: string;
    na_prydr: number;
    na_prycr: number;
  }>;
  ntran_cy: Record<string, { debits: number; credits: number; net: number }>;
  anoml_pending: Array<{
    nominal_account: string;
    source: string;
    date: string;
    value: number;
    reference: string;
    comment: string;
  }>;
  anoml_summary: Array<{ status: 'Posted' | 'Pending'; count: number; total: number }>;
}

function makeOperaDb(state: MockState): any {
  const db: any = (table: string) => {
    let conds: Record<string, unknown> = {};
    let cmpConds: Array<{ col: string; op: string; val: any }> = [];
    let likeRaw: Array<{ sql: string; args: any[] }> = [];
    let groupByRawCalled = false;
    let maxCalled = false;
    const builder: any = {
      where: (col: any, op?: any, val?: any) => {
        if (typeof col === 'function') {
          col(builder);
          return builder;
        }
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
      whereRaw: (sql: string, args: any[] = []) => {
        likeRaw.push({ sql, args });
        return builder;
      },
      andWhereRaw: (sql: string, args: any[] = []) => {
        likeRaw.push({ sql, args });
        return builder;
      },
      andWhere: (col: any, op?: any, val?: any) => {
        if (typeof col === 'function') {
          col(builder);
          return builder;
        }
        return builder.where(col, op, val);
      },
      orWhereNull: () => builder,
      orderBy: () => builder,
      groupBy: () => builder,
      groupByRaw: () => {
        groupByRawCalled = true;
        return builder;
      },
      max: () => {
        maxCalled = true;
        return builder;
      },
      select: (..._cols: any[]) => builder,
      first: async () => {
        const arr = resolve();
        return arr[0];
      },
      then: (cb: (rows: any[]) => unknown, errCb?: (err: any) => unknown) => {
        try {
          const arr = resolve();
          return Promise.resolve(cb(arr));
        } catch (err) {
          if (errCb) return Promise.resolve(errCb(err));
          return Promise.reject(err);
        }
      },
    };

    function resolve(): any[] {
      if (table === 'nbank') {
        const code = likeRaw[0]?.args[0] as string | undefined;
        const row = code ? state.nbank[code] : undefined;
        if (!row) return [];
        return [
          {
            nk_acnt: row.nk_acnt,
            description: row.description,
            nk_sort: row.nk_sort,
            nk_number: row.nk_number,
            nk_curbal: row.nk_curbal,
          },
        ];
      }
      if (table === 'ntran') {
        if (maxCalled) {
          return [{ current_year: state.current_year_max }];
        }
        const acnt = (conds.nt_acnt as string) ?? '';
        return [
          state.ntran_cy[acnt] ?? { debits: 0, credits: 0, net: 0 },
        ];
      }
      if (table === 'atran') {
        const acnt = (conds.at_acnt as string) ?? '';
        const isCy = likeRaw.some((r) => r.sql.includes('YEAR'));
        if (isCy) {
          return [
            state.atran_cy[acnt] ?? {
              entry_count: 0,
              transaction_count: 0,
              receipts_pence: 0,
              payments_pence: 0,
              net_pence: 0,
            },
          ];
        }
        return [
          state.atran_all[acnt] ?? {
            entry_count: 0,
            transaction_count: 0,
            net_pence: 0,
          },
        ];
      }
      if (table === 'nacnt') {
        const acnt = (conds.na_acnt as string) ?? '';
        const r = state.nacnt[acnt];
        if (!r) return [];
        return [
          {
            na_acnt: acnt,
            description: r.description,
            na_ytddr: 0,
            na_ytdcr: 0,
            na_prydr: r.na_prydr,
            na_prycr: r.na_prycr,
          },
        ];
      }
      if (table === 'anoml') {
        if (groupByRawCalled) {
          return state.anoml_summary;
        }
        return state.anoml_pending.map((r) => ({
          ax_nacnt: r.nominal_account,
          ax_source: r.source,
          ax_date: r.date,
          ax_value: r.value,
          ax_tref: r.reference,
          ax_comment: r.comment,
          ax_done: 'N',
        }));
      }
      return [];
    }
    return builder;
  };
  db.raw = (s: string) => s;
  db.fn = { now: () => '__NOW__' };
  return db;
}

const NOW = new Date('2026-05-09T12:00:00Z');

function emptyState(): MockState {
  return {
    nbank: {},
    current_year_max: 2026,
    atran_cy: {},
    atran_all: {},
    nacnt: {},
    ntran_cy: {},
    anoml_pending: [],
    anoml_summary: [],
  };
}

describe('reconcileBank', () => {
  it('returns 404-style error when bank not found', async () => {
    const state = emptyState();
    const result = await reconcileBank(makeOperaDb(state), 'NOPE', NOW);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it('reports RECONCILED when all three balances match within tolerance', async () => {
    const state = emptyState();
    state.nbank.BANK01 = {
      nk_acnt: 'BANK01',
      description: 'Test bank',
      nk_sort: '12-34-56',
      nk_number: '12345678',
      nk_curbal: 100000,
    };
    state.atran_cy.BANK01 = {
      entry_count: 5,
      transaction_count: 5,
      receipts_pence: 100000,
      payments_pence: 0,
      net_pence: 100000,
    };
    state.atran_all.BANK01 = { entry_count: 5, net_pence: 100000 };
    state.nacnt.BANK01 = { description: 'Bank A', na_prydr: 0, na_prycr: 0 };
    state.ntran_cy.BANK01 = { debits: 1000, credits: 0, net: 1000 };
    const result = await reconcileBank(makeOperaDb(state), 'BANK01', NOW);
    expect(result.success).toBe(true);
    expect(result.status).toBe('RECONCILED');
    expect(result.message).toMatch(/fully reconciles/);
    expect(result.bank_account?.code).toBe('BANK01');
    expect(result.bank_master?.balance_pounds).toBe(1000);
    expect(result.nominal_ledger?.total_balance).toBe(1000);
  });

  it('reports UNRECONCILED with diff message when cashbook differs from nbank', async () => {
    const state = emptyState();
    state.nbank.BANK01 = {
      nk_acnt: 'BANK01',
      description: '',
      nk_sort: '',
      nk_number: '',
      nk_curbal: 100000,
    };
    state.atran_cy.BANK01 = {
      entry_count: 1,
      transaction_count: 1,
      receipts_pence: 75000,
      payments_pence: 0,
      net_pence: 75000,
    };
    state.atran_all.BANK01 = { entry_count: 1, net_pence: 75000 };
    state.nacnt.BANK01 = { description: '', na_prydr: 0, na_prycr: 0 };
    state.ntran_cy.BANK01 = { debits: 750, credits: 0, net: 750 };
    const result = await reconcileBank(makeOperaDb(state), 'BANK01', NOW);
    expect(result.status).toBe('UNRECONCILED');
    expect(result.message).toMatch(/Cashbook/);
    expect(result.message).toMatch(/Bank Master/);
    expect(result.variance?.cashbook_vs_bank_master.amount).toBeCloseTo(-250, 2);
  });

  it('factors B/F into expected closing', async () => {
    const state = emptyState();
    state.nbank.BANK01 = {
      nk_acnt: 'BANK01',
      description: '',
      nk_sort: '',
      nk_number: '',
      nk_curbal: 150000,
    };
    state.atran_cy.BANK01 = {
      entry_count: 1,
      transaction_count: 1,
      receipts_pence: 100000,
      payments_pence: 0,
      net_pence: 100000,
    };
    state.atran_all.BANK01 = { entry_count: 1, net_pence: 100000 };
    state.nacnt.BANK01 = { description: '', na_prydr: 500, na_prycr: 0 };
    state.ntran_cy.BANK01 = { debits: 1500, credits: 0, net: 1500 };
    const result = await reconcileBank(makeOperaDb(state), 'BANK01', NOW);
    expect(result.cashbook?.expected_closing).toBe(1500);
    expect(result.cashbook?.prior_year_bf).toBe(500);
    expect(result.status).toBe('RECONCILED');
  });

  it('counts pending vs posted transfers from anoml', async () => {
    const state = emptyState();
    state.nbank.BANK01 = {
      nk_acnt: 'BANK01',
      description: '',
      nk_sort: '',
      nk_number: '',
      nk_curbal: 100000,
    };
    state.atran_cy.BANK01 = {
      entry_count: 1,
      transaction_count: 1,
      receipts_pence: 100000,
      payments_pence: 0,
      net_pence: 100000,
    };
    state.atran_all.BANK01 = { entry_count: 1, net_pence: 100000 };
    state.nacnt.BANK01 = { description: '', na_prydr: 0, na_prycr: 0 };
    state.ntran_cy.BANK01 = { debits: 1000, credits: 0, net: 1000 };
    state.anoml_pending = [
      {
        nominal_account: 'BANK01',
        source: 'S',
        date: '2026-04-15',
        value: 250,
        reference: 'INV001',
        comment: 'Sales receipt',
      },
    ];
    state.anoml_summary = [
      { status: 'Posted', count: 10, total: 5000 },
      { status: 'Pending', count: 1, total: 250 },
    ];
    const result = await reconcileBank(makeOperaDb(state), 'BANK01', NOW);
    expect(result.cashbook?.transfer_file.posted_to_nl.count).toBe(10);
    expect(result.cashbook?.transfer_file.pending_transfer.count).toBe(1);
    expect(result.cashbook?.transfer_file.pending_transfer.transactions[0]?.source_desc).toBe('Sales');
    expect(result.message).toMatch(/1 entries.*pending/);
  });

  it('treats missing nacnt as no nominal info', async () => {
    const state = emptyState();
    state.nbank.BANK01 = {
      nk_acnt: 'BANK01',
      description: '',
      nk_sort: '',
      nk_number: '',
      nk_curbal: 0,
    };
    state.atran_cy.BANK01 = {
      entry_count: 0,
      transaction_count: 0,
      receipts_pence: 0,
      payments_pence: 0,
      net_pence: 0,
    };
    state.atran_all.BANK01 = { entry_count: 0, net_pence: 0 };
    const result = await reconcileBank(makeOperaDb(state), 'BANK01', NOW);
    expect(result.success).toBe(true);
    expect(result.nominal_ledger?.description).toMatch(/not found/i);
    expect(result.nominal_ledger?.total_balance).toBe(0);
  });

  it('rejects empty bank_code', async () => {
    const state = emptyState();
    const result = await reconcileBank(makeOperaDb(state), '', NOW);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/required/);
  });

  it('reports DB error gracefully', async () => {
    const operaDb: any = (_t: string) => {
      const builder: any = {
        where: () => builder,
        whereRaw: () => builder,
        andWhere: () => builder,
        andWhereRaw: () => builder,
        orWhereNull: () => builder,
        orderBy: () => builder,
        groupBy: () => builder,
        groupByRaw: () => builder,
        max: () => builder,
        select: () => builder,
        first: () => Promise.reject(new Error('DB unavailable')),
        then: (_resolve: any, reject: any) => {
          reject(new Error('DB unavailable'));
        },
      };
      return builder;
    };
    operaDb.raw = (s: string) => s;
    const result = await reconcileBank(operaDb, 'BANK01', NOW);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/DB unavailable/);
  });
});

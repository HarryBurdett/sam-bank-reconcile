import { describe, it, expect } from 'vitest';
import { reconcileBankDashboard } from '../src/services/reconcile-dashboard.js';

interface State {
  banks: Array<{
    nk_acnt: string;
    description: string;
    nk_sort: string;
    nk_number: string;
    nk_curbal: number; // pence
  }>;
  /** atran rows (current year only). Amounts in pence. */
  atran: Array<{
    at_acnt: string;
    at_pstdate: string;
    at_value: number;
    at_entry: string;
  }>;
  /** ntran current year rows; values in pounds */
  ntran: Array<{
    nt_acnt: string;
    nt_value: number;
    nt_year: number;
  }>;
  nacnt?: {
    na_acnt: string;
    description: string;
    na_ytddr: number;
    na_ytdcr: number;
    na_prydr: number;
    na_prycr: number;
  };
  anoml: Array<{
    ax_nacnt: string;
    ax_source: string;
    ax_date: string;
    ax_value: number;
    ax_tref: string;
    ax_comment: string;
    ax_done: 'Y' | null;
  }>;
}

function makeOperaDb(state: State, currentYear = 2026): any {
  const raw = async (sql: string, params: any[] = []) => {
    const lower = sql.toLowerCase();
    if (lower.includes('from nbank with (nolock)')) {
      const code = (params?.[0] ?? '').toString();
      const found = state.banks.find((b) => b.nk_acnt.trim() === code);
      return found ? [found] : [];
    }
    if (lower.startsWith('select max(nt_year)')) {
      return [{ current_year: currentYear }];
    }
    if (
      lower.includes('count(distinct at_entry)') &&
      lower.includes('year(at_pstdate)')
    ) {
      const code = params?.[0];
      const yr = params?.[1];
      const rows = state.atran.filter(
        (r) =>
          r.at_acnt === code &&
          new Date(r.at_pstdate).getFullYear() === yr,
      );
      const entries = new Set(rows.map((r) => r.at_entry)).size;
      const receipts = rows
        .filter((r) => r.at_value > 0)
        .reduce((a, r) => a + r.at_value, 0);
      const payments = rows
        .filter((r) => r.at_value < 0)
        .reduce((a, r) => a + Math.abs(r.at_value), 0);
      const net = rows.reduce((a, r) => a + r.at_value, 0);
      return [
        {
          entry_count: entries,
          transaction_count: rows.length,
          receipts_pence: receipts,
          payments_pence: payments,
          net_pence: net,
        },
      ];
    }
    if (
      lower.includes('count(distinct at_entry)') &&
      !lower.includes('year(at_pstdate)')
    ) {
      const code = params?.[0];
      const rows = state.atran.filter((r) => r.at_acnt === code);
      const entries = new Set(rows.map((r) => r.at_entry)).size;
      const net = rows.reduce((a, r) => a + r.at_value, 0);
      return [
        {
          entry_count: entries,
          transaction_count: rows.length,
          net_pence: net,
        },
      ];
    }
    if (lower.startsWith('select na_acnt') && lower.includes('from nacnt')) {
      const code = params?.[0];
      if (state.nacnt && state.nacnt.na_acnt === code) {
        return [state.nacnt];
      }
      return [];
    }
    if (
      lower.includes('case when nt_value > 0') &&
      lower.includes('from ntran')
    ) {
      const code = params?.[0];
      const yr = params?.[1];
      const rows = state.ntran.filter(
        (r) => r.nt_acnt === code && r.nt_year === yr,
      );
      const debits = rows.filter((r) => r.nt_value > 0).reduce((a, r) => a + r.nt_value, 0);
      const credits = rows.filter((r) => r.nt_value < 0).reduce((a, r) => a + Math.abs(r.nt_value), 0);
      const net = rows.reduce((a, r) => a + r.nt_value, 0);
      return [{ debits, credits, net }];
    }
    if (lower.includes('from anoml') && lower.includes('order by ax_date')) {
      const code = params?.[0];
      const rows = state.anoml.filter(
        (r) => r.ax_nacnt === code && r.ax_done !== 'Y',
      );
      return rows.map((r) => ({
        nominal_account: r.ax_nacnt,
        source: r.ax_source,
        date: r.ax_date,
        value: r.ax_value,
        reference: r.ax_tref,
        comment: r.ax_comment,
      }));
    }
    if (
      lower.includes('from anoml') &&
      lower.includes("case when ax_done = 'y'")
    ) {
      const code = params?.[0];
      const rows = state.anoml.filter((r) => r.ax_nacnt === code);
      const posted = rows.filter((r) => r.ax_done === 'Y');
      const pending = rows.filter((r) => r.ax_done !== 'Y');
      const out: any[] = [];
      if (posted.length > 0)
        out.push({
          status: 'Posted',
          count: posted.length,
          total: posted.reduce((a, r) => a + r.ax_value, 0),
        });
      if (pending.length > 0)
        out.push({
          status: 'Pending',
          count: pending.length,
          total: pending.reduce((a, r) => a + r.ax_value, 0),
        });
      return out;
    }
    return [];
  };
  const db: any = (table: string) => ({
    select: () => ({
      where: () => ({ first: async () => undefined }),
    }),
  });
  db.raw = raw;
  return db;
}

describe('reconcileBankDashboard', () => {
  it('rejects empty bank_code', async () => {
    const result = await reconcileBankDashboard(
      makeOperaDb({ banks: [], atran: [], ntran: [], anoml: [] }),
      '',
    );
    expect(result.success).toBe(false);
  });

  it('returns 404-like error when bank not found', async () => {
    const result = await reconcileBankDashboard(
      makeOperaDb({ banks: [], atran: [], ntran: [], anoml: [] }),
      'GHOST',
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it('reconciles when cashbook + bank master + nominal align', async () => {
    const state: State = {
      banks: [
        {
          nk_acnt: 'BC010',
          description: 'Barclays',
          nk_sort: '20-00-00',
          nk_number: '12345678',
          nk_curbal: 100000, // £1000 in pence
        },
      ],
      atran: [
        {
          at_acnt: 'BC010',
          at_pstdate: '2026-04-15',
          at_value: 50000, // £500 receipt
          at_entry: 'R100000001',
        },
        {
          at_acnt: 'BC010',
          at_pstdate: '2026-04-20',
          at_value: 50000, // £500 receipt
          at_entry: 'R100000002',
        },
      ],
      ntran: [
        // £1000 net debit on bank account = +1000 in nt_value
        { nt_acnt: 'BC010', nt_value: 1000, nt_year: 2026 },
      ],
      nacnt: {
        na_acnt: 'BC010',
        description: 'Bank account',
        na_ytddr: 0,
        na_ytdcr: 0,
        na_prydr: 0,
        na_prycr: 0,
      },
      anoml: [],
    };
    const result = await reconcileBankDashboard(makeOperaDb(state), 'BC010');
    expect(result.success).toBe(true);
    expect(result.status).toBe('RECONCILED');
    expect(result.variance?.summary.all_reconciled).toBe(true);
    expect(result.cashbook?.current_year_movements).toBe(1000);
    expect(result.bank_master?.balance_pounds).toBe(1000);
    expect(result.nominal_ledger?.total_balance).toBe(1000);
  });

  it('flags variance when totals do not match', async () => {
    const state: State = {
      banks: [
        {
          nk_acnt: 'BC010',
          description: 'Barclays',
          nk_sort: '20-00-00',
          nk_number: '12345678',
          nk_curbal: 100000,
        },
      ],
      atran: [],
      ntran: [{ nt_acnt: 'BC010', nt_value: 50, nt_year: 2026 }],
      nacnt: {
        na_acnt: 'BC010',
        description: 'Bank',
        na_ytddr: 0,
        na_ytdcr: 0,
        na_prydr: 0,
        na_prycr: 0,
      },
      anoml: [],
    };
    const result = await reconcileBankDashboard(makeOperaDb(state), 'BC010');
    expect(result.success).toBe(true);
    expect(result.status).toBe('UNRECONCILED');
    expect(result.variance?.cashbook_vs_bank_master.reconciled).toBe(false);
    expect(result.variance?.bank_master_vs_nominal.reconciled).toBe(false);
  });

  it('surfaces transfer-file pending count + transactions', async () => {
    const state: State = {
      banks: [
        {
          nk_acnt: 'BC010',
          description: 'Barclays',
          nk_sort: '20-00-00',
          nk_number: '12345678',
          nk_curbal: 100000,
        },
      ],
      atran: [],
      ntran: [],
      anoml: [
        {
          ax_nacnt: 'BC010',
          ax_source: 'A',
          ax_date: '2026-04-15',
          ax_value: 100,
          ax_tref: 'REF123',
          ax_comment: 'Pending entry',
          ax_done: null,
        },
      ],
    };
    const result = await reconcileBankDashboard(makeOperaDb(state), 'BC010');
    expect(result.success).toBe(true);
    expect(result.cashbook?.transfer_file.pending_transfer.count).toBe(1);
    expect(
      result.cashbook?.transfer_file.pending_transfer.transactions[0]?.source_desc,
    ).toBe('Cashbook');
  });
});

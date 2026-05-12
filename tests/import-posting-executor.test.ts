import { describe, it, expect } from 'vitest';
import { bankImportPostingExecutor } from '../src/services/import-posting-executor.js';
import type { PdfExtractionResult } from '../src/services/import-from-pdf.js';

interface SqlCall {
  sql: string;
  params?: any[];
}

interface State {
  calls: SqlCall[];
}

function makeOperaDb(state: State): any {
  const raw = async (sql: string, params: any[] = []) => {
    state.calls.push({ sql, params });
    const lower = sql.toLowerCase();
    if (lower.startsWith('select top 1 1 as x from atype')) {
      return [{ x: 1 }];
    }
    if (lower.startsWith('select top 1 rtrim(ay_cbtype)')) {
      return [{ ay_cbtype: 'R1' }];
    }
    if (lower.includes('select top 1 ncd_period')) {
      return [{ ncd_period: 4, ncd_year: 2026 }];
    }
    if (lower.includes('select top 1 sn_name')) {
      return [
        {
          sn_name: 'Acme Ltd',
          sn_region: 'K',
          sn_terrtry: '001',
          sn_custype: 'DD1',
        },
      ];
    }
    if (lower.includes('select top 1 pn_name')) {
      return [
        {
          pn_name: 'Energy Co',
          pn_region: 'K',
          pn_terrtry: '001',
          pn_custype: 'DD1',
        },
      ];
    }
    if (lower.includes('rtrim(isnull(sp.sc_dbtctrl')) {
      return [{ control_account: 'NL1100' }];
    }
    if (lower.includes('rtrim(isnull(pp.pc_crdctrl')) {
      return [{ control_account: 'NL2100' }];
    }
    if (lower.includes('select np_nexjrnl from nparm')) {
      return [{ np_nexjrnl: 1000 }];
    }
    if (lower.includes('select nextid from nextid')) {
      const tbl = (params?.[0] ?? '').toString();
      const counters: Record<string, number> = {
        aentry: 9001,
        atran: 9002,
        stran: 9003,
        ptran: 9004,
        ntran: 9005,
        anoml: 9006,
      };
      return [{ nextid: counters[tbl] ?? 1 }];
    }
    if (lower.includes('select ay_entry from atype')) {
      return [{ ay_entry: 'R100000001' }];
    }
    if (lower.includes('select 1 as x from aentry')) {
      return [];
    }
    if (lower.includes('na_type, na_subt')) {
      return [{ na_type: 'B ', na_subt: 'BC' }];
    }
    return { rowCount: 1 };
  };

  const tableBuilder = (table: string) => {
    const builder: any = {
      select: () => builder,
      where: () => builder,
      whereRaw: () => builder,
      andWhere: () => builder,
      andWhereNot: () => builder,
      first: async () => {
        if (table === 'sprfls') return { debtors_control: 'NL1100' };
        if (table === 'pprfls') return { creditors_control: 'NL2100' };
        if (table === 'nparm')
          return { debtors_control: 'NL1100', creditors_control: 'NL2100' };
        return undefined;
      },
    };
    return builder;
  };
  const db: any = (table: string) => tableBuilder(table);
  db.raw = raw;
  db.transaction = async (cb: (trx: any) => Promise<any>) => cb(db);
  return db;
}

const SAMPLE_STATEMENT: PdfExtractionResult = {
  bank_name: 'Barclays',
  account_number: '12345678',
  sort_code: '20-00-00',
  statement_date: '2026-04-30',
  period_start: '2026-04-01',
  period_end: '2026-04-30',
  opening_balance: 1000,
  closing_balance: 2000,
  transactions: [],
};

describe('bankImportPostingExecutor', () => {
  it('posts a sales_receipt — aentry/atran/stran/sname/nbank/ntran/anoml/njmemo', async () => {
    const state: State = { calls: [] };
    const result = await bankImportPostingExecutor.postBankImport({
      operaDb: makeOperaDb(state),
      bankCode: 'BC010',
      statementInfo: SAMPLE_STATEMENT,
      transactions: [
        {
          date: '2026-04-15',
          name: 'Acme Ltd',
          memo: 'Customer payment',
          amount: 100,
          type: 'credit',
          ...({ matched_account: 'A001', action: 'sales_receipt' } as Record<
            string,
            unknown
          >),
        },
      ],
      overrides: [],
      selectedRows: null,
      autoAllocate: false,
      autoReconcile: false,
    });
    expect(result.success).toBe(true);
    expect(result.records_imported).toBe(1);
    const inserts = state.calls.filter((c) =>
      c.sql.toLowerCase().includes('insert into'),
    );
    const tables = new Set(
      inserts.map((c) => /insert into (\w+)/i.exec(c.sql)?.[1] ?? '?'),
    );
    expect(tables.has('aentry')).toBe(true);
    expect(tables.has('atran')).toBe(true);
    expect(tables.has('stran')).toBe(true);
    expect(tables.has('ntran')).toBe(true);
    expect(tables.has('anoml')).toBe(true);
    expect(tables.has('njmemo')).toBe(true);
    const nbankUpdate = state.calls.find((c) =>
      c.sql.toLowerCase().includes('update nbank'),
    );
    expect(nbankUpdate).toBeDefined();
    const snameUpdate = state.calls.find((c) =>
      c.sql.toLowerCase().includes('update sname'),
    );
    expect(snameUpdate).toBeDefined();
  });

  it('posts a purchase_payment — uses ptran instead of stran', async () => {
    const state: State = { calls: [] };
    const result = await bankImportPostingExecutor.postBankImport({
      operaDb: makeOperaDb(state),
      bankCode: 'BC010',
      statementInfo: SAMPLE_STATEMENT,
      transactions: [
        {
          date: '2026-04-15',
          name: 'Energy Co',
          memo: 'DD energy bill',
          amount: -50,
          type: 'debit',
          ...({
            matched_account: 'B001',
            action: 'purchase_payment',
          } as Record<string, unknown>),
        },
      ],
      overrides: [],
      selectedRows: null,
      autoAllocate: false,
      autoReconcile: false,
    });
    expect(result.success).toBe(true);
    expect(result.records_imported).toBe(1);
    const inserts = state.calls.filter((c) =>
      c.sql.toLowerCase().includes('insert into'),
    );
    const tables = new Set(
      inserts.map((c) => /insert into (\w+)/i.exec(c.sql)?.[1] ?? '?'),
    );
    expect(tables.has('ptran')).toBe(true);
    expect(tables.has('stran')).toBe(false);
  });

  it('skips skip/defer rows; posts nominal entries', async () => {
    const state: State = { calls: [] };
    const result = await bankImportPostingExecutor.postBankImport({
      operaDb: makeOperaDb(state),
      bankCode: 'BC010',
      statementInfo: SAMPLE_STATEMENT,
      transactions: [
        {
          date: '2026-04-15',
          name: 'A',
          memo: '',
          amount: 50,
          type: 'credit',
          ...({ action: 'skip' } as Record<string, unknown>),
        },
        {
          date: '2026-04-15',
          name: 'B',
          memo: '',
          amount: -50,
          type: 'debit',
          ...({ action: 'nominal_payment', matched_account: 'NL5000' } as Record<
            string,
            unknown
          >),
        },
      ],
      overrides: [],
      selectedRows: null,
      autoAllocate: false,
      autoReconcile: false,
    });
    expect(result.skipped_count).toBe(1); // skip
    expect(result.records_imported).toBe(1); // nominal posted
  });

  it('posts a bank_transfer (paired source+dest aentry/atran)', async () => {
    const state: State = { calls: [] };
    const result = await bankImportPostingExecutor.postBankImport({
      operaDb: makeOperaDb(state),
      bankCode: 'BC010',
      statementInfo: SAMPLE_STATEMENT,
      transactions: [
        {
          date: '2026-04-15',
          name: 'Transfer',
          memo: 'Transfer to savings',
          amount: -1000, // money OUT
          type: 'debit',
          ...({ action: 'bank_transfer', matched_account: 'BC020' } as Record<
            string,
            unknown
          >),
        },
      ],
      overrides: [],
      selectedRows: null,
      autoAllocate: false,
      autoReconcile: false,
    });
    expect(result.success).toBe(true);
    expect(result.records_imported).toBe(1);
    const aentryInserts = state.calls.filter((c) =>
      /insert into aentry/i.test(c.sql),
    );
    expect(aentryInserts.length).toBe(2); // source + dest
  });

  it('per-row error does not roll back other rows', async () => {
    const state: State = { calls: [] };
    let firstAttempt = true;
    const db: any = makeOperaDb(state);
    const realTransaction = db.transaction;
    db.transaction = async (cb: (trx: any) => Promise<any>) => {
      if (firstAttempt) {
        firstAttempt = false;
        throw new Error('simulated row failure');
      }
      return realTransaction(cb);
    };
    const result = await bankImportPostingExecutor.postBankImport({
      operaDb: db,
      bankCode: 'BC010',
      statementInfo: SAMPLE_STATEMENT,
      transactions: [
        {
          date: '2026-04-15',
          name: 'Bad',
          memo: '',
          amount: 50,
          type: 'credit',
          ...({ matched_account: 'A001', action: 'sales_receipt' } as Record<
            string,
            unknown
          >),
        },
        {
          date: '2026-04-15',
          name: 'Good',
          memo: '',
          amount: 50,
          type: 'credit',
          ...({ matched_account: 'A001', action: 'sales_receipt' } as Record<
            string,
            unknown
          >),
        },
      ],
      overrides: [],
      selectedRows: null,
      autoAllocate: false,
      autoReconcile: false,
    });
    expect(result.records_failed).toBe(1);
    expect(result.records_imported).toBe(1);
    expect(result.errors[0]).toMatch(/Row 1/);
  });

  it('respects selectedRows', async () => {
    const state: State = { calls: [] };
    const result = await bankImportPostingExecutor.postBankImport({
      operaDb: makeOperaDb(state),
      bankCode: 'BC010',
      statementInfo: SAMPLE_STATEMENT,
      transactions: [
        {
          date: '2026-04-15',
          name: 'A',
          memo: '',
          amount: 50,
          type: 'credit',
          ...({ matched_account: 'A001', action: 'sales_receipt' } as Record<
            string,
            unknown
          >),
        },
        {
          date: '2026-04-15',
          name: 'B',
          memo: '',
          amount: 50,
          type: 'credit',
          ...({ matched_account: 'A001', action: 'sales_receipt' } as Record<
            string,
            unknown
          >),
        },
      ],
      overrides: [],
      selectedRows: [2], // 1-indexed: only post second row
      autoAllocate: false,
      autoReconcile: false,
    });
    expect(result.records_imported).toBe(1);
    expect(result.skipped_count).toBe(1);
  });
});

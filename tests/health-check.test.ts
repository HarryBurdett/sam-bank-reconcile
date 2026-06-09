import { describe, it, expect } from 'vitest';
import { runHealthCheck } from '../src/services/health-check.js';

const TEST_COMPANY = 'C';

function makeMockOpera(canned: {
  banks?: string[];
  customers?: string[];
  suppliers?: string[];
  nominals?: string[];
}): any {
  const db: any = () => ({});
  db.raw = async (sql: string) => {
    if (sql.includes('FROM nbank')) return (canned.banks ?? []).map((c) => ({ code: c }));
    if (sql.includes('FROM sname')) return (canned.customers ?? []).map((c) => ({ code: c }));
    if (sql.includes('FROM pname')) return (canned.suppliers ?? []).map((c) => ({ code: c }));
    if (sql.includes('FROM nacnt')) return (canned.nominals ?? []).map((c) => ({ code: c }));
    return [];
  };
  return db;
}

function makeMockAppDb(canned: {
  aliases?: Array<{
    bank_name: string;
    account_code: string;
    ledger_type: string;
    bank_code?: string;
  }>;
  patterns?: Array<{ account_code: string; opera_account?: string; ledger_type?: string }>;
  imports?: Array<{ bank_code: string }>;
  errorOnAliases?: boolean;
}): any {
  const db: any = (table: string) => {
    if (table === 'bank_import_aliases') {
      // Service now does `.where(companyScope(companyCode)).select(...)`;
      // the mock ignores the scope filter (canned data is pre-filtered
      // to the test's company) but must honour the chain shape.
      const aliasBuilder: any = {
        where: () => aliasBuilder,
        select: () => {
          if (canned.errorOnAliases) {
            return Promise.reject(new Error('Invalid object name'));
          }
          return Promise.resolve(canned.aliases ?? []);
        },
      };
      return aliasBuilder;
    }
    if (table === 'bank_import_patterns') {
      return {
        select: (..._cols: unknown[]) => ({
          whereNotNull: () => Promise.resolve(canned.patterns ?? []),
        }),
      };
    }
    if (table === 'bank_statement_imports') {
      return {
        distinct: () => ({
          whereNotNull: () => Promise.resolve(canned.imports ?? []),
        }),
      };
    }
    return {};
  };
  db.raw = async () => [];
  return db;
}

describe('bank-reconcile runHealthCheck', () => {
  it('reports healthy when aliases reference valid Opera codes', async () => {
    const opera = makeMockOpera({
      banks: ['BC010', 'BC020'],
      customers: ['CUST001'],
      suppliers: ['SUPP001'],
      nominals: ['7800'],
    });
    const appDb = makeMockAppDb({
      aliases: [
        {
          bank_name: 'Barclays',
          account_code: 'CUST001',
          ledger_type: 'C',
          bank_code: 'BC010',
        },
      ],
    });

    const result = await runHealthCheck({ operaDb: opera, appDb, companyCode: TEST_COMPANY });

    expect(result.app).toBe('bank_reconcile');
    expect(result.healthy).toBe(true);
    expect(result.checks.find((c) => c.name === 'Alias customer codes')?.passed).toBe(true);
  });

  it('flags orphan customer aliases as warnings', async () => {
    const opera = makeMockOpera({
      banks: ['BC010'],
      customers: ['CUST001'],
    });
    const appDb = makeMockAppDb({
      aliases: [
        {
          bank_name: 'B',
          account_code: 'GHOST',
          ledger_type: 'C',
          bank_code: 'BC010',
        },
      ],
    });

    const result = await runHealthCheck({ operaDb: opera, appDb, companyCode: TEST_COMPANY });
    const custCheck = result.checks.find((c) => c.name === 'Alias customer codes');
    expect(custCheck?.passed).toBe(false);
    expect(custCheck?.severity).toBe('warning');
    expect(custCheck?.orphan_count).toBe(1);
  });

  it('reports error when Opera connection returns nothing', async () => {
    const opera = makeMockOpera({});
    const appDb = makeMockAppDb({});
    const result = await runHealthCheck({ operaDb: opera, appDb, companyCode: TEST_COMPANY });

    const conn = result.checks.find((c) => c.name === 'Opera connection');
    expect(conn?.passed).toBe(false);
    expect(conn?.severity).toBe('error');
    expect(result.healthy).toBe(false);
  });

  it('skips alias checks when no app DB available', async () => {
    const opera = makeMockOpera({ banks: ['BC010'] });
    const result = await runHealthCheck({ operaDb: opera, appDb: null, companyCode: TEST_COMPANY });

    const skipped = result.checks.find((c) => c.name === 'Bank aliases');
    expect(skipped?.severity).toBe('info');
    expect(result.healthy).toBe(true);
  });
});

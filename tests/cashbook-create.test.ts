import { describe, it, expect, vi } from 'vitest';
import {
  listCashbookBankAccounts,
  autoMatchStatementLines,
} from '../src/services/cashbook-create.js';

function makeOperaDb(banks: any[] = []): any {
  const db: any = (_table: string) => ({
    where: () => ({
      andWhere: () => ({
        count: () => ({ first: async () => ({ cnt: 0 }) }),
      }),
    }),
  });
  db.raw = async (sql: string) => {
    if (sql.includes('FROM nbank')) return banks;
    return [];
  };
  return db;
}

describe('listCashbookBankAccounts', () => {
  it('returns bank list', async () => {
    const result = await listCashbookBankAccounts(
      makeOperaDb([
        {
          code: 'BC010',
          description: 'Barclays',
          current_balance: 1000,
          reconciled_balance: 1000,
          sort_code: '20-00-00',
          account_number: '12345678',
        },
      ]),
    );
    expect(result.success).toBe(true);
    expect(result.banks.length).toBe(1);
  });

  it('returns empty when no banks', async () => {
    const result = await listCashbookBankAccounts(makeOperaDb([]));
    expect(result.banks).toEqual([]);
  });
});

describe('autoMatchStatementLines', () => {
  it('returns total + matched=0 (deferred to reconcile flow)', async () => {
    const db: any = (_table: string) => {
      const builder: any = {
        where: () => builder,
        andWhere: (col: any) => {
          if (typeof col === 'function') col.call(builder);
          return builder;
        },
        whereNull: () => builder,
        orWhere: () => builder,
        count: () => ({ first: async () => ({ cnt: 5 }) }),
      };
      return builder;
    };
    db.raw = async () => [];
    const r = await autoMatchStatementLines(db, 'BC010', 1);
    expect(r.success).toBe(true);
    expect(r.matched).toBe(0);
    expect(r.total).toBe(5);
  });
});

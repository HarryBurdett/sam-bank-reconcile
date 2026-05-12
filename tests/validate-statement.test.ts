import { describe, it, expect } from 'vitest';
import { validateStatementForReconciliation } from '../src/services/validate-statement.js';

interface NbankRow {
  nk_acnt: string;
  expected_opening: number;
  last_statement_number: number | null;
  current_balance: number;
}

function makeOperaDb(rows: NbankRow[]): any {
  const db: any = (table: string) => {
    if (table !== 'nbank') throw new Error(`Unexpected table: ${table}`);
    let conds: Record<string, unknown> = {};
    const builder: any = {
      where: (cond: Record<string, unknown>) => {
        Object.assign(conds, cond);
        return builder;
      },
      select: (..._cols: any[]) => builder,
      first: async () => {
        const match = rows.find((r) =>
          Object.entries(conds).every(([k, v]) => (r as any)[k] === v),
        );
        if (!match) return undefined;
        return {
          expected_opening: match.expected_opening,
          last_statement_number: match.last_statement_number,
          current_balance: match.current_balance,
        };
      },
    };
    return builder;
  };
  db.raw = (s: string) => s;
  return db;
}

describe('validateStatementForReconciliation', () => {
  it('reports valid when opening balance matches Opera (1p tolerance)', async () => {
    const operaDb = makeOperaDb([
      {
        nk_acnt: 'BANK01',
        expected_opening: 1000.0,
        last_statement_number: 5,
        current_balance: 1500.0,
      },
    ]);
    const result = await validateStatementForReconciliation(operaDb, {
      bankAccount: 'BANK01',
      openingBalance: 1000.005,
      closingBalance: 1500.0,
      statementDate: '2026-04-30',
    });
    expect(result.valid).toBe(true);
    expect(result.opening_matches).toBe(true);
    expect(result.expected_opening).toBeCloseTo(1000.0);
    expect(result.next_statement_number).toBe(6);
    expect(result.statement_date).toBe('2026-04-30');
    expect(result.error_message).toBeNull();
  });

  it('reports invalid when opening balance differs by more than 1p', async () => {
    const operaDb = makeOperaDb([
      {
        nk_acnt: 'BANK01',
        expected_opening: 1000.0,
        last_statement_number: 0,
        current_balance: 1000.0,
      },
    ]);
    const result = await validateStatementForReconciliation(operaDb, {
      bankAccount: 'BANK01',
      openingBalance: 1050.0,
      closingBalance: 1100.0,
    });
    expect(result.valid).toBe(false);
    expect(result.opening_matches).toBe(false);
    expect(result.difference).toBe(50.0);
    expect(result.error_message).toMatch(/mismatch/i);
    expect(result.next_statement_number).toBe(1);
  });

  it('uses caller-supplied statement_number when provided', async () => {
    const operaDb = makeOperaDb([
      {
        nk_acnt: 'BANK01',
        expected_opening: 500.0,
        last_statement_number: 10,
        current_balance: 500.0,
      },
    ]);
    const result = await validateStatementForReconciliation(operaDb, {
      bankAccount: 'BANK01',
      openingBalance: 500.0,
      closingBalance: 500.0,
      statementNumber: 99,
    });
    expect(result.next_statement_number).toBe(99);
  });

  it('returns 404-style error when bank not found', async () => {
    const operaDb = makeOperaDb([]);
    const result = await validateStatementForReconciliation(operaDb, {
      bankAccount: 'MISSING',
      openingBalance: 100.0,
      closingBalance: 100.0,
    });
    expect(result.valid).toBe(false);
    expect(result.error_message).toMatch(/not found/);
  });

  it('rejects empty bank_account', async () => {
    const operaDb = makeOperaDb([]);
    const result = await validateStatementForReconciliation(operaDb, {
      bankAccount: '',
      openingBalance: 100.0,
      closingBalance: 100.0,
    });
    expect(result.valid).toBe(false);
    expect(result.error_message).toMatch(/required/);
  });

  it('reports DB error gracefully', async () => {
    const operaDb: any = (_t: string) => {
      const builder: any = {
        where: () => builder,
        select: () => builder,
        first: () => Promise.reject(new Error('DB unavailable')),
      };
      return builder;
    };
    operaDb.raw = (s: string) => s;
    const result = await validateStatementForReconciliation(operaDb, {
      bankAccount: 'BANK01',
      openingBalance: 100,
      closingBalance: 100,
    });
    expect(result.valid).toBe(false);
    expect(result.error_message).toMatch(/DB unavailable/);
  });

  it('handles last_statement_number = null (first statement)', async () => {
    const operaDb = makeOperaDb([
      {
        nk_acnt: 'BANK01',
        expected_opening: 0,
        last_statement_number: null,
        current_balance: 0,
      },
    ]);
    const result = await validateStatementForReconciliation(operaDb, {
      bankAccount: 'BANK01',
      openingBalance: 0,
      closingBalance: 100,
    });
    expect(result.valid).toBe(true);
    expect(result.next_statement_number).toBe(1);
  });
});

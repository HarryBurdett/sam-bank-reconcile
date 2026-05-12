import { describe, it, expect } from 'vitest';
import {
  calculateStatementLineNumbers,
} from '../src/services/complete-reconciliation.js';

// ---------------------------------------------------------------------
// calculateStatementLineNumbers (pure function, no DB)
// ---------------------------------------------------------------------

describe('calculateStatementLineNumbers', () => {
  it('assigns 10/20/30 to consecutive matched lines', () => {
    const result = calculateStatementLineNumbers(3, [1, 2, 3], []);
    expect(result.get(1)).toBe(10);
    expect(result.get(2)).toBe(20);
    expect(result.get(3)).toBe(30);
  });

  it('skips unmatched lines but preserves the gap', () => {
    // 5 lines: positions 1, 3, 5 matched; 2, 4 unmatched
    const result = calculateStatementLineNumbers(5, [1, 3, 5], [2, 4]);
    expect(result.get(1)).toBe(10); // 0 unmatched before → 10
    expect(result.get(3)).toBe(20); // 1 unmatched before → (1+1)*10=20
    expect(result.get(5)).toBe(30); // 2 unmatched before → (2+1)*10=30
  });

  it('handles only-some-matched: positions 1 and 3 matched out of 3', () => {
    const result = calculateStatementLineNumbers(3, [1, 3], [2]);
    expect(result.get(1)).toBe(10); // 0 unmatched before → 10
    expect(result.get(2)).toBeUndefined();
    expect(result.get(3)).toBe(20); // 1 unmatched before → (1+1)*10=20
  });

  it('only-some-matched at later positions', () => {
    // 4 lines: positions 3, 4 matched; 1, 2 unmatched
    const result = calculateStatementLineNumbers(4, [3, 4], [1, 2]);
    expect(result.get(3)).toBe(30); // 2 unmatched before → 30
    expect(result.get(4)).toBe(40);
  });

  it('returns empty map when no matched positions', () => {
    const result = calculateStatementLineNumbers(5, [], [1, 2, 3, 4, 5]);
    expect(result.size).toBe(0);
  });

  it('returns empty map when total_lines is 0', () => {
    const result = calculateStatementLineNumbers(0, [], []);
    expect(result.size).toBe(0);
  });

  it('handles many unmatched before a single match (>9 unmatched)', () => {
    // 12 lines, only position 12 matched, 1-11 unmatched
    const matched = [12];
    const unmatched = Array.from({ length: 11 }, (_, i) => i + 1);
    const result = calculateStatementLineNumbers(12, matched, unmatched);
    // 11 unmatched before → (11+1) * 10 = 120
    expect(result.get(12)).toBe(120);
  });

  it('preserves monotonic ordering when current_line forces bigger gaps', () => {
    // Edge case: matched at 1 and 2, with unmatched between later
    const result = calculateStatementLineNumbers(2, [1, 2], []);
    expect(result.get(1)).toBe(10);
    expect(result.get(2)).toBe(20);
  });
});

// ---------------------------------------------------------------------
// completeReconciliation orchestration
// ---------------------------------------------------------------------

import { completeReconciliation } from '../src/services/complete-reconciliation.js';

interface NbankRow {
  reconciled_balance: number;
  current_balance: number;
  last_rec_line: number | null;
  last_stmt_no: number | null;
  last_stmt_date: string | null;
  last_rec_date: string | null;
  rec_cfwd_balance: number;
}

interface AentryRow {
  ae_acnt: string;
  ae_entry: string;
  ae_value: number; // pence
  ae_reclnum: number;
  ae_complet: number;
  ae_lstdate?: string;
}

interface MockState {
  nbank: NbankRow | null;
  unrec: { count: number; total: number };
  aentry: AentryRow[];
}

function makeOperaDb(state: MockState): any {
  const db: any = (table: string) => {
    if (table !== 'aentry') {
      throw new Error(`Unexpected operaDb table: ${table}`);
    }
    let acntCond = '';
    let inEntries: string[] = [];
    let cmpConds: Array<{ col: string; op: string; val: any }> = [];
    const builder: any = {
      where: (col: any, op?: any, val?: any) => {
        if (typeof col === 'object' && col.ae_acnt) {
          acntCond = col.ae_acnt;
        } else if (typeof col === 'string' && val !== undefined) {
          cmpConds.push({ col, op, val });
        }
        return builder;
      },
      whereIn: (col: string, vals: string[]) => {
        if (col === 'ae_entry') inEntries = vals;
        return builder;
      },
      andWhere: (col: any, op?: any, val?: any) => builder.where(col, op, val),
      orderBy: () => builder,
      select: async (..._cols: any[]) => {
        return state.aentry.filter(
          (r) =>
            (acntCond === '' || r.ae_acnt === acntCond) &&
            (inEntries.length === 0 || inEntries.includes(r.ae_entry)),
        );
      },
      first: async () => state.aentry[0],
      update: async () => 0,
    };
    return builder;
  };
  db.raw = async (sql: string) => {
    if (sql.includes('FROM nbank')) {
      return state.nbank ? [state.nbank] : [];
    }
    if (sql.includes('FROM aentry') && sql.includes('COUNT')) {
      return [state.unrec];
    }
    return [];
  };
  db.fn = { now: () => '__NOW__' };
  return db;
}

function makeAppDb(): any {
  const db: any = (_t: string) => {
    const builder: any = {
      where: () => builder,
      andWhere: () => builder,
      first: async () => undefined,
      insert: async () => [1],
      update: async () => 1,
      delete: async () => 1,
    };
    return builder;
  };
  db.raw = async () => [];
  db.fn = { now: () => '__NOW__' };
  return db;
}

describe('completeReconciliation', () => {
  it('rejects empty matched_entries', async () => {
    const state: MockState = {
      nbank: null,
      unrec: { count: 0, total: 0 },
      aentry: [],
    };
    const result = await completeReconciliation(
      makeOperaDb(state),
      makeAppDb(),
      {
        bankCode: 'BANK01',
        statementNumber: 1,
        statementDate: '2026-04-30',
        closingBalance: 1000,
        matchedEntries: [],
        statementTransactions: [],
      },
    );
    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toMatch(/No entries/);
  });

  it('errors when bank account not found', async () => {
    const state: MockState = {
      nbank: null,
      unrec: { count: 0, total: 0 },
      aentry: [],
    };
    const result = await completeReconciliation(
      makeOperaDb(state),
      makeAppDb(),
      {
        bankCode: 'MISSING',
        statementNumber: 1,
        statementDate: '2026-04-30',
        closingBalance: 1000,
        matchedEntries: [{ entry_number: 'R001', statement_line: 1 }],
        statementTransactions: [{ line_number: 1 }],
      },
    );
    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toMatch(/not found/);
  });

  it('errors when matched entry numbers not found in aentry', async () => {
    const state: MockState = {
      nbank: {
        reconciled_balance: 1000,
        current_balance: 1500,
        last_rec_line: 0,
        last_stmt_no: 0,
        last_stmt_date: null,
        last_rec_date: null,
        rec_cfwd_balance: 0,
      },
      unrec: { count: 0, total: 0 },
      aentry: [], // no matching entries
    };
    const result = await completeReconciliation(
      makeOperaDb(state),
      makeAppDb(),
      {
        bankCode: 'BANK01',
        statementNumber: 1,
        statementDate: '2026-04-30',
        closingBalance: 1500,
        matchedEntries: [{ entry_number: 'R_GHOST', statement_line: 1 }],
        statementTransactions: [{ line_number: 1 }],
      },
    );
    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toMatch(/Could not find entries/);
  });

  it('rejects matched_entries that all have empty entry_numbers', async () => {
    const state: MockState = {
      nbank: {
        reconciled_balance: 1000,
        current_balance: 1500,
        last_rec_line: 0,
        last_stmt_no: 0,
        last_stmt_date: null,
        last_rec_date: null,
        rec_cfwd_balance: 0,
      },
      unrec: { count: 0, total: 0 },
      aentry: [],
    };
    const result = await completeReconciliation(
      makeOperaDb(state),
      makeAppDb(),
      {
        bankCode: 'BANK01',
        statementNumber: 1,
        statementDate: '2026-04-30',
        closingBalance: 1500,
        matchedEntries: [{ entry_number: '', statement_line: 1 }],
        statementTransactions: [{ line_number: 1 }],
      },
    );
    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toMatch(/No valid entry numbers/);
  });
});

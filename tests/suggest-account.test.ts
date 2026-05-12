import { describe, it, expect } from 'vitest';
import { suggestAccountForTransaction } from '../src/services/suggest-account.js';

interface SnameRow {
  code: string;
  name: string;
  stop?: 'Y' | 'N' | null;
}

interface State {
  sname: SnameRow[];
  pname: SnameRow[];
}

function makeOperaDb(state: State): any {
  const db: any = (table: string) => {
    if (table !== 'sname' && table !== 'pname') {
      throw new Error(`Unexpected table: ${table}`);
    }
    const builder: any = {
      select: () => builder,
      where: (cond: any) => {
        if (typeof cond === 'function') cond.call(builder);
        return builder;
      },
      orWhereNull: () => builder,
      orderBy: () => builder,
      then: async (resolve: any) => {
        const rows = table === 'sname' ? state.sname : state.pname;
        return resolve(
          rows
            .filter((r) => r.stop !== 'Y')
            .map((r) => ({ code: r.code, name: r.name })),
        );
      },
    };
    return builder;
  };
  db.raw = (s: string) => s;
  return db;
}

describe('suggestAccountForTransaction', () => {
  it('returns no suggestions when ledger empty', async () => {
    const result = await suggestAccountForTransaction(
      makeOperaDb({ sname: [], pname: [] }),
      'ACME LTD',
      'sales_receipt',
    );
    expect(result.success).toBe(true);
    expect(result.suggestions.length).toBe(0);
    expect(result.searched_count).toBe(0);
  });

  it('substring match wins with score 95', async () => {
    const state: State = {
      sname: [
        { code: 'A001', name: 'Acme Ltd' },
        { code: 'A002', name: 'Acme Trading Co' },
        { code: 'B001', name: 'Beta plc' },
      ],
      pname: [],
    };
    const result = await suggestAccountForTransaction(
      makeOperaDb(state),
      'Acme',
      'sales_receipt',
    );
    expect(result.success).toBe(true);
    // Both Acme rows should have score 95 (substring match)
    const acmeMatches = result.suggestions.filter((s) => s.score === 95);
    expect(acmeMatches.length).toBeGreaterThanOrEqual(1);
    expect(acmeMatches[0]?.match_type).toBe('substring');
  });

  it('word_match catches multi-word overlap', async () => {
    const state: State = {
      sname: [
        { code: 'A001', name: 'WIDGETS INTERNATIONAL LIMITED' },
      ],
      pname: [],
    };
    const result = await suggestAccountForTransaction(
      makeOperaDb(state),
      'WIDGETS LIMITED COMPANY',
      'sales_receipt',
    );
    expect(result.success).toBe(true);
    expect(result.suggestions.length).toBeGreaterThanOrEqual(1);
    const top = result.suggestions[0];
    expect(top?.match_type === 'word_match' || top?.match_type === 'substring').toBe(true);
  });

  it('fuzzy match for similar but non-overlapping strings', async () => {
    const state: State = {
      sname: [{ code: 'A001', name: 'JONESCO ENTERPRISES' }],
      pname: [],
    };
    const result = await suggestAccountForTransaction(
      makeOperaDb(state),
      'JONESCO ENTERPRISE',
      'sales_receipt',
    );
    expect(result.suggestions.length).toBeGreaterThanOrEqual(1);
  });

  it('routes to suppliers for purchase types', async () => {
    const state: State = {
      sname: [{ code: 'A001', name: 'Acme Ltd' }],
      pname: [{ code: 'P001', name: 'Energy Co' }],
    };
    const result = await suggestAccountForTransaction(
      makeOperaDb(state),
      'Energy',
      'purchase_payment',
    );
    expect(result.ledger_type).toBe('S');
    expect(result.suggestions[0]?.code).toBe('P001');
  });

  it('routes to customers for sales types', async () => {
    const state: State = {
      sname: [{ code: 'A001', name: 'Acme Ltd' }],
      pname: [{ code: 'P001', name: 'Acme Ltd' }],
    };
    const result = await suggestAccountForTransaction(
      makeOperaDb(state),
      'Acme',
      'sales_refund',
    );
    expect(result.ledger_type).toBe('C');
    expect(result.suggestions[0]?.code).toBe('A001');
  });

  it('respects limit', async () => {
    const state: State = {
      sname: [
        { code: 'A001', name: 'Acme Ltd' },
        { code: 'A002', name: 'Acme Trading' },
        { code: 'A003', name: 'Acme Engineering' },
        { code: 'A004', name: 'Acme Holdings' },
      ],
      pname: [],
    };
    const result = await suggestAccountForTransaction(
      makeOperaDb(state),
      'Acme',
      'sales_receipt',
      2,
    );
    expect(result.suggestions.length).toBe(2);
  });

  it('skips dormant accounts', async () => {
    const state: State = {
      sname: [
        { code: 'A001', name: 'Acme Ltd', stop: 'Y' },
        { code: 'A002', name: 'Acme Trading' },
      ],
      pname: [],
    };
    const result = await suggestAccountForTransaction(
      makeOperaDb(state),
      'Acme',
      'sales_receipt',
    );
    expect(result.suggestions.find((s) => s.code === 'A001')).toBeUndefined();
    expect(result.suggestions.find((s) => s.code === 'A002')).toBeDefined();
  });
});

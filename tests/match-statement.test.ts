import { describe, it, expect } from 'vitest';
import { matchStatementToCashbook } from '../src/services/match-statement.js';

interface UnreconRow {
  ae_acnt: string;
  ae_entry: string;
  ae_value: number; // pence
  ae_lstdate: string;
  ae_entref: string;
  ae_comment: string;
  ae_cbtype: string;
  ae_complet: number;
  ae_reclnum: number;
  ae_remove: number;
}

interface ReconRow extends UnreconRow {
  ae_recdate: string;
}

interface MockState {
  unrecon: UnreconRow[];
  recon: ReconRow[];
}

function makeOperaDb(state: MockState): any {
  const db: any = (table: string) => {
    if (table !== 'aentry') throw new Error(`Unexpected table: ${table}`);
    let conds: Record<string, unknown> = {};
    let cmpConds: Array<{ col: string; op: string; val: any }> = [];
    let between: { col: string; lo: string; hi: string } | null = null;
    const reset = () => {
      conds = {};
      cmpConds = [];
      between = null;
    };
    const builder: any = {
      where: (col: any, op?: any, val?: any) => {
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
      andWhere: (col: any, op?: any, val?: any) => builder.where(col, op, val),
      whereBetween: (col: string, range: [string, string]) => {
        between = { col, lo: range[0], hi: range[1] };
        return builder;
      },
      orderBy: () => builder,
      select: async (..._cols: any[]) => {
        // Decide which set based on conds
        const isReconciled = cmpConds.some(
          (c) => c.col === 'ae_reclnum' && c.op === '>' && Number(c.val) === 0,
        );
        const source = isReconciled ? state.recon : state.unrecon;
        const matched = source.filter((r) => {
          for (const [k, v] of Object.entries(conds)) {
            if ((r as any)[k] !== v) return false;
          }
          for (const c of cmpConds) {
            const lhs = (r as any)[c.col];
            if (c.op === '>' && !(Number(lhs) > Number(c.val))) return false;
          }
          if (between) {
            const lhs = (r as any)[between.col] as string;
            if (lhs < between.lo || lhs > between.hi) return false;
          }
          return true;
        });
        const out = matched.map((r) => ({
          ae_entry: r.ae_entry,
          amount_pounds: r.ae_value / 100,
          ae_lstdate: r.ae_lstdate,
          ae_entref: r.ae_entref,
          ae_comment: r.ae_comment,
          ae_cbtype: r.ae_cbtype,
          ae_complet: r.ae_complet,
          ae_reclnum: r.ae_reclnum,
          ae_recdate: (r as ReconRow).ae_recdate,
        }));
        reset();
        return out;
      },
    };
    return builder;
  };
  db.raw = (s: string) => s;
  return db;
}

function unrecon(over: Partial<UnreconRow> = {}): UnreconRow {
  return {
    ae_acnt: 'BANK01',
    ae_entry: 'R000001',
    ae_value: 50000, // £500
    ae_lstdate: '2026-04-15',
    ae_entref: 'BACS-12345',
    ae_comment: 'Customer Ltd payment',
    ae_cbtype: 'R',
    ae_complet: 1,
    ae_reclnum: 0,
    ae_remove: 0,
    ...over,
  };
}

function recon(over: Partial<ReconRow> = {}): ReconRow {
  return {
    ...unrecon(over),
    ae_reclnum: 1,
    ae_recdate: over.ae_recdate ?? '2026-04-30',
    ...over,
  };
}

const PERIOD_START = '2026-04-01';
const PERIOD_END = '2026-04-30';

describe('matchStatementToCashbook', () => {
  it('Tier 1: exact reference + amount → 100% confidence (auto)', async () => {
    const state: MockState = {
      unrecon: [
        unrecon({
          ae_entry: 'R001',
          ae_value: 50000,
          ae_entref: 'BACS-12345',
        }),
      ],
      recon: [],
    };
    const result = await matchStatementToCashbook(makeOperaDb(state), {
      bankAccount: 'BANK01',
      statementTransactions: [
        {
          line_number: 1,
          date: '2026-04-15',
          amount: 500,
          reference: 'BACS-12345',
          description: 'Customer Ltd payment',
        },
      ],
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });
    expect(result.success).toBe(true);
    expect(result.auto_matched).toHaveLength(1);
    expect(result.auto_matched[0]?.confidence).toBe(100);
    expect(result.auto_matched[0]?.entry_number).toBe('R001');
  });

  it('Tier 2: amount + same date + matching description → 100%', async () => {
    const state: MockState = {
      unrecon: [
        unrecon({
          ae_entry: 'R001',
          ae_value: 50000,
          ae_entref: '', // no ref
          ae_comment: 'BIG CUSTOMER LTD',
          ae_lstdate: '2026-04-15',
        }),
      ],
      recon: [],
    };
    const result = await matchStatementToCashbook(makeOperaDb(state), {
      bankAccount: 'BANK01',
      statementTransactions: [
        {
          line_number: 1,
          date: '2026-04-15',
          amount: 500,
          reference: '',
          description: 'Big Customer Ltd payment',
        },
      ],
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });
    expect(result.auto_matched).toHaveLength(1);
    expect(result.auto_matched[0]?.confidence).toBe(100);
  });

  it('Tier 2: amount + same date no desc match → 95% (auto)', async () => {
    const state: MockState = {
      unrecon: [
        unrecon({
          ae_entry: 'R001',
          ae_value: 50000,
          ae_entref: '',
          ae_comment: '',
          ae_lstdate: '2026-04-15',
        }),
      ],
      recon: [],
    };
    const result = await matchStatementToCashbook(makeOperaDb(state), {
      bankAccount: 'BANK01',
      statementTransactions: [
        { line_number: 1, date: '2026-04-15', amount: 500 },
      ],
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });
    expect(result.auto_matched).toHaveLength(1);
    expect(result.auto_matched[0]?.confidence).toBe(95);
  });

  it('Tier 2: amount + 2-day gap → 85% (suggested)', async () => {
    const state: MockState = {
      unrecon: [
        unrecon({
          ae_entry: 'R001',
          ae_value: 50000,
          ae_entref: '',
          ae_lstdate: '2026-04-13',
        }),
      ],
      recon: [],
    };
    const result = await matchStatementToCashbook(makeOperaDb(state), {
      bankAccount: 'BANK01',
      statementTransactions: [
        { line_number: 1, date: '2026-04-15', amount: 500 },
      ],
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });
    expect(result.suggested_matched).toHaveLength(1);
    expect(result.suggested_matched[0]?.confidence).toBe(85);
  });

  it('confidence drops to 55 for >90 day gap', async () => {
    const state: MockState = {
      unrecon: [
        unrecon({
          ae_entry: 'R001',
          ae_value: 50000,
          ae_entref: '',
          ae_lstdate: '2026-01-01', // ~104 days before
        }),
      ],
      recon: [],
    };
    const result = await matchStatementToCashbook(makeOperaDb(state), {
      bankAccount: 'BANK01',
      statementTransactions: [
        { line_number: 1, date: '2026-04-15', amount: 500 },
      ],
      // No period bounds — falls back to unbounded so the Jan entry isn't filtered out
    });
    expect(result.suggested_matched).toHaveLength(1);
    expect(result.suggested_matched[0]?.confidence).toBe(55);
  });

  it('unmatched statement line goes to unmatched_statement bucket', async () => {
    const state: MockState = {
      unrecon: [],
      recon: [],
    };
    const result = await matchStatementToCashbook(makeOperaDb(state), {
      bankAccount: 'BANK01',
      statementTransactions: [
        {
          line_number: 1,
          date: '2026-04-15',
          amount: 999.99,
          reference: 'NOPE',
        },
      ],
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });
    expect(result.unmatched_statement).toHaveLength(1);
    expect(result.unmatched_statement[0]?.statement_reference).toBe('NOPE');
  });

  it('unmatched cashbook entries reported separately', async () => {
    const state: MockState = {
      unrecon: [
        unrecon({ ae_entry: 'R001', ae_value: 50000 }),
        unrecon({ ae_entry: 'R002', ae_value: 75000 }),
      ],
      recon: [],
    };
    const result = await matchStatementToCashbook(makeOperaDb(state), {
      bankAccount: 'BANK01',
      statementTransactions: [
        {
          line_number: 1,
          date: '2026-04-15',
          amount: 500,
          reference: 'BACS-12345',
        },
      ],
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });
    expect(result.unmatched_cashbook).toHaveLength(1);
    expect(result.unmatched_cashbook[0]?.entry_number).toBe('R002');
  });

  it('already-reconciled lines move to already_reconciled bucket', async () => {
    const state: MockState = {
      unrecon: [],
      recon: [
        recon({
          ae_entry: 'R001',
          ae_value: 50000,
          ae_lstdate: '2026-04-15',
          ae_reclnum: 5,
          ae_recdate: '2026-04-30',
        }),
      ],
    };
    const result = await matchStatementToCashbook(makeOperaDb(state), {
      bankAccount: 'BANK01',
      statementTransactions: [
        { line_number: 1, date: '2026-04-15', amount: 500 },
      ],
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });
    expect(result.already_reconciled).toHaveLength(1);
    expect(result.already_reconciled[0]?.reclnum).toBe(5);
    expect(result.unmatched_statement).toHaveLength(0);
  });

  it('does not double-match a single Opera entry', async () => {
    const state: MockState = {
      unrecon: [
        unrecon({
          ae_entry: 'R001',
          ae_value: 50000,
          ae_entref: 'BACS-12345',
        }),
      ],
      recon: [],
    };
    const result = await matchStatementToCashbook(makeOperaDb(state), {
      bankAccount: 'BANK01',
      statementTransactions: [
        {
          line_number: 1,
          date: '2026-04-15',
          amount: 500,
          reference: 'BACS-12345',
        },
        {
          line_number: 2,
          date: '2026-04-16',
          amount: 500,
          reference: 'BACS-12345',
        },
      ],
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });
    expect(result.auto_matched).toHaveLength(1);
    expect(result.unmatched_statement).toHaveLength(1);
    expect(result.unmatched_statement[0]?.statement_line).toBe(2);
  });

  it('respects open-year start cutoff for tier 2 matching', async () => {
    const state: MockState = {
      unrecon: [
        unrecon({
          ae_entry: 'R001',
          ae_value: 50000,
          ae_entref: '',
          ae_lstdate: '2025-06-15', // before open-year start
        }),
      ],
      recon: [],
    };
    const result = await matchStatementToCashbook(makeOperaDb(state), {
      bankAccount: 'BANK01',
      statementTransactions: [
        { line_number: 1, date: '2026-04-15', amount: 500 },
      ],
      openYearStart: new Date('2026-01-01T00:00:00Z'),
    });
    // Excluded by open-year filter
    expect(result.suggested_matched).toHaveLength(0);
    expect(result.unmatched_statement).toHaveLength(1);
  });

  it('falls back to unbounded pool when period bounds omitted (with warn)', async () => {
    const state: MockState = {
      unrecon: [
        unrecon({
          ae_entry: 'R001',
          ae_value: 50000,
          ae_entref: 'BACS-1',
          ae_lstdate: '2025-01-01', // way out of any period window
        }),
      ],
      recon: [],
    };
    let warned: string | null = null;
    const result = await matchStatementToCashbook(makeOperaDb(state), {
      bankAccount: 'BANK01',
      statementTransactions: [
        {
          line_number: 1,
          date: '2026-04-15',
          amount: 500,
          reference: 'BACS-1',
        },
      ],
      onWarn: (msg) => {
        warned = msg;
      },
    });
    expect(result.auto_matched).toHaveLength(1);
    expect(warned).not.toBeNull();
    expect(warned).toMatch(/period bounds not provided/i);
  });

  it('summary counts match the bucket lengths', async () => {
    const state: MockState = {
      unrecon: [
        unrecon({ ae_entry: 'R001', ae_value: 50000, ae_entref: 'BACS-1' }),
        unrecon({ ae_entry: 'R002', ae_value: 75000, ae_entref: 'BACS-2' }),
      ],
      recon: [],
    };
    const result = await matchStatementToCashbook(makeOperaDb(state), {
      bankAccount: 'BANK01',
      statementTransactions: [
        {
          line_number: 1,
          date: '2026-04-15',
          amount: 500,
          reference: 'BACS-1',
        },
        {
          line_number: 2,
          date: '2026-04-15',
          amount: 999.99,
          reference: 'X',
        },
      ],
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    });
    expect(result.summary.total_statement_lines).toBe(2);
    expect(result.summary.auto_matched_count).toBe(1);
    expect(result.summary.unmatched_statement_count).toBe(1);
    expect(result.summary.unmatched_cashbook_count).toBe(1);
  });

  it('reports DB error gracefully', async () => {
    const operaDb: any = (_t: string) => {
      const builder: any = {
        where: () => builder,
        andWhere: () => builder,
        whereBetween: () => builder,
        orderBy: () => builder,
        select: () => Promise.reject(new Error('DB unavailable')),
      };
      return builder;
    };
    operaDb.raw = (s: string) => s;
    const result = await matchStatementToCashbook(operaDb, {
      bankAccount: 'BANK01',
      statementTransactions: [],
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/DB unavailable/);
  });
});

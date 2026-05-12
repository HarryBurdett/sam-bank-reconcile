import { describe, it, expect } from 'vitest';
import {
  recordCorrection,
  isNegativeMatch,
  listCorrections,
} from '../src/services/alias-corrections.js';

interface AliasRow {
  id: number;
  bank_code: string;
  payee_pattern: string;
  match_type: string;
  opera_account: string;
  confidence: number;
  direction: string;
  match_count: number;
  updated_at: string;
}

interface CorrectionRow {
  id: number;
  bank_name: string;
  wrong_account: string;
  correct_account: string;
  ledger_type: string;
  corrected_by: string;
  created_at: string;
}

interface NegRow {
  id: number;
  bank_name: string;
  wrong_account: string;
  created_at: string;
}

interface MockState {
  aliases: AliasRow[];
  corrections: CorrectionRow[];
  negatives: NegRow[];
  nextAliasId: number;
  nextCorrId: number;
  nextNegId: number;
}

function makeAppDb(state: MockState): any {
  const tableHandler = (table: string) => {
    let conds: Record<string, unknown> = {};
    let order: Array<{ col: string; dir: 'asc' | 'desc' }> = [];
    let limitN = Infinity;
    const builder: any = {
      where: (cond: Record<string, unknown>) => {
        Object.assign(conds, cond);
        return builder;
      },
      orderBy: (col: string, dir: 'asc' | 'desc' = 'asc') => {
        order.push({ col, dir });
        return builder;
      },
      limit: (n: number) => {
        limitN = n;
        return builder;
      },
      first: () => {
        const arr =
          table === 'bank_import_aliases'
            ? state.aliases
            : table === 'alias_corrections'
              ? state.corrections
              : state.negatives;
        const found = arr.find((r) =>
          Object.entries(conds).every(([k, v]) => (r as any)[k] === v),
        );
        return Promise.resolve(found);
      },
      then: (cb: (rows: any[]) => unknown) => {
        const arr =
          table === 'bank_import_aliases'
            ? state.aliases
            : table === 'alias_corrections'
              ? state.corrections
              : state.negatives;
        let rows = arr.filter((r) =>
          Object.entries(conds).every(([k, v]) => (r as any)[k] === v),
        );
        for (const o of [...order].reverse()) {
          rows = [...rows].sort((a, b) => {
            const cmp = String((a as any)[o.col]).localeCompare(
              String((b as any)[o.col]),
            );
            return o.dir === 'desc' ? -cmp : cmp;
          });
        }
        return Promise.resolve(cb(rows.slice(0, limitN)));
      },
      insert: (row: Record<string, unknown>) => {
        if (table === 'bank_import_aliases') {
          const id = state.nextAliasId++;
          state.aliases.push({
            id,
            bank_code: String(row.bank_code ?? ''),
            payee_pattern: String(row.payee_pattern ?? ''),
            match_type: String(row.match_type ?? ''),
            opera_account: String(row.opera_account ?? ''),
            confidence: Number(row.confidence ?? 0),
            direction: String(row.direction ?? ''),
            match_count: Number(row.match_count ?? 0),
            updated_at: new Date().toISOString(),
          });
          return Promise.resolve([id]);
        }
        if (table === 'alias_corrections') {
          const id = state.nextCorrId++;
          state.corrections.push({
            id,
            bank_name: String(row.bank_name ?? ''),
            wrong_account: String(row.wrong_account ?? ''),
            correct_account: String(row.correct_account ?? ''),
            ledger_type: String(row.ledger_type ?? ''),
            corrected_by: String(row.corrected_by ?? 'USER'),
            created_at: new Date().toISOString(),
          });
          return Promise.resolve([id]);
        }
        if (table === 'negative_aliases') {
          const id = state.nextNegId++;
          state.negatives.push({
            id,
            bank_name: String(row.bank_name ?? ''),
            wrong_account: String(row.wrong_account ?? ''),
            created_at: new Date().toISOString(),
          });
          return Promise.resolve([id]);
        }
        throw new Error('unexpected insert');
      },
      update: (data: Record<string, unknown>) => {
        const arr =
          table === 'bank_import_aliases' ? state.aliases : state.corrections;
        let count = 0;
        for (const r of arr) {
          if (
            Object.entries(conds).every(([k, v]) => (r as any)[k] === v)
          ) {
            Object.assign(r, data);
            count++;
          }
        }
        return Promise.resolve(count);
      },
    };
    return builder;
  };
  const db: any = (table: string) => tableHandler(table);
  db.fn = { now: () => new Date() };
  db.transaction = async (cb: (trx: unknown) => Promise<unknown>) => {
    const trx: any = (table: string) => tableHandler(table);
    trx.fn = { now: () => new Date() };
    return cb(trx);
  };
  return db;
}

function emptyState(): MockState {
  return {
    aliases: [],
    corrections: [],
    negatives: [],
    nextAliasId: 1,
    nextCorrId: 1,
    nextNegId: 1,
  };
}

describe('recordCorrection', () => {
  it('writes audit row + alias upsert + negative example for customer correction', async () => {
    const state = emptyState();
    const result = await recordCorrection(makeAppDb(state), {
      bank_name: 'Acme Direct Debit',
      wrong_account: 'WRONG_CUST',
      correct_account: 'CORRECT_CUST',
      ledger_type: 'C',
      corrected_by: 'admin',
    });
    expect(result.success).toBe(true);
    expect(state.corrections).toHaveLength(1);
    expect(state.aliases).toHaveLength(1);
    expect(state.negatives).toHaveLength(1);
    expect(state.aliases[0]?.opera_account).toBe('CORRECT_CUST');
    expect(state.aliases[0]?.confidence).toBe(1.0);
    expect(state.aliases[0]?.direction).toBe('receipt');
    expect(state.aliases[0]?.match_type).toBe('customer');
    expect(state.negatives[0]?.bank_name).toBe('ACME DIRECT DEBIT');
    expect(state.negatives[0]?.wrong_account).toBe('WRONG_CUST');
  });

  it('uses payment direction for supplier correction', async () => {
    const state = emptyState();
    await recordCorrection(makeAppDb(state), {
      bank_name: 'WidgetCo Ltd',
      wrong_account: 'WRONG_SUPP',
      correct_account: 'CORRECT_SUPP',
      ledger_type: 'S',
    });
    expect(state.aliases[0]?.match_type).toBe('supplier');
    expect(state.aliases[0]?.direction).toBe('payment');
  });

  it('updates existing alias row instead of duplicating', async () => {
    const state = emptyState();
    state.aliases.push({
      id: 99,
      bank_code: '*',
      payee_pattern: 'Acme',
      match_type: 'customer',
      opera_account: 'OLD',
      confidence: 0.5,
      direction: 'either',
      match_count: 0,
      updated_at: '2026-04-10',
    });
    state.nextAliasId = 100;
    await recordCorrection(makeAppDb(state), {
      bank_name: 'Acme',
      wrong_account: 'OLD',
      correct_account: 'NEW',
      ledger_type: 'C',
    });
    expect(state.aliases).toHaveLength(1);
    expect(state.aliases[0]?.opera_account).toBe('NEW');
    expect(state.aliases[0]?.confidence).toBe(1.0);
  });

  it('case-insensitive ledger_type', async () => {
    const state = emptyState();
    const result = await recordCorrection(makeAppDb(state), {
      bank_name: 'X',
      wrong_account: 'W',
      correct_account: 'R',
      ledger_type: 's',
    });
    expect(result.success).toBe(true);
    expect(state.corrections[0]?.ledger_type).toBe('S');
  });

  it('rejects bad ledger_type', async () => {
    const result = await recordCorrection(makeAppDb(emptyState()), {
      bank_name: 'X',
      wrong_account: 'W',
      correct_account: 'R',
      ledger_type: 'X',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ledger_type/);
  });

  it('rejects missing fields', async () => {
    const result = await recordCorrection(makeAppDb(emptyState()), {
      bank_name: '',
      wrong_account: 'W',
      correct_account: 'R',
      ledger_type: 'C',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/required/);
  });

  it('does NOT duplicate negative_aliases on same (bank_name, wrong_account)', async () => {
    const state = emptyState();
    await recordCorrection(makeAppDb(state), {
      bank_name: 'Acme',
      wrong_account: 'WRONG',
      correct_account: 'A',
      ledger_type: 'C',
    });
    await recordCorrection(makeAppDb(state), {
      bank_name: 'Acme',
      wrong_account: 'WRONG',
      correct_account: 'B',
      ledger_type: 'C',
    });
    expect(state.negatives).toHaveLength(1);
  });
});

describe('isNegativeMatch', () => {
  it('returns true when (bank_name, wrong_account) is recorded', async () => {
    const state = emptyState();
    state.negatives.push({
      id: 1,
      bank_name: 'ACME',
      wrong_account: 'CUST_WRONG',
      created_at: '2026-04-15',
    });
    expect(
      await isNegativeMatch(makeAppDb(state), 'acme', 'CUST_WRONG'),
    ).toBe(true);
  });

  it('returns false when missing', async () => {
    expect(
      await isNegativeMatch(makeAppDb(emptyState()), 'X', 'Y'),
    ).toBe(false);
  });

  it('returns false on empty input', async () => {
    expect(
      await isNegativeMatch(makeAppDb(emptyState()), '', 'X'),
    ).toBe(false);
  });
});

describe('listCorrections', () => {
  it('returns rows in date-desc order', async () => {
    const state = emptyState();
    state.corrections.push(
      {
        id: 1, bank_name: 'A', wrong_account: 'W1', correct_account: 'C1',
        ledger_type: 'C', corrected_by: 'admin', created_at: '2026-04-10',
      },
      {
        id: 2, bank_name: 'B', wrong_account: 'W2', correct_account: 'C2',
        ledger_type: 'S', corrected_by: 'admin', created_at: '2026-04-15',
      },
    );
    const result = await listCorrections(makeAppDb(state));
    expect(result.entries[0]?.id).toBe(2);
  });

  it('filters by bank_name', async () => {
    const state = emptyState();
    state.corrections.push(
      {
        id: 1, bank_name: 'Acme', wrong_account: 'W', correct_account: 'C',
        ledger_type: 'C', corrected_by: '', created_at: '2026-04-10',
      },
      {
        id: 2, bank_name: 'Beta', wrong_account: 'W', correct_account: 'C',
        ledger_type: 'C', corrected_by: '', created_at: '2026-04-15',
      },
    );
    const result = await listCorrections(makeAppDb(state), {
      bankName: 'Acme',
    });
    expect(result.count).toBe(1);
  });
});

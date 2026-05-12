import { describe, it, expect } from 'vitest';
import {
  recordDuplicateOverride,
  getDuplicateOverride,
} from '../src/services/duplicate-override.js';

interface Row {
  id: number;
  transaction_hash: string;
  override_reason: string;
  user_code: string | null;
  created_at: string;
}

interface MockState {
  rows: Row[];
  nextId: number;
}

function makeAppDb(state: MockState): any {
  const db: any = (table: string) => {
    if (table !== 'duplicate_overrides') {
      throw new Error(`Unexpected table: ${table}`);
    }
    let whereCond: { transaction_hash?: string; id?: number } = {};
    const builder: any = {
      where: (cond: { transaction_hash?: string; id?: number }) => {
        whereCond = { ...whereCond, ...cond };
        return builder;
      },
      first: () => {
        const row = state.rows.find((r) => {
          if (whereCond.transaction_hash !== undefined) {
            return r.transaction_hash === whereCond.transaction_hash;
          }
          if (whereCond.id !== undefined) return r.id === whereCond.id;
          return false;
        });
        return Promise.resolve(row);
      },
      insert: (data: Record<string, unknown>) => {
        const id = state.nextId++;
        state.rows.push({
          id,
          transaction_hash: String(data.transaction_hash ?? ''),
          override_reason: String(data.override_reason ?? ''),
          user_code: (data.user_code as string | null) ?? null,
          created_at: new Date().toISOString(),
        });
        return Promise.resolve([id]);
      },
      update: (data: Record<string, unknown>) => {
        const target = state.rows.find((r) => r.id === whereCond.id);
        if (target) {
          if ('override_reason' in data)
            target.override_reason = String(data.override_reason);
          if ('user_code' in data)
            target.user_code = (data.user_code as string | null) ?? null;
          if ('created_at' in data) target.created_at = new Date().toISOString();
        }
        return Promise.resolve(1);
      },
    };
    return builder;
  };
  db.fn = { now: () => 'NOW()' };
  return db;
}

describe('recordDuplicateOverride', () => {
  it('inserts a new override row', async () => {
    const state: MockState = { rows: [], nextId: 1 };
    const db = makeAppDb(state);
    const result = await recordDuplicateOverride(db, {
      transactionHash: 'abc123',
      reason: 'Genuine separate transaction',
      userCode: 'admin',
    });

    expect(result.success).toBe(true);
    expect(result.message).toBe('Duplicate override recorded');
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({
      transaction_hash: 'abc123',
      override_reason: 'Genuine separate transaction',
      user_code: 'admin',
    });
  });

  it('updates existing row instead of duplicating (upsert by hash)', async () => {
    const state: MockState = { rows: [], nextId: 1 };
    const db = makeAppDb(state);
    await recordDuplicateOverride(db, {
      transactionHash: 'h1',
      reason: 'first',
      userCode: 'a',
    });
    await recordDuplicateOverride(db, {
      transactionHash: 'h1',
      reason: 'updated',
      userCode: 'b',
    });
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]?.override_reason).toBe('updated');
    expect(state.rows[0]?.user_code).toBe('b');
  });

  it('rejects empty transaction hash', async () => {
    const result = await recordDuplicateOverride(makeAppDb({ rows: [], nextId: 1 }), {
      transactionHash: '',
      reason: 'irrelevant',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/transaction_hash/);
  });

  it('rejects empty reason', async () => {
    const result = await recordDuplicateOverride(makeAppDb({ rows: [], nextId: 1 }), {
      transactionHash: 'h',
      reason: '   ',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/reason/);
  });

  it('handles userCode null gracefully', async () => {
    const state: MockState = { rows: [], nextId: 1 };
    await recordDuplicateOverride(makeAppDb(state), {
      transactionHash: 'h',
      reason: 'r',
    });
    expect(state.rows[0]?.user_code).toBeNull();
  });
});

describe('getDuplicateOverride', () => {
  it('returns the row when present', async () => {
    const state: MockState = {
      rows: [
        {
          id: 1,
          transaction_hash: 'XYZ',
          override_reason: 'manual',
          user_code: null,
          created_at: '2026-04-15',
        },
      ],
      nextId: 2,
    };
    const db = makeAppDb(state);
    const row = await getDuplicateOverride(db, 'XYZ');
    expect(row?.override_reason).toBe('manual');
  });

  it('returns null when not found', async () => {
    const db = makeAppDb({ rows: [], nextId: 1 });
    const row = await getDuplicateOverride(db, 'missing');
    expect(row).toBeNull();
  });

  it('returns null on empty input', async () => {
    const db = makeAppDb({ rows: [], nextId: 1 });
    const row = await getDuplicateOverride(db, '');
    expect(row).toBeNull();
  });
});

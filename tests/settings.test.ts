import { describe, it, expect } from 'vitest';
import {
  getRecurringEntriesMode,
  setRecurringEntriesMode,
} from '../src/services/settings.js';

interface MockState {
  rows: Map<string, { key: string; value: string; updated_at: Date }>;
}

function makeAppDb(state: MockState): any {
  const db: any = (table: string) => {
    if (table !== 'settings') {
      throw new Error(`Unexpected table: ${table}`);
    }
    let whereKey = '';
    const builder: any = {
      where: (col: Record<string, unknown>) => {
        if (typeof col.key === 'string') whereKey = col.key;
        return builder;
      },
      first: async () => state.rows.get(whereKey) ?? null,
      update: async (patch: Record<string, unknown>) => {
        const existing = state.rows.get(whereKey);
        if (existing) {
          state.rows.set(whereKey, {
            ...existing,
            value: String(patch.value),
            updated_at: new Date(),
          });
          return 1;
        }
        return 0;
      },
      insert: async (row: Record<string, unknown>) => {
        state.rows.set(String(row.key), {
          key: String(row.key),
          value: String(row.value),
          updated_at: new Date(),
        });
        return [1];
      },
    };
    return builder;
  };
  db.fn = { now: () => new Date() };
  return db;
}

describe('getRecurringEntriesMode', () => {
  it("returns 'process' when no row exists", async () => {
    const db = makeAppDb({ rows: new Map() });
    const result = await getRecurringEntriesMode(db);
    expect(result.success).toBe(true);
    expect(result.mode).toBe('process');
  });

  it("returns the stored mode when valid", async () => {
    const state: MockState = {
      rows: new Map([
        [
          'recurring_entries_mode',
          {
            key: 'recurring_entries_mode',
            value: '"warn"',
            updated_at: new Date(),
          },
        ],
      ]),
    };
    const db = makeAppDb(state);
    const result = await getRecurringEntriesMode(db);
    expect(result.success).toBe(true);
    expect(result.mode).toBe('warn');
  });

  it("falls back to 'process' when stored value is invalid", async () => {
    const state: MockState = {
      rows: new Map([
        [
          'recurring_entries_mode',
          {
            key: 'recurring_entries_mode',
            value: '"chaos"',
            updated_at: new Date(),
          },
        ],
      ]),
    };
    const db = makeAppDb(state);
    const result = await getRecurringEntriesMode(db);
    expect(result.mode).toBe('process');
  });
});

describe('setRecurringEntriesMode', () => {
  it("rejects modes other than process/warn", async () => {
    const db = makeAppDb({ rows: new Map() });
    const result = await setRecurringEntriesMode(db, 'chaos');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/process.*warn/);
  });

  it("inserts when no existing row", async () => {
    const state: MockState = { rows: new Map() };
    const db = makeAppDb(state);
    const result = await setRecurringEntriesMode(db, 'warn');
    expect(result.success).toBe(true);
    expect(result.mode).toBe('warn');
    expect(state.rows.get('recurring_entries_mode')?.value).toBe('"warn"');
  });

  it("updates existing row", async () => {
    const state: MockState = {
      rows: new Map([
        [
          'recurring_entries_mode',
          {
            key: 'recurring_entries_mode',
            value: '"process"',
            updated_at: new Date(),
          },
        ],
      ]),
    };
    const db = makeAppDb(state);
    const result = await setRecurringEntriesMode(db, 'warn');
    expect(result.success).toBe(true);
    expect(state.rows.get('recurring_entries_mode')?.value).toBe('"warn"');
  });
});

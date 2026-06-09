import { describe, it, expect } from 'vitest';
import {
  getRecurringEntriesMode,
  setRecurringEntriesMode,
} from '../src/services/settings.js';

/**
 * Mock Knex with an in-memory settings table that respects the
 * (key, company_code) composite key introduced in migration 018.
 *
 * Rows are stored keyed by `${key}|${company_code}` so multiple
 * companies can each own their own row, matching the real schema.
 *
 * Per-company isolation behaviour is covered by
 * settings-company-isolation.test.ts (against a real SQLite DB with
 * migration 018 applied). The tests here exercise the same surface
 * against the mock — every call now threads a `companyCode` through
 * to match the post-migration-018 service signature.
 */
const TEST_COMPANY = 'C';

interface MockRow {
  key: string;
  company_code: string;
  value: string;
  updated_at: Date;
}

interface MockState {
  rows: Map<string, MockRow>;
}

const rowKey = (k: string, c: string) => `${k}|${c}`;

function makeAppDb(state: MockState): any {
  const db: any = (table: string) => {
    if (table !== 'settings') {
      throw new Error(`Unexpected table: ${table}`);
    }
    let whereClause: { key?: string; company_code?: string } = {};
    const builder: any = {
      where: (col: string | Record<string, unknown>, _val?: unknown) => {
        if (typeof col === 'object') Object.assign(whereClause, col);
        else if (_val !== undefined) (whereClause as any)[col] = _val;
        return builder;
      },
      first: async () => {
        if (whereClause.key && whereClause.company_code !== undefined) {
          return (
            state.rows.get(rowKey(whereClause.key, whereClause.company_code)) ??
            null
          );
        }
        return null;
      },
      update: async (patch: Record<string, unknown>) => {
        if (whereClause.key && whereClause.company_code !== undefined) {
          const k = rowKey(whereClause.key, whereClause.company_code);
          const existing = state.rows.get(k);
          if (existing) {
            state.rows.set(k, {
              ...existing,
              value: String(patch.value),
              updated_at: new Date(),
            });
            return 1;
          }
        }
        return 0;
      },
      insert: async (row: Record<string, unknown>) => {
        const k = String(row.key);
        const c = String(row.company_code ?? '');
        state.rows.set(rowKey(k, c), {
          key: k,
          company_code: c,
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
    const result = await getRecurringEntriesMode(db, TEST_COMPANY);
    expect(result.success).toBe(true);
    expect(result.mode).toBe('process');
  });

  it("returns the stored mode when valid", async () => {
    const state: MockState = {
      rows: new Map([
        [
          rowKey('recurring_entries_mode', TEST_COMPANY),
          {
            key: 'recurring_entries_mode',
            company_code: TEST_COMPANY,
            value: '"warn"',
            updated_at: new Date(),
          },
        ],
      ]),
    };
    const db = makeAppDb(state);
    const result = await getRecurringEntriesMode(db, TEST_COMPANY);
    expect(result.success).toBe(true);
    expect(result.mode).toBe('warn');
  });

  it("falls back to 'process' when stored value is invalid", async () => {
    const state: MockState = {
      rows: new Map([
        [
          rowKey('recurring_entries_mode', TEST_COMPANY),
          {
            key: 'recurring_entries_mode',
            company_code: TEST_COMPANY,
            value: '"chaos"',
            updated_at: new Date(),
          },
        ],
      ]),
    };
    const db = makeAppDb(state);
    const result = await getRecurringEntriesMode(db, TEST_COMPANY);
    expect(result.mode).toBe('process');
  });
});

describe('setRecurringEntriesMode', () => {
  it("rejects modes other than process/warn", async () => {
    const db = makeAppDb({ rows: new Map() });
    const result = await setRecurringEntriesMode(db, TEST_COMPANY, 'chaos');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/process.*warn/);
  });

  it("inserts when no existing row", async () => {
    const state: MockState = { rows: new Map() };
    const db = makeAppDb(state);
    const result = await setRecurringEntriesMode(db, TEST_COMPANY, 'warn');
    expect(result.success).toBe(true);
    expect(result.mode).toBe('warn');
    expect(state.rows.get(rowKey('recurring_entries_mode', TEST_COMPANY))?.value).toBe('"warn"');
  });

  it("updates existing row", async () => {
    const state: MockState = {
      rows: new Map([
        [
          rowKey('recurring_entries_mode', TEST_COMPANY),
          {
            key: 'recurring_entries_mode',
            company_code: TEST_COMPANY,
            value: '"process"',
            updated_at: new Date(),
          },
        ],
      ]),
    };
    const db = makeAppDb(state);
    const result = await setRecurringEntriesMode(db, TEST_COMPANY, 'warn');
    expect(result.success).toBe(true);
    expect(state.rows.get(rowKey('recurring_entries_mode', TEST_COMPANY))?.value).toBe('"warn"');
  });
});

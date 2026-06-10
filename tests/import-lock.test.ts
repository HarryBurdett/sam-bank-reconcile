import { describe, it, expect } from 'vitest';
import {
  acquireImportLock,
  releaseImportLock,
  getActiveLocks,
  withImportLock,
  ImportLockError,
  LOCK_EXPIRY_SECONDS,
} from '../src/services/import-lock.js';

const TEST_COMPANY = 'C';

interface LockRow {
  id: number;
  company_code: string;
  bank_code: string;
  locked_at: Date;
  locked_by: string;
  endpoint: string;
  description: string;
}

interface MockState {
  rows: LockRow[];
  nextId: number;
  /** When set, simulates clock advance so `cleanupStaleLocks` finds expired rows. */
  clockOffsetSeconds?: number;
}

function makeAppDb(state: MockState): any {
  const now = () => new Date();
  const db: any = (table: string) => {
    if (table !== 'import_locks') {
      throw new Error(`Unexpected table: ${table}`);
    }
    let conds: Partial<LockRow> = {};
    let lessThanCol: keyof LockRow | null = null;
    let lessThanVal: Date | null = null;

    const builder: any = {
      where: (cond: Partial<LockRow> | string, val?: unknown) => {
        if (typeof cond === 'object') {
          conds = { ...conds, ...cond };
        } else if (typeof cond === 'string' && val !== undefined) {
          // .where('locked_at', '<', date) — captured below in 3-arg form
          (conds as any)[cond] = val;
        }
        return builder;
      },
      // .where('locked_at', '<', cutoffDate)
      // The 3-arg variant gets called via .where(col, op, val)
      // Let's add an explicit method:
      first: () => {
        const found = state.rows.find((r) =>
          Object.entries(conds).every(([k, v]) => (r as any)[k] === v),
        );
        return Promise.resolve(found);
      },
      delete: () => {
        if (lessThanCol && lessThanVal) {
          const before = state.rows.length;
          state.rows = state.rows.filter(
            (r) => (r as any)[lessThanCol!].getTime() >= lessThanVal!.getTime(),
          );
          return Promise.resolve(before - state.rows.length);
        }
        const before = state.rows.length;
        state.rows = state.rows.filter(
          (r) =>
            !Object.entries(conds).every(([k, v]) => (r as any)[k] === v),
        );
        return Promise.resolve(before - state.rows.length);
      },
      insert: (row: Partial<LockRow>) => {
        const lockedBy = (row as any).locked_by ?? 'unknown';
        const endpoint = (row as any).endpoint ?? 'unknown';
        const desc = (row as any).description ?? '';
        const companyCode = String((row as any).company_code ?? '');
        // Composite UNIQUE (company_code, bank_code) per migration 020.
        if (
          state.rows.some(
            (r) =>
              r.bank_code === (row as any).bank_code &&
              r.company_code === companyCode,
          )
        ) {
          return Promise.reject(new Error('UNIQUE constraint'));
        }
        state.rows.push({
          id: state.nextId++,
          company_code: companyCode,
          bank_code: String((row as any).bank_code ?? ''),
          locked_at: (row as any).locked_at instanceof Date
            ? (row as any).locked_at
            : now(),
          locked_by: String(lockedBy),
          endpoint: String(endpoint),
          description: String(desc),
        });
        return Promise.resolve([state.nextId - 1]);
      },
      select: (..._cols: unknown[]) => {
        return Promise.resolve(state.rows);
      },
    };

    // Override: where with 3 args (col, op, val) for cleanup
    const origWhere = builder.where;
    builder.where = (cond: any, op?: any, val?: any) => {
      if (typeof cond === 'string' && op === '<' && val instanceof Date) {
        lessThanCol = cond as keyof LockRow;
        lessThanVal = val;
        return builder;
      }
      return origWhere(cond, op);
    };
    builder.andWhere = (cond: any, op?: any, val?: any) => builder.where(cond, op, val);
    return builder;
  };
  db.fn = { now: () => new Date() };
  return db;
}

describe('acquireImportLock + releaseImportLock', () => {
  it('acquires a lock when none held', async () => {
    const state: MockState = { rows: [], nextId: 1 };
    const db = makeAppDb(state);
    const ok = await acquireImportLock(db, TEST_COMPANY, 'BC010', {
      locked_by: 'api',
      endpoint: 'import',
    });
    expect(ok).toBe(true);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]?.bank_code).toBe('BC010');
    expect(state.rows[0]?.locked_by).toBe('api');
    expect(state.rows[0]?.endpoint).toBe('import');
  });

  it('refuses second acquire while held', async () => {
    const state: MockState = { rows: [], nextId: 1 };
    const db = makeAppDb(state);
    expect(await acquireImportLock(db, TEST_COMPANY, 'BC010')).toBe(true);
    expect(await acquireImportLock(db, TEST_COMPANY, 'BC010')).toBe(false);
    expect(state.rows).toHaveLength(1);
  });

  it('releases the lock', async () => {
    const state: MockState = { rows: [], nextId: 1 };
    const db = makeAppDb(state);
    await acquireImportLock(db, TEST_COMPANY, 'BC010');
    await releaseImportLock(db, TEST_COMPANY, 'BC010');
    expect(state.rows).toHaveLength(0);
    // Re-acquirable after release
    expect(await acquireImportLock(db, TEST_COMPANY, 'BC010')).toBe(true);
  });

  it('cleans up stale locks before acquiring (locks older than LOCK_EXPIRY_SECONDS)', async () => {
    const stale = new Date(Date.now() - (LOCK_EXPIRY_SECONDS + 60) * 1000);
    const state: MockState = {
      rows: [
        {
          id: 1,
          company_code: TEST_COMPANY,
          bank_code: 'BC010',
          locked_at: stale,
          locked_by: 'old',
          endpoint: 'old',
          description: '',
        },
      ],
      nextId: 2,
    };
    const db = makeAppDb(state);
    const ok = await acquireImportLock(db, TEST_COMPANY, 'BC010', { locked_by: 'new' });
    expect(ok).toBe(true);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]?.locked_by).toBe('new');
  });

  it('does NOT clean up locks within expiry window', async () => {
    const fresh = new Date(Date.now() - 30 * 1000); // 30s old
    const state: MockState = {
      rows: [
        {
          id: 1,
          company_code: TEST_COMPANY,
          bank_code: 'BC010',
          locked_at: fresh,
          locked_by: 'fresh',
          endpoint: 'fresh',
          description: '',
        },
      ],
      nextId: 2,
    };
    const db = makeAppDb(state);
    expect(await acquireImportLock(db, TEST_COMPANY, 'BC010')).toBe(false);
  });

  it('rejects empty bank code', async () => {
    const db = makeAppDb({ rows: [], nextId: 1 });
    expect(await acquireImportLock(db, TEST_COMPANY, '')).toBe(false);
    expect(await acquireImportLock(db, TEST_COMPANY, '   ')).toBe(false);
  });
});

describe('getActiveLocks', () => {
  it('returns active locks with age_seconds', async () => {
    const lockedAt = new Date(Date.now() - 60 * 1000);
    const state: MockState = {
      rows: [
        {
          id: 1,
          company_code: TEST_COMPANY,
          bank_code: 'BC010',
          locked_at: lockedAt,
          locked_by: 'api',
          endpoint: 'import',
          description: '',
        },
      ],
      nextId: 2,
    };
    const locks = await getActiveLocks(makeAppDb(state), TEST_COMPANY);
    expect(locks).toHaveLength(1);
    expect(locks[0]?.bank_code).toBe('BC010');
    expect(locks[0]?.age_seconds).toBeGreaterThanOrEqual(59);
    expect(locks[0]?.age_seconds).toBeLessThan(65);
  });
});

describe('withImportLock', () => {
  it('runs fn with lock held + releases on success', async () => {
    const state: MockState = { rows: [], nextId: 1 };
    const db = makeAppDb(state);
    const result = await withImportLock(
      db,
      TEST_COMPANY,
      'BC010',
      { locked_by: 'api' },
      async () => {
        // While inside, the lock should be present
        expect(state.rows).toHaveLength(1);
        return 'done';
      },
    );
    expect(result).toBe('done');
    expect(state.rows).toHaveLength(0); // released after
  });

  it('releases lock even when fn throws', async () => {
    const state: MockState = { rows: [], nextId: 1 };
    const db = makeAppDb(state);
    await expect(
      withImportLock(db, TEST_COMPANY, 'BC010', { locked_by: 'api' }, async () => {
        throw new Error('inner bang');
      }),
    ).rejects.toThrow(/inner bang/);
    expect(state.rows).toHaveLength(0);
  });

  it('throws ImportLockError when bank already locked', async () => {
    const state: MockState = {
      rows: [
        {
          id: 1,
          company_code: TEST_COMPANY,
          bank_code: 'BC010',
          locked_at: new Date(),
          locked_by: 'other',
          endpoint: 'other',
          description: '',
        },
      ],
      nextId: 2,
    };
    const db = makeAppDb(state);
    let caught: unknown = null;
    try {
      await withImportLock(db, TEST_COMPANY, 'BC010', { locked_by: 'me' }, async () => 'ok');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ImportLockError);
    expect((caught as Error).message).toMatch(/being imported by another user/);
    expect(state.rows).toHaveLength(1); // original lock untouched
  });
});

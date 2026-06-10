import { describe, it, expect, beforeEach } from 'vitest';
import knexLib, { type Knex } from 'knex';
import { findExistingCycleRow } from '../src/services/cycle-row-lookup.js';

const TEST_COMPANY = 'C';

const IMPORTS_SCHEMA = `CREATE TABLE bank_statement_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_code TEXT,
  bank_code TEXT NOT NULL,
  statement_date DATE,
  period_start DATE,
  period_end DATE,
  closing_balance REAL,
  is_reconciled INTEGER DEFAULT 0,
  filename TEXT
)`;

async function makeDb(): Promise<Knex> {
  const db = knexLib({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  await db.raw(IMPORTS_SCHEMA);
  return db;
}

describe('findExistingCycleRow', () => {
  let db: Knex;

  beforeEach(async () => {
    db = await makeDb();
  });

  it('returns null when no row matches the cycle key', async () => {
    await db('bank_statement_imports').insert({
      company_code: TEST_COMPANY, bank_code: 'BC010', period_start: '2026-04-01',
      period_end: '2026-04-30', closing_balance: 100,
    });
    const r = await findExistingCycleRow(db, TEST_COMPANY, 'BC010','2026-05-01');
    expect(r).toBeNull();
  });

  it('returns null when period_start is null/empty (cycle key requires it)', async () => {
    const r = await findExistingCycleRow(db, TEST_COMPANY, 'BC010',null);
    expect(r).toBeNull();
    const r2 = await findExistingCycleRow(db, TEST_COMPANY, 'BC010','');
    expect(r2).toBeNull();
  });

  it('returns the row when bank_code + period_start match (cycle exists)', async () => {
    const [id] = await db('bank_statement_imports').insert({
      company_code: TEST_COMPANY, bank_code: 'BC010', period_start: '2026-05-01',
      period_end: '2026-05-08', closing_balance: 100, is_reconciled: 0,
    }).returning('id');
    const r = await findExistingCycleRow(db, TEST_COMPANY, 'BC010','2026-05-01');
    expect(r).not.toBeNull();
    expect(r?.id).toBe(typeof id === 'number' ? id : (id as { id: number }).id);
    expect(r?.is_reconciled).toBe(0);
    expect(r?.period_end).toBe('2026-05-08');
    expect(r?.closing_balance).toBe(100);
  });

  it('distinguishes banks — same period_start, different bank_code', async () => {
    await db('bank_statement_imports').insert({
      company_code: TEST_COMPANY, bank_code: 'BC010', period_start: '2026-05-01',
      period_end: '2026-05-08', closing_balance: 100,
    });
    const r = await findExistingCycleRow(db, TEST_COMPANY, 'BC020', '2026-05-01');
    expect(r).toBeNull();
  });

  it('returns the most recent row when multiple share the cycle key (historical anomaly)', async () => {
    // Pre-cycle-aware data might already have two rows for the same cycle.
    // We want the most recent one — that's the operator-current state.
    await db('bank_statement_imports').insert([
      { company_code: TEST_COMPANY, bank_code: 'BC010', period_start: '2026-05-01', period_end: '2026-05-08',
        closing_balance: 100, is_reconciled: 1 },
      { company_code: TEST_COMPANY, bank_code: 'BC010', period_start: '2026-05-01', period_end: '2026-05-15',
        closing_balance: 95, is_reconciled: 0 },
    ]);
    const r = await findExistingCycleRow(db, TEST_COMPANY, 'BC010','2026-05-01');
    expect(r?.period_end).toBe('2026-05-15');
    expect(r?.is_reconciled).toBe(0);
  });

  it('returns reconciled state correctly for is_reconciled=1', async () => {
    await db('bank_statement_imports').insert({
      company_code: TEST_COMPANY, bank_code: 'BC010', period_start: '2026-05-01',
      period_end: '2026-05-31', closing_balance: 90, is_reconciled: 1,
    });
    const r = await findExistingCycleRow(db, TEST_COMPANY, 'BC010','2026-05-01');
    expect(r?.is_reconciled).toBe(1);
  });
});

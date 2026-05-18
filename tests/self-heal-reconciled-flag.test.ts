/**
 * Regression tests for the silent self-heal pass.
 *
 * Verifies the data-flow invariant that drives the whole feature:
 *
 *   "Once a statement is reconciled to completion, Opera's
 *    nk_recbal == that statement's closing balance."
 *
 * Therefore: when Opera's nk_recbal matches exactly one unreconciled
 * SAM statement's closing, the statement IS reconciled — SAM should
 * silently flip is_reconciled=1 with no banner.
 *
 * Tests cover every safety condition so the auto-promote can never
 * produce a false positive.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import knexLib, { type Knex } from 'knex';
import { selfHealBalanceMatch } from '../src/services/self-heal-reconciled-flag.js';

const IMPORTS_SCHEMA = `CREATE TABLE bank_statement_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_code TEXT NOT NULL,
  statement_date DATE,
  closing_balance REAL,
  is_reconciled INTEGER DEFAULT 0,
  reconciled_count INTEGER DEFAULT 0,
  reconciled_at TEXT,
  reconciled_by TEXT,
  filename TEXT
)`;

const TXNS_SCHEMA = `CREATE TABLE bank_statement_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL,
  line_number INTEGER NOT NULL,
  post_date DATE NOT NULL,
  description TEXT,
  amount REAL NOT NULL,
  balance REAL,
  is_reconciled INTEGER DEFAULT 0
)`;

function makeFakeOperaDb(nkRecbal: number, bankExists = true): Knex {
  const builder = (table: string) => {
    if (table !== 'nbank') throw new Error(`unexpected table: ${table}`);
    const chain: any = {
      select: () => chain,
      where: () => chain,
      first: async () => (bankExists ? { reconciled_balance: nkRecbal } : undefined),
    };
    return chain;
  };
  (builder as any).raw = (sql: string) => sql;
  return builder as unknown as Knex;
}

async function makeAppDb(): Promise<Knex> {
  const db = knexLib({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  await db.raw(IMPORTS_SCHEMA);
  await db.raw(TXNS_SCHEMA);
  return db;
}

describe('selfHealBalanceMatch — silent auto-promote', () => {
  let appDb: Knex;

  beforeEach(async () => {
    appDb = await makeAppDb();
  });

  it('promotes the intsys BC010 scenario: exactly one unreconciled match', async () => {
    await appDb('bank_statement_imports').insert([
      { id: 24, bank_code: 'BC010', statement_date: '2026-04-17',
        closing_balance: 119822.40, is_reconciled: 1,
        reconciled_at: '2026-05-02T18:44:18', filename: '17-APR.pdf' },
      { id: 27, bank_code: 'BC010', statement_date: '2026-05-01',
        closing_balance: 115064.71, is_reconciled: 1,
        reconciled_at: '2026-05-05T13:19:51', filename: '01-MAY.pdf' },
      { id: 31, bank_code: 'BC010', statement_date: '2026-05-08',
        closing_balance: 125912.72, is_reconciled: 0,
        filename: '08-MAY.pdf' },
    ]);
    const result = await selfHealBalanceMatch(
      makeFakeOperaDb(125912.72),
      appDb,
      'BC010',
    );
    expect(result.promoted).toBe(true);
    expect(result.import_id).toBe(31);
    expect(result.closing_balance).toBe(125912.72);
    const row = await appDb('bank_statement_imports').where({ id: 31 }).first();
    expect(row.is_reconciled).toBe(1);
    expect(row.reconciled_by).toBe('sync-with-opera');
  });

  it('refuses to promote when Opera and SAM are already in sync', async () => {
    await appDb('bank_statement_imports').insert({
      id: 24, bank_code: 'BC010', statement_date: '2026-04-17',
      closing_balance: 119822.40, is_reconciled: 1,
      reconciled_at: '2026-05-02T18:44:18', filename: '17-APR.pdf',
    });
    const result = await selfHealBalanceMatch(
      makeFakeOperaDb(119822.40),
      appDb,
      'BC010',
    );
    expect(result.promoted).toBe(false);
    expect(result.reason).toBe('already_in_sync');
  });

  it('refuses to promote when no unreconciled SAM statement matches (Fork B)', async () => {
    await appDb('bank_statement_imports').insert({
      id: 24, bank_code: 'BC010', statement_date: '2026-04-17',
      closing_balance: 119822.40, is_reconciled: 1,
      reconciled_at: '2026-05-02T18:44:18', filename: '17-APR.pdf',
    });
    // Opera nk_recbal at a value SAM never saw.
    const result = await selfHealBalanceMatch(
      makeFakeOperaDb(999999.99),
      appDb,
      'BC010',
    );
    expect(result.promoted).toBe(false);
    expect(result.reason).toBe('no_matching_unreconciled_statement');
  });

  it('refuses to promote when multiple unreconciled statements share the closing (ambiguous)', async () => {
    await appDb('bank_statement_imports').insert([
      { id: 24, bank_code: 'BC010', statement_date: '2026-04-17',
        closing_balance: 119822.40, is_reconciled: 1,
        reconciled_at: '2026-05-02T18:44:18', filename: '17-APR.pdf' },
      { id: 31, bank_code: 'BC010', statement_date: '2026-05-08',
        closing_balance: 125912.72, is_reconciled: 0, filename: '08-MAY.pdf' },
      { id: 32, bank_code: 'BC010', statement_date: '2026-05-15',
        closing_balance: 125912.72, is_reconciled: 0, filename: '15-MAY.pdf' },
    ]);
    const result = await selfHealBalanceMatch(
      makeFakeOperaDb(125912.72),
      appDb,
      'BC010',
    );
    expect(result.promoted).toBe(false);
    expect(result.reason).toBe('ambiguous_multiple_matches');
    // Neither row should have been touched.
    const stillUnreconciled = await appDb('bank_statement_imports')
      .where('is_reconciled', 0)
      .count<{ c: number }[]>({ c: '*' })
      .first();
    expect(Number(stillUnreconciled?.c)).toBe(2);
  });

  it('refuses to promote when the matching statement is OLDER than SAM anchor', async () => {
    // SAM has 24-APR-26 reconciled. Opera nk_recbal happens to match
    // an OLDER unreconciled statement (17-APR-26 by accident — a
    // duplicate or coincidence). Auto-promote must refuse.
    await appDb('bank_statement_imports').insert([
      { id: 25, bank_code: 'BC010', statement_date: '2026-04-27',
        closing_balance: 116726.07, is_reconciled: 1,
        reconciled_at: '2026-05-02T19:23:48', filename: '24-APR.pdf' },
      { id: 24, bank_code: 'BC010', statement_date: '2026-04-17',
        closing_balance: 119822.40, is_reconciled: 0,
        filename: '17-APR-duplicate.pdf' },
    ]);
    const result = await selfHealBalanceMatch(
      makeFakeOperaDb(119822.40),
      appDb,
      'BC010',
    );
    expect(result.promoted).toBe(false);
    expect(result.reason).toBe('matching_statement_is_older');
  });

  it('refuses to promote when SAM is ahead of Opera (restore direction)', async () => {
    await appDb('bank_statement_imports').insert([
      { id: 24, bank_code: 'BC010', statement_date: '2026-04-17',
        closing_balance: 119822.40, is_reconciled: 1,
        reconciled_at: '2026-05-02T18:44:18', filename: '17-APR.pdf' },
    ]);
    // Opera rolled back to 50000 — far below SAM's most-recent
    // reconciled closing.
    const result = await selfHealBalanceMatch(
      makeFakeOperaDb(50000),
      appDb,
      'BC010',
    );
    expect(result.promoted).toBe(false);
    expect(result.reason).toBe('sam_ahead_of_opera');
  });

  it('returns bank_not_found when the bank does not exist in Opera', async () => {
    const result = await selfHealBalanceMatch(
      makeFakeOperaDb(0, false),
      appDb,
      'NOPE',
    );
    expect(result.promoted).toBe(false);
    expect(result.reason).toBe('bank_not_found');
  });

  it('honors a supplied user attribution', async () => {
    await appDb('bank_statement_imports').insert([
      { id: 24, bank_code: 'BC010', statement_date: '2026-04-17',
        closing_balance: 119822.40, is_reconciled: 1,
        reconciled_at: '2026-05-02T18:44:18', filename: '17-APR.pdf' },
      { id: 31, bank_code: 'BC010', statement_date: '2026-05-08',
        closing_balance: 125912.72, is_reconciled: 0, filename: '08-MAY.pdf' },
    ]);
    await selfHealBalanceMatch(
      makeFakeOperaDb(125912.72),
      appDb,
      'BC010',
      { user: 'harry' },
    );
    const row = await appDb('bank_statement_imports').where({ id: 31 }).first();
    expect(row.reconciled_by).toBe('harry');
  });
});

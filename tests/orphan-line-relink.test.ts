/**
 * Regression tests for the orphan-line repair tool.
 *
 * Reproduces the intsys-style data state: `bank_statement_transactions`
 * rows reference `import_id` values that don't exist in
 * `bank_statement_imports`. Verifies the repair tool can relink
 * them by period+balance match in the common case and refuses to
 * act in ambiguous cases.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import knexLib, { type Knex } from 'knex';
import { repairOrphanTransactionLinks } from '../src/services/orphan-line-relink.js';

const IMPORTS_SCHEMA = `CREATE TABLE bank_statement_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_code TEXT NOT NULL,
  statement_date DATE,
  period_start DATE,
  period_end DATE,
  closing_balance REAL,
  is_reconciled INTEGER DEFAULT 0,
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

async function makeDb(): Promise<Knex> {
  const db = knexLib({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  await db.raw(IMPORTS_SCHEMA);
  await db.raw(TXNS_SCHEMA);
  return db;
}

describe('orphan-line repair', () => {
  let db: Knex;

  beforeEach(async () => {
    db = await makeDb();
  });

  it('reports zero orphans when everything is linked', async () => {
    await db('bank_statement_imports').insert({
      id: 1, bank_code: 'BC010', statement_date: '2026-04-17',
      period_start: '2026-04-13', period_end: '2026-04-17',
      closing_balance: 119822.40, filename: '17-APR.pdf',
    });
    await db('bank_statement_transactions').insert([
      { import_id: 1, line_number: 1, post_date: '2026-04-13',
        amount: -100, balance: 119722.40 },
      { import_id: 1, line_number: 2, post_date: '2026-04-17',
        amount: 100, balance: 119822.40 },
    ]);
    const result = await repairOrphanTransactionLinks(db, 'BC010');
    expect(result.success).toBe(true);
    expect(result.orphan_groups).toEqual([]);
    expect(result.relinked_rows).toBe(0);
  });

  it('relinks orphans by closing-balance match within period bracket', async () => {
    // The intsys-style scenario: parent at id=24, orphan transactions
    // at import_id=67. Period brackets the orphan dates AND the
    // orphan's highest balance matches the parent's closing.
    await db('bank_statement_imports').insert({
      id: 24, bank_code: 'BC010', statement_date: '2026-04-17',
      period_start: '2026-04-13', period_end: '2026-04-17',
      closing_balance: 119822.40, filename: '17-APR.pdf',
    });
    await db('bank_statement_transactions').insert([
      { import_id: 67, line_number: 1, post_date: '2026-04-13',
        amount: -100, balance: 119722.40 },
      { import_id: 67, line_number: 2, post_date: '2026-04-17',
        amount: 100, balance: 119822.40 },
    ]);
    const result = await repairOrphanTransactionLinks(db, 'BC010');
    expect(result.success).toBe(true);
    expect(result.orphan_groups).toHaveLength(1);
    expect(result.orphan_groups[0]?.orphan_import_id).toBe(67);
    expect(result.orphan_groups[0]?.matched_parent_import_id).toBe(24);
    expect(result.orphan_groups[0]?.match_reason).toContain('closing_balance match');
    expect(result.relinked_groups).toBe(1);
    expect(result.relinked_rows).toBe(2);

    // Verify the rows are actually relinked
    const rows = await db('bank_statement_transactions')
      .select('id', 'import_id')
      .orderBy('id');
    expect(rows.every((r) => r.import_id === 24)).toBe(true);
  });

  it('dry-run reports intent without mutating', async () => {
    await db('bank_statement_imports').insert({
      id: 24, bank_code: 'BC010', statement_date: '2026-04-17',
      period_start: '2026-04-13', period_end: '2026-04-17',
      closing_balance: 119822.40,
    });
    await db('bank_statement_transactions').insert({
      import_id: 67, line_number: 1, post_date: '2026-04-15',
      amount: -50, balance: 119822.40,
    });
    const dryRun = await repairOrphanTransactionLinks(db, 'BC010', { dryRun: true });
    expect(dryRun.dry_run).toBe(true);
    expect(dryRun.relinked_rows).toBe(1);
    // Verify NOT actually changed
    const stillOrphan = await db('bank_statement_transactions')
      .where({ import_id: 67 }).count<{ c: number }[]>({ c: '*' }).first();
    expect(Number(stillOrphan?.c)).toBe(1);
  });

  it('refuses to relink when multiple parents share the same closing balance', async () => {
    // Two parent rows with the same closing balance — ambiguous.
    await db('bank_statement_imports').insert([
      { id: 24, bank_code: 'BC010', statement_date: '2026-04-17',
        period_start: '2026-04-13', period_end: '2026-04-17',
        closing_balance: 119822.40 },
      { id: 25, bank_code: 'BC010', statement_date: '2026-04-27',
        period_start: '2026-04-10', period_end: '2026-04-30',
        closing_balance: 119822.40 },
    ]);
    await db('bank_statement_transactions').insert({
      import_id: 67, line_number: 1, post_date: '2026-04-15',
      amount: -50, balance: 119822.40,
    });
    const result = await repairOrphanTransactionLinks(db, 'BC010');
    expect(result.orphan_groups[0]?.matched_parent_import_id).toBeNull();
    expect(result.orphan_groups[0]?.match_reason).toContain('ambiguous');
    expect(result.relinked_groups).toBe(0);
    expect(result.unmatched_groups).toBe(1);
  });

  it('falls back to unique period match when closing balance differs', async () => {
    await db('bank_statement_imports').insert({
      id: 24, bank_code: 'BC010', statement_date: '2026-04-17',
      period_start: '2026-04-13', period_end: '2026-04-17',
      closing_balance: 119822.40,
    });
    // Orphan dates fall in the period but the balance is different
    // (e.g. legacy data has a slightly different running balance)
    await db('bank_statement_transactions').insert({
      import_id: 67, line_number: 1, post_date: '2026-04-15',
      amount: -50, balance: 100000,
    });
    const result = await repairOrphanTransactionLinks(db, 'BC010');
    expect(result.orphan_groups[0]?.matched_parent_import_id).toBe(24);
    expect(result.orphan_groups[0]?.match_reason).toContain('unique period bracket');
  });

  it('handles the full intsys scenario — 3 orphan groups → 3 parents', async () => {
    await db('bank_statement_imports').insert([
      { id: 24, bank_code: 'BC010', statement_date: '2026-04-17',
        period_start: '2026-04-13', period_end: '2026-04-17',
        closing_balance: 119822.40, filename: '17-APR.pdf' },
      { id: 25, bank_code: 'BC010', statement_date: '2026-04-27',
        period_start: '2026-04-20', period_end: '2026-04-24',
        closing_balance: 116726.07, filename: '24-APR.pdf' },
      { id: 27, bank_code: 'BC010', statement_date: '2026-05-01',
        period_start: '2026-04-27', period_end: '2026-05-01',
        closing_balance: 115064.71, filename: '01-MAY.pdf' },
    ]);
    // Orphan groups matching each parent's period+balance
    const orphans = [
      ...Array.from({ length: 17 }, (_, i) => ({
        import_id: 67, line_number: i + 1, post_date: '2026-04-15',
        amount: -100, balance: i === 16 ? 119822.40 : 119722.40,
      })),
      ...Array.from({ length: 24 }, (_, i) => ({
        import_id: 68, line_number: i + 1, post_date: '2026-04-22',
        amount: -100, balance: i === 23 ? 116726.07 : 116626.07,
      })),
      ...Array.from({ length: 36 }, (_, i) => ({
        import_id: 71, line_number: i + 1, post_date: '2026-04-30',
        amount: -100, balance: i === 35 ? 115064.71 : 114964.71,
      })),
    ];
    await db('bank_statement_transactions').insert(orphans);
    const result = await repairOrphanTransactionLinks(db, 'BC010');
    expect(result.relinked_groups).toBe(3);
    expect(result.relinked_rows).toBe(17 + 24 + 36);
    expect(result.unmatched_groups).toBe(0);
    // 67→24, 68→25, 71→27
    const after = await db('bank_statement_transactions')
      .select('import_id')
      .countDistinct<{ d: number }[]>('import_id as d')
      .groupBy('import_id');
    const ids = (await db('bank_statement_transactions')
      .distinct<{ import_id: number }[]>('import_id'))
      .map((r) => r.import_id)
      .sort();
    expect(ids).toEqual([24, 25, 27]);
    expect(after).toBeDefined();
  });
});

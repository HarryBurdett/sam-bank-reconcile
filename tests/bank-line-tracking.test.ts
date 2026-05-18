/**
 * Tests for buildBankLineTracking — the shared lookup used by
 * preview-from-pdf and process-statement to learn per-line tracking
 * facts (posted_entry_number + is_reconciled) about bank lines this
 * SAM instance has imported before.
 *
 * Key behaviours exercised:
 *   - is_reconciled propagates from stored rows to the map entry
 *     ("anything reconciled is correct, leave it alone")
 *   - posted_entry_number propagates too (no regression of pre-existing
 *     behaviour)
 *   - ±7-day scope window keeps unrelated statements out
 *   - (date, amount) ambiguity sets count>1 and OR-merges flags
 *   - missing appDb / missing anchor → empty map (no-op fallback)
 *   - malformed anchor → empty map (no-op fallback)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import knexLib, { type Knex } from 'knex';
import {
  buildBankLineTracking,
  bankLineTrackingKey,
} from '../src/services/bank-line-tracking.js';

const IMPORTS_SCHEMA = `CREATE TABLE bank_statement_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_code TEXT NOT NULL,
  statement_date DATE,
  period_start DATE,
  period_end DATE
)`;

const TRANSACTIONS_SCHEMA = `CREATE TABLE bank_statement_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL,
  post_date DATE,
  amount REAL,
  description TEXT,
  posted_entry_number TEXT,
  is_reconciled INTEGER DEFAULT 0
)`;

async function makeDb(): Promise<Knex> {
  const db = knexLib({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  await db.raw(IMPORTS_SCHEMA);
  await db.raw(TRANSACTIONS_SCHEMA);
  return db;
}

async function seedImport(
  db: Knex,
  bankCode: string,
  statementDate: string,
): Promise<number> {
  const [id] = await db('bank_statement_imports').insert({
    bank_code: bankCode,
    statement_date: statementDate,
  });
  return id as number;
}

async function seedTxn(
  db: Knex,
  importId: number,
  postDate: string,
  amount: number,
  opts: { is_reconciled?: number; posted_entry_number?: string | null } = {},
): Promise<void> {
  await db('bank_statement_transactions').insert({
    import_id: importId,
    post_date: postDate,
    amount,
    is_reconciled: opts.is_reconciled ?? 0,
    posted_entry_number: opts.posted_entry_number ?? null,
  });
}

describe('buildBankLineTracking', () => {
  let db: Knex;

  beforeEach(async () => {
    db = await makeDb();
  });

  it('returns empty map when appDb is null', async () => {
    const m = await buildBankLineTracking({
      appDb: null,
      bankCode: 'BB005',
      scopeAnchor: '2026-05-18',
    });
    expect(m.size).toBe(0);
  });

  it('returns empty map when scopeAnchor is null', async () => {
    const m = await buildBankLineTracking({
      appDb: db,
      bankCode: 'BB005',
      scopeAnchor: null,
    });
    expect(m.size).toBe(0);
  });

  it('returns empty map when scopeAnchor is unparseable', async () => {
    const m = await buildBankLineTracking({
      appDb: db,
      bankCode: 'BB005',
      scopeAnchor: 'not-a-date',
    });
    expect(m.size).toBe(0);
  });

  it('propagates is_reconciled=true from stored rows', async () => {
    const impId = await seedImport(db, 'BB005', '2026-05-18');
    await seedTxn(db, impId, '2026-05-14', 100, {
      is_reconciled: 1,
      posted_entry_number: 'BR000123',
    });

    const m = await buildBankLineTracking({
      appDb: db,
      bankCode: 'BB005',
      scopeAnchor: '2026-05-18',
    });

    const entry = m.get(bankLineTrackingKey('2026-05-14', 100));
    expect(entry).toBeDefined();
    expect(entry?.is_reconciled).toBe(true);
    expect(entry?.posted_entry_number).toBe('BR000123');
    expect(entry?.count).toBe(1);
  });

  it('returns is_reconciled=false when the stored row is unreconciled', async () => {
    const impId = await seedImport(db, 'BB005', '2026-05-18');
    await seedTxn(db, impId, '2026-05-14', 100, { is_reconciled: 0 });

    const m = await buildBankLineTracking({
      appDb: db,
      bankCode: 'BB005',
      scopeAnchor: '2026-05-18',
    });

    const entry = m.get(bankLineTrackingKey('2026-05-14', 100));
    expect(entry?.is_reconciled).toBe(false);
  });

  it('excludes imports outside the ±7-day window', async () => {
    // Anchor 2026-05-18; window is 2026-05-11..2026-05-25.
    // statement_date 2026-04-30 is outside (>7 days before).
    const oldImp = await seedImport(db, 'BB005', '2026-04-30');
    await seedTxn(db, oldImp, '2026-04-29', 50, { is_reconciled: 1 });

    const inWindow = await seedImport(db, 'BB005', '2026-05-15');
    await seedTxn(db, inWindow, '2026-05-14', 100, { is_reconciled: 1 });

    const m = await buildBankLineTracking({
      appDb: db,
      bankCode: 'BB005',
      scopeAnchor: '2026-05-18',
    });

    expect(m.size).toBe(1);
    expect(m.get(bankLineTrackingKey('2026-05-14', 100))?.is_reconciled).toBe(true);
    expect(m.get(bankLineTrackingKey('2026-04-29', 50))).toBeUndefined();
  });

  it('excludes other banks', async () => {
    const imp = await seedImport(db, 'BC010', '2026-05-18');
    await seedTxn(db, imp, '2026-05-14', 100, { is_reconciled: 1 });

    const m = await buildBankLineTracking({
      appDb: db,
      bankCode: 'BB005', // different bank
      scopeAnchor: '2026-05-18',
    });
    expect(m.size).toBe(0);
  });

  it('counts duplicates and OR-merges flags when (date, amount) collides', async () => {
    const imp = await seedImport(db, 'BB005', '2026-05-18');
    await seedTxn(db, imp, '2026-05-14', 100, { is_reconciled: 0 });
    await seedTxn(db, imp, '2026-05-14', 100, { is_reconciled: 1 });

    const m = await buildBankLineTracking({
      appDb: db,
      bankCode: 'BB005',
      scopeAnchor: '2026-05-18',
    });

    const entry = m.get(bankLineTrackingKey('2026-05-14', 100));
    expect(entry?.count).toBe(2);
    // Reconciled flag OR-merges: callers must gate on count===1
    // before trusting it, but the map carries the union.
    expect(entry?.is_reconciled).toBe(true);
  });

  it('keeps the first non-empty posted_entry_number when colliding', async () => {
    const imp = await seedImport(db, 'BB005', '2026-05-18');
    await seedTxn(db, imp, '2026-05-14', 100, {
      posted_entry_number: 'BR000001',
    });
    await seedTxn(db, imp, '2026-05-14', 100, {
      posted_entry_number: 'BR000002',
    });

    const m = await buildBankLineTracking({
      appDb: db,
      bankCode: 'BB005',
      scopeAnchor: '2026-05-18',
    });

    const entry = m.get(bankLineTrackingKey('2026-05-14', 100));
    expect(entry?.count).toBe(2);
    // First non-empty value wins (existing behaviour preserved).
    expect(entry?.posted_entry_number).toBe('BR000001');
  });

  it('falls back to empty map on DB errors (best-effort)', async () => {
    // Tear down the table so the SELECT fails.
    await db.schema.dropTable('bank_statement_transactions');
    const m = await buildBankLineTracking({
      appDb: db,
      bankCode: 'BB005',
      scopeAnchor: '2026-05-18',
    });
    expect(m.size).toBe(0);
  });

  it('formats keys consistently via bankLineTrackingKey', () => {
    // Negative amounts and rounding both go through toFixed(2).
    expect(bankLineTrackingKey('2026-05-14', 100)).toBe('2026-05-14|100.00');
    expect(bankLineTrackingKey('2026-05-14', -42.5)).toBe('2026-05-14|-42.50');
    expect(bankLineTrackingKey('2026-05-14T12:00:00Z', 100)).toBe('2026-05-14|100.00');
  });

  it('honours a custom tolerance window', async () => {
    // Place an import 10 days before the anchor — outside the default
    // ±7d window but inside a 14-day override.
    const imp = await seedImport(db, 'BB005', '2026-05-08');
    await seedTxn(db, imp, '2026-05-07', 100, { is_reconciled: 1 });

    const tight = await buildBankLineTracking({
      appDb: db,
      bankCode: 'BB005',
      scopeAnchor: '2026-05-18',
    });
    expect(tight.size).toBe(0);

    const wide = await buildBankLineTracking({
      appDb: db,
      bankCode: 'BB005',
      scopeAnchor: '2026-05-18',
      toleranceDays: 14,
    });
    expect(wide.size).toBe(1);
    expect(wide.get(bankLineTrackingKey('2026-05-07', 100))?.is_reconciled).toBe(true);
  });
});

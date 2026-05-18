/**
 * Tests for postRecurringEntry — the service behind
 * POST /api/recurring-entries/post.
 *
 * Scope: validation, state checks, multi-line decline, batch wiring.
 * The single-line happy-path exercises the full Opera write machinery
 * (aentry + atran + ntran + anoml + stran/ptran + arhead advance),
 * which depends on MSSQL-specific schemas and the bank-import
 * executor's internals — that path is verified live against an Opera
 * SE instance, not via the in-memory sqlite harness used here.
 *
 * What we DO test in unit-test scope:
 *   - bank-code + entry-ref validation
 *   - entry not found for this bank
 *   - exhausted templates (ae_posted >= ae_topost) are refused
 *   - unsupported ae_type (e.g. 7) is refused with a clear message
 *   - multi-line entries (line_count > 1) are accepted and forwarded
 *     to postOperaCashbookEntry (the unified core helper)
 *   - missing posting date is refused
 *   - composite-key parsing (`REC0000002:2026-05-15`) extracts the
 *     date and uses it as the override
 *   - batch wrapper short-circuits on empty input and aggregates
 *     per-entry results otherwise
 */
import { describe, it, expect, beforeEach } from 'vitest';
import knexLib, { type Knex } from 'knex';
import {
  postRecurringEntry,
  postRecurringEntriesBatch,
} from '../src/services/post-recurring-entry.js';

const SCHEMA = [
  `CREATE TABLE arhead (
    ae_entry TEXT, ae_acnt TEXT, ae_type INTEGER, ae_desc TEXT,
    ae_freq TEXT, ae_every INTEGER, ae_nxtpost TEXT, ae_lstpost TEXT,
    ae_posted INTEGER, ae_topost INTEGER, ae_vatanal INTEGER
  )`,
  `CREATE TABLE arline (
    at_entry TEXT, at_acnt TEXT, at_line INTEGER, at_account TEXT,
    at_cbtype TEXT, at_value INTEGER, at_entref TEXT, at_comment TEXT,
    at_project TEXT, at_job TEXT, at_vatcde TEXT, at_vatval INTEGER
  )`,
];

async function makeDb(): Promise<Knex> {
  const db = knexLib({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  for (const s of SCHEMA) await db.raw(s);
  return db;
}

async function seedHead(
  db: Knex,
  row: Partial<{
    ae_entry: string;
    ae_acnt: string;
    ae_type: number;
    ae_desc: string;
    ae_freq: string;
    ae_every: number;
    ae_nxtpost: string;
    ae_posted: number;
    ae_topost: number;
  }>,
): Promise<void> {
  await db('arhead').insert({
    ae_entry: row.ae_entry,
    ae_acnt: row.ae_acnt,
    ae_type: row.ae_type ?? 5,
    ae_desc: row.ae_desc ?? '',
    ae_freq: row.ae_freq ?? 'M',
    ae_every: row.ae_every ?? 1,
    ae_nxtpost: row.ae_nxtpost ?? null,
    ae_lstpost: null,
    ae_posted: row.ae_posted ?? 0,
    ae_topost: row.ae_topost ?? 0,
    ae_vatanal: 0,
  });
}

async function seedLine(
  db: Knex,
  row: Partial<{
    at_entry: string;
    at_acnt: string;
    at_line: number;
    at_account: string;
    at_cbtype: string;
    at_value: number;
    at_entref: string;
    at_comment: string;
    at_vatcde: string;
    at_vatval: number;
  }>,
): Promise<void> {
  await db('arline').insert({
    at_entry: row.at_entry,
    at_acnt: row.at_acnt,
    at_line: row.at_line ?? 1,
    at_account: row.at_account ?? '',
    at_cbtype: row.at_cbtype ?? 'NP',
    at_value: row.at_value ?? 0,
    at_entref: row.at_entref ?? '',
    at_comment: row.at_comment ?? '',
    at_project: '',
    at_job: '',
    at_vatcde: row.at_vatcde ?? '',
    at_vatval: row.at_vatval ?? 0,
  });
}

describe('postRecurringEntry — validation + state checks', () => {
  let db: Knex;

  beforeEach(async () => {
    db = await makeDb();
  });

  it('refuses an invalid bank code', async () => {
    const r = await postRecurringEntry(db, {
      bankCode: 'not!valid',
      entryRef: 'REC0000002',
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/bank/i);
  });

  it('refuses an invalid entry ref', async () => {
    const r = await postRecurringEntry(db, {
      bankCode: 'BB005',
      entryRef: 'bad ref with spaces',
    });
    expect(r.success).toBe(false);
    // validateEntryNumber emits its own message; just confirm we
    // surface an error rather than crash.
    expect(r.error).toBeDefined();
  });

  it('refuses when arhead has no matching row', async () => {
    const r = await postRecurringEntry(db, {
      bankCode: 'BB005',
      entryRef: 'REC0000002',
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not found/i);
  });

  it('refuses when arhead exists but arline is empty', async () => {
    await seedHead(db, {
      ae_entry: 'REC0000002',
      ae_acnt: 'BB005',
      ae_type: 5,
      ae_nxtpost: '2026-05-15',
    });
    const r = await postRecurringEntry(db, {
      bankCode: 'BB005',
      entryRef: 'REC0000002',
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/no detail lines/i);
  });

  it('refuses exhausted templates (ae_posted >= ae_topost)', async () => {
    await seedHead(db, {
      ae_entry: 'REC0000002',
      ae_acnt: 'BB005',
      ae_type: 5,
      ae_nxtpost: '2026-05-15',
      ae_posted: 12,
      ae_topost: 12,
    });
    await seedLine(db, { at_entry: 'REC0000002', at_acnt: 'BB005', at_value: -10000 });
    const r = await postRecurringEntry(db, {
      bankCode: 'BB005',
      entryRef: 'REC0000002',
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/exhausted/i);
  });

  it('refuses unsupported ae_type (e.g. 7)', async () => {
    await seedHead(db, {
      ae_entry: 'REC0000003',
      ae_acnt: 'BB005',
      ae_type: 7, // outside the supported 1..6 range
      ae_nxtpost: '2026-05-15',
    });
    await seedLine(db, { at_entry: 'REC0000003', at_acnt: 'BB005', at_value: -10000 });
    const r = await postRecurringEntry(db, {
      bankCode: 'BB005',
      entryRef: 'REC0000003',
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/unsupported recurring entry type 7/i);
  });

  it('accepts multi-line entries (forwards to core helper)', async () => {
    await seedHead(db, {
      ae_entry: 'REC0000020',
      ae_acnt: 'BB005',
      ae_type: 1, // Nominal Payment, multi-line journal
      ae_nxtpost: '2026-05-15',
    });
    await seedLine(db, {
      at_entry: 'REC0000020',
      at_acnt: 'BB005',
      at_line: 1,
      at_account: 'N100',
      at_value: -10000,
    });
    await seedLine(db, {
      at_entry: 'REC0000020',
      at_acnt: 'BB005',
      at_line: 2,
      at_account: 'N200',
      at_value: -25000,
    });

    const r = await postRecurringEntry(db, {
      bankCode: 'BB005',
      entryRef: 'REC0000020',
    });
    // Multi-line is no longer declined; the helper now forwards to the
    // core posting function. In this sqlite test harness it'll fail at
    // some downstream insert (no full Opera schema), but the error
    // must NOT be the "multi-line" decline.
    expect(r.success).toBe(false);
    expect(r.error).not.toMatch(/multi-line/i);
    expect(r.error).not.toMatch(/post in opera/i);
  });

  it('refuses when there is no posting date (no nxtpost, no override, no composite-key date)', async () => {
    await seedHead(db, {
      ae_entry: 'REC0000040',
      ae_acnt: 'BB005',
      ae_type: 5,
      ae_nxtpost: null as any,
    });
    await seedLine(db, { at_entry: 'REC0000040', at_acnt: 'BB005', at_value: -10000 });
    const r = await postRecurringEntry(db, {
      bankCode: 'BB005',
      entryRef: 'REC0000040',
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/no posting date/i);
  });

  it('accepts a composite-key date as the implied override', async () => {
    // No ae_nxtpost; rely on the composite-key date to drive the post.
    // We expect this NOT to fail on the "no posting date" gate, but it
    // WILL fail later on control-account / writes against sqlite — so
    // we just assert the date-derivation didn't short-circuit too early.
    await seedHead(db, {
      ae_entry: 'REC0000050',
      ae_acnt: 'BB005',
      ae_type: 5,
      ae_nxtpost: null as any,
    });
    await seedLine(db, {
      at_entry: 'REC0000050',
      at_acnt: 'BB005',
      at_value: -10000,
      at_account: 'S001',
    });
    const r = await postRecurringEntry(db, {
      bankCode: 'BB005',
      entryRef: 'REC0000050:2026-05-15',
    });
    // It won't succeed in sqlite (no period_posting_decision tables,
    // no aentry, etc.) but the error should NOT be about a missing
    // posting date — that gate must have passed.
    expect(r.success).toBe(false);
    expect(r.error).not.toMatch(/no posting date/i);
  });
});

describe('postRecurringEntriesBatch', () => {
  let db: Knex;

  beforeEach(async () => {
    db = await makeDb();
  });

  it('rejects empty bank_code', async () => {
    const r = await postRecurringEntriesBatch(db, {
      bankCode: '',
      entries: [{ entry_ref: 'REC0000002' }],
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/bank_code/i);
  });

  it('rejects empty entries list', async () => {
    const r = await postRecurringEntriesBatch(db, {
      bankCode: 'BB005',
      entries: [],
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/no entries/i);
  });

  it('aggregates per-entry results across a multi-entry batch', async () => {
    await seedHead(db, {
      ae_entry: 'REC0000001',
      ae_acnt: 'BB005',
      ae_type: 5,
      ae_nxtpost: '2026-05-15',
      ae_posted: 12,
      ae_topost: 12, // exhausted
    });
    await seedLine(db, { at_entry: 'REC0000001', at_acnt: 'BB005', at_value: -100 });

    const r = await postRecurringEntriesBatch(db, {
      bankCode: 'BB005',
      entries: [
        { entry_ref: 'REC0000001' }, // will fail: exhausted
        { entry_ref: 'REC0009999' }, // will fail: not found
      ],
    });
    expect(r.results.length).toBe(2);
    expect(r.posted_count).toBe(0);
    expect(r.failed_count).toBe(2);
    // success=false because at least one failed AND none posted
    expect(r.success).toBe(false);
    expect(r.results[0]?.error).toMatch(/exhausted/i);
    expect(r.results[1]?.error).toMatch(/not found/i);
  });
});

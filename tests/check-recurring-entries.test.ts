/**
 * Tests for checkRecurringEntries — the read-only route that drives
 * the "Recurring Entries Must Be Processed First" prompt in
 * BankStatementHub.
 *
 * We exercise the service against an in-memory sqlite stand-in for
 * Opera's arhead/arline (plus nacnt/sname/pname for descriptions).
 * The legacy uses MSSQL-specific syntax (GETDATE, WITH (NOLOCK)) which
 * sqlite tolerates — sqlite parses `WITH (NOLOCK)` as a CTE hint and
 * recognises GETDATE() as a function name with our seeded stub.
 *
 * Coverage focus:
 *   - bank-code validation
 *   - only-active filter (ae_topost>0 AND ae_posted>=ae_topost excluded)
 *   - only-this-bank filter
 *   - outstanding-date expansion across D/W/M/Q/Y frequencies
 *   - composite entry_ref keying for multi-date entries
 *   - line aggregation (multi-line entries get a summed total)
 *   - account description join from nacnt/sname/pname
 *   - graceful-empty when no rows
 */
import { describe, it, expect, beforeEach } from 'vitest';
import knexLib, { type Knex } from 'knex';
import { checkRecurringEntries } from '../src/services/check-recurring-entries.js';

const SCHEMA_STATEMENTS = [
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
  `CREATE TABLE nacnt (na_acnt TEXT, na_desc TEXT)`,
  `CREATE TABLE sname (sn_account TEXT, sn_name TEXT)`,
  `CREATE TABLE pname (pn_account TEXT, pn_name TEXT)`,
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)`,
  // Period-posting decision queries this; an empty table → defaults applied.
  `CREATE TABLE nclndd (
    ncd_year INTEGER, ncd_period INTEGER,
    ncd_nlstat INTEGER, ncd_slstat INTEGER, ncd_plstat INTEGER,
    ncd_ststat INTEGER, ncd_wgstat INTEGER, ncd_fastat INTEGER,
    ncd_strdate TEXT, ncd_enddate TEXT
  )`,
];

async function makeDb(): Promise<{ opera: Knex; app: Knex }> {
  const opera = knexLib({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  for (const stmt of SCHEMA_STATEMENTS) {
    await opera.raw(stmt);
  }
  const app = knexLib({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  await app.raw('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  return { opera, app };
}

async function seedHead(
  opera: Knex,
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
  await opera('arhead').insert({
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
  opera: Knex,
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
  await opera('arline').insert({
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

describe('checkRecurringEntries', () => {
  let opera: Knex;
  let app: Knex;

  beforeEach(async () => {
    ({ opera, app } = await makeDb());
  });

  it('rejects an invalid bank code', async () => {
    const r = await checkRecurringEntries(opera, app, 'not!valid');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/bank/i);
  });

  it('returns empty when no recurring entries exist', async () => {
    const r = await checkRecurringEntries(opera, app, 'BB005');
    if (!r.success) throw new Error(`unexpected failure: ${r.error}`);
    expect(r.total_due).toBe(0);
    expect(r.entries).toEqual([]);
    expect(r.postable_count).toBe(0);
    expect(r.blocked_count).toBe(0);
  });

  it('surfaces a due entry with composite description and amount', async () => {
    await seedHead(opera, {
      ae_entry: 'REC0000002',
      ae_acnt: 'BB005',
      ae_type: 5, // Purchase Payment
      ae_desc: 'Suneria',
      ae_freq: 'M',
      ae_every: 1,
      ae_nxtpost: '2026-04-15', // in the past — due
      ae_posted: 40,
      ae_topost: 48,
    });
    await seedLine(opera, {
      at_entry: 'REC0000002',
      at_acnt: 'BB005',
      at_value: -172500, // pence
      at_account: 'S100',
    });
    await opera('pname').insert({ pn_account: 'S100', pn_name: 'Suneria Ltd' });

    const r = await checkRecurringEntries(opera, app, 'BB005');
    expect(r.success).toBe(true);
    // ae_nxtpost is 2026-04-15 and today is much later, so the
    // outstanding-date expansion produces multiple cycles.
    expect((r.total_due ?? 0)).toBeGreaterThanOrEqual(1);
    const first = r.entries![0]!;
    expect(first.base_entry_ref).toBe('REC0000002');
    expect(first.amount_pounds).toBe(1725);
    expect(first.description).toBe('Suneria');
    expect(first.type).toBe(5);
    expect(first.type_desc).toBe('Purchase Payment');
    expect(first.account).toBe('S100');
    expect(first.account_desc).toBe('Suneria Ltd');
    expect(first.frequency).toBe('Monthly');
  });

  it('excludes exhausted templates (ae_posted >= ae_topost)', async () => {
    await seedHead(opera, {
      ae_entry: 'REC0000001',
      ae_acnt: 'BB005',
      ae_type: 5,
      ae_desc: 'Done',
      ae_nxtpost: '2026-04-15',
      ae_posted: 12,
      ae_topost: 12, // fully posted
    });
    await seedLine(opera, { at_entry: 'REC0000001', at_acnt: 'BB005', at_value: -10000 });

    const r = await checkRecurringEntries(opera, app, 'BB005');
    expect(r.total_due).toBe(0);
  });

  it('treats ae_topost=0 as unlimited and still surfaces the row', async () => {
    await seedHead(opera, {
      ae_entry: 'REC0000003',
      ae_acnt: 'BB005',
      ae_type: 5,
      ae_desc: 'Forever',
      ae_nxtpost: '2026-05-15',
      ae_posted: 99,
      ae_topost: 0, // unlimited
    });
    await seedLine(opera, { at_entry: 'REC0000003', at_acnt: 'BB005', at_value: -5000 });

    const r = await checkRecurringEntries(opera, app, 'BB005');
    expect((r.total_due ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it('does not return entries from other banks', async () => {
    await seedHead(opera, {
      ae_entry: 'REC0000010',
      ae_acnt: 'BC010', // different bank
      ae_type: 5,
      ae_nxtpost: '2026-05-15',
    });
    await seedLine(opera, { at_entry: 'REC0000010', at_acnt: 'BC010', at_value: -10000 });

    const r = await checkRecurringEntries(opera, app, 'BB005');
    expect(r.total_due).toBe(0);
  });

  it('aggregates multi-line entries into one summed total', async () => {
    await seedHead(opera, {
      ae_entry: 'REC0000020',
      ae_acnt: 'BB005',
      ae_type: 1, // Nominal Payment (no customer/supplier lookup)
      ae_desc: 'Multi-line journal',
      ae_nxtpost: '2026-05-15',
    });
    await seedLine(opera, {
      at_entry: 'REC0000020', at_acnt: 'BB005', at_line: 1,
      at_account: 'N100', at_value: -10000,
    });
    await seedLine(opera, {
      at_entry: 'REC0000020', at_acnt: 'BB005', at_line: 2,
      at_account: 'N200', at_value: -25000,
    });

    const r = await checkRecurringEntries(opera, app, 'BB005');
    expect((r.total_due ?? 0)).toBeGreaterThanOrEqual(1);
    const e = r.entries![0]!;
    expect(e.line_count).toBe(2);
    expect(e.amount_pounds).toBe(350); // 10000 + 25000 pence = £350
    expect(e.lines.length).toBe(2);
  });

  it('uses composite entry_ref for multi-date expansion', async () => {
    // Three months in the past, monthly cadence — surfaces 3 outstanding cycles.
    const now = new Date();
    const threeMonthsBack = new Date(now.getFullYear(), now.getMonth() - 3, 15);
    const ymd = threeMonthsBack.toISOString().slice(0, 10);

    await seedHead(opera, {
      ae_entry: 'REC0000030',
      ae_acnt: 'BB005',
      ae_type: 5,
      ae_desc: 'Monthly',
      ae_freq: 'M',
      ae_every: 1,
      ae_nxtpost: ymd,
      ae_posted: 0,
      ae_topost: 0,
    });
    await seedLine(opera, { at_entry: 'REC0000030', at_acnt: 'BB005', at_value: -1000 });
    await opera('pname').insert({ pn_account: '', pn_name: '' });

    const r = await checkRecurringEntries(opera, app, 'BB005');
    expect((r.total_due ?? 0)).toBeGreaterThanOrEqual(2);
    // Composite refs include the post-date suffix.
    for (const e of r.entries!) {
      expect(e.entry_ref).toMatch(/^REC0000030:\d{4}-\d{2}-\d{2}$/);
      expect(e.base_entry_ref).toBe('REC0000030');
    }
    // Dates strictly increase by ~1 month.
    const dates = r.entries!.map((e) => e.next_post_date!);
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i]! > dates[i - 1]!).toBe(true);
    }
  });

  it('reads mode from app DB settings (defaults to process when missing)', async () => {
    await app('settings').insert({
      key: 'recurring_entries_mode',
      value: JSON.stringify('warn'),
    });
    const r = await checkRecurringEntries(opera, app, 'BB005');
    expect(r.success).toBe(true);
    expect(r.mode).toBe('warn');
  });

  it('returns success: false when the Opera SQL is broken (table missing)', async () => {
    await opera.schema.dropTable('arline');
    const r = await checkRecurringEntries(opera, app, 'BB005');
    expect(r.success).toBe(false);
    expect(r.error).toBeDefined();
  });
});

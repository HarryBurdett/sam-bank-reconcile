/**
 * Regression tests for the exact-amount rule in repeat-entry matching.
 *
 * Finance principle: amounts must match EXACTLY. £54.99 ≠ £55.00.
 * The legacy ±10p tolerance produced false positives like
 * "£54.99 Amazon purchase" being classified as a £55.00 monthly
 * subscription. This test pins the corrected behaviour.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import knexLib, { type Knex } from 'knex';
import { checkRepeatEntry } from '../src/services/check-repeat-entry.js';

// Minimal arhead/arline schema matching Opera SE column shapes.
const ARHEAD_SCHEMA = `CREATE TABLE arhead (
  ae_entry TEXT,
  ae_desc TEXT,
  ae_acnt TEXT,
  ae_nxtpost DATE,
  ae_freq TEXT,
  ae_every INTEGER,
  ae_posted INTEGER DEFAULT 0,
  ae_topost INTEGER DEFAULT 0
)`;
const ARLINE_SCHEMA = `CREATE TABLE arline (
  at_entry TEXT,
  at_acnt TEXT,
  at_value REAL,
  at_comment TEXT
)`;

async function makeOperaDb(): Promise<Knex> {
  const db = knexLib({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  await db.raw(ARHEAD_SCHEMA);
  await db.raw(ARLINE_SCHEMA);
  return db;
}

describe('checkRepeatEntry — exact-amount rule', () => {
  let opera: Knex;

  beforeEach(async () => {
    opera = await makeOperaDb();
  });

  it('does NOT match £54.99 Amazon to £55.00 Bounce repeat (1p mismatch)', async () => {
    // The intsys BC010 false-positive case verbatim.
    await opera('arhead').insert({
      ae_entry: 'REC0000053', ae_desc: 'Bounce HB', ae_acnt: 'BC010',
      ae_nxtpost: '2026-05-23', ae_freq: 'M', ae_every: 1,
      ae_posted: 2, ae_topost: 12,
    });
    await opera('arline').insert({
      at_entry: 'REC0000053', at_acnt: 'BC010',
      at_value: -5500,  // £55.00 in pence
      at_comment: 'Bounce',
    });

    const result = await checkRepeatEntry(opera, null, {
      bankCode: 'BC010',
      date: '2026-05-14',
      amountPounds: -54.99,  // bank line: £54.99 Amazon
      name: 'Card Payment to Amznmktplace*NA65L On 14 May',
      reference: '',
      memo: '',
    });

    expect(result.is_match).toBe(false);
    expect(result.match_kind).toBe('none');
  });

  it('DOES match £55.00 → £55.00 Bounce repeat (exact amount)', async () => {
    await opera('arhead').insert({
      ae_entry: 'REC0000053', ae_desc: 'Bounce HB', ae_acnt: 'BC010',
      ae_nxtpost: '2026-05-23', ae_freq: 'M', ae_every: 1,
      ae_posted: 2, ae_topost: 12,
    });
    await opera('arline').insert({
      at_entry: 'REC0000053', at_acnt: 'BC010',
      at_value: -5500,
      at_comment: 'Bounce',
    });

    const result = await checkRepeatEntry(opera, null, {
      bankCode: 'BC010',
      date: '2026-05-14',
      amountPounds: -55.00,
      name: 'Direct Debit to Bounce HB',
      reference: '',
      memo: '',
    });

    expect(result.is_match).toBe(true);
    expect(result.entry_ref).toBe('REC0000053');
    expect(result.match_kind).toBe('amount');
  });

  it('rejects reference-only match with wrong amount', async () => {
    // Description matches "AMAZON" but amount differs — would have
    // hit the legacy OR-branch but should now be rejected by the
    // amount-exact gate.
    await opera('arhead').insert({
      ae_entry: 'REC0000099', ae_desc: 'Amazon Web Services', ae_acnt: 'BC010',
      ae_nxtpost: '2026-05-15', ae_freq: 'M', ae_every: 1,
      ae_posted: 5, ae_topost: 12,
    });
    await opera('arline').insert({
      at_entry: 'REC0000099', at_acnt: 'BC010',
      at_value: -12345,  // £123.45 — totally different
      at_comment: 'AWS',
    });

    const result = await checkRepeatEntry(opera, null, {
      bankCode: 'BC010',
      date: '2026-05-14',
      amountPounds: -54.99,
      name: 'Card Payment to AMAZON Marketplace',
      reference: '',
      memo: '',
    });

    expect(result.is_match).toBe(false);
  });

  it('rejects amount-close-but-not-exact (the ±10p false-positive class)', async () => {
    await opera('arhead').insert({
      ae_entry: 'REC1', ae_desc: 'Subscription', ae_acnt: 'BC010',
      ae_nxtpost: '2026-05-20', ae_freq: 'M', ae_every: 1,
      ae_posted: 1, ae_topost: 12,
    });
    // Repeat at £10.00, bank txn at £10.05 (5p apart, was within
    // legacy 10p tolerance, must now reject).
    await opera('arline').insert({
      at_entry: 'REC1', at_acnt: 'BC010', at_value: -1000, at_comment: 'Sub',
    });

    const result = await checkRepeatEntry(opera, null, {
      bankCode: 'BC010',
      date: '2026-05-15',
      amountPounds: -10.05,
      name: 'Some payment',
      reference: '',
      memo: '',
    });
    expect(result.is_match).toBe(false);
  });

  it('matches at the exact integer-pence value with float-safe equality', async () => {
    // Opera returns at_value as float sometimes; verify equality still fires.
    await opera('arhead').insert({
      ae_entry: 'R', ae_desc: 'Test', ae_acnt: 'BC010',
      ae_nxtpost: '2026-05-20', ae_freq: 'M', ae_every: 1,
      ae_posted: 0, ae_topost: 12,
    });
    await opera('arline').insert({
      at_entry: 'R', at_acnt: 'BC010',
      at_value: -5499.0,  // explicitly a float
      at_comment: 'X',
    });
    const result = await checkRepeatEntry(opera, null, {
      bankCode: 'BC010',
      date: '2026-05-15',
      amountPounds: -54.99,
      name: 'X',
      reference: '',
      memo: '',
    });
    expect(result.is_match).toBe(true);
  });

  it('skips already-fully-posted repeat entries', async () => {
    // Repeat where ae_topost <= ae_posted — already fully posted.
    await opera('arhead').insert({
      ae_entry: 'DONE', ae_desc: 'Completed', ae_acnt: 'BC010',
      ae_nxtpost: '2026-05-20', ae_freq: 'M', ae_every: 1,
      ae_posted: 12, ae_topost: 12,
    });
    await opera('arline').insert({
      at_entry: 'DONE', at_acnt: 'BC010', at_value: -5499, at_comment: 'X',
    });
    const result = await checkRepeatEntry(opera, null, {
      bankCode: 'BC010',
      date: '2026-05-15',
      amountPounds: -54.99,
      name: 'X',
      reference: '',
      memo: '',
    });
    expect(result.is_match).toBe(false);
  });
});

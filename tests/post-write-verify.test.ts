/**
 * Tests for the multi-line extension of assertAentryAtran. The
 * existing single-line behaviour is covered indirectly by the
 * import-posting-executor regression suite; here we add narrow
 * coverage for the new expectedAtranCount parameter.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import knexLib, { type Knex } from 'knex';
import {
  assertAentryAtran,
  PostingVerificationError,
} from '../src/_shared/post-write-verify.js';

const SCHEMA = [
  `CREATE TABLE aentry (
    ae_entry TEXT, ae_acnt TEXT, ae_value INTEGER
  )`,
  `CREATE TABLE atran (
    at_entry TEXT, at_acnt TEXT, at_value INTEGER, at_pstdate TEXT,
    at_type INTEGER, at_refer TEXT
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

describe('assertAentryAtran multi-line', () => {
  let db: Knex;
  beforeEach(async () => {
    db = await makeDb();
  });

  it('accepts expectedAtranCount=2 with two matching atran rows', async () => {
    await db('aentry').insert({ ae_entry: 'E1', ae_acnt: 'BB005', ae_value: -350000 });
    await db('atran').insert({
      at_entry: 'E1', at_acnt: 'BB005', at_value: -100000,
      at_pstdate: '2026-05-15', at_type: 1, at_refer: 'REF',
    });
    await db('atran').insert({
      at_entry: 'E1', at_acnt: 'BB005', at_value: -250000,
      at_pstdate: '2026-05-15', at_type: 1, at_refer: 'REF',
    });

    await expect(
      assertAentryAtran(db, {
        entryNumber: 'E1',
        bankAccount: 'BB005',
        expectedSignedPence: -350000,
        expectedAtType: 1,
        expectedDate: '2026-05-15',
        expectedAtranCount: 2,
      }),
    ).resolves.not.toThrow();
  });

  it('rejects when atran count mismatches expectedAtranCount', async () => {
    await db('aentry').insert({ ae_entry: 'E1', ae_acnt: 'BB005', ae_value: -350000 });
    await db('atran').insert({
      at_entry: 'E1', at_acnt: 'BB005', at_value: -100000,
      at_pstdate: '2026-05-15', at_type: 1, at_refer: 'REF',
    });

    await expect(
      assertAentryAtran(db, {
        entryNumber: 'E1',
        bankAccount: 'BB005',
        expectedSignedPence: -350000,
        expectedAtType: 1,
        expectedDate: '2026-05-15',
        expectedAtranCount: 2,
      }),
    ).rejects.toThrow(PostingVerificationError);
  });

  it('rejects when atran row count is right but the sum is wrong', async () => {
    await db('aentry').insert({ ae_entry: 'E1', ae_acnt: 'BB005', ae_value: -350000 });
    // Two rows totalling -300000, not the expected -350000.
    await db('atran').insert({
      at_entry: 'E1', at_acnt: 'BB005', at_value: -100000,
      at_pstdate: '2026-05-15', at_type: 1, at_refer: 'REF',
    });
    await db('atran').insert({
      at_entry: 'E1', at_acnt: 'BB005', at_value: -200000,
      at_pstdate: '2026-05-15', at_type: 1, at_refer: 'REF',
    });

    await expect(
      assertAentryAtran(db, {
        entryNumber: 'E1',
        bankAccount: 'BB005',
        expectedSignedPence: -350000,
        expectedAtType: 1,
        expectedDate: '2026-05-15',
        expectedAtranCount: 2,
      }),
    ).rejects.toThrow(/Σatran/);
  });

  it('keeps default single-line behaviour when expectedAtranCount omitted', async () => {
    await db('aentry').insert({ ae_entry: 'E1', ae_acnt: 'BB005', ae_value: -100000 });
    await db('atran').insert({
      at_entry: 'E1', at_acnt: 'BB005', at_value: -100000,
      at_pstdate: '2026-05-15', at_type: 1, at_refer: 'REF',
    });

    await expect(
      assertAentryAtran(db, {
        entryNumber: 'E1',
        bankAccount: 'BB005',
        expectedSignedPence: -100000,
        expectedAtType: 1,
        expectedDate: '2026-05-15',
      }),
    ).resolves.not.toThrow();
  });
});

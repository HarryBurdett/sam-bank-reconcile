/**
 * Per-company isolation tests for bank-reconcile Phase B2 + B3 tables.
 *
 * Verifies migration 020 + service refactors keep the remaining
 * per-company tables properly isolated between Opera companies that
 * share one SAM-provisioned database. Covers a representative subset
 * of the highest-severity tables:
 *
 *   - bank_statement_imports + bank_statement_transactions: two
 *     companies can import statements with the same `bank_code` and
 *     never see each other's data.
 *   - alias_corrections + negative_aliases: correction audit + the
 *     "do not match" set are independent per company.
 *   - import_locks: the migration replaced a global UNIQUE on
 *     `bank_code` with composite (company_code, bank_code) — two
 *     companies must each be able to hold a lock on the same bank
 *     code at the same time. This is the whole point of the
 *     constraint change.
 *   - deferred_transactions: defer audit per company.
 *   - file_archive_log: archive log per company.
 *
 * Uses an in-memory SQLite DB with the real migrations applied — same
 * pattern as `tests/tier1-company-isolation.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import knex, { type Knex } from 'knex';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  recordCorrection,
  isNegativeMatch,
  listCorrections,
} from '../src/services/alias-corrections.js';
import {
  acquireImportLock,
  releaseImportLock,
} from '../src/services/import-lock.js';
import {
  recordDeferredTransaction,
  listDeferredItems,
  deleteDeferredItems,
} from '../src/services/deferred-items.js';
import {
  archiveFile,
  getArchiveHistory,
  type FileStorageAdapter,
} from '../src/services/archive.js';

const MIGRATIONS_DIR = path.resolve(__dirname, '../db/migrations');

async function makeDb(): Promise<Knex> {
  const db = knex({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  const files = (await fs.readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.ts') || f.endsWith('.js'))
    .sort();
  for (const file of files) {
    const mod = (await import(path.resolve(MIGRATIONS_DIR, file))) as {
      up: (k: Knex) => Promise<void>;
    };
    await mod.up(db);
  }
  return db;
}

/** Minimal file-storage stub for archiveFile tests. */
function makeStubStorage(): FileStorageAdapter {
  return {
    archive: async ({ sourcePath }) => ({
      archivePath: `/archive/${sourcePath.split('/').pop()}`,
    }),
    restore: async ({ originalPath }) => ({ restoredPath: originalPath }),
    listPending: async () => [],
  };
}

describe('bank-reconcile B2+B3 — per-company isolation', () => {
  let db: Knex;

  beforeEach(async () => {
    db = await makeDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  // ----------------------------------------------------------------
  // bank_statement_imports + bank_statement_transactions
  // ----------------------------------------------------------------

  it('statement imports: two companies can import statements with the same bank_code without leakage', async () => {
    // Both companies use bank_code 'BC010' (Opera bank codes happen
    // to collide across tenants in practice).
    const [cImportId] = await db('bank_statement_imports').insert({
      company_code: 'C',
      bank_code: 'BC010',
      statement_date: '2026-05-15',
      closing_balance: 100000,
      filename: 'cloudsis-may.pdf',
    });
    const [iImportId] = await db('bank_statement_imports').insert({
      company_code: 'I',
      bank_code: 'BC010',
      statement_date: '2026-05-15',
      closing_balance: 500000, // very different
      filename: 'intsys-may.pdf',
    });

    await db('bank_statement_transactions').insert({
      company_code: 'C',
      import_id: cImportId,
      line_number: 1,
      post_date: '2026-05-10',
      amount: 100,
      description: 'Cloudsis-only payment',
    });
    await db('bank_statement_transactions').insert({
      company_code: 'I',
      import_id: iImportId,
      line_number: 1,
      post_date: '2026-05-10',
      amount: 500,
      description: 'Intsys-only payment',
    });

    const cRows = await db('bank_statement_imports').where({
      company_code: 'C',
      bank_code: 'BC010',
    });
    const iRows = await db('bank_statement_imports').where({
      company_code: 'I',
      bank_code: 'BC010',
    });
    expect(cRows).toHaveLength(1);
    expect(iRows).toHaveLength(1);
    expect(Number(cRows[0]?.closing_balance)).toBe(100000);
    expect(Number(iRows[0]?.closing_balance)).toBe(500000);

    const cTxns = await db('bank_statement_transactions').where({
      company_code: 'C',
    });
    const iTxns = await db('bank_statement_transactions').where({
      company_code: 'I',
    });
    expect(cTxns[0]?.description).toBe('Cloudsis-only payment');
    expect(iTxns[0]?.description).toBe('Intsys-only payment');
  });

  // ----------------------------------------------------------------
  // alias_corrections + negative_aliases
  // ----------------------------------------------------------------

  it('alias_corrections: each company has its own correction audit log', async () => {
    await recordCorrection(db, 'C', {
      bank_name: 'Acme Direct Debit',
      wrong_account: 'WRONG_C',
      correct_account: 'CUST_C019',
      ledger_type: 'C',
    });
    await recordCorrection(db, 'I', {
      bank_name: 'Acme Direct Debit',
      wrong_account: 'WRONG_I',
      correct_account: 'CUST_I042',
      ledger_type: 'C',
    });

    const cList = await listCorrections(db, 'C');
    const iList = await listCorrections(db, 'I');
    expect(cList.count).toBe(1);
    expect(iList.count).toBe(1);
    expect(cList.entries[0]?.correct_account).toBe('CUST_C019');
    expect(iList.entries[0]?.correct_account).toBe('CUST_I042');
  });

  it('negative_aliases: composite UNIQUE allows the same (bank_name, wrong_account) across companies', async () => {
    // Cloudsis records: ACME → WRONG is a known mismatch.
    await recordCorrection(db, 'C', {
      bank_name: 'ACME',
      wrong_account: 'WRONG',
      correct_account: 'CUST_C019',
      ledger_type: 'C',
    });
    // Intsys independently records the same negative pair —
    // composite (company_code, bank_name, wrong_account) UNIQUE per
    // migration 020 must allow this.
    await recordCorrection(db, 'I', {
      bank_name: 'ACME',
      wrong_account: 'WRONG',
      correct_account: 'CUST_I042',
      ledger_type: 'C',
    });

    expect(await isNegativeMatch(db, 'C', 'ACME', 'WRONG')).toBe(true);
    expect(await isNegativeMatch(db, 'I', 'ACME', 'WRONG')).toBe(true);

    // The two rows live independently — neither company's negative
    // entry leaks across.
    const cNegs = await db('negative_aliases').where({ company_code: 'C' });
    const iNegs = await db('negative_aliases').where({ company_code: 'I' });
    expect(cNegs).toHaveLength(1);
    expect(iNegs).toHaveLength(1);
  });

  it('isNegativeMatch: returns false for a company that never recorded the pair', async () => {
    await recordCorrection(db, 'C', {
      bank_name: 'Cloudsis-only',
      wrong_account: 'WRONG',
      correct_account: 'X',
      ledger_type: 'C',
    });
    // Intsys never saw this — must return false.
    expect(await isNegativeMatch(db, 'I', 'Cloudsis-only', 'WRONG')).toBe(false);
  });

  // ----------------------------------------------------------------
  // import_locks — composite (company_code, bank_code) UNIQUE
  // ----------------------------------------------------------------

  it('import_locks: two companies can both hold a lock on the same bank_code', async () => {
    // The whole point of migration 020's UNIQUE change: pre-020, the
    // second acquire would FAIL with a global UNIQUE violation.
    const c = await acquireImportLock(db, 'C', 'BC010', {
      locked_by: 'cloudsis',
      endpoint: 'import',
    });
    const i = await acquireImportLock(db, 'I', 'BC010', {
      locked_by: 'intsys',
      endpoint: 'import',
    });
    expect(c).toBe(true);
    expect(i).toBe(true);

    const rows = await db('import_locks')
      .where({ bank_code: 'BC010' })
      .orderBy('company_code');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.company_code).sort()).toEqual(['C', 'I']);
  });

  it('import_locks: releasing one company\'s lock leaves the other intact', async () => {
    await acquireImportLock(db, 'C', 'BC010', { locked_by: 'cloudsis' });
    await acquireImportLock(db, 'I', 'BC010', { locked_by: 'intsys' });

    await releaseImportLock(db, 'C', 'BC010');

    const remaining = await db('import_locks').where({ bank_code: 'BC010' });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.company_code).toBe('I');
  });

  it('import_locks: same-company re-acquire of same bank_code is still refused', async () => {
    expect(await acquireImportLock(db, 'C', 'BC010', { locked_by: 'a' })).toBe(true);
    expect(await acquireImportLock(db, 'C', 'BC010', { locked_by: 'b' })).toBe(false);
  });

  // ----------------------------------------------------------------
  // deferred_transactions
  // ----------------------------------------------------------------

  it('deferred_transactions: each company has its own defer list', async () => {
    await recordDeferredTransaction(db, 'C', {
      bankCode: 'BC010',
      statementDate: '2026-05-15',
      amount: 100,
      description: 'Cloudsis defer',
      deferredBy: 'cloudsis-admin',
    });
    await recordDeferredTransaction(db, 'I', {
      bankCode: 'BC010',
      statementDate: '2026-05-15',
      amount: 500,
      description: 'Intsys defer',
      deferredBy: 'intsys-admin',
    });

    const cItems = await listDeferredItems(db, 'C', 'BC010');
    const iItems = await listDeferredItems(db, 'I', 'BC010');
    expect(cItems.items).toHaveLength(1);
    expect(iItems.items).toHaveLength(1);
    expect(cItems.items[0]?.description).toBe('Cloudsis defer');
    expect(iItems.items[0]?.description).toBe('Intsys defer');
  });

  it('deferred_transactions: bulk delete in one company never deletes another company\'s defers', async () => {
    const c = await recordDeferredTransaction(db, 'C', {
      bankCode: 'BC010',
      statementDate: '2026-05-15',
      amount: 100,
      description: 'C-only',
      deferredBy: 'admin',
    });
    await recordDeferredTransaction(db, 'I', {
      bankCode: 'BC010',
      statementDate: '2026-05-15',
      amount: 500,
      description: 'I-only',
      deferredBy: 'admin',
    });

    // Delete all C defers for this bank.
    const del = await deleteDeferredItems(db, 'C', 'BC010', [c.id!]);
    expect(del.deleted).toBe(1);

    const cAfter = await listDeferredItems(db, 'C', 'BC010');
    const iAfter = await listDeferredItems(db, 'I', 'BC010');
    expect(cAfter.items).toHaveLength(0);
    expect(iAfter.items).toHaveLength(1); // untouched
  });

  // ----------------------------------------------------------------
  // file_archive_log
  // ----------------------------------------------------------------

  it('file_archive_log: each company has its own archive history', async () => {
    const storage = makeStubStorage();
    await archiveFile(db, 'C', storage, {
      filePath: '/in/cloudsis-april.pdf',
      importType: 'bank-statement',
    });
    await archiveFile(db, 'I', storage, {
      filePath: '/in/intsys-april.pdf',
      importType: 'bank-statement',
    });

    const cHist = await getArchiveHistory(db, 'C', null);
    const iHist = await getArchiveHistory(db, 'I', null);
    expect(cHist.count).toBe(1);
    expect(iHist.count).toBe(1);
    expect(cHist.history?.[0]?.filename).toBe('cloudsis-april.pdf');
    expect(iHist.history?.[0]?.filename).toBe('intsys-april.pdf');
  });

  // ----------------------------------------------------------------
  // Empty-company-code refusal (fail-loud invariant)
  // ----------------------------------------------------------------

  it('throws on empty company code across all B2+B3 services', async () => {
    // companyScope() is invoked outside any try/catch in these services —
    // it must throw, not gracefully return success:false. That's the
    // fail-loud invariant from src/_shared/get-company.ts.
    await expect(
      recordCorrection(db, '', {
        bank_name: 'X',
        wrong_account: 'Y',
        correct_account: 'Z',
        ledger_type: 'C',
      }),
    ).rejects.toThrow(/empty company code/i);
    await expect(listCorrections(db, '')).rejects.toThrow(/empty company code/i);
    await expect(
      recordDeferredTransaction(db, '', {
        bankCode: 'BC010',
        statementDate: '2026-05-15',
        amount: 100,
        description: '',
        deferredBy: 'x',
      }),
    ).rejects.toThrow(/empty company code/i);
    await expect(listDeferredItems(db, '', 'BC010')).rejects.toThrow(
      /empty company code/i,
    );
    await expect(getArchiveHistory(db, '', null)).rejects.toThrow(
      /empty company code/i,
    );
  });
});

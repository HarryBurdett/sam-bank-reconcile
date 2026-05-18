/**
 * Regression tests for the bidirectional Opera-divergence recovery.
 *
 * Covers both directions of the recovery contract:
 *   - 'extra' (Opera ahead of SAM) — common when a SAM reconcile
 *     workflow completed but failed to flip is_reconciled=1 on
 *     the import row (silent UPDATE failure / missing import_id
 *     in the request). Recovery promotes the matching SAM row.
 *   - 'restore' (SAM ahead of Opera) — Opera DB was rolled back.
 *     Recovery clears stale is_reconciled flags after the anchor.
 *
 * Both paths are critical for the operator never getting stuck on
 * the "Opera reconciliation divergence" banner.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import knexLib, { type Knex } from 'knex';
import { recoverFromOperaDivergence } from '../src/services/reconciliation-status.js';

const APP_SCHEMA_IMPORTS = `CREATE TABLE bank_statement_imports (
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

const APP_SCHEMA_TXNS = `CREATE TABLE bank_statement_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL,
  line_number INTEGER NOT NULL,
  post_date DATE NOT NULL,
  description TEXT,
  amount REAL NOT NULL,
  balance REAL,
  transaction_type TEXT,
  reference TEXT,
  matched_entry TEXT,
  match_confidence REAL,
  match_type TEXT,
  is_reconciled INTEGER DEFAULT 0,
  posted_entry_number TEXT,
  posted_at TEXT
)`;

function makeFakeOperaDb(nkRecbal: number): Knex {
  // Minimal Knex-shaped mock — only the queries recoverFromOperaDivergence
  // actually issues need to work.
  const builder = (table: string) => {
    if (table !== 'nbank') {
      throw new Error(`unexpected table: ${table}`);
    }
    const chain: any = {
      select: () => chain,
      where: () => chain,
      first: async () => ({ reconciled_balance: nkRecbal }),
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
  await db.raw(APP_SCHEMA_IMPORTS);
  await db.raw(APP_SCHEMA_TXNS);
  return db;
}

describe('recoverFromOperaDivergence — bidirectional', () => {
  describe('"extra" direction — Opera ahead of SAM', () => {
    let appDb: Knex;

    beforeEach(async () => {
      appDb = await makeAppDb();
      // The intsys BC010 scenario: 3 statements correctly marked
      // is_reconciled=1, plus the 08-MAY-26 statement (id=31) that
      // got imported and posted to Opera but whose is_reconciled
      // flag never flipped.
      await appDb('bank_statement_imports').insert([
        { id: 24, bank_code: 'BC010', statement_date: '2026-04-17',
          closing_balance: 119822.40, is_reconciled: 1,
          reconciled_at: '2026-05-02T18:44:18', filename: '17-APR.pdf' },
        { id: 25, bank_code: 'BC010', statement_date: '2026-04-27',
          closing_balance: 116726.07, is_reconciled: 1,
          reconciled_at: '2026-05-02T19:23:48', filename: '24-APR.pdf' },
        { id: 27, bank_code: 'BC010', statement_date: '2026-05-01',
          closing_balance: 115064.71, is_reconciled: 1,
          reconciled_at: '2026-05-05T13:19:51', filename: '01-MAY.pdf' },
        { id: 31, bank_code: 'BC010', statement_date: '2026-05-08',
          closing_balance: 125912.72, is_reconciled: 0,
          filename: '08-MAY.pdf' },
      ]);
    });

    it('promotes the matching unreconciled statement to is_reconciled=1', async () => {
      const opera = makeFakeOperaDb(125912.72);
      const result = await recoverFromOperaDivergence(opera, appDb, 'BC010');
      expect(result.success).toBe(true);
      expect(result.direction).toBe('extra');
      expect(result.promoted).toBe(1);
      expect(result.cleared).toBe(0);
      expect(result.promoted_imports?.[0]?.import_id).toBe(31);
    });

    it('flips is_reconciled and sets reconciled_at on the matched row', async () => {
      const opera = makeFakeOperaDb(125912.72);
      await recoverFromOperaDivergence(opera, appDb, 'BC010');
      const row = await appDb('bank_statement_imports').where({ id: 31 }).first();
      expect(row.is_reconciled).toBe(1);
      expect(row.reconciled_at).not.toBeNull();
      expect(row.reconciled_by).toBe('sync-with-opera');
    });

    it('uses the supplied user when provided', async () => {
      const opera = makeFakeOperaDb(125912.72);
      await recoverFromOperaDivergence(opera, appDb, 'BC010', { user: 'harry' });
      const row = await appDb('bank_statement_imports').where({ id: 31 }).first();
      expect(row.reconciled_by).toBe('harry');
    });

    it('returns failure with diagnostic when no SAM statement matches', async () => {
      // Opera nk_recbal at a value SAM never saw
      const opera = makeFakeOperaDb(999999.99);
      const result = await recoverFromOperaDivergence(opera, appDb, 'BC010');
      expect(result.success).toBe(false);
      expect(result.direction).toBe('extra');
      expect(result.error).toContain('999999.99');
      expect(result.error).toContain('Opera Cashbook history');
    });

    it('returns success+0 when SAM and Opera already agree', async () => {
      // Opera matches SAM's most-recently-reconciled (id=24, 119822.40)
      await appDb('bank_statement_imports')
        .whereIn('id', [25, 27, 31])
        .delete();
      // Only id=24 remains reconciled at 119822.40.
      const opera = makeFakeOperaDb(119822.40);
      const result = await recoverFromOperaDivergence(opera, appDb, 'BC010');
      expect(result.success).toBe(true);
      expect(result.direction).toBe('none');
      expect(result.promoted).toBe(0);
      expect(result.cleared).toBe(0);
    });
  });

  describe('"restore" direction — SAM ahead of Opera', () => {
    let appDb: Knex;

    beforeEach(async () => {
      appDb = await makeAppDb();
      // All 4 statements are marked reconciled in SAM, but Opera
      // got rolled back to where the 24-APR statement was the
      // latest reconciled (nk_recbal=116726.07).
      await appDb('bank_statement_imports').insert([
        { id: 24, bank_code: 'BC010', statement_date: '2026-04-17',
          closing_balance: 119822.40, is_reconciled: 1,
          reconciled_at: '2026-05-02T18:44:18', filename: '17-APR.pdf' },
        { id: 25, bank_code: 'BC010', statement_date: '2026-04-27',
          closing_balance: 116726.07, is_reconciled: 1,
          reconciled_at: '2026-05-02T19:23:48', filename: '24-APR.pdf' },
        { id: 27, bank_code: 'BC010', statement_date: '2026-05-01',
          closing_balance: 115064.71, is_reconciled: 1,
          reconciled_at: '2026-05-05T13:19:51', filename: '01-MAY.pdf' },
        { id: 31, bank_code: 'BC010', statement_date: '2026-05-08',
          closing_balance: 125912.72, is_reconciled: 1,
          reconciled_at: '2026-05-15T09:00:00', filename: '08-MAY.pdf' },
      ]);
    });

    it('clears stale is_reconciled on statements after the anchor', async () => {
      const opera = makeFakeOperaDb(116726.07);
      const result = await recoverFromOperaDivergence(opera, appDb, 'BC010');
      expect(result.success).toBe(true);
      expect(result.direction).toBe('restore');
      expect(result.cleared).toBe(2); // id=27, id=31
      expect(result.promoted).toBeFalsy();
    });

    it('returns failure when Opera lands on a value SAM never saw', async () => {
      // 117000 — not equal to any SAM statement's closing
      const opera = makeFakeOperaDb(117000);
      const result = await recoverFromOperaDivergence(opera, appDb, 'BC010');
      expect(result.success).toBe(false);
      expect(result.direction).toBe('restore');
      expect(result.error).toContain('no SAM statement matches');
    });
  });
});

/**
 * Per-company settings isolation tests for bank-reconcile.
 *
 * Verifies the fix for the cross-company settings leak documented in
 * Jonathan's gocardless-multi-company-handoff.md (2026-06-09) — same
 * issue applies to every multi-company SAM plugin, not just
 * gocardless.
 *
 *   - Two Opera companies in the same SAM-provisioned database must
 *     keep separate `settings.recurring_entries_mode` and
 *     `settings.folder_settings` rows. Saving for one must never
 *     overwrite the other.
 *   - Loading with an empty / missing company code must FAIL LOUDLY
 *     (companyScope throws) — never silently fall through to
 *     "no filter" and return a random row.
 *   - Migration 018 + the new (companyCode) parameter on
 *     getRecurringEntriesMode / setRecurringEntriesMode /
 *     getFolderSettings / saveFolderSettings is what enforces this.
 *
 * Bank-reconcile is HIGHER severity than gocardless because settings
 * drive Opera writes (cashbook entries, reconciliation stamps).
 *
 * Uses an in-memory SQLite DB with the real migrations applied,
 * matching the migrations.test.ts pattern.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import knex, { type Knex } from 'knex';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  getRecurringEntriesMode,
  setRecurringEntriesMode,
} from '../src/services/settings.js';
import {
  getFolderSettings,
  saveFolderSettings,
} from '../src/services/folder-settings.js';

const MIGRATIONS_DIR = path.resolve(__dirname, '../db/migrations');

async function makeDb(): Promise<Knex> {
  const db = knex({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  // Apply every migration in lexical order — mirrors how the SAM
  // host's plugin migration runner does it.
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

describe('bank-reconcile settings — per-company isolation', () => {
  let db: Knex;

  beforeEach(async () => {
    db = await makeDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  // -------------------------------------------------------------
  // recurring_entries_mode
  // -------------------------------------------------------------

  it('recurring_entries_mode: save+load round-trips per company without cross-talk', async () => {
    await setRecurringEntriesMode(db, 'C', 'warn');
    await setRecurringEntriesMode(db, 'I', 'process');

    const cloudsis = await getRecurringEntriesMode(db, 'C');
    const intsys = await getRecurringEntriesMode(db, 'I');

    expect(cloudsis.mode).toBe('warn');
    expect(intsys.mode).toBe('process');
  });

  it('recurring_entries_mode: saving for one company never overwrites another', async () => {
    await setRecurringEntriesMode(db, 'C', 'warn');
    await setRecurringEntriesMode(db, 'I', 'process');
    // Cloudsis updates again — Intsys must be untouched.
    await setRecurringEntriesMode(db, 'C', 'process');

    expect((await getRecurringEntriesMode(db, 'I')).mode).toBe('process');
    expect((await getRecurringEntriesMode(db, 'C')).mode).toBe('process');
  });

  it('recurring_entries_mode: unconfigured company returns default, not another company data', async () => {
    await setRecurringEntriesMode(db, 'C', 'warn');

    // 'Z' has no row at all — must return default 'process', NOT 'warn'.
    const z = await getRecurringEntriesMode(db, 'Z');
    expect(z.mode).toBe('process');
  });

  it('recurring_entries_mode: throws on empty company code', async () => {
    await expect(getRecurringEntriesMode(db, '')).rejects.toThrow(
      /empty company code/i,
    );
    await expect(setRecurringEntriesMode(db, '', 'warn')).rejects.toThrow(
      /empty company code/i,
    );
  });

  // -------------------------------------------------------------
  // folder_settings
  // -------------------------------------------------------------

  it('folder_settings: save+load round-trips per company without cross-talk', async () => {
    await saveFolderSettings(db, 'C', {
      base_folder: '/data/cloudsis/bank',
      archive_folder: '/data/cloudsis/archive',
    });
    await saveFolderSettings(db, 'I', {
      base_folder: '/data/intsys/bank',
      archive_folder: '/data/intsys/archive',
    });

    const cloudsis = await getFolderSettings(db, 'C');
    const intsys = await getFolderSettings(db, 'I');

    expect(cloudsis.base_folder).toBe('/data/cloudsis/bank');
    expect(cloudsis.archive_folder).toBe('/data/cloudsis/archive');
    expect(intsys.base_folder).toBe('/data/intsys/bank');
    expect(intsys.archive_folder).toBe('/data/intsys/archive');
  });

  it('folder_settings: unconfigured company returns empty defaults, not another company data', async () => {
    await saveFolderSettings(db, 'C', {
      base_folder: '/data/cloudsis/bank',
      archive_folder: '/data/cloudsis/archive',
    });

    const z = await getFolderSettings(db, 'Z');
    expect(z.base_folder).toBe('');
    expect(z.archive_folder).toBe('');
    expect(z.folder_enabled).toBe(false);
  });

  it('folder_settings: throws on empty company code', async () => {
    await expect(getFolderSettings(db, '')).rejects.toThrow(
      /empty company code/i,
    );
    await expect(
      saveFolderSettings(db, '', { base_folder: '/leak', archive_folder: '' }),
    ).rejects.toThrow(/empty company code/i);
  });

  // -------------------------------------------------------------
  // Schema-level invariants from migration 018
  // -------------------------------------------------------------

  it('migration 018 enforces (key, company_code) composite uniqueness', async () => {
    await setRecurringEntriesMode(db, 'C', 'warn');
    await setRecurringEntriesMode(db, 'I', 'process');
    await saveFolderSettings(db, 'C', {
      base_folder: '/data/cloudsis/bank',
      archive_folder: '',
    });
    await saveFolderSettings(db, 'I', {
      base_folder: '/data/intsys/bank',
      archive_folder: '',
    });

    // Two recurring-mode rows (one per company) and two folder rows.
    const rows = await db('settings').select('key', 'company_code');
    const recurring = rows.filter(
      (r) => r.key === 'recurring_entries_mode',
    );
    const folder = rows.filter((r) => r.key === 'folder_settings');
    expect(recurring.map((r) => r.company_code).sort()).toEqual(['C', 'I']);
    expect(folder.map((r) => r.company_code).sort()).toEqual(['C', 'I']);
  });

  it('on-disk row count: settings table has exactly one row per (key, company)', async () => {
    // Update the same company three times — should still be one row.
    await setRecurringEntriesMode(db, 'C', 'warn');
    await setRecurringEntriesMode(db, 'C', 'process');
    await setRecurringEntriesMode(db, 'C', 'warn');

    const rows = await db('settings').where({
      key: 'recurring_entries_mode',
      company_code: 'C',
    });
    expect(rows).toHaveLength(1);
  });
});

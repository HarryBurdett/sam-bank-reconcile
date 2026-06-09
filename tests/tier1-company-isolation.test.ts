/**
 * Per-company isolation tests for bank-reconcile Phase B1 tables.
 *
 * Verifies migration 019 + service refactors keep:
 *   - bank_import_drafts
 *   - match_config
 *   - bank_import_aliases
 *
 * properly isolated between Opera companies sharing one SAM-provisioned
 * database. These three tables sit in the hot path of every
 * reconciliation; a leak here means one company's drafts / match
 * tuning / payee-customer mappings surface in another's UI and drive
 * the WRONG Opera company's writes.
 *
 * Uses an in-memory SQLite DB with the real migrations applied.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import knex, { type Knex } from 'knex';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  saveImportDraft,
  loadImportDraft,
  deleteImportDraft,
} from '../src/services/bank-import-drafts.js';
import {
  getMatchConfig,
  updateMatchConfig,
} from '../src/services/match-config.js';
import { lookupAlias, saveAlias } from '../src/services/bank-aliases.js';

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

describe('bank-reconcile tier-1 — per-company isolation', () => {
  let db: Knex;

  beforeEach(async () => {
    db = await makeDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  // ----------------------------------------------------------------
  // bank_import_drafts
  // ----------------------------------------------------------------

  it('drafts: two companies can hold their own drafts for the same statement key', async () => {
    const keyParts = {
      bankCode: 'BC010',
      source: 'email',
      emailId: 'email-1',
      attachmentId: 'att-1',
      pdfHash: 'sha256-deadbeef',
      filename: 'May-2026-statement.pdf',
    };

    const cloudsisInput = {
      ...keyParts,
      previewData: { rows: [{ desc: 'Cloudsis customer payment', amount: 100 }] },
      userEdits: null as Record<string, unknown> | null,
    };
    const intsysInput = {
      ...keyParts,
      previewData: { rows: [{ desc: 'Intsys customer payment', amount: 500 }] },
      userEdits: null as Record<string, unknown> | null,
    };

    const c = await saveImportDraft(db, 'C', cloudsisInput);
    const i = await saveImportDraft(db, 'I', intsysInput);
    expect(c.success).toBe(true);
    expect(i.success).toBe(true);

    const cLoad = await loadImportDraft(db, 'C', keyParts);
    const iLoad = await loadImportDraft(db, 'I', keyParts);

    expect(cLoad.draft?.preview_data.rows[0].desc).toBe(
      'Cloudsis customer payment',
    );
    expect(iLoad.draft?.preview_data.rows[0].desc).toBe(
      'Intsys customer payment',
    );
  });

  it('drafts: deleting one company\'s draft never touches another\'s', async () => {
    const keyParts = {
      bankCode: 'BC010',
      source: 'email',
      emailId: 'shared-email',
      attachmentId: 'shared-att',
      pdfHash: 'shared-hash',
      filename: 'shared-name.pdf',
    };
    await saveImportDraft(db, 'C', {
      ...keyParts,
      previewData: { rows: [{ tag: 'cloudsis' }] },
      userEdits: null,
    });
    await saveImportDraft(db, 'I', {
      ...keyParts,
      previewData: { rows: [{ tag: 'intsys' }] },
      userEdits: null,
    });

    await deleteImportDraft(db, 'C', keyParts);

    const cLoad = await loadImportDraft(db, 'C', keyParts);
    const iLoad = await loadImportDraft(db, 'I', keyParts);
    expect(cLoad.has_draft).toBe(false);
    expect(iLoad.has_draft).toBe(true);
    expect(iLoad.draft?.preview_data.rows[0].tag).toBe('intsys');
  });

  it('drafts: throws on empty company code', async () => {
    await expect(
      saveImportDraft(db, '', {
        bankCode: 'BC010',
        source: 'email',
        emailId: '',
        attachmentId: '',
        pdfHash: '',
        filename: 'leak.pdf',
        previewData: {},
        userEdits: null,
      }),
    ).rejects.toThrow(/empty company code/i);
  });

  // ----------------------------------------------------------------
  // match_config
  // ----------------------------------------------------------------

  it('match_config: each company has independent thresholds', async () => {
    await updateMatchConfig(db, 'C', {
      min_match_score: 0.7,
      learn_threshold: 0.9,
    });
    await updateMatchConfig(db, 'I', {
      min_match_score: 0.5,
      learn_threshold: 0.75,
    });

    const c = await getMatchConfig(db, 'C');
    const i = await getMatchConfig(db, 'I');

    expect(Number(c.config?.min_match_score)).toBeCloseTo(0.7, 2);
    expect(Number(i.config?.min_match_score)).toBeCloseTo(0.5, 2);
    expect(Number(c.config?.learn_threshold)).toBeCloseTo(0.9, 2);
    expect(Number(i.config?.learn_threshold)).toBeCloseTo(0.75, 2);
  });

  it('match_config: updating one company never overwrites another', async () => {
    await updateMatchConfig(db, 'C', { min_match_score: 0.7 });
    await updateMatchConfig(db, 'I', { min_match_score: 0.5 });
    await updateMatchConfig(db, 'C', { min_match_score: 0.9 });

    expect(Number((await getMatchConfig(db, 'I')).config?.min_match_score)).toBeCloseTo(
      0.5,
      2,
    );
    expect(Number((await getMatchConfig(db, 'C')).config?.min_match_score)).toBeCloseTo(
      0.9,
      2,
    );
  });

  it('match_config: throws on empty company code', async () => {
    await expect(getMatchConfig(db, '')).rejects.toThrow(
      /empty company code/i,
    );
    await expect(updateMatchConfig(db, '', { min_match_score: 0.5 })).rejects.toThrow(
      /empty company code/i,
    );
  });

  // ----------------------------------------------------------------
  // bank_import_aliases
  // ----------------------------------------------------------------

  it('aliases: each company learns its own payee → opera_account mapping', async () => {
    // Cloudsis learned: "ACME LIMITED" → C019
    await saveAlias(db, 'C', {
      bankCode: 'BC010',
      payeeName: 'ACME LIMITED',
      ledger: 'customer',
      operaAccount: 'C019',
      direction: 'receipt',
      matchScore: 0.95,
    });
    // Intsys learned: "ACME LIMITED" → I042 (same payee, different account)
    await saveAlias(db, 'I', {
      bankCode: 'BC010',
      payeeName: 'ACME LIMITED',
      ledger: 'customer',
      operaAccount: 'I042',
      direction: 'receipt',
      matchScore: 0.95,
    });

    const cLookup = await lookupAlias(db, 'C', 'ACME LIMITED', 'customer', 'BC010');
    const iLookup = await lookupAlias(db, 'I', 'ACME LIMITED', 'customer', 'BC010');

    expect(cLookup?.account).toBe('C019');
    expect(iLookup?.account).toBe('I042');
  });

  it('aliases: an unmatched payee in one company never falls through to another\'s match', async () => {
    await saveAlias(db, 'C', {
      bankCode: 'BC010',
      payeeName: 'CLOUDSIS ONLY PAYEE',
      ledger: 'customer',
      operaAccount: 'C100',
      direction: 'receipt',
      matchScore: 0.9,
    });

    // Intsys never learnt this payee — must return null, NOT Cloudsis's.
    const iLookup = await lookupAlias(
      db,
      'I',
      'CLOUDSIS ONLY PAYEE',
      'customer',
      'BC010',
    );
    expect(iLookup).toBeNull();
  });

  it('aliases: throws on empty company code', async () => {
    await expect(
      lookupAlias(db, '', 'ACME LIMITED', 'customer', 'BC010'),
    ).rejects.toThrow(/empty company code/i);
    await expect(
      saveAlias(db, '', {
        bankCode: 'BC010',
        payeeName: 'ACME LIMITED',
        ledger: 'customer',
        operaAccount: 'X100',
        direction: 'receipt',
        matchScore: 0.5,
      }),
    ).rejects.toThrow(/empty company code/i);
  });

  // ----------------------------------------------------------------
  // Schema-level invariants from migration 019
  // ----------------------------------------------------------------

  it('migration 019: bank_import_drafts UNIQUE includes company_code', async () => {
    // Same 6-column natural key for both companies should be ALLOWED.
    const keyParts = {
      bankCode: 'BC010',
      source: 'email',
      emailId: 'e1',
      attachmentId: 'a1',
      pdfHash: 'h1',
      filename: 'f1.pdf',
    };
    const c = await saveImportDraft(db, 'C', {
      ...keyParts,
      previewData: {},
      userEdits: null,
    });
    const i = await saveImportDraft(db, 'I', {
      ...keyParts,
      previewData: {},
      userEdits: null,
    });
    expect(c.success).toBe(true);
    expect(i.success).toBe(true);

    const rows = await db('bank_import_drafts').select('company_code');
    expect(rows.map((r) => r.company_code).sort()).toEqual(['C', 'I']);
  });

  it('migration 019: match_config UNIQUE prevents duplicate rows for the same company', async () => {
    await updateMatchConfig(db, 'C', { min_match_score: 0.7 });
    await updateMatchConfig(db, 'C', { min_match_score: 0.8 });
    await updateMatchConfig(db, 'C', { min_match_score: 0.9 });

    const rows = await db('match_config').where({ company_code: 'C' });
    expect(rows).toHaveLength(1);
  });
});

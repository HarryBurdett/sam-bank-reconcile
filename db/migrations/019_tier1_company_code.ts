/**
 * Migration 019 — add company_code to the three highest-severity
 * bank-reconcile per-company tables.
 *
 * Phase B1 of the per-company isolation rollout (see migration 018
 * for Phase A). These three tables sit in the hot path of every
 * reconciliation and directly influence what gets written to Opera:
 *
 *   - `bank_import_drafts`     held edits that become Opera writes
 *                              on commit. A leak here means one
 *                              company's draft surfaces in another's
 *                              UI and gets posted to the wrong
 *                              Opera company.
 *   - `match_config`           the matching algorithm config
 *                              (thresholds, phonetic, levenshtein,
 *                              n-gram). A leak silently shifts the
 *                              other company's match behaviour.
 *   - `bank_import_aliases`    payee → customer/supplier/nominal
 *                              mappings learnt from past imports.
 *                              A leak means every match in company
 *                              A pulls in B's learnt customer
 *                              account — by far the most dangerous
 *                              of the three for downstream Opera
 *                              writes.
 *
 * THIS MIGRATION
 * --------------
 * For each table:
 *   1. Add nullable `company_code` (string, 32).
 *   2. For tables that had a per-row UNIQUE (only bank_import_drafts
 *      currently), drop the existing UNIQUE and add a composite that
 *      includes company_code. Other tables get a fresh composite
 *      index on (company_code, <natural key>) for query performance.
 *
 * Pre-existing rows preserved with NULL `company_code` — the
 * companyScope() helper refuses to query NULL, so no normal request
 * can read them. A follow-up reassignment migration will stamp or
 * clear them.
 */
import type { Knex } from 'knex';

async function addCompanyCodeColumn(
  knex: Knex,
  table: string,
): Promise<void> {
  const has = await knex.schema.hasColumn(table, 'company_code');
  if (!has) {
    await knex.schema.alterTable(table, (t) => {
      t.string('company_code', 32);
    });
  }
}

export async function up(knex: Knex): Promise<void> {
  // ------------------------------------------------------------
  // bank_import_aliases — payee → opera_account learning table.
  // No pre-existing UNIQUE; just add the column + an index for
  // common-lookup performance (company_code, bank_code).
  // ------------------------------------------------------------
  await addCompanyCodeColumn(knex, 'bank_import_aliases');
  await knex.schema.alterTable('bank_import_aliases', (t) => {
    t.index(['company_code', 'bank_code'], 'ix_aliases_company_bank');
  });

  // ------------------------------------------------------------
  // match_config — one row per company. Add the column + a
  // composite UNIQUE on (company_code) so we can upsert by company
  // without ambiguity. NOTE: legacy single-row table; existing row
  // (if any) stays with NULL company_code.
  // ------------------------------------------------------------
  await addCompanyCodeColumn(knex, 'match_config');
  await knex.schema.alterTable('match_config', (t) => {
    t.unique(['company_code'], { indexName: 'ux_match_config_company' });
  });

  // ------------------------------------------------------------
  // bank_import_drafts — has a 6-column composite UNIQUE
  // (uq_bank_import_drafts_key from migration 006). Two companies
  // can in theory have the same (bank_code, source, email_id,
  // attachment_id, pdf_hash, filename) tuple — drop the old UNIQUE
  // and replace with a 7-column version including company_code.
  // ------------------------------------------------------------
  await addCompanyCodeColumn(knex, 'bank_import_drafts');
  try {
    await knex.schema.alterTable('bank_import_drafts', (t) => {
      t.dropUnique(
        ['bank_code', 'source', 'email_id', 'attachment_id', 'pdf_hash', 'filename'],
        'uq_bank_import_drafts_key',
      );
    });
  } catch {
    // Index may have been dropped out-of-band; proceed.
  }
  await knex.schema.alterTable('bank_import_drafts', (t) => {
    t.unique(
      [
        'company_code',
        'bank_code',
        'source',
        'email_id',
        'attachment_id',
        'pdf_hash',
        'filename',
      ],
      { indexName: 'uq_bank_import_drafts_company_key' },
    );
  });
}

export async function down(knex: Knex): Promise<void> {
  // Best-effort reverse. We leave company_code columns in place to
  // avoid losing data on a re-upgrade. Restoring the old single
  // UNIQUE on bank_import_drafts may fail if duplicates exist —
  // accept that downgrade leaves the table without the original
  // 6-column UNIQUE.
  try {
    await knex.schema.alterTable('bank_import_drafts', (t) => {
      t.dropUnique([], 'uq_bank_import_drafts_company_key');
    });
  } catch {
    /* index may not exist */
  }
  try {
    await knex.schema.alterTable('bank_import_drafts', (t) => {
      t.unique(
        ['bank_code', 'source', 'email_id', 'attachment_id', 'pdf_hash', 'filename'],
        { indexName: 'uq_bank_import_drafts_key' },
      );
    });
  } catch {
    /* duplicates may exist that prevent restoring the old UNIQUE */
  }

  try {
    await knex.schema.alterTable('match_config', (t) => {
      t.dropUnique([], 'ux_match_config_company');
    });
  } catch {
    /* index may not exist */
  }

  try {
    await knex.schema.alterTable('bank_import_aliases', (t) => {
      t.dropIndex([], 'ix_aliases_company_bank');
    });
  } catch {
    /* index may not exist */
  }
}

/**
 * Migration 020 — Phase B2+B3: add company_code to every remaining
 * per-company table in bank-reconcile.
 *
 * Builds on:
 *   - migration 014 (bank_import_patterns)
 *   - migration 018 (settings)
 *   - migration 019 (bank_import_drafts, match_config, bank_import_aliases)
 *
 * After this migration, every per-company table in bank-reconcile has
 * a `company_code` column. Service code can rely on companyScope()
 * everywhere without exception.
 *
 * Tables this migration touches:
 *   B2a — statement data + corrections (highest-severity, drives Opera writes):
 *     - bank_statement_imports
 *     - bank_statement_transactions
 *     - alias_corrections
 *
 *   B3 — remaining operator-facing tables:
 *     - deferred_transactions
 *     - repeat_entry_aliases
 *     - import_locks               (UNIQUE on bank_code → composite (company_code, bank_code))
 *     - ignored_bank_transactions
 *     - file_archive_log
 *     - duplicate_overrides
 *     - negative_aliases           (UNIQUE on (bank_name, wrong_account) → adds company_code)
 *     - extraction_cache
 *     - ai_suggestions
 *
 * Existing rows are preserved with NULL company_code. The companyScope()
 * helper refuses to query NULL, so no normal request reads them. A
 * follow-up reassignment migration may stamp or clear them later.
 *
 * SAFETY NOTE for UNIQUE/PRIMARY KEY changes
 * ------------------------------------------
 *  - `import_locks.bank_code` was UNIQUE — replaced with composite
 *    (company_code, bank_code). This is the only really hot one
 *    because two companies can use the same `bank_code` value (the
 *    Opera bank code string is per-company in practice but the
 *    constraint enforced global uniqueness, which is wrong for the
 *    multi-company model).
 *  - `negative_aliases` had UNIQUE on (bank_name, wrong_account) →
 *    extended with company_code. Same reasoning.
 *  - `extraction_cache.content_hash` is intentionally LEFT GLOBAL —
 *    PDF content hash is a true content-addressed cache key, not a
 *    per-company concept. Adding company_code is for filtering at
 *    read time, not for uniqueness.
 *  - `duplicate_overrides.transaction_hash` likewise stays globally
 *    UNIQUE — the hash is content-addressed.
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
  // ----------------------------------------------------------------
  // B2a — statement data + corrections (highest severity)
  // ----------------------------------------------------------------

  // bank_statement_imports — no existing UNIQUE; add column + index
  await addCompanyCodeColumn(knex, 'bank_statement_imports');
  await knex.schema.alterTable('bank_statement_imports', (t) => {
    t.index(['company_code', 'bank_code'], 'ix_bsi_company_bank');
  });

  // bank_statement_transactions — no existing UNIQUE; FK to imports.
  // Add column + index for the hot company-scoped scan path.
  await addCompanyCodeColumn(knex, 'bank_statement_transactions');
  await knex.schema.alterTable('bank_statement_transactions', (t) => {
    t.index('company_code', 'ix_bst_company');
  });

  // alias_corrections — no existing UNIQUE; indexes already on
  // bank_name + correct_account. Add column.
  await addCompanyCodeColumn(knex, 'alias_corrections');
  await knex.schema.alterTable('alias_corrections', (t) => {
    t.index(['company_code', 'bank_name'], 'ix_alias_corr_company_bank');
  });

  // ----------------------------------------------------------------
  // B3 — remaining operator-facing tables
  // ----------------------------------------------------------------

  // deferred_transactions — no UNIQUE; index already on bank_code.
  await addCompanyCodeColumn(knex, 'deferred_transactions');
  await knex.schema.alterTable('deferred_transactions', (t) => {
    t.index(['company_code', 'bank_code'], 'ix_deferred_company_bank');
  });

  // repeat_entry_aliases — no UNIQUE; just add column + index.
  await addCompanyCodeColumn(knex, 'repeat_entry_aliases');
  await knex.schema.alterTable('repeat_entry_aliases', (t) => {
    t.index(['company_code', 'bank_code'], 'ix_repeat_aliases_company_bank');
  });

  // import_locks — UNIQUE on bank_code is WRONG for multi-company.
  // Drop it, replace with composite (company_code, bank_code).
  await addCompanyCodeColumn(knex, 'import_locks');
  try {
    await knex.schema.alterTable('import_locks', (t) => {
      t.dropUnique(['bank_code']);
    });
  } catch {
    /* may already be dropped */
  }
  await knex.schema.alterTable('import_locks', (t) => {
    t.unique(['company_code', 'bank_code'], {
      indexName: 'ux_import_locks_company_bank',
    });
  });

  // ignored_bank_transactions — no UNIQUE; indexes on (bank_code, *).
  await addCompanyCodeColumn(knex, 'ignored_bank_transactions');
  await knex.schema.alterTable('ignored_bank_transactions', (t) => {
    t.index(['company_code', 'bank_code'], 'ix_ignored_company_bank');
  });

  // file_archive_log — no UNIQUE; indexes on archived_at + import_type.
  await addCompanyCodeColumn(knex, 'file_archive_log');
  await knex.schema.alterTable('file_archive_log', (t) => {
    t.index(['company_code', 'archived_at'], 'ix_file_log_company_archived');
  });

  // duplicate_overrides — has UNIQUE on transaction_hash (content-
  // addressed); leave that alone, just add column + index.
  await addCompanyCodeColumn(knex, 'duplicate_overrides');
  await knex.schema.alterTable('duplicate_overrides', (t) => {
    t.index('company_code', 'ix_dup_overrides_company');
  });

  // negative_aliases — has UNIQUE on (bank_name, wrong_account).
  // Drop it and replace with composite that includes company_code.
  await addCompanyCodeColumn(knex, 'negative_aliases');
  try {
    await knex.schema.alterTable('negative_aliases', (t) => {
      t.dropUnique(['bank_name', 'wrong_account'], 'uq_negative_aliases_pair');
    });
  } catch {
    /* may already be dropped */
  }
  await knex.schema.alterTable('negative_aliases', (t) => {
    t.unique(['company_code', 'bank_name', 'wrong_account'], {
      indexName: 'uq_negative_aliases_company_pair',
    });
  });

  // extraction_cache — has UNIQUE on content_hash (content-addressed,
  // intentionally global). Just add column.
  await addCompanyCodeColumn(knex, 'extraction_cache');

  // ai_suggestions — no UNIQUE; index on description_hash. Add column.
  await addCompanyCodeColumn(knex, 'ai_suggestions');
}

export async function down(knex: Knex): Promise<void> {
  // Best-effort reverse. Drops the new indexes / unique constraints
  // and leaves company_code columns in place (SQLite column drops
  // require a full table rebuild and aren't worth the risk in down).
  const dropMaybe = async (
    table: string,
    indexName: string,
    isUnique: boolean,
  ) => {
    try {
      await knex.schema.alterTable(table, (t) => {
        if (isUnique) {
          t.dropUnique([], indexName);
        } else {
          t.dropIndex([], indexName);
        }
      });
    } catch {
      /* index may not exist */
    }
  };

  await dropMaybe('bank_statement_imports', 'ix_bsi_company_bank', false);
  await dropMaybe('bank_statement_transactions', 'ix_bst_company', false);
  await dropMaybe('alias_corrections', 'ix_alias_corr_company_bank', false);
  await dropMaybe('deferred_transactions', 'ix_deferred_company_bank', false);
  await dropMaybe('repeat_entry_aliases', 'ix_repeat_aliases_company_bank', false);
  await dropMaybe('import_locks', 'ux_import_locks_company_bank', true);
  await dropMaybe('ignored_bank_transactions', 'ix_ignored_company_bank', false);
  await dropMaybe('file_archive_log', 'ix_file_log_company_archived', false);
  await dropMaybe('duplicate_overrides', 'ix_dup_overrides_company', false);
  await dropMaybe('negative_aliases', 'uq_negative_aliases_company_pair', true);

  // Restore old UNIQUEs (may fail if duplicates now exist — accept that)
  try {
    await knex.schema.alterTable('import_locks', (t) => {
      t.unique(['bank_code']);
    });
  } catch {
    /* duplicates may prevent restore */
  }
  try {
    await knex.schema.alterTable('negative_aliases', (t) => {
      t.unique(['bank_name', 'wrong_account'], {
        indexName: 'uq_negative_aliases_pair',
      });
    });
  } catch {
    /* duplicates may prevent restore */
  }
}

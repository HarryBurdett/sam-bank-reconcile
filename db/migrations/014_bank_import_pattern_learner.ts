/**
 * Migration 014 — extend bank_import_patterns with the columns the
 * legacy pattern learner writes.
 *
 * The original SAM table (migration 001) was a minimal stub:
 *   pattern, opera_account, confidence, match_count, updated_at.
 *
 * The legacy learner (sql_rag/bank_patterns.py:71) needs:
 *   company_code, description_raw, description_normalized,
 *   transaction_type, account_code, account_name, ledger_type,
 *   vat_code, nominal_code, net_amount_typical, times_used,
 *   first_used, last_used.
 *
 * We ADD those columns alongside the existing ones (rather than
 * replace) so legacy callers (health-check.ts:197, bank-aliases.ts)
 * continue to work unchanged. The unique index on
 * (company_code, description_normalized) gives the legacy
 * UPSERT-on-normalized-description semantic.
 */
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const addColumn = async (
    name: string,
    builder: (t: Knex.AlterTableBuilder) => void,
  ) => {
    if (!(await knex.schema.hasColumn('bank_import_patterns', name))) {
      await knex.schema.alterTable('bank_import_patterns', builder);
    }
  };

  await addColumn('company_code', (t) => t.string('company_code', 32));
  await addColumn('description_raw', (t) => t.text('description_raw'));
  await addColumn('description_normalized', (t) =>
    t.string('description_normalized', 400),
  );
  await addColumn('transaction_type', (t) => t.string('transaction_type', 32));
  await addColumn('account_code', (t) => t.string('account_code', 32));
  await addColumn('account_name', (t) => t.string('account_name', 200));
  await addColumn('ledger_type', (t) => t.string('ledger_type', 4));
  await addColumn('vat_code', (t) => t.string('vat_code', 8));
  await addColumn('nominal_code', (t) => t.string('nominal_code', 32));
  await addColumn('net_amount_typical', (t) =>
    t.decimal('net_amount_typical', 14, 2),
  );
  await addColumn('times_used', (t) => t.integer('times_used').defaultTo(0));
  await addColumn('first_used', (t) => t.string('first_used', 32));
  await addColumn('last_used', (t) => t.string('last_used', 32));

  // Legacy uniqueness is (company_code, description_normalized).
  // SQLite tolerates duplicates if either side is NULL, which is the
  // behaviour we want during the transition: SAM-original rows have
  // NULL company_code + NULL description_normalized so they don't
  // collide with new learner rows.
  await knex.schema.alterTable('bank_import_patterns', (t) => {
    t.unique(['company_code', 'description_normalized'], {
      indexName: 'ux_bank_import_patterns_company_desc',
    });
  });
}

export async function down(knex: Knex): Promise<void> {
  // Best-effort: drop the unique index. Column drops are skipped to
  // avoid losing existing rows; downgrading SAM-original behaviour
  // doesn't require column removal.
  try {
    await knex.schema.alterTable('bank_import_patterns', (t) => {
      t.dropUnique([], 'ux_bank_import_patterns_company_desc');
    });
  } catch {
    /* index may not exist on partially-downgraded DBs */
  }
}

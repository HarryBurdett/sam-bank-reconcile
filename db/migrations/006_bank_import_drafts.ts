/**
 * `bank_import_drafts` — work-in-progress state for bank statement
 * imports.
 *
 * Mirrors the SQLite schema in `api/email/storage.py:2724-2756` so
 * existing drafts can be migrated row-for-row from the legacy DB.
 *
 * Composite uniqueness on (bank_code, source, email_id, attachment_id,
 * pdf_hash, filename) — matches the ON CONFLICT clause of the legacy
 * INSERT. The Python columns email_id/attachment_id/pdf_hash are
 * stored as TEXT '' when null (so the unique-conflict semantic holds);
 * we replicate that with `defaultTo('')` and `notNullable()`.
 */
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('bank_import_drafts', (table) => {
    table.increments('id').primary();
    table.string('bank_code', 16).notNullable();
    table.string('source', 16).notNullable(); // 'email' or 'file'
    table.string('email_id', 64).notNullable().defaultTo('');
    table.string('attachment_id', 200).notNullable().defaultTo('');
    table.string('pdf_hash', 64).notNullable().defaultTo('');
    table.string('filename', 400).notNullable();
    table.text('preview_data'); // JSON
    table.text('user_edits'); // JSON
    table.string('target_system', 32).defaultTo('opera_se');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.unique(
      ['bank_code', 'source', 'email_id', 'attachment_id', 'pdf_hash', 'filename'],
      { indexName: 'uq_bank_import_drafts_key' },
    );
    table.index('bank_code');
    table.index('updated_at');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('bank_import_drafts');
}

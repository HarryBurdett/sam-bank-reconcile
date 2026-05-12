/**
 * Migration 010 — file archive log table.
 *
 * Replaces the on-disk JSON log used by Python's
 * `sql_rag/file_archive.py` with a per-app SQLite table. Storage of
 * the actual file bytes is handled by an adapter the SAM team
 * supplies; this table only tracks what was archived, when, and
 * whether it has been restored.
 */
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('file_archive_log', (table) => {
    table.increments('id').primary();
    table.timestamp('archived_at').defaultTo(knex.fn.now()).index();
    table.string('original_path', 1000).notNullable();
    table.string('archive_path', 1000).notNullable();
    table.string('import_type', 32).notNullable().index();
    table.string('filename', 500);
    table.text('metadata'); // JSON
    table.timestamp('restored_at');
    table.string('restored_to', 1000);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('file_archive_log');
}

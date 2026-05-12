/**
 * Add `endpoint` and `description` columns to import_locks so the
 * port of `sql_rag/import_lock.py` can record the same audit info
 * the Python version does.
 *
 * Migration 001 created the table without these columns. Adding them
 * here is non-breaking (the Python schema has them; we're catching up).
 */
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('import_locks', (table) => {
    table.string('endpoint', 64).defaultTo('unknown');
    table.text('description').defaultTo('');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('import_locks', (table) => {
    table.dropColumn('description');
    table.dropColumn('endpoint');
  });
}

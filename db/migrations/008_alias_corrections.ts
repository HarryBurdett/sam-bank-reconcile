/**
 * Tables for alias correction learning + negative-example storage.
 *
 * Mirrors the SQLite schema in `sql_rag/bank_aliases.py` so historic
 * data can be migrated row-for-row.
 *
 *   - alias_corrections — audit log of operator corrections
 *   - negative_aliases  — "bank_name should NOT match wrong_account"
 *
 * The primary alias storage (bank_import_aliases from migration 001)
 * already exists; this migration only adds the supporting correction
 * + negative tables.
 */
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('alias_corrections', (table) => {
    table.increments('id').primary();
    table.string('bank_name', 200).notNullable();
    table.string('wrong_account', 32);
    table.string('correct_account', 32);
    table.string('ledger_type', 4); // 'S' or 'C'
    table.string('corrected_by', 64).defaultTo('USER');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.index('bank_name');
    table.index('correct_account');
  });

  await knex.schema.createTable('negative_aliases', (table) => {
    table.increments('id').primary();
    table.string('bank_name', 200).notNullable();
    table.string('wrong_account', 32).notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.unique(['bank_name', 'wrong_account'], {
      indexName: 'uq_negative_aliases_pair',
    });
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('negative_aliases');
  await knex.schema.dropTableIfExists('alias_corrections');
}

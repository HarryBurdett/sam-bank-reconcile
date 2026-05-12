/**
 * Migration 012 — archived columns on bank_statement_imports.
 */
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('bank_statement_imports', 'archived_at'))) {
    await knex.schema.alterTable('bank_statement_imports', (table) => {
      table.timestamp('archived_at');
      table.string('archived_by', 64);
      table.integer('records_imported').defaultTo(0);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('bank_statement_imports', 'archived_at')) {
    await knex.schema.alterTable('bank_statement_imports', (table) => {
      table.dropColumn('records_imported');
      table.dropColumn('archived_by');
      table.dropColumn('archived_at');
    });
  }
}

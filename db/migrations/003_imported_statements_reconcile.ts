/**
 * Add reconciliation-tracking columns to bank_statement_imports.
 *
 * The base bank_statement_imports table from migration 001 holds the
 * import audit log. This migration adds the reconciliation-state
 * columns the Python implementation tracks (is_reconciled,
 * reconciled_count, target_system) so the
 * /api/statement-files/* endpoints can manage post-import workflow.
 */
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bank_statement_imports', (table) => {
    table.boolean('is_reconciled').defaultTo(false);
    table.integer('reconciled_count').defaultTo(0);
    table.string('target_system', 32).defaultTo('opera_se');
    table.timestamp('reconciled_at').nullable();
    table.string('filename', 500).nullable();
    table.index('is_reconciled');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bank_statement_imports', (table) => {
    table.dropColumn('is_reconciled');
    table.dropColumn('reconciled_count');
    table.dropColumn('target_system');
    table.dropColumn('reconciled_at');
    table.dropColumn('filename');
  });
}

/**
 * Migration 011 — deferred_transactions audit log.
 *
 * Tracks transactions the operator marked as 'defer' during a bank
 * import — they're not posted to Opera but are recorded so
 * Sequential Statement Gating can show 'imported' state on the
 * next scan. Faithful port of the SQLite schema in
 * `sql_rag/deferred_transactions.py`.
 */
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('deferred_transactions', (table) => {
    table.increments('id').primary();
    table.string('bank_code', 32).notNullable().index();
    table.date('statement_date');
    table.decimal('amount', 14, 2);
    table.string('description', 255);
    table.string('deferred_by', 64);
    table.timestamp('deferred_at').defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('deferred_transactions');
}

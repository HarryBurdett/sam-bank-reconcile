/**
 * Align `duplicate_overrides` schema with the canonical Python SQLite
 * schema in `apps/bank_reconcile/api/routes.py:2980-2988`.
 *
 * Migration 001 used a pared-down version of the table
 * (bank_code/amount/post_date/reference) that didn't match what the
 * legacy code reads/writes. The legacy schema is keyed by a
 * transaction hash, with override_reason + user_code metadata.
 *
 * Drops + recreates because nothing references the old schema yet
 * (greenfield).
 */
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('duplicate_overrides');
  await knex.schema.createTable('duplicate_overrides', (table) => {
    table.increments('id').primary();
    table.string('transaction_hash', 200).notNullable().unique();
    table.text('override_reason');
    table.string('user_code', 64);
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.index('user_code');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('duplicate_overrides');
  await knex.schema.createTable('duplicate_overrides', (table) => {
    table.increments('id').primary();
    table.string('bank_code', 16).notNullable();
    table.decimal('amount', 12, 2);
    table.date('post_date');
    table.string('reference', 200);
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });
}

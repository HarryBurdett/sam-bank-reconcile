/**
 * ignored_bank_transactions table — bank statement lines that the
 * operator marked as "already in Opera manually, don't reconcile to
 * me" (e.g. GoCardless receipts, internal transfers).
 *
 * Faithful port of the Python schema in core-email's email_data.db.
 * Under SAM, this table moves to the bank-reconcile per-app database.
 */
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('ignored_bank_transactions', (table) => {
    table.increments('id').primary();
    table.string('bank_code', 16).notNullable();
    table.date('transaction_date').notNullable();
    table.decimal('amount', 12, 2).notNullable();
    table.string('description', 500);
    table.string('reference', 200);
    table.text('reason');
    table.string('ignored_by', 64);
    table.timestamp('ignored_at').defaultTo(knex.fn.now());
    table.index(['bank_code', 'transaction_date']);
    table.index(['bank_code', 'amount']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('ignored_bank_transactions');
}

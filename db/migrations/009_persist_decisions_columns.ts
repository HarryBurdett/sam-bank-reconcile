/**
 * Add persist-decisions columns to bank_statement_imports.
 *
 * Migrations 001+003 covered the basics. The persist-decisions
 * endpoint (apps/bank_reconcile/api/routes.py:3406-3565) writes a
 * tracking row with these additional fields the legacy schema has:
 *   - transactions_imported (int, default 0)
 *   - total_receipts (decimal, default 0)
 *   - total_payments (decimal, default 0)
 *   - account_number (string)
 *   - sort_code (string)
 *   - period_start (date)
 *   - period_end (date)
 *   - reconciled_by (string)
 */
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bank_statement_imports', (table) => {
    table.integer('transactions_imported').defaultTo(0);
    table.decimal('total_receipts', 14, 2).defaultTo(0);
    table.decimal('total_payments', 14, 2).defaultTo(0);
    table.string('account_number', 32);
    table.string('sort_code', 16);
    table.date('period_start');
    table.date('period_end');
    table.string('reconciled_by', 64);
    table.index(['bank_code', 'period_start']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bank_statement_imports', (table) => {
    table.dropColumn('reconciled_by');
    table.dropColumn('period_end');
    table.dropColumn('period_start');
    table.dropColumn('sort_code');
    table.dropColumn('account_number');
    table.dropColumn('total_payments');
    table.dropColumn('total_receipts');
    table.dropColumn('transactions_imported');
  });
}

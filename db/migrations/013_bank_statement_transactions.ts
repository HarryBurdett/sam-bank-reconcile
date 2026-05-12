/**
 * SAM enhancement — per-line statement transaction tracking.
 *
 * Legacy's `bank_statement_transactions` table (in email_data.db)
 * stores one row per statement line with the Opera at_entry/ae_entry
 * reference it was posted to. SAM's bank-reconcile.db didn't have an
 * equivalent — only the per-statement `bank_statement_imports` table.
 *
 * Without per-line tracking, when Opera is restored to a backup
 * SAM can't detect which posted lines lost their Opera footprint.
 * This migration adds the table; the import flow + a new orphan-
 * check service populate and validate it.
 */
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('bank_statement_transactions', (table) => {
    table.increments('id').primary();
    table.integer('import_id').notNullable().index();
    table.integer('line_number').notNullable();
    table.date('post_date').notNullable();
    table.text('description');
    table.decimal('amount', 14, 2).notNullable();
    table.decimal('balance', 14, 2);
    table.string('transaction_type', 32);
    table.string('reference', 200);
    table.string('matched_entry', 64);
    table.decimal('match_confidence', 4, 2);
    table.string('match_type', 32);
    table.boolean('is_reconciled').defaultTo(false);
    /**
     * Opera `at_entry` / `ae_entry` the line was posted to. NULL when
     * not yet posted. Cleared by the orphan-check recovery when Opera
     * no longer has the entry.
     */
    table.string('posted_entry_number', 32);
    table.timestamp('posted_at');
    table.index(['import_id', 'line_number']);
    table.index('posted_entry_number');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('bank_statement_transactions');
}

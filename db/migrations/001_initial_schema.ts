/**
 * Initial schema for the bank-reconcile per-app database.
 *
 * Mirrors the per-company SQLite schemas in the Python implementation:
 *   - data/{company}/bank_reconcile/bank_aliases.db
 *   - data/{company}/bank_reconcile/bank_patterns.db
 *   - data/{company}/bank_reconcile/pdf_extraction_cache.db
 *   - data/{company}/bank_reconcile/import_locks.db
 *   - data/{company}/bank_reconcile/deferred_transactions.db
 */
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Settings — one row per tenant
  await knex.schema.createTable('settings', (table) => {
    table.increments('id').primary();
    table.string('key', 64).notNullable().unique();
    table.text('value');
    table.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  // Bank aliases — payee → customer/supplier/nominal mappings learned from imports
  await knex.schema.createTable('bank_import_aliases', (table) => {
    table.increments('id').primary();
    table.string('bank_code', 16).notNullable();
    table.string('payee_pattern', 200).notNullable();
    table.string('match_type', 16); // customer / supplier / nominal
    table.string('opera_account', 32);
    table.decimal('confidence', 4, 2);
    table.string('direction', 16); // receipt / payment / either
    table.integer('match_count').defaultTo(0);
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
    table.index(['bank_code', 'payee_pattern']);
    table.index('opera_account');
  });

  // Repeat-entry aliases (separate from main aliases — for recurring entries)
  await knex.schema.createTable('repeat_entry_aliases', (table) => {
    table.increments('id').primary();
    table.string('bank_code', 16).notNullable();
    table.string('memo_pattern', 200).notNullable();
    table.string('opera_repeat_ref', 64);
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // AI extraction suggestions
  await knex.schema.createTable('ai_suggestions', (table) => {
    table.increments('id').primary();
    table.string('description_hash', 64).notNullable();
    table.text('original_description');
    table.string('extracted_payee', 200);
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.index('description_hash');
  });

  // Duplicate-detection overrides (operator marks "this is NOT a duplicate")
  await knex.schema.createTable('duplicate_overrides', (table) => {
    table.increments('id').primary();
    table.string('bank_code', 16).notNullable();
    table.decimal('amount', 12, 2);
    table.date('post_date');
    table.string('reference', 200);
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // Pattern learning — generalised patterns built from successful imports
  await knex.schema.createTable('bank_import_patterns', (table) => {
    table.increments('id').primary();
    table.string('pattern', 200).notNullable();
    table.string('opera_account', 32);
    table.decimal('confidence', 4, 2);
    table.integer('match_count').defaultTo(0);
    table.timestamp('updated_at').defaultTo(knex.fn.now());
  });

  // PDF extraction cache (avoid re-extracting the same statement)
  await knex.schema.createTable('extraction_cache', (table) => {
    table.increments('id').primary();
    table.string('content_hash', 64).notNullable().unique();
    table.text('extraction_json');
    table.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // Import locks (per-bank to prevent concurrent imports corrupting nk_recbal)
  await knex.schema.createTable('import_locks', (table) => {
    table.increments('id').primary();
    table.string('bank_code', 16).notNullable().unique();
    table.string('locked_by', 64);
    table.timestamp('locked_at').defaultTo(knex.fn.now());
    table.timestamp('expires_at');
  });

  // Note: `deferred_transactions` is created by migration 011 with
  // its production schema (statement_date, deferred_by). The earlier
  // version sketched here had the wrong column shape and clashed with
  // 011 — removing it from 001 lets a fresh database apply both
  // migrations cleanly.

  // Statement history (which PDFs were imported, when, by whom)
  await knex.schema.createTable('bank_statement_imports', (table) => {
    table.increments('id').primary();
    table.string('bank_code', 16).notNullable();
    table.date('statement_date');
    table.decimal('opening_balance', 14, 2);
    table.decimal('closing_balance', 14, 2);
    table.string('source', 16); // 'email' | 'file'
    table.string('source_ref', 500);
    table.string('imported_by', 64);
    table.timestamp('imported_at').defaultTo(knex.fn.now());
    table.index(['bank_code', 'statement_date']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('bank_statement_imports');
  // deferred_transactions: dropped by migration 011's down()
  await knex.schema.dropTableIfExists('import_locks');
  await knex.schema.dropTableIfExists('extraction_cache');
  await knex.schema.dropTableIfExists('bank_import_patterns');
  await knex.schema.dropTableIfExists('duplicate_overrides');
  await knex.schema.dropTableIfExists('ai_suggestions');
  await knex.schema.dropTableIfExists('repeat_entry_aliases');
  await knex.schema.dropTableIfExists('bank_import_aliases');
  await knex.schema.dropTableIfExists('settings');
}

/**
 * match_config table for bank-import matching thresholds.
 *
 * Mirrors the SQLite schema embedded in
 * `sql_rag/bank_aliases.py::BankAliasManager._get_conn` (used by
 * GET/PUT `/api/bank-import/config`).
 *
 * Columns deliberately mirror the per-company SQLite schema so we can
 * do a straight migration of historic configs from the legacy DB.
 */
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('match_config', (table) => {
    table.increments('id').primary();
    table.decimal('min_match_score', 4, 2).defaultTo(0.6);
    table.decimal('learn_threshold', 4, 2).defaultTo(0.8);
    table.decimal('ambiguity_threshold', 4, 2).defaultTo(0.15);
    table.boolean('use_phonetic').defaultTo(true);
    table.boolean('use_levenshtein').defaultTo(true);
    table.boolean('use_ngram').defaultTo(true);
    table.timestamp('updated_at').defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('match_config');
}

/**
 * Drop the redundant `bank_statement_imports_bank_code_period_start_idx`
 * index introduced by migration 016.
 *
 * Migration 009 (`009_persist_decisions_columns.ts`) already creates an
 * auto-named index on `bank_statement_imports (bank_code, period_start)`
 * called `bank_statement_imports_bank_code_period_start_index` via
 * `table.index(['bank_code', 'period_start'])`. Migration 016 didn't
 * notice this and added a second physical index on the same columns
 * with a different name. SQLite was maintaining both B-trees on
 * every INSERT/UPDATE — pure overhead, no benefit.
 *
 * This migration drops the redundant `_idx` one. The
 * findExistingCycleRow helper uses the migration-009 `_index`
 * index transparently (SQLite's query planner doesn't care about
 * the name; the column tuple is what matters).
 *
 * Idempotent: `DROP INDEX IF EXISTS` is a no-op when the index
 * is already gone.
 */
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    `DROP INDEX IF EXISTS bank_statement_imports_bank_code_period_start_idx`,
  );
}

export async function down(_knex: Knex): Promise<void> {
  // No-op: re-creating the redundant index would just put us back
  // in the buggy state from migration 016.
}

/**
 * Add an index on `bank_statement_imports (bank_code, period_start)`
 * to make cycle-row lookups O(log N).
 *
 * A cycle = the set of pulls of a single calendar-month statement
 * from a cumulative bank (Monzo, Wise, some Tide configurations).
 * The cycle key is `(bank_code, period_start)`. On every Import
 * call, the import service looks up the existing cycle row and
 * UPDATEs it rather than INSERTing a duplicate. Without this
 * index, every Import call would do a full-table scan of
 * bank_statement_imports — fine for now (rows in the 100s) but
 * grows linearly.
 *
 * Idempotent: knex.schema.hasIndex doesn't exist as such, so we
 * check the index by name via sqlite_master before creating.
 */
import type { Knex } from 'knex';

const INDEX_NAME = 'bank_statement_imports_bank_code_period_start_idx';

export async function up(knex: Knex): Promise<void> {
  const client = (knex.client as { config?: { client?: string } }).config?.client;
  if (client !== 'sqlite3') return;

  const existing = (await knex.raw(
    `SELECT name FROM sqlite_master WHERE type='index' AND name=?`,
    [INDEX_NAME],
  )) as Array<{ name: string }>;
  if (existing.length > 0) return;

  await knex.raw(
    `CREATE INDEX ${INDEX_NAME}
       ON bank_statement_imports (bank_code, period_start)`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
}

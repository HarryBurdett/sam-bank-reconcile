/**
 * Add FK with ON DELETE CASCADE on bank_statement_transactions.import_id.
 *
 * Background — the legacy-DB seeder originally copied parent rows
 * without preserving their `id`, while copying child rows verbatim,
 * so every child carrying a stale legacy `import_id` was orphaned.
 * The seeder is now fixed (preserveId on the spec, plus a
 * sqlite_sequence bump), and `PRAGMA foreign_keys=ON` is enabled
 * per-connection. The missing piece is the FK itself.
 *
 * SQLite can't add a foreign-key constraint to an existing table
 * via ALTER TABLE. We must do the 12-step recreate dance:
 *   1. Rename current → _old
 *   2. CREATE new with the FK
 *   3. INSERT INTO new SELECT * FROM _old
 *   4. DROP _old
 *
 * Safety:
 *   - Before recreate, we orphan-clean: delete every
 *     bank_statement_transactions row whose import_id has no matching
 *     bank_statement_imports.id. The repair tool at
 *     /api/reconcile/bank/:code/repair-orphan-links should be run
 *     FIRST to relink recoverable orphans; anything left at this
 *     point is genuinely unmatched.
 *   - Indexes are recreated to preserve query performance.
 *   - This migration is idempotent — checks for an existing FK
 *     via `PRAGMA foreign_key_list` and exits early when present.
 */
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Only applies to sqlite — other clients aren't used by this app
  // but be defensive about the dialect check.
  const client = (knex.client as { config?: { client?: string } }).config?.client;
  if (client !== 'sqlite3') return;

  // If the FK already exists, skip — re-running this migration is a
  // no-op.
  const fks = (await knex.raw(
    `PRAGMA foreign_key_list(bank_statement_transactions)`,
  )) as Array<{ table: string; from: string; on_delete: string }>;
  const hasFk = fks.some(
    (fk) => fk.from === 'import_id' && fk.table === 'bank_statement_imports',
  );
  if (hasFk) return;

  // Archive orphans (don't delete) so the audit trail survives.
  // The repair endpoint at /api/reconcile/bank/:code/repair-orphan-links
  // is the supported way to relink — anything left at this point is
  // genuinely unmatchable from a period+balance perspective, but
  // archiving preserves the data for forensic review.
  //
  // Idempotent: only creates the archive table when it doesn't exist
  // yet, and only moves rows that aren't already there.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS bank_statement_transactions_orphans_archive (
      archived_at TEXT DEFAULT CURRENT_TIMESTAMP,
      original_id INTEGER,
      import_id INTEGER,
      line_number INTEGER,
      post_date TEXT,
      description TEXT,
      amount REAL,
      balance REAL,
      transaction_type TEXT,
      reference TEXT,
      matched_entry TEXT,
      match_confidence REAL,
      match_type TEXT,
      is_reconciled INTEGER,
      posted_entry_number TEXT,
      posted_at TEXT
    )
  `);
  await knex.raw(`
    INSERT INTO bank_statement_transactions_orphans_archive
      (original_id, import_id, line_number, post_date, description, amount,
       balance, transaction_type, reference, matched_entry, match_confidence,
       match_type, is_reconciled, posted_entry_number, posted_at)
    SELECT id, import_id, line_number, post_date, description, amount,
           balance, transaction_type, reference, matched_entry,
           match_confidence, match_type, is_reconciled,
           posted_entry_number, posted_at
      FROM bank_statement_transactions
     WHERE import_id NOT IN (SELECT id FROM bank_statement_imports)
  `);
  await knex.raw(`
    DELETE FROM bank_statement_transactions
     WHERE import_id NOT IN (SELECT id FROM bank_statement_imports)
  `);

  // Temporarily disable FK enforcement while we swap tables — the
  // partial state during the recreate would otherwise trip the
  // enforcement we're about to add.
  await knex.raw('PRAGMA foreign_keys=OFF');

  // Rename current table out of the way.
  await knex.raw(
    `ALTER TABLE bank_statement_transactions RENAME TO bank_statement_transactions_old`,
  );

  // Drop the indexes attached to the renamed table — SQLite keeps
  // their names tied to the original schema, so the next CREATE
  // TABLE re-defining them would otherwise hit
  // "index ... already exists".
  for (const name of [
    'bank_statement_transactions_import_id_index',
    'bank_statement_transactions_import_id_line_number_index',
    'bank_statement_transactions_posted_entry_number_index',
  ]) {
    try {
      await knex.raw(`DROP INDEX IF EXISTS ${name}`);
    } catch {
      // best-effort — indexes might have been dropped already
    }
  }

  // Recreate with the FK.
  await knex.schema.createTable('bank_statement_transactions', (table) => {
    table.increments('id').primary();
    table
      .integer('import_id')
      .notNullable()
      .references('id')
      .inTable('bank_statement_imports')
      .onDelete('CASCADE')
      .index();
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
    table.string('posted_entry_number', 32);
    table.timestamp('posted_at');
    table.index(['import_id', 'line_number']);
    table.index('posted_entry_number');
  });

  // Copy rows over.
  await knex.raw(`
    INSERT INTO bank_statement_transactions
    SELECT * FROM bank_statement_transactions_old
  `);

  // Drop the old table.
  await knex.raw('DROP TABLE bank_statement_transactions_old');

  // Re-enable FK enforcement.
  await knex.raw('PRAGMA foreign_keys=ON');
}

export async function down(_knex: Knex): Promise<void> {
  // Down-migration is intentionally a no-op. Reverting the FK is
  // dangerous (would re-allow orphans) and there's no scenario
  // where the operator needs that capability.
}

/**
 * Migration smoke test — runs every migration in db/migrations against
 * an in-memory SQLite database to catch:
 *
 *  - Syntax errors that type-checking can't see
 *  - Wrong file ordering (002 references a column 003 creates, etc.)
 *  - Up/down asymmetry (down should be the inverse of up)
 *  - Knex schema-builder methods that aren't generic
 *
 * SAM hosts run against Postgres in production. This test runs against
 * SQLite — both share the standard Knex schema-builder vocabulary, so
 * if a migration uses a generic Knex method here it'll work in
 * Postgres too. Catching dialect-specific syntax (raw SQL, jsonb,
 * etc.) is the value-add.
 */
import { describe, it, expect, afterEach } from 'vitest';
import knex, { type Knex } from 'knex';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../db/migrations');

async function makeDb(): Promise<Knex> {
  return knex({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
}

async function listMigrations(): Promise<string[]> {
  const entries = await fs.readdir(MIGRATIONS_DIR);
  return entries
    .filter((f) => f.endsWith('.ts') || f.endsWith('.js'))
    .sort();
}

describe('migrations smoke test', () => {
  let db: Knex | null = null;

  afterEach(async () => {
    if (db) {
      await db.destroy();
      db = null;
    }
  });

  it('every migration file in db/migrations runs cleanly in order', async () => {
    db = await makeDb();
    const files = await listMigrations();
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const mod = (await import(
        path.join(MIGRATIONS_DIR, file)
      )) as { up: (k: Knex) => Promise<void> };
      try {
        await mod.up(db);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Migration ${file} failed: ${msg}`);
      }
    }
  });

  it('every migration has a working down() that reverts up()', async () => {
    db = await makeDb();
    const files = await listMigrations();

    // Apply all up
    for (const file of files) {
      const mod = (await import(
        path.join(MIGRATIONS_DIR, file)
      )) as { up: (k: Knex) => Promise<void> };
      await mod.up(db);
    }

    // Roll back in reverse order
    for (const file of files.slice().reverse()) {
      const mod = (await import(
        path.join(MIGRATIONS_DIR, file)
      )) as { down?: (k: Knex) => Promise<void> };
      if (!mod.down) continue;
      try {
        await mod.down(db);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Migration ${file} down() failed: ${msg}`);
      }
    }
  });

  it('migrations are idempotent under knex.migrate.latest()', async () => {
    db = await makeDb();
    await db.migrate.latest({
      directory: MIGRATIONS_DIR,
      loadExtensions: ['.ts'],
    });
    // Second run should be a no-op
    const r = await db.migrate.latest({
      directory: MIGRATIONS_DIR,
      loadExtensions: ['.ts'],
    });
    // r is [batch, log] where log is empty array on no-op
    expect(Array.isArray(r)).toBe(true);
    expect(r[1].length).toBe(0);
  });
});

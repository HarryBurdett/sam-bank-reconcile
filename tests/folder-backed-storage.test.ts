import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import knex, { type Knex } from 'knex';
import {
  createFolderBackedFileStorage,
  createFolderBackedPdfContentReader,
} from '../src/services/folder-backed-storage.js';

const TEST_COMPANY = 'C';

let db: Knex;
let root: string;

beforeEach(async () => {
  db = knex({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  await db.schema.createTable('settings', (t) => {
    t.increments('id').primary();
    t.string('key', 64).notNullable();
    t.string('company_code', 1).notNullable().defaultTo('');
    t.text('value');
    t.unique(['key', 'company_code']);
  });
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'fbs-'));
});

afterEach(async () => {
  await db.destroy();
  await fs.rm(root, { recursive: true, force: true });
});

async function setBaseFolder(folder: string | null) {
  await db('settings').delete();
  if (folder) {
    await db('settings').insert({
      key: 'folder_settings',
      company_code: TEST_COMPANY,
      value: JSON.stringify({ base_folder: folder, archive_folder: '' }),
    });
  }
}

describe('createFolderBackedFileStorage', () => {
  it('returns empty list when folder_settings is unset', async () => {
    const storage = createFolderBackedFileStorage(() => db, TEST_COMPANY);
    const r = await storage.listPending('bank-statement');
    expect(r).toEqual([]);
  });

  it('reads files from the configured base_folder', async () => {
    await fs.writeFile(path.join(root, 'a.pdf'), 'pdf');
    await setBaseFolder(root);
    const storage = createFolderBackedFileStorage(() => db, TEST_COMPANY);
    const r = await storage.listPending('bank-statement');
    expect(r.map((f) => f.filename)).toContain('a.pdf');
  });

  it('updates immediately when operator changes the folder', async () => {
    const root2 = await fs.mkdtemp(path.join(os.tmpdir(), 'fbs2-'));
    try {
      await fs.writeFile(path.join(root, 'old.pdf'), 'old');
      await fs.writeFile(path.join(root2, 'new.pdf'), 'new');
      const storage = createFolderBackedFileStorage(() => db, TEST_COMPANY);

      await setBaseFolder(root);
      let r = await storage.listPending('bank-statement');
      expect(r.map((f) => f.filename)).toEqual(['old.pdf']);

      // Operator switches folder via Settings UI — no plugin restart.
      await setBaseFolder(root2);
      r = await storage.listPending('bank-statement');
      expect(r.map((f) => f.filename)).toEqual(['new.pdf']);
    } finally {
      await fs.rm(root2, { recursive: true, force: true });
    }
  });

  it('archive() throws clear error when folder unconfigured', async () => {
    const storage = createFolderBackedFileStorage(() => db, TEST_COMPANY);
    await expect(
      storage.archive({ sourcePath: '/x/y.pdf', importType: 'bank-statement' }),
    ).rejects.toThrow(/not configured/);
  });

  it('handles malformed folder_settings JSON gracefully', async () => {
    await db('settings').insert({
      key: 'folder_settings',
      company_code: TEST_COMPANY,
      value: '{not json}',
    });
    const storage = createFolderBackedFileStorage(() => db, TEST_COMPANY);
    const r = await storage.listPending('bank-statement');
    expect(r).toEqual([]);
  });

  it('returns empty when ctx.db.app is null (per-app DB not provisioned)', async () => {
    const storage = createFolderBackedFileStorage(() => null, TEST_COMPANY);
    const r = await storage.listPending('bank-statement');
    expect(r).toEqual([]);
  });
});

describe('createFolderBackedPdfContentReader', () => {
  it('reads bytes when folder configured and file inside', async () => {
    await fs.writeFile(path.join(root, 'stmt.pdf'), 'hello');
    await setBaseFolder(root);
    const reader = createFolderBackedPdfContentReader(() => db, TEST_COMPANY);
    const bytes = await reader.readBytes({ path: path.join(root, 'stmt.pdf') });
    expect(bytes).not.toBeNull();
    expect(Buffer.from(bytes!).toString('utf8')).toBe('hello');
  });

  it('rejects path outside configured root', async () => {
    await fs.writeFile(path.join(root, 'stmt.pdf'), 'x');
    await setBaseFolder(root);
    const escape = path.join(root, '..', 'elsewhere.pdf');
    const reader = createFolderBackedPdfContentReader(() => db, TEST_COMPANY);
    expect(await reader.readBytes({ path: escape })).toBeNull();
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createDefaultFileStorage } from '../src/services/default-file-storage.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bank-fs-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('createDefaultFileStorage', () => {
  it('returns empty list when subfolder is missing and not flat', async () => {
    const fsa = createDefaultFileStorage({ rootDir: root });
    const r = await fsa.listPending('bank-statement');
    expect(r).toEqual([]);
  });

  it('lists pdf/csv files in the bank-statement subfolder', async () => {
    const dir = path.join(root, 'bank-statements');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'a.pdf'), 'pdf-bytes');
    await fs.writeFile(path.join(dir, 'b.csv'), 'date,amount');
    await fs.writeFile(path.join(dir, 'ignore.txt'), 'noise');

    const fsa = createDefaultFileStorage({ rootDir: root });
    const r = await fsa.listPending('bank-statement');
    const names = r.map((f) => f.filename).sort();
    expect(names).toContain('a.pdf');
    expect(names).toContain('b.csv');
    // .txt is recognised by the regex but caller decides what to do — present here
    expect(names).toContain('ignore.txt');
  });

  it('skips dotfiles and the archive folder', async () => {
    const dir = path.join(root, 'bank-statements');
    await fs.mkdir(path.join(dir, 'archive'), { recursive: true });
    await fs.writeFile(path.join(dir, '.hidden.pdf'), 'x');
    await fs.writeFile(path.join(dir, 'archive', 'old.pdf'), 'x');
    await fs.writeFile(path.join(dir, 'live.pdf'), 'x');

    const fsa = createDefaultFileStorage({ rootDir: root });
    const r = await fsa.listPending('bank-statement');
    expect(r.map((f) => f.filename)).toEqual(['live.pdf']);
  });

  it('archives by moving file into archive/YYYY-MM/', async () => {
    const dir = path.join(root, 'bank-statements');
    await fs.mkdir(dir, { recursive: true });
    const src = path.join(dir, 'stmt.pdf');
    await fs.writeFile(src, 'data');

    const fsa = createDefaultFileStorage({ rootDir: root });
    const r = await fsa.archive({ sourcePath: src, importType: 'bank-statement' });
    expect(r.archivePath).toMatch(/archive[\/\\]\d{4}-\d{2}[\/\\]stmt\.pdf$/);
    await expect(fs.stat(src)).rejects.toThrow();
    const data = await fs.readFile(r.archivePath, 'utf8');
    expect(data).toBe('data');
  });

  it('restores file back to original path', async () => {
    const dir = path.join(root, 'bank-statements');
    await fs.mkdir(dir, { recursive: true });
    const src = path.join(dir, 'stmt.pdf');
    await fs.writeFile(src, 'restoredata');
    const fsa = createDefaultFileStorage({ rootDir: root });
    const arch = await fsa.archive({ sourcePath: src, importType: 'bank-statement' });
    const r = await fsa.restore({
      archivePath: arch.archivePath,
      originalPath: src,
    });
    expect(r.restoredPath).toBe(src);
    expect(await fs.readFile(src, 'utf8')).toBe('restoredata');
  });

  it('honours flatLayout by scanning rootDir when subfolder absent', async () => {
    await fs.writeFile(path.join(root, 'flat.pdf'), 'x');
    const fsa = createDefaultFileStorage({ rootDir: root, flatLayout: true });
    const r = await fsa.listPending('bank-statement');
    expect(r.map((f) => f.filename)).toContain('flat.pdf');
  });
});

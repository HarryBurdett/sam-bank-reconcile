import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createDefaultPdfContentReader } from '../src/services/default-pdf-content-reader.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bank-pdf-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('createDefaultPdfContentReader', () => {
  it('returns null for empty path', async () => {
    const reader = createDefaultPdfContentReader();
    expect(await reader.readBytes({ path: '' })).toBeNull();
  });

  it('returns null when file missing', async () => {
    const reader = createDefaultPdfContentReader({ rootDir: root });
    expect(
      await reader.readBytes({ path: path.join(root, 'nope.pdf') }),
    ).toBeNull();
  });

  it('reads bytes from absolute path inside root', async () => {
    const file = path.join(root, 'a.pdf');
    await fs.writeFile(file, 'hello');
    const reader = createDefaultPdfContentReader({ rootDir: root });
    const bytes = await reader.readBytes({ path: file });
    expect(bytes).not.toBeNull();
    expect(Buffer.from(bytes!).toString('utf8')).toBe('hello');
  });

  it('rejects path outside rootDir', async () => {
    const file = path.join(root, 'a.pdf');
    await fs.writeFile(file, 'hi');
    const reader = createDefaultPdfContentReader({ rootDir: root });
    const escape = path.join(root, '..', 'something.pdf');
    expect(await reader.readBytes({ path: escape })).toBeNull();
  });

  it('resolves relative path under rootDir', async () => {
    const dir = path.join(root, 'bank-statements');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'r.pdf'), 'rel');
    const reader = createDefaultPdfContentReader({ rootDir: root });
    const bytes = await reader.readBytes({
      path: 'bank-statements/r.pdf',
    });
    expect(bytes).not.toBeNull();
    expect(Buffer.from(bytes!).toString('utf8')).toBe('rel');
  });

  it('without rootDir reads any absolute path it can resolve', async () => {
    const file = path.join(root, 'unbound.pdf');
    await fs.writeFile(file, 'unbound');
    const reader = createDefaultPdfContentReader();
    const bytes = await reader.readBytes({ path: file });
    expect(bytes).not.toBeNull();
    expect(Buffer.from(bytes!).toString('utf8')).toBe('unbound');
  });
});

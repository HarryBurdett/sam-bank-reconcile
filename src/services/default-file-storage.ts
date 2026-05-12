/**
 * Default filesystem-based FileStorageAdapter.
 *
 * Used as a zero-config fallback when the SAM team hasn't wired a
 * custom storage backend (Microsoft Graph, S3, on-premise share). It
 * watches a root directory on disk, treats subfolders by import type,
 * and archives by moving files into an `archive/YYYY-MM/` folder under
 * each type — mirroring the layout the Python implementation
 * (`sql_rag/file_archive.py`) uses.
 *
 * The adapter is intentionally inert: if the configured root directory
 * doesn't exist it returns empty pending lists rather than throwing,
 * so health-check / list endpoints stay green during initial setup.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
  FileStorageAdapter,
  ImportType,
} from './archive.js';

interface FileStorageOptions {
  /** Root directory containing per-import-type subfolders. */
  rootDir: string;
  /** Allow scanning the root directory itself when no subfolder matches. */
  flatLayout?: boolean;
}

const SUBFOLDERS: Record<ImportType, string> = {
  'bank-statement': 'bank-statements',
  gocardless: 'gocardless',
  invoice: 'invoices',
};

const PDF_EXT = /\.(pdf|csv|ofx|qif|sta|txt)$/i;

function importTypeFolder(opts: FileStorageOptions, type: ImportType): string {
  return path.join(opts.rootDir, SUBFOLDERS[type]);
}

function archiveFolder(opts: FileStorageOptions, type: ImportType): string {
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return path.join(importTypeFolder(opts, type), 'archive', ym);
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function listFilesRecursive(
  root: string,
  acc: Array<{ abs: string; rel: string }> = [],
  rel = '',
  depth = 0,
): Promise<Array<{ abs: string; rel: string }>> {
  if (depth > 4) return acc;
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    entries = (await fs.readdir(root, { withFileTypes: true })) as any;
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.name.toLowerCase() === 'archive') continue;
    const abs = path.join(root, e.name);
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) {
      await listFilesRecursive(abs, acc, r, depth + 1);
    } else if (e.isFile() && PDF_EXT.test(e.name)) {
      acc.push({ abs, rel: r });
    }
  }
  return acc;
}

export function createDefaultFileStorage(
  options: FileStorageOptions,
): FileStorageAdapter {
  return {
    async archive({ sourcePath, importType }) {
      const dir = archiveFolder(options, importType);
      await ensureDir(dir);
      const filename = path.basename(sourcePath);
      const target = path.join(dir, filename);
      try {
        await fs.rename(sourcePath, target);
      } catch (err: any) {
        if (err?.code === 'EXDEV') {
          // Cross-device — fall back to copy + unlink
          const data = await fs.readFile(sourcePath);
          await fs.writeFile(target, data);
          await fs.unlink(sourcePath);
        } else {
          throw err;
        }
      }
      return { archivePath: target };
    },

    async restore({ archivePath, originalPath }) {
      const dir = path.dirname(originalPath);
      await ensureDir(dir);
      try {
        await fs.rename(archivePath, originalPath);
      } catch (err: any) {
        if (err?.code === 'EXDEV') {
          const data = await fs.readFile(archivePath);
          await fs.writeFile(originalPath, data);
          await fs.unlink(archivePath);
        } else {
          throw err;
        }
      }
      return { restoredPath: originalPath };
    },

    async listPending(importType) {
      const folder = importTypeFolder(options, importType);
      let scanRoot = folder;
      try {
        await fs.stat(folder);
      } catch {
        if (options.flatLayout) {
          scanRoot = options.rootDir;
        } else {
          return [];
        }
      }
      const found = await listFilesRecursive(scanRoot);
      const out: Array<{
        path: string;
        filename: string;
        folder: string;
        size: number;
        modified: string;
      }> = [];
      for (const f of found) {
        try {
          const st = await fs.stat(f.abs);
          out.push({
            path: f.abs,
            filename: path.basename(f.abs),
            folder: path.dirname(f.rel) || '.',
            size: st.size,
            modified: st.mtime.toISOString(),
          });
        } catch {
          // skip vanished files
        }
      }
      out.sort((a, b) => (a.modified < b.modified ? 1 : -1));
      return out;
    },
  };
}

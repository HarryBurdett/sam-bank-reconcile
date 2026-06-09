/**
 * Lazy fileStorage + PDF reader bound to the per-tenant
 * `folder_settings` row.
 *
 * The legacy `default-file-storage.ts` factory took a static rootDir
 * at construction time. That doesn't fit SAM, where the operator
 * sets the folder via the plugin's own Settings UI *after* the
 * plugin has been mounted — and can change it later. We need an
 * adapter whose root resolves on every call.
 *
 * Both wrappers share these semantics:
 *  - Read `settings(key=folder_settings).value` (JSON) on every
 *    method call.
 *  - If `base_folder` is set, delegate to a fresh inner adapter
 *    rooted at that path.
 *  - If `base_folder` is missing, return empty / null (which
 *    routes naturally surface as "no files configured").
 *
 * This is fine for the request rate of bank-reconcile (interactive
 * UI, not high-throughput) — one extra DB round-trip per call. If
 * that becomes a hot path, cache the row with a short TTL.
 */
import type { Knex } from 'knex';
import {
  createDefaultFileStorage,
} from './default-file-storage.js';
import { createDefaultPdfContentReader } from './default-pdf-content-reader.js';
import type { FileStorageAdapter, ImportType } from './archive.js';
import type { PdfContentReader } from './misc-endpoints.js';

import { companyScope } from '../_shared/get-company.js';

const FOLDER_SETTINGS_KEY = 'folder_settings';

async function readBaseFolder(
  appDb: Knex | null,
  companyCode: string,
): Promise<string | null> {
  if (!appDb) return null;
  // companyScope throws if companyCode is empty — fail loud rather
  // than silently reading another company's folder path.
  const scope = companyScope(companyCode);
  try {
    const row = (await appDb('settings')
      .where({ ...scope, key: FOLDER_SETTINGS_KEY })
      .first()) as { value?: string | null } | undefined;
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as { base_folder?: string };
    const base = (parsed.base_folder ?? '').toString().trim();
    return base || null;
  } catch {
    return null;
  }
}

/**
 * FileStorageAdapter whose `rootDir` resolves on every method call
 * from the per-app `folder_settings.base_folder` scoped to one Opera
 * company.
 *
 * Note: `companyCode` is passed at construction time, NOT per call.
 * Callers must build a fresh adapter per request (a `getFileStorage`
 * helper in router.ts does this) — sharing one adapter across
 * concurrent requests of different companies would re-introduce the
 * cross-company leak this is designed to prevent.
 */
export function createFolderBackedFileStorage(
  getAppDb: () => Knex | null,
  companyCode: string,
): FileStorageAdapter {
  const inner = async (): Promise<FileStorageAdapter | null> => {
    const root = await readBaseFolder(getAppDb(), companyCode);
    if (!root) return null;
    return createDefaultFileStorage({ rootDir: root, flatLayout: true });
  };
  return {
    async archive(opts: { sourcePath: string; importType: ImportType }) {
      const f = await inner();
      if (!f) {
        throw new Error(
          'bank-reconcile folder is not configured — set the base folder in the plugin Settings page.',
        );
      }
      return f.archive(opts);
    },
    async restore(opts) {
      const f = await inner();
      if (!f) {
        throw new Error('bank-reconcile folder is not configured.');
      }
      return f.restore(opts);
    },
    async listPending(importType) {
      const f = await inner();
      if (!f) return [];
      return f.listPending(importType);
    },
  };
}

/**
 * PdfContentReader whose rootDir resolves on every call from
 * `folder_settings.base_folder`. When unconfigured, falls back to a
 * reader with no rootDir guard — the caller's filePath is trusted
 * absolutely (the SAM team can override this by wiring
 * ctx.pdfContentReader directly).
 */
export function createFolderBackedPdfContentReader(
  getAppDb: () => Knex | null,
  companyCode: string,
): PdfContentReader {
  return {
    async readBytes(opts: { path: string }) {
      const root = await readBaseFolder(getAppDb(), companyCode);
      const inner = root
        ? createDefaultPdfContentReader({ rootDir: root })
        : createDefaultPdfContentReader({});
      return inner.readBytes(opts);
    },
  };
}

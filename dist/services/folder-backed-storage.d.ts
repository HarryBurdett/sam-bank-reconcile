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
import type { FileStorageAdapter } from './archive.js';
import type { PdfContentReader } from './misc-endpoints.js';
/**
 * FileStorageAdapter whose `rootDir` resolves on every method call
 * from the per-app `folder_settings.base_folder`.
 */
export declare function createFolderBackedFileStorage(getAppDb: () => Knex | null): FileStorageAdapter;
/**
 * PdfContentReader whose rootDir resolves on every call from
 * `folder_settings.base_folder`. When unconfigured, falls back to a
 * reader with no rootDir guard — the caller's filePath is trusted
 * absolutely (the SAM team can override this by wiring
 * ctx.pdfContentReader directly).
 */
export declare function createFolderBackedPdfContentReader(getAppDb: () => Knex | null): PdfContentReader;
//# sourceMappingURL=folder-backed-storage.d.ts.map
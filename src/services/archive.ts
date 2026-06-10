/**
 * File archive endpoints — port of `/api/archive/*` in
 * `apps/bank_reconcile/api/routes.py:2068-2186` and the underlying
 * `sql_rag/file_archive.py` module.
 *
 * In the Python implementation the archive is a filesystem operation
 * with a JSON log on disk. SAM plugins don't directly own the
 * customer's filesystem, so this port abstracts file operations
 * behind a `FileStorageAdapter` and persists the archive log in the
 * per-app database (`file_archive_log` table — created by migration
 * 005 alongside this file). The SAM team plugs in whatever storage
 * strategy fits (Microsoft Graph, S3, on-premise share, etc.).
 *
 * Endpoints surface the same response shapes as Python so the
 * existing frontend doesn't need changes.
 */
import type { Knex } from 'knex';
import { companyScope } from '../_shared/get-company.js';

export type ImportType = 'bank-statement' | 'gocardless' | 'invoice';

export const SUPPORTED_IMPORT_TYPES: ImportType[] = [
  'bank-statement',
  'gocardless',
  'invoice',
];

export interface FileStorageAdapter {
  /** Move (or copy + delete) a source file into the archive folder for
   *  the given import type. Returns the archived path. */
  archive(opts: {
    sourcePath: string;
    importType: ImportType;
  }): Promise<{ archivePath: string }>;
  /** Restore an archived file back to its original path. */
  restore(opts: {
    archivePath: string;
    originalPath: string;
  }): Promise<{ restoredPath: string }>;
  /** List files currently sitting in the source folders for an import
   *  type but not yet archived. */
  listPending(
    importType: ImportType,
  ): Promise<Array<{
    path: string;
    filename: string;
    folder: string;
    size: number;
    modified: string;
  }>>;
}

export interface ArchiveLogEntry {
  id: number;
  archived_at: string;
  original_path: string;
  archive_path: string;
  import_type: string;
  filename: string;
  metadata: Record<string, unknown>;
  restored_at: string | null;
  restored_to: string | null;
}

export interface ArchiveResponse {
  success: boolean;
  message?: string;
  archive_path?: string;
  original_path?: string;
  restored_path?: string;
  history?: ArchiveLogEntry[];
  count?: number;
  files?: Array<{
    path: string;
    filename: string;
    folder: string;
    size: number;
    modified: string;
  }>;
  error?: string;
}

interface RawLogRow {
  id: number;
  archived_at: string | Date;
  original_path: string;
  archive_path: string;
  import_type: string;
  filename: string;
  metadata: string | null;
  restored_at: string | Date | null;
  restored_to: string | null;
}

function mapLogRow(row: RawLogRow): ArchiveLogEntry {
  let metadata: Record<string, unknown> = {};
  try {
    if (row.metadata) metadata = JSON.parse(row.metadata) as Record<string, unknown>;
  } catch {
    // ignore malformed
  }
  const archivedAt =
    row.archived_at instanceof Date
      ? row.archived_at.toISOString()
      : String(row.archived_at);
  const restoredAt = row.restored_at
    ? row.restored_at instanceof Date
      ? row.restored_at.toISOString()
      : String(row.restored_at)
    : null;
  return {
    id: Number(row.id),
    archived_at: archivedAt,
    original_path: row.original_path,
    archive_path: row.archive_path,
    import_type: row.import_type,
    filename: row.filename,
    metadata,
    restored_at: restoredAt,
    restored_to: row.restored_to,
  };
}

export interface ArchiveFileInput {
  filePath: string;
  importType: ImportType;
  transactionsExtracted?: number;
  transactionsMatched?: number;
  transactionsReconciled?: number;
}

export async function archiveFile(
  appDb: Knex,
  companyCode: string,
  storage: FileStorageAdapter,
  input: ArchiveFileInput,
): Promise<ArchiveResponse> {
  if (!input.filePath) return { success: false, error: 'file_path is required' };
  if (!SUPPORTED_IMPORT_TYPES.includes(input.importType)) {
    return {
      success: false,
      error: `Unsupported import_type: ${input.importType}`,
    };
  }
  const scope = companyScope(companyCode);
  let archivePath: string;
  try {
    const r = await storage.archive({
      sourcePath: input.filePath,
      importType: input.importType,
    });
    archivePath = r.archivePath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Archive failed: ${msg}` };
  }

  const filename = input.filePath.split(/[/\\]/).pop() ?? input.filePath;
  const metadata = {
    transactions_extracted: input.transactionsExtracted ?? null,
    transactions_matched: input.transactionsMatched ?? null,
    transactions_reconciled: input.transactionsReconciled ?? null,
  };
  try {
    await appDb('file_archive_log').insert({
      ...scope,
      archived_at: appDb.fn.now(),
      original_path: input.filePath,
      archive_path: archivePath,
      import_type: input.importType,
      filename,
      metadata: JSON.stringify(metadata),
    });
  } catch {
    // log-write failure is non-fatal
  }
  return {
    success: true,
    message: `Archived to ${archivePath}`,
    archive_path: archivePath,
    original_path: input.filePath,
  };
}

export async function getArchiveHistory(
  appDb: Knex,
  companyCode: string,
  importType: ImportType | null,
  limit = 50,
): Promise<ArchiveResponse> {
  const scope = companyScope(companyCode);
  try {
    let q = appDb('file_archive_log')
      .where(scope)
      .orderBy('archived_at', 'desc')
      .limit(limit);
    if (importType) q = q.where({ import_type: importType });
    const rows = (await q) as unknown as RawLogRow[];
    return {
      success: true,
      history: rows.map(mapLogRow),
      count: rows.length,
    };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

export async function restoreArchivedFile(
  appDb: Knex,
  companyCode: string,
  storage: FileStorageAdapter,
  archivePath: string,
): Promise<ArchiveResponse> {
  if (!archivePath) {
    return { success: false, error: 'archive_path is required' };
  }
  const scope = companyScope(companyCode);
  const row = (await appDb('file_archive_log')
    .where({ ...scope, archive_path: archivePath })
    .orderBy('archived_at', 'desc')
    .first()) as RawLogRow | undefined;
  if (!row) {
    return {
      success: false,
      error: `No archive log entry found for path '${archivePath}'`,
    };
  }
  try {
    const result = await storage.restore({
      archivePath,
      originalPath: row.original_path,
    });
    await appDb('file_archive_log').where({ ...scope, id: row.id }).update({
      restored_at: appDb.fn.now(),
      restored_to: result.restoredPath,
    });
    return {
      success: true,
      message: `Restored to ${result.restoredPath}`,
      restored_path: result.restoredPath,
      original_path: row.original_path,
    };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

export async function getPendingFiles(
  storage: FileStorageAdapter,
  importType: ImportType,
): Promise<ArchiveResponse> {
  if (!SUPPORTED_IMPORT_TYPES.includes(importType)) {
    return {
      success: false,
      error: `Unsupported import_type: ${importType}`,
      files: [],
    };
  }
  try {
    const files = await storage.listPending(importType);
    return { success: true, files, count: files.length };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err), files: [] };
  }
}

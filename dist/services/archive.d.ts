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
export type ImportType = 'bank-statement' | 'gocardless' | 'invoice';
export declare const SUPPORTED_IMPORT_TYPES: ImportType[];
export interface FileStorageAdapter {
    /** Move (or copy + delete) a source file into the archive folder for
     *  the given import type. Returns the archived path. */
    archive(opts: {
        sourcePath: string;
        importType: ImportType;
    }): Promise<{
        archivePath: string;
    }>;
    /** Restore an archived file back to its original path. */
    restore(opts: {
        archivePath: string;
        originalPath: string;
    }): Promise<{
        restoredPath: string;
    }>;
    /** List files currently sitting in the source folders for an import
     *  type but not yet archived. */
    listPending(importType: ImportType): Promise<Array<{
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
export interface ArchiveFileInput {
    filePath: string;
    importType: ImportType;
    transactionsExtracted?: number;
    transactionsMatched?: number;
    transactionsReconciled?: number;
}
export declare function archiveFile(appDb: Knex, storage: FileStorageAdapter, input: ArchiveFileInput): Promise<ArchiveResponse>;
export declare function getArchiveHistory(appDb: Knex, importType: ImportType | null, limit?: number): Promise<ArchiveResponse>;
export declare function restoreArchivedFile(appDb: Knex, storage: FileStorageAdapter, archivePath: string): Promise<ArchiveResponse>;
export declare function getPendingFiles(storage: FileStorageAdapter, importType: ImportType): Promise<ArchiveResponse>;
//# sourceMappingURL=archive.d.ts.map
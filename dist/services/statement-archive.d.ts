/**
 * Statement-archive endpoints — track which imported statement
 * PDFs have been archived (move to archive folder, hide from list,
 * keep available for re-download).
 *
 * Faithful ports of:
 *   - archive_statement (routes.py:5924, 7933)
 *   - get_archived_statements (routes.py:8042)
 *   - restore_statement (routes.py:8056)
 *   - get_archived_statement_pdf (routes.py:8176)
 *   - delete_archived_statement (routes.py:8205)
 *   - manage_statements (routes.py:8262 — composite list)
 *
 * Persisted in the per-app `bank_statement_imports` table that
 * already exists; this just adds CRUD around the `import_status` /
 * `archived` columns. PDF bytes themselves come from the
 * FileStorageAdapter the SAM team provides.
 */
import type { Knex } from 'knex';
import type { FileStorageAdapter } from './archive.js';
export interface ArchivedStatement {
    id: number;
    bank_code: string;
    filename: string;
    source: string;
    source_ref: string;
    opening_balance: number | null;
    closing_balance: number | null;
    imported_at: string;
    import_status: string;
    archived_at: string | null;
}
export declare function archiveStatement(appDb: Knex, importId: number, by: string): Promise<{
    success: boolean;
    error?: string;
}>;
export declare function listArchivedStatements(appDb: Knex, bankCode?: string | null, limit?: number): Promise<{
    success: boolean;
    statements: ArchivedStatement[];
    count: number;
    error?: string;
}>;
export declare function restoreStatement(appDb: Knex, importId: number): Promise<{
    success: boolean;
    error?: string;
}>;
export declare function getArchivedStatementPdf(appDb: Knex, storage: FileStorageAdapter | null, recordId: number): Promise<{
    success: boolean;
    bytes?: Uint8Array;
    filename?: string;
    error?: string;
}>;
export declare function deleteArchivedStatement(appDb: Knex, recordId: number): Promise<{
    success: boolean;
    error?: string;
}>;
export interface ManageStatementsRow {
    id: number;
    bank_code: string;
    filename: string;
    source: string;
    imported_at: string;
    import_status: string;
    opening_balance: number | null;
    closing_balance: number | null;
    records_imported: number;
}
export declare function manageStatements(appDb: Knex, bankCode: string | null, includeArchived: boolean): Promise<{
    success: boolean;
    statements: ManageStatementsRow[];
    count: number;
    error?: string;
}>;
//# sourceMappingURL=statement-archive.d.ts.map
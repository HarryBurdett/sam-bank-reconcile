/**
 * Bank-statement folder settings (per-tenant).
 *
 * Faithful port of:
 *   - get_bank_import_folder_settings
 *     (apps/bank_reconcile/api/routes.py:5501-5516)
 *   - save_bank_import_folder_settings
 *     (apps/bank_reconcile/api/routes.py:5522-5535)
 *
 * Stored as a single JSON blob under settings.key='folder_settings'.
 * Used by:
 *   - the file-system scan endpoint (/api/bank-import/scan-folder)
 *   - the email scan + archive endpoints (which copy the PDF into
 *     the matching subfolder under base_folder)
 */
import type { Knex } from 'knex';
export interface FolderSettings {
    base_folder: string;
    archive_folder: string;
}
export interface GetFolderSettingsResponse {
    success: boolean;
    base_folder: string;
    archive_folder: string;
    /** True when base_folder is configured. Mirrors Python's `bool(base)`. */
    folder_enabled: boolean;
    error?: string;
}
export declare function getFolderSettings(appDb: Knex): Promise<GetFolderSettingsResponse>;
export interface SaveFolderSettingsInput {
    base_folder?: string | null;
    archive_folder?: string | null;
}
export interface SaveFolderSettingsResponse {
    success: boolean;
    message?: string;
    error?: string;
}
export declare function saveFolderSettings(appDb: Knex, input: SaveFolderSettingsInput): Promise<SaveFolderSettingsResponse>;
//# sourceMappingURL=folder-settings.d.ts.map
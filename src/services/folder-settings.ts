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

const FOLDER_SETTINGS_KEY = 'folder_settings';

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

export async function getFolderSettings(
  appDb: Knex,
): Promise<GetFolderSettingsResponse> {
  try {
    const row = (await appDb('settings')
      .where({ key: FOLDER_SETTINGS_KEY })
      .first()) as unknown as { value: string | null } | undefined;
    if (!row?.value) {
      return {
        success: true,
        base_folder: '',
        archive_folder: '',
        folder_enabled: false,
      };
    }
    let parsed: Partial<FolderSettings> = {};
    try {
      const decoded = JSON.parse(row.value);
      if (decoded && typeof decoded === 'object') parsed = decoded;
    } catch {
      // Match Python: graceful default on bad JSON
    }
    const base = (parsed.base_folder ?? '').toString();
    const archive = (parsed.archive_folder ?? '').toString();
    return {
      success: true,
      base_folder: base,
      archive_folder: archive,
      folder_enabled: !!base,
    };
  } catch (err: any) {
    // Python returns success=true even on read errors so the UI loads
    return {
      success: true,
      base_folder: '',
      archive_folder: '',
      folder_enabled: false,
      error: err?.message ?? String(err),
    };
  }
}

export interface SaveFolderSettingsInput {
  base_folder?: string | null;
  archive_folder?: string | null;
}

export interface SaveFolderSettingsResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export async function saveFolderSettings(
  appDb: Knex,
  input: SaveFolderSettingsInput,
): Promise<SaveFolderSettingsResponse> {
  try {
    const payload: FolderSettings = {
      base_folder: typeof input.base_folder === 'string' ? input.base_folder : '',
      archive_folder:
        typeof input.archive_folder === 'string' ? input.archive_folder : '',
    };
    const value = JSON.stringify(payload);
    const existing = (await appDb('settings')
      .where({ key: FOLDER_SETTINGS_KEY })
      .first()) as unknown as { id: number | null } | undefined;
    if (existing) {
      await appDb('settings')
        .where({ key: FOLDER_SETTINGS_KEY })
        .update({ value, updated_at: appDb.fn.now() });
    } else {
      await appDb('settings').insert({ key: FOLDER_SETTINGS_KEY, value });
    }
    return { success: true, message: 'Folder settings saved' };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

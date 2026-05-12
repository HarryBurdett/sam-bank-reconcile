const FOLDER_SETTINGS_KEY = 'folder_settings';
export async function getFolderSettings(appDb) {
    try {
        const row = (await appDb('settings')
            .where({ key: FOLDER_SETTINGS_KEY })
            .first());
        if (!row?.value) {
            return {
                success: true,
                base_folder: '',
                archive_folder: '',
                folder_enabled: false,
            };
        }
        let parsed = {};
        try {
            const decoded = JSON.parse(row.value);
            if (decoded && typeof decoded === 'object')
                parsed = decoded;
        }
        catch {
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
    }
    catch (err) {
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
export async function saveFolderSettings(appDb, input) {
    try {
        const payload = {
            base_folder: typeof input.base_folder === 'string' ? input.base_folder : '',
            archive_folder: typeof input.archive_folder === 'string' ? input.archive_folder : '',
        };
        const value = JSON.stringify(payload);
        const existing = (await appDb('settings')
            .where({ key: FOLDER_SETTINGS_KEY })
            .first());
        if (existing) {
            await appDb('settings')
                .where({ key: FOLDER_SETTINGS_KEY })
                .update({ value, updated_at: appDb.fn.now() });
        }
        else {
            await appDb('settings').insert({ key: FOLDER_SETTINGS_KEY, value });
        }
        return { success: true, message: 'Folder settings saved' };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
//# sourceMappingURL=folder-settings.js.map
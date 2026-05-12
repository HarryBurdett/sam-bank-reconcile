import { createDefaultFileStorage, } from './default-file-storage.js';
import { createDefaultPdfContentReader } from './default-pdf-content-reader.js';
const FOLDER_SETTINGS_KEY = 'folder_settings';
async function readBaseFolder(appDb) {
    if (!appDb)
        return null;
    try {
        const row = (await appDb('settings')
            .where({ key: FOLDER_SETTINGS_KEY })
            .first());
        if (!row?.value)
            return null;
        const parsed = JSON.parse(row.value);
        const base = (parsed.base_folder ?? '').toString().trim();
        return base || null;
    }
    catch {
        return null;
    }
}
/**
 * FileStorageAdapter whose `rootDir` resolves on every method call
 * from the per-app `folder_settings.base_folder`.
 */
export function createFolderBackedFileStorage(getAppDb) {
    const inner = async () => {
        const root = await readBaseFolder(getAppDb());
        if (!root)
            return null;
        return createDefaultFileStorage({ rootDir: root, flatLayout: true });
    };
    return {
        async archive(opts) {
            const f = await inner();
            if (!f) {
                throw new Error('bank-reconcile folder is not configured — set the base folder in the plugin Settings page.');
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
            if (!f)
                return [];
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
export function createFolderBackedPdfContentReader(getAppDb) {
    return {
        async readBytes(opts) {
            const root = await readBaseFolder(getAppDb());
            const inner = root
                ? createDefaultPdfContentReader({ rootDir: root })
                : createDefaultPdfContentReader({});
            return inner.readBytes(opts);
        },
    };
}
//# sourceMappingURL=folder-backed-storage.js.map
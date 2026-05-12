import type { FileStorageAdapter } from './archive.js';
interface FileStorageOptions {
    /** Root directory containing per-import-type subfolders. */
    rootDir: string;
    /** Allow scanning the root directory itself when no subfolder matches. */
    flatLayout?: boolean;
}
export declare function createDefaultFileStorage(options: FileStorageOptions): FileStorageAdapter;
export {};
//# sourceMappingURL=default-file-storage.d.ts.map
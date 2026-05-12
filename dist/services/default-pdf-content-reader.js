/**
 * Default filesystem-based PdfContentReader.
 *
 * Reads raw PDF bytes off disk. Returns null when the file is missing
 * (not throws), matching the contract `getPdfContent` expects so the
 * route can return a 404-equivalent JSON payload.
 *
 * Optional `rootDir` constrains reads to a directory (defence against
 * a caller passing `..` or absolute paths outside the configured
 * import folder). When omitted, the reader trusts the caller — the
 * SAM team should set `rootDir` in any deployment that exposes the
 * route to untrusted clients.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
function isInside(root, candidate) {
    const r = path.resolve(root);
    const c = path.resolve(candidate);
    return c === r || c.startsWith(r + path.sep);
}
export function createDefaultPdfContentReader(options = {}) {
    return {
        async readBytes({ path: filePath }) {
            if (!filePath)
                return null;
            const target = path.isAbsolute(filePath)
                ? filePath
                : options.rootDir
                    ? path.join(options.rootDir, filePath)
                    : path.resolve(filePath);
            if (options.rootDir && !isInside(options.rootDir, target)) {
                return null;
            }
            try {
                const buf = await fs.readFile(target);
                return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
            }
            catch (err) {
                if (err?.code === 'ENOENT' || err?.code === 'EISDIR')
                    return null;
                throw err;
            }
        },
    };
}
//# sourceMappingURL=default-pdf-content-reader.js.map
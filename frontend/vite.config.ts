import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Vite SPA build for the bank-reconcile SAM plugin.
 *
 * SAM mounts each plugin in an iframe at /apps/<appId>/ — see
 * packages/portal/src/components/apps/AppIframe.tsx and the backend's
 * static handler in packages/backend/src/index.ts:157-177. It serves
 * `frontend-dist/index.html` and the hashed assets under
 * `frontend-dist/assets/*`.
 *
 * `base: './'` makes generated asset references relative so they resolve
 * correctly when served at any path (e.g. `/apps/bank-reconcile/`).
 *
 * `__APP_VERSION__` is injected from the plugin's root package.json
 * so the "Live Version" label in PageHeader.tsx auto-updates on
 * every release — no more hand-editing the version constant in
 * lockstep with package.json and manifest.json.
 */
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'),
) as { version: string };

export default defineConfig({
  base: './',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    sourcemap: true,
    minify: 'esbuild',
  },
});

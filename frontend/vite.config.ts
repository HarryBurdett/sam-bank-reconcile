import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
 */
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    sourcemap: true,
    minify: 'esbuild',
  },
});

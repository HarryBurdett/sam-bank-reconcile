/**
 * Bank Reconciliation plugin — SPA entry.
 *
 * Mounted by SAM in an iframe at /apps/bank-reconcile/. SAM serves
 * the built `index.html` and hashed assets — see
 * ai-sam/packages/backend/src/index.ts:157-177.
 *
 * Context comes from `window.__SAM_CONTEXT__` when SAM injects it into
 * the iframe HTML before this script runs. When that's absent (e.g.
 * standalone dev), a cookie-auth fallback is constructed so /api calls
 * still work against the same-origin backend.
 */
import { createRoot } from 'react-dom/client';
import './index.css';
import BankReconcile from './BankReconcile';
import { setSamContext } from './api-shim';
import type { SamApiClient, SamPluginContext } from './sam';

declare global {
  interface Window {
    __SAM_CONTEXT__?: SamPluginContext;
  }
}

const APP_ID = 'bank-reconcile';

function buildFallbackApi(): SamApiClient {
  return {
    baseUrl: '',
    fetch: async <T = unknown>(
      path: string,
      options: RequestInit = {},
    ): Promise<T> => {
      const url = path.startsWith('/api/')
        ? path
        : `/api/apps/${APP_ID}${path.startsWith('/') ? path : '/' + path}`;
      const res = await fetch(url, { credentials: 'include', ...options });
      if (!res.ok) {
        throw new Error(`Request failed: ${res.status} ${res.statusText}`);
      }
      const ct = res.headers.get('content-type') ?? '';
      return (ct.includes('application/json') ? res.json() : res.text()) as Promise<T>;
    },
  };
}

const ctx: SamPluginContext = window.__SAM_CONTEXT__ ?? {
  appId: APP_ID,
  user: null,
  token: null,
  currentCompany: null,
  api: buildFallbackApi(),
};

setSamContext(ctx);

const rootEl = document.getElementById('root');
if (!rootEl) {
  console.error(`[${APP_ID}] #root element not found in index.html`);
} else {
  createRoot(rootEl).render(<BankReconcile context={ctx} />);
}

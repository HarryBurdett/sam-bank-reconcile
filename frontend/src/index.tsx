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
  // Every plugin-scoped path is rooted at /api/apps/<appId> in the
  // standalone host (where the per-tenant dispatcher mounts the
  // plugin's router). Callers pass paths like '/api/cashbook/...'
  // or 'cashbook/...' — we always prepend the app prefix, never
  // short-circuit, so the fallback behaves the same as SAM's
  // injected api.fetch (which performs the equivalent mapping
  // host-side).
  return {
    baseUrl: `/api/apps/${APP_ID}`,
    fetch: async <T = unknown>(
      path: string,
      options: RequestInit = {},
    ): Promise<T> => {
      const tail = path.startsWith('/') ? path : `/${path}`;
      const url = `/api/apps/${APP_ID}${tail}`;
      const res = await fetch(url, { credentials: 'include', ...options });
      if (!res.ok) {
        throw new Error(`Request failed: ${res.status} ${res.statusText}`);
      }
      const ct = res.headers.get('content-type') ?? '';
      return (ct.includes('application/json') ? res.json() : res.text()) as Promise<T>;
    },
  };
}

// SAM injects the full context object (including an `api` SAM client)
// into window.__SAM_CONTEXT__ before this script loads. The standalone
// dev host injects everything EXCEPT `api`, because JSON-serialised
// injection can't carry functions — the standalone relies on this
// SPA to build the cookie-auth fallback at module init. Merge so:
//   - SAM-injected context (with api):  use as-is
//   - Standalone-injected context (no api):  graft the fallback api on
//   - No injection at all (e.g. unit harness):  full fallback
const injected = window.__SAM_CONTEXT__;
const ctx: SamPluginContext = injected
  ? { ...injected, api: injected.api ?? buildFallbackApi() }
  : {
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

/**
 * SAM frontend context shape.
 *
 * Mirrors `AppShell.tsx` in the SAM host
 * (packages/frontend/src/plugins/AppShell.tsx).
 */

export interface SamUser {
  userId?: string;
  email?: string;
  name?: string;
  role?: 'admin' | 'user' | 'sam-admin';
  appRole?: string | null;
  appConfig?: Record<string, unknown> | null;
}

export interface SamCompany {
  code: string;
  name?: string;
}

export interface SamApiClient {
  baseUrl: string;
  fetch: <T = unknown>(path: string, options?: RequestInit) => Promise<T>;
}

export interface SamPluginContext {
  appId: string;
  user: SamUser | null;
  token: string | null;
  currentCompany: SamCompany | null;
  api: SamApiClient;
  events?: EventTarget;
}

export interface SamAppEntry {
  id: string;
  component: (props: { context: SamPluginContext }) => unknown;
}

declare global {
  interface Window {
    __SAM_APPS__?: Record<string, SamAppEntry>;
    __SAM_SHARED__?: {
      react?: typeof import('react');
      reactDom?: typeof import('react-dom');
    };
  }
}

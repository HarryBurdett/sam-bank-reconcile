/**
 * Adapts SAM's `context.api.fetch` onto the axios-style call surface
 * the legacy `frontend/src/api/client.ts` exposes. Lets the page port
 * stay close to the original source — keep diff noise low so the SAM
 * port can be audited against the canonical Python frontend.
 *
 * Usage:
 *   import { setSamApi } from './api-shim';
 *   useEffect(() => setSamApi(context.api), [context.api]);
 *   import apiClient, { authFetch, friendlyError } from './api-shim';
 *   const r = await apiClient.get('/api/reconcile/banks');
 */
import type { SamApiClient, SamPluginContext } from './sam';

let samApi: SamApiClient | null = null;
let companyCode: string | null = null;

export function setSamApi(api: SamApiClient | null, company: string | null = null): void {
  samApi = api;
  companyCode = company;
}

/** Convenience setter that pulls api + company from context. */
export function setSamContext(ctx: SamPluginContext | null): void {
  samApi = ctx?.api ?? null;
  companyCode = ctx?.currentCompany?.code ?? null;
}

function buildUrl(path: string, params?: Record<string, unknown>): string {
  if (!params) return path;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) qs.append(k, String(item));
    } else {
      qs.append(k, String(v));
    }
  }
  const tail = qs.toString();
  return tail ? `${path}${path.includes('?') ? '&' : '?'}${tail}` : path;
}

async function call<T = any>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  params?: Record<string, unknown>,
): Promise<{ data: T }> {
  if (!samApi) {
    throw new Error('SAM API not initialised — call setSamApi(context.api) first.');
  }
  const url = buildUrl(path, params);
  const init: RequestInit = {
    method,
    headers: companyCode ? { 'X-Opera-Company': companyCode } : undefined,
  };
  if (body !== undefined) {
    init.headers = {
      ...(init.headers as Record<string, string>),
      'Content-Type': 'application/json',
    };
    init.body = JSON.stringify(body);
  }
  const data = await samApi.fetch<T>(url, init);
  return { data };
}

const apiClient = {
  get: <T = any>(path: string, opts?: { params?: Record<string, unknown> }) =>
    call<T>('GET', path, undefined, opts?.params),
  post: <T = any>(path: string, body?: unknown, opts?: { params?: Record<string, unknown> }) =>
    call<T>('POST', path, body, opts?.params),
  put: <T = any>(path: string, body?: unknown, opts?: { params?: Record<string, unknown> }) =>
    call<T>('PUT', path, body, opts?.params),
  delete: <T = any>(path: string, opts?: { params?: Record<string, unknown> }) =>
    call<T>('DELETE', path, undefined, opts?.params),

  // Higher-level helpers ported from frontend/src/api/client.ts. The
  // canonical paths are the SAM router's, so the prefix here is /api.
  reconcileBanks: () => call<any>('GET', '/api/reconcile/banks'),
  getBankReconciliationStatus: (bankCode: string, currentFilename?: string) => {
    const tail = currentFilename
      ? `?current_filename=${encodeURIComponent(currentFilename)}`
      : '';
    return call<any>('GET', `/api/reconcile/bank/${bankCode}/status${tail}`);
  },
  getUnreconciledEntries: (bankCode: string) =>
    call<any>('GET', `/api/reconcile/bank/${bankCode}/unreconciled`),
  markEntriesReconciled: (bankCode: string, data: unknown) =>
    call<any>('POST', `/api/reconcile/bank/${bankCode}/mark-reconciled`, data),
  unreconcileEntries: (bankCode: string, entryNumbers: string[]) =>
    call<any>('POST', `/api/reconcile/bank/${bankCode}/unreconcile`, entryNumbers),
  getArchiveHistory: (importType?: string, limit?: number) =>
    call<any>('GET', '/api/archive/history', undefined, {
      import_type: importType,
      limit,
    }),
  restoreArchivedFile: (archivePath: string) =>
    call<any>('POST', '/api/archive/restore', null, {
      archive_path: archivePath,
    }),
};

/** Direct fetch shim for the small number of legacy callers that
 *  bypass apiClient. Returns a Response-like object that supports
 *  json(), ok, status. */
export async function authFetch(
  path: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; json: () => Promise<any> }> {
  if (!samApi) {
    throw new Error('SAM API not initialised — call setSamApi(context.api) first.');
  }
  const headers = {
    ...(init.headers as Record<string, string> | undefined),
    ...(companyCode ? { 'X-Opera-Company': companyCode } : {}),
  };
  try {
    const data = await samApi.fetch<unknown>(path, { ...init, headers });
    return { ok: true, status: 200, json: async () => data };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      json: async () => ({ error: err instanceof Error ? err.message : String(err) }),
    };
  }
}

/**
 * Translate raw database / technical error messages into user-friendly
 * text. Lift-and-shift from `frontend/src/api/client.ts:friendlyError`
 * — keep in sync if the source ever changes.
 */
export function friendlyError(msg: string): string {
  if (!msg) return 'An unexpected error occurred.';
  const lower = msg.toLowerCase();
  if (lower.includes('4060') || lower.includes('cannot open database'))
    return 'Opera database is currently unavailable — it may be locked by a backup or another process. Please try again in a few minutes.';
  if (lower.includes('18456') || lower.includes('login failed'))
    return 'Cannot connect to Opera — database login failed. Please check the connection settings.';
  if (lower.includes('timeout') && (lower.includes('connection') || lower.includes('login')))
    return 'Connection to the Opera database timed out. Please try again shortly.';
  if (lower.includes('network') || lower.includes('unreachable') || lower.includes('tcp provider') || lower.includes('server is not found'))
    return 'Cannot reach the Opera database server. Please check the network connection.';
  if (lower.includes('deadlock') || lower.includes('1205'))
    return 'The operation was temporarily blocked by another user. Please try again.';
  if (lower.includes('lock request time out') || lower.includes('lock timeout'))
    return 'Opera is busy — another user or process is updating the same data. Please wait and try again.';
  if (lower.includes('connection reset') || lower.includes('broken pipe'))
    return 'The database connection was interrupted. Please try again.';
  if (lower.includes('database connection failed') || lower.includes('query execution failed')) {
    const inner = msg.includes(': ') ? msg.split(': ').slice(1).join(': ') : msg;
    const innerResult = friendlyError(inner);
    if (innerResult !== inner) return innerResult;
  }
  return msg;
}

export default apiClient;

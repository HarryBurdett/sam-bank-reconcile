/**
 * Per-app Health Check page.
 *
 * Renders the standardised HealthCheckResult shape returned by each
 * app's /api/{app}/health-check endpoint.  One component, three
 * routes — `appFilter` controls which endpoint is called and which
 * label appears.
 *
 * Why per-app: each app knows its own data dependencies (bank-rec
 * cares about bank/customer/supplier codes; gocardless cares about
 * customer codes + settings; suppliers about supplier codes). SAM
 * (Phase C) will fan out across all apps and aggregate the results.
 *
 * The check is useful any time, especially:
 *   - immediately after an Opera 3 → Opera SE upgrade
 *   - as a periodic data-integrity audit
 *   - when something looks wrong (orphan codes, broken patterns)
 */
import { useQuery } from '@tanstack/react-query';
import {
  Activity, CheckCircle2, AlertTriangle, XCircle, Info, RefreshCw,
} from 'lucide-react';
import { authFetch } from './api-shim';
import { PageHeader, LoadingState } from './PageHeader';

type AppFilter = 'bank_reconcile' | 'gocardless' | 'suppliers';
type Severity = 'info' | 'warning' | 'error';

interface HealthCheckItem {
  name: string;
  description: string;
  passed: boolean;
  total_checked: number;
  orphan_count: number;
  orphans: Record<string, unknown>[];
  severity: Severity;
}

interface HealthCheckResult {
  app: string;
  healthy: boolean;
  summary: string;
  checks: HealthCheckItem[];
  metadata: Record<string, unknown>;
}

interface HealthCheckProps {
  appFilter: AppFilter;
  title?: string;
}

const ENDPOINT_BY_APP: Record<AppFilter, string> = {
  bank_reconcile: '/api/bank-import/health-check',
  gocardless: '/api/gocardless/health-check',
  suppliers: '/api/suppliers/health-check',
};

const TITLE_BY_APP: Record<AppFilter, string> = {
  bank_reconcile: 'Bank Reconciliation — Health Check',
  gocardless: 'GoCardless — Health Check',
  suppliers: 'Suppliers — Health Check',
};

export function HealthCheck({ appFilter, title }: HealthCheckProps) {
  const endpoint = ENDPOINT_BY_APP[appFilter];
  const pageTitle = title ?? TITLE_BY_APP[appFilter];

  const { data, isLoading, isFetching, error, refetch } = useQuery<HealthCheckResult>({
    queryKey: ['health-check', appFilter],
    queryFn: async () => {
      const r = await authFetch(endpoint);
      if (!r.ok) throw new Error(`Health check failed: ${r.statusText}`);
      return r.json();
    },
    // Don't refetch on window focus — we want this triggered by the
    // user clicking Refresh, not silently in the background.
    refetchOnWindowFocus: false,
  });

  return (
    <div className="p-6 max-w-4xl">
      <PageHeader
        icon={Activity}
        title={pageTitle}
        subtitle="Verify your local data still references valid Opera codes. Run after upgrades or when something looks off."
      >
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-2 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
          {isFetching ? 'Running…' : 'Run check'}
        </button>
      </PageHeader>

      {isLoading && <div className="mt-6"><LoadingState message="Running health check…" /></div>}

      {error && (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
          <AlertTriangle className="w-5 h-5 text-red-500 mt-0.5" />
          <div>
            <p className="text-sm text-red-800 font-medium">Health check failed</p>
            <p className="text-sm text-red-700">{(error as Error).message}</p>
          </div>
        </div>
      )}

      {data && (
        <div className="mt-6 space-y-4">
          <OverallStatus result={data} />
          <div className="space-y-2">
            {data.checks.map((c, i) => (
              <CheckRow key={i} check={c} />
            ))}
          </div>
          <Metadata data={data.metadata} />
        </div>
      )}
    </div>
  );
}

function OverallStatus({ result }: { result: HealthCheckResult }) {
  const cls = result.healthy
    ? 'bg-green-50 border-green-200'
    : 'bg-amber-50 border-amber-200';
  const Icon = result.healthy ? CheckCircle2 : AlertTriangle;
  const iconCls = result.healthy ? 'text-green-600' : 'text-amber-600';

  return (
    <div className={`p-4 rounded-lg border flex items-start gap-3 ${cls}`}>
      <Icon className={`w-6 h-6 ${iconCls} mt-0.5 flex-shrink-0`} />
      <div className="flex-1">
        <p className="font-medium text-gray-800">
          {result.healthy ? 'Healthy' : 'Issues found'}
        </p>
        <p className="text-sm text-gray-700 mt-0.5">{result.summary}</p>
      </div>
    </div>
  );
}

function CheckRow({ check }: { check: HealthCheckItem }) {
  const StatusIcon = check.passed ? CheckCircle2 : check.severity === 'error' ? XCircle : AlertTriangle;
  const iconCls = check.passed
    ? 'text-green-600'
    : check.severity === 'error'
      ? 'text-red-600'
      : check.severity === 'info'
        ? 'text-blue-600'
        : 'text-amber-600';
  const sevCls = check.passed
    ? 'border-gray-200 bg-white'
    : check.severity === 'error'
      ? 'border-red-200 bg-red-50'
      : check.severity === 'info'
        ? 'border-blue-200 bg-blue-50'
        : 'border-amber-200 bg-amber-50';

  return (
    <details className={`rounded-lg border ${sevCls}`}>
      <summary className="p-3 flex items-start gap-3 cursor-pointer">
        <StatusIcon className={`w-5 h-5 ${iconCls} mt-0.5 flex-shrink-0`} />
        <div className="flex-1">
          <div className="flex items-center justify-between">
            <p className="font-medium text-gray-800">{check.name}</p>
            <span className="text-xs text-gray-500">
              {check.total_checked > 0 && (
                <>
                  {check.total_checked.toLocaleString()} checked
                  {check.orphan_count > 0 && (
                    <span className="text-amber-700 ml-2">
                      • {check.orphan_count.toLocaleString()} orphan{check.orphan_count !== 1 ? 's' : ''}
                    </span>
                  )}
                </>
              )}
            </span>
          </div>
          <p className="text-sm text-gray-600 mt-0.5">{check.description}</p>
        </div>
      </summary>
      {check.orphans.length > 0 && (
        <div className="px-3 pb-3 pt-1 border-t border-gray-200">
          <p className="text-xs font-medium text-gray-700 mb-1">
            {check.orphans.length} of {check.orphan_count} orphans shown
          </p>
          <div className="space-y-1 text-xs font-mono">
            {check.orphans.map((o, i) => (
              <div key={i} className="bg-white p-2 rounded border border-gray-200">
                {Object.entries(o).map(([k, v]) => (
                  <div key={k}>
                    <span className="text-gray-500">{k}:</span>{' '}
                    <span className="text-gray-800">{String(v)}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </details>
  );
}

function Metadata({ data }: { data: Record<string, unknown> }) {
  if (!data || Object.keys(data).length === 0) return null;
  return (
    <details className="text-xs text-gray-500">
      <summary className="cursor-pointer flex items-center gap-1">
        <Info className="w-3 h-3" /> Run details
      </summary>
      <pre className="mt-1 p-2 bg-gray-50 rounded overflow-x-auto">
        {JSON.stringify(data, null, 2)}
      </pre>
    </details>
  );
}

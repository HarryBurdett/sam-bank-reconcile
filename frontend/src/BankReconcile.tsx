/**
 * Bank Reconciliation plugin entry component.
 *
 * Renders four vendored legacy pages behind a top-tab nav:
 *   - Bank Statements (BankStatementHub — Load Statements / Process & Import
 *                       / Reconcile / Manage sub-tabs internally)
 *   - Health Check    (HealthCheck — aliases + history reference Opera codes)
 *   - Cleardown       (Cleardown — reset routine flags)
 *   - Settings        (Settings — folders, recurring entries, opera mapping, email)
 *
 * Mirrors the sam-gocardless GitHub repo pattern (GoCardless.tsx). SAM
 * AppShell still owns global chrome (top bar, app switcher) when running
 * SAM-plugged; in the standalone host, this tab bar is the only nav.
 */
import { useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Landmark, Activity, RotateCcw, Settings as SettingsIcon, LogOut } from 'lucide-react';
import type { SamPluginContext } from './sam';
import { setSamContext } from './api-shim';
import { BankStatementHub } from './BankStatementHub';
import { HealthCheck } from './HealthCheck';
import { Cleardown } from './Cleardown';
import { Settings } from './Settings';

type Tab = 'bank-statements' | 'health' | 'cleardown' | 'settings';

const TABS: ReadonlyArray<{ id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'bank-statements', label: 'Bank Statements', icon: Landmark },
  { id: 'health', label: 'Health Check', icon: Activity },
  { id: 'cleardown', label: 'Cleardown', icon: RotateCcw },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
];

export default function BankReconcile({ context }: { context: SamPluginContext }) {
  // Wire the api-shim BEFORE the child's first render so vendored pages'
  // mount-time useQuery hooks see a populated samApi.
  setSamContext(context);

  useEffect(() => {
    setSamContext(context);
  }, [context]);

  const [tab, setTab] = useState<Tab>('bank-statements');

  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false },
        },
      }),
    [],
  );

  const companyLabel = context.currentCompany?.name ?? context.currentCompany?.code ?? null;

  async function handleLogout() {
    try {
      await fetch('/auth/logout', { method: 'POST' });
    } finally {
      window.location.href = '/login.html';
    }
  }

  return (
    <div className="bank-reconcile-app">
      <QueryClientProvider client={queryClient}>
        <div className="min-h-screen bg-gray-50">
          <div className="border-b border-gray-200 bg-white">
            <div className="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between">
              <nav className="flex items-center gap-1">
                {TABS.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setTab(id)}
                    className={
                      'flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ' +
                      (tab === id
                        ? 'bg-blue-50 text-blue-700'
                        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900')
                    }
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                  </button>
                ))}
              </nav>
              <div className="flex items-center gap-3">
                {companyLabel && (
                  <span className="text-xs px-2 py-1 bg-gray-100 text-gray-700 rounded-full font-medium">
                    {companyLabel}
                  </span>
                )}
                <button
                  type="button"
                  onClick={handleLogout}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
                  title="Log out / switch company"
                >
                  <LogOut className="h-4 w-4" />
                  Log out
                </button>
              </div>
            </div>
          </div>

          <div className="max-w-7xl mx-auto px-6 py-6">
            {tab === 'bank-statements' && <BankStatementHub />}
            {tab === 'health' && <HealthCheck appFilter="bank_reconcile" />}
            {tab === 'cleardown' && <Cleardown appFilter="bank_reconcile" />}
            {tab === 'settings' && <Settings />}
          </div>
        </div>
      </QueryClientProvider>
    </div>
  );
}

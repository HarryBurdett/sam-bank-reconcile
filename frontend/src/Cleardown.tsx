import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  RotateCcw, FileText, CreditCard, EyeOff, Brain,
  Link2, FileSearch, AlertTriangle, CheckCircle, X, CheckSquare, Square
} from 'lucide-react';
import { authFetch } from './api-shim';
import apiClient from './api-shim';
import { PageHeader, LoadingState } from './PageHeader';

// Each cleardown option is tagged with the app(s) it belongs to.
// The SystemReset component filters by `appFilter` prop so each app
// shows only its own cleardown options in its own menu.
type AppName = 'bank_reconcile' | 'gocardless' | 'suppliers';

interface ResetOption {
  id: string;
  action: string;
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  tables: string[];
  apps: AppName[];   // which apps this cleardown belongs to
}

const RESET_OPTIONS: ResetOption[] = [
  {
    id: 'bank_imports',
    action: 'bank_imports',
    title: 'Bank Import History',
    description: 'Bank statement import records and transaction lines. Does not affect Opera.',
    icon: FileText,
    tables: ['bank_statement_imports', 'bank_statement_transactions'],
    apps: ['bank_reconcile'],
  },
  {
    id: 'gocardless_imports',
    action: 'gocardless_imports',
    title: 'GoCardless Import History',
    description: 'GoCardless payout import records. Does not affect Opera.',
    icon: CreditCard,
    tables: ['gocardless_imports'],
    apps: ['gocardless'],
  },
  {
    id: 'ignored_transactions',
    action: 'ignored_transactions',
    title: 'Ignored Transactions',
    description: 'Transactions marked as "ignore" during bank imports. Items will reappear as unmatched.',
    icon: EyeOff,
    tables: ['ignored_bank_transactions'],
    apps: ['bank_reconcile'],
  },
  {
    id: 'learned_patterns',
    action: 'learned_patterns',
    title: 'Learned Patterns',
    description: 'Auto-learned transaction patterns (nominal codes, VAT codes, types). System will re-learn.',
    icon: Brain,
    tables: ['bank_import_patterns'],
    apps: ['bank_reconcile'],
  },
  {
    id: 'learned_aliases',
    action: 'learned_aliases',
    title: 'Learned Aliases',
    description: 'Auto-learned bank description aliases (customer/supplier name mappings). System will re-learn.',
    icon: Link2,
    tables: ['bank_import_aliases', 'ai_suggestions', 'repeat_entry_aliases'],
    apps: ['bank_reconcile'],
  },
  {
    id: 'pdf_cache',
    action: 'pdf_cache',
    title: 'PDF Extraction Cache',
    description: 'Cached PDF extraction results. Statements will be re-extracted from PDF on next import.',
    icon: FileSearch,
    tables: ['extraction_cache'],
    apps: ['bank_reconcile', 'suppliers'],
  },
];

function getOptionCount(option: ResetOption, counts: Record<string, number>): number {
  return option.tables.reduce((sum, t) => sum + (counts[t] || 0), 0);
}

interface SystemResetProps {
  /** Restrict visible cleardown options to one app's items only.
   *  Per-app routes pass this so each app shows only its own
   *  cleardowns in its own menu (matches the per-app independence
   *  architecture). When unset (default), shows everything — used
   *  by admin-level full-reset flows. */
  appFilter?: AppName;
  /** Optional title override (default: "Routines Cleardown"). */
  title?: string;
}

export function Cleardown({ appFilter, title }: SystemResetProps = {}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<{ total: number; companyName: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Filter to options for the selected app (or show all when unset)
  const visibleOptions = appFilter
    ? RESET_OPTIONS.filter(o => o.apps.includes(appFilter))
    : RESET_OPTIONS;

  // Fetch current company info
  const { data: companiesData } = useQuery({
    queryKey: ['companies'],
    queryFn: async () => {
      const response = await apiClient.getCompanies();
      return response.data;
    },
  });

  const currentCompany = companiesData?.current_company;
  const companyName = currentCompany?.name || '';

  // Fetch counts for the current company
  const { data, isLoading } = useQuery({
    queryKey: ['system-reset-counts'],
    queryFn: async () => {
      const response = await authFetch('/api/admin/system-reset/counts');
      if (!response.ok) {
        const err = await response.json().catch(() => ({ detail: 'Failed to fetch counts' }));
        throw new Error(err.detail || 'Failed to fetch counts');
      }
      return response.json();
    },
  });

  const counts: Record<string, number> = data?.counts || {};
  const totalSelected = visibleOptions
    .filter(o => selected.has(o.id))
    .reduce((sum, o) => sum + getOptionCount(o, counts), 0);
  const allSelected = visibleOptions.length > 0 && selected.size === visibleOptions.length;

  const toggleOption = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    setConfirmOpen(false);
  };

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(visibleOptions.map(o => o.id)));
    }
    setConfirmOpen(false);
  };

  const handleExecute = async () => {
    if (selected.size === 0) return;
    setExecuting(true);
    setError(null);
    setResult(null);

    try {
      const actions = Array.from(selected);
      const response = await authFetch('/api/admin/system-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actions }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ detail: 'Reset failed' }));
        throw new Error(err.detail || 'Reset failed');
      }

      const data = await response.json();
      setResult({ total: data.total_deleted, companyName: companyName });
      setSelected(new Set());
      setConfirmOpen(false);
      queryClient.invalidateQueries({ queryKey: ['system-reset-counts'] });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'An unexpected error occurred');
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="p-6 max-w-4xl">
      <PageHeader icon={RotateCcw} title={title || 'Routines Cleardown'} subtitle={`Clear application data and caches${companyName ? ` for ${companyName}` : ''}. Opera transactions are never affected.`} />

      {/* Success feedback */}
      {result && (
        <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-lg flex items-start gap-2">
          <CheckCircle className="w-5 h-5 text-green-500 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <p className="text-sm text-green-800 font-medium">Cleardown complete — {result.companyName}</p>
            <p className="text-sm text-green-700">{result.total.toLocaleString()} record{result.total !== 1 ? 's' : ''} deleted.</p>
          </div>
          <button onClick={() => setResult(null)} className="text-green-400 hover:text-green-600">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Error feedback */}
      {error && (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
          <AlertTriangle className="w-5 h-5 text-red-500 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <p className="text-sm text-red-800 font-medium">Cleardown failed</p>
            <p className="text-sm text-red-700">{error}</p>
          </div>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Loading counts */}
      {isLoading ? (
        <div className="mt-6"><LoadingState message="Loading record counts..." /></div>
      ) : (
        <div className="mt-6">
          {/* Select All / Clear Selected header */}
          <div className="flex items-center justify-between mb-3">
            <button
              onClick={toggleAll}
              disabled={executing}
              className="flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-blue-600 transition-colors disabled:opacity-50"
            >
              {allSelected
                ? <CheckSquare className="w-4 h-4 text-blue-600" />
                : <Square className="w-4 h-4 text-gray-400" />
              }
              Select All
            </button>
            {selected.size > 0 && (
              <span className="text-xs text-gray-500">
                {selected.size} of {visibleOptions.length} selected ({totalSelected.toLocaleString()} records)
              </span>
            )}
          </div>

          {/* Options list */}
          <div className="space-y-2">
            {visibleOptions.map((option) => {
              const Icon = option.icon;
              const count = getOptionCount(option, counts);
              const isSelected = selected.has(option.id);

              return (
                <div
                  key={option.id}
                  onClick={() => !executing && toggleOption(option.id)}
                  className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                    isSelected
                      ? 'border-blue-300 bg-blue-50'
                      : 'border-gray-200 bg-white hover:border-gray-300'
                  } ${executing ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {/* Checkbox */}
                  {isSelected
                    ? <CheckSquare className="w-5 h-5 text-blue-600 flex-shrink-0" />
                    : <Square className="w-5 h-5 text-gray-300 flex-shrink-0" />
                  }

                  {/* Icon */}
                  <div className={`p-1.5 rounded-md ${isSelected ? 'bg-blue-100' : 'bg-gray-100'}`}>
                    <Icon className={`w-4 h-4 ${isSelected ? 'text-blue-600' : 'text-gray-500'}`} />
                  </div>

                  {/* Text */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className={`text-sm font-medium ${isSelected ? 'text-blue-900' : 'text-gray-900'}`}>{option.title}</h3>
                      {count > 0 && (
                        <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                          isSelected ? 'bg-blue-200 text-blue-800' : 'bg-gray-200 text-gray-600'
                        }`}>
                          {count.toLocaleString()}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">{option.description}</p>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Action bar */}
          <div className="mt-4 border-t border-gray-200 pt-4">
            {!confirmOpen ? (
              <button
                onClick={() => setConfirmOpen(true)}
                disabled={selected.size === 0 || executing}
                className={`px-4 py-2 text-sm font-medium rounded-md text-white transition-colors ${
                  selected.size === 0 || executing
                    ? 'bg-gray-300 cursor-not-allowed'
                    : 'bg-red-600 hover:bg-red-700'
                }`}
              >
                Clear Selected ({totalSelected.toLocaleString()} records)
              </button>
            ) : (
              <div className="flex items-center gap-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0" />
                <p className="text-sm text-amber-800 flex-1">
                  Permanently delete {totalSelected.toLocaleString()} record{totalSelected !== 1 ? 's' : ''} from <strong>{companyName}</strong>? This cannot be undone.
                </p>
                <div className="flex gap-2 flex-shrink-0">
                  <button
                    onClick={handleExecute}
                    disabled={executing}
                    className="px-4 py-1.5 text-sm font-medium rounded-md text-white bg-red-600 hover:bg-red-700 transition-colors disabled:opacity-50"
                  >
                    {executing ? 'Clearing...' : 'Confirm'}
                  </button>
                  <button
                    onClick={() => setConfirmOpen(false)}
                    disabled={executing}
                    className="px-4 py-1.5 text-sm font-medium rounded-md text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

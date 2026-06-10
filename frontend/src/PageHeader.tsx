import type { ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';

/**
 * Single source of truth for the version label rendered next to
 * every page header (e.g. "Bank Statements - Live Version 1.4").
 * Bump on each release.
 *
 * 1.4 — Phase B2+B3 of per-company isolation: migration 020 +
 *       companyCode plumbed through every remaining per-company
 *       table — bank_statement_imports, bank_statement_transactions,
 *       alias_corrections, deferred_transactions, repeat_entry_aliases,
 *       import_locks (composite (company_code, bank_code) UNIQUE),
 *       ignored_bank_transactions, file_archive_log,
 *       duplicate_overrides, negative_aliases (composite UNIQUE),
 *       extraction_cache, ai_suggestions. Cross-tenant isolation
 *       is now complete across the entire plugin.
 *
 * 1.3 — Phase B1: migration 019 + companyCode plumbed through
 *       bank_import_drafts, match_config, and bank_import_aliases.
 *
 * 1.2 — Phase A: migration 018 + companyScope fail-loud helper +
 *       companyCode plumbed through settings, folder-settings,
 *       folder-backed-storage, scan-all-banks, check-recurring-entries.
 */
export const LIVE_VERSION = '1.4';

interface PageHeaderProps {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string;
  children?: ReactNode;
}

export function PageHeader({ icon: Icon, title, subtitle, children }: PageHeaderProps) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center">
          <Icon className="h-5 w-5 text-blue-600" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-gray-900">
            {title}
            <span className="ml-2 text-xs font-medium text-gray-400">
              Live Version {LIVE_VERSION}
            </span>
          </h1>
          {subtitle && <p className="text-sm text-gray-500">{subtitle}</p>}
        </div>
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}

interface LoadingStateProps {
  message?: string;
  size?: 'sm' | 'md' | 'lg';
}

const sizeClasses = {
  sm: { icon: 'h-4 w-4', text: 'text-sm', padding: 'py-4' },
  md: { icon: 'h-6 w-6', text: 'text-sm', padding: 'py-12' },
  lg: { icon: 'h-8 w-8', text: 'text-base', padding: 'py-20' },
};

export function LoadingState({ message, size = 'md' }: LoadingStateProps) {
  const s = sizeClasses[size];
  return (
    <div className={`flex flex-col items-center justify-center ${s.padding}`}>
      <RefreshCw className={`${s.icon} animate-spin text-blue-500 mb-3`} />
      {message && <p className={`${s.text} text-gray-500`}>{message}</p>}
    </div>
  );
}

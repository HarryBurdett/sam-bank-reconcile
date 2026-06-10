import type { ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';

/**
 * Single source of truth for the version label rendered next to
 * every page header (e.g. "Bank Statements - Live Version 1.4").
 *
 * The value is injected at BUILD TIME by Vite via the `define`
 * block in vite.config.ts, which reads `package.json#version`.
 * Future releases only need to bump package.json + manifest.json
 * — this label updates automatically. No more three-place edits.
 *
 * Falls back to 'dev' when the global isn't defined (e.g. running
 * a non-Vite test harness directly against the source).
 *
 * Display form is `major.minor` (e.g. "1.4") to match the existing
 * label convention. The full semver remains in __APP_VERSION__ if
 * a more precise display is ever wanted.
 */
declare const __APP_VERSION__: string | undefined;

const FULL_VERSION =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

export const LIVE_VERSION =
  FULL_VERSION === 'dev'
    ? 'dev'
    : FULL_VERSION.split('.').slice(0, 2).join('.');

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

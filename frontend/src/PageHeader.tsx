import type { ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';

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
          <h1 className="text-xl font-bold text-gray-900">{title}</h1>
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

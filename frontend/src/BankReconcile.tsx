/**
 * Bank Reconciliation plugin entry component.
 *
 * Mounts the full ported `BankStatementReconcile` page (5,400+ lines
 * lifted from the legacy `frontend/src/pages/BankStatementReconcile.tsx`)
 * inside SAM's plugin shell. The legacy page expects:
 *
 *   - `apiClient` / `authFetch` — provided by `./api-shim.ts`, which we
 *     bind to SAM's `context.api` for the lifetime of the component.
 *   - `useQuery` / `useMutation` — needs a `QueryClientProvider`, which
 *     we instantiate once per mount.
 *   - `useSearchParams` / `useVoice` — stubbed inside the page itself
 *     (see top of BankStatementReconcile.tsx).
 *
 * After this wrapper is mounted, every `apiClient.*` call the legacy
 * page makes resolves against `context.api.fetch`, automatically
 * including `X-Opera-Company` for the active SAM tenant.
 */
import { useEffect, useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SamPluginContext } from './sam';
import { setSamContext } from './api-shim';
import { BankStatementReconcile } from './BankStatementReconcile';

export default function BankReconcile({
  context,
}: {
  context: SamPluginContext;
}) {
  // Ensure api-shim points at this SAM context for the duration of the
  // component's lifetime. Re-wires whenever the context object changes
  // (rare — at most when SAM swaps tenants).
  useEffect(() => {
    setSamContext(context);
    return () => {
      // Don't blank out on unmount — other in-flight callbacks may
      // still resolve. SAM remounts the component when ctx changes,
      // and the next setSamContext will overwrite cleanly.
    };
  }, [context]);

  // One QueryClient per plugin mount — react-query keeps cache state
  // here, and we don't want to share it with other SAM plugins.
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      }),
    [],
  );

  return (
    <div className="bank-reconcile-app">
      <QueryClientProvider client={queryClient}>
        <BankStatementReconcile />
      </QueryClientProvider>
    </div>
  );
}

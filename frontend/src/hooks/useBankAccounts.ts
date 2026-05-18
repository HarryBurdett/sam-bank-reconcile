/**
 * Single source of truth for the bank-account list.
 *
 * Every page that needs the list of Opera bank accounts uses this
 * hook instead of rolling its own useState + useQuery + useEffect.
 * That eliminates the recurring class of bug where:
 *
 *   - Some page expected `data.accounts`, others `data.banks`, others
 *     `data.bank_accounts` — and silently rendered empty when the BE
 *     shape disagreed.
 *   - Some page gated `setBankAccounts` on `currentCompanyId` — which
 *     resolves to '' in the standalone host and blocked the
 *     population entirely.
 *   - Different components hit different endpoint paths
 *     (`/opera-sql/bank-accounts` was 404 after the routes
 *     consolidated; `/cashbook/bank-accounts` is the truth).
 *
 * One hook owns all of that. Any future BE shape change is one fix
 * in one place.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { authFetch } from '../api-shim';

export interface BankAccount {
  code: string;
  description: string;
  /** Bank's sort code (e.g. "04-00-04"). Empty string when unknown. */
  sort_code: string;
  /** Account number digits. Empty string when unknown. */
  account_number: string;
}

export interface UseBankAccountsResult {
  accounts: BankAccount[];
  isLoading: boolean;
  isError: boolean;
  error: string | null;
  /** Re-fetch from the BE (e.g. after a company switch). */
  refresh: () => void;
}

/**
 * Pure normaliser — extracted from the hook so it can be unit-tested
 * without React Testing Library. The hook composes this with
 * react-query; tests pin the response shapes against this directly.
 *
 * Accepts any of `banks`, `accounts`, or `bank_accounts` as the array
 * key so a future BE rename doesn't silently empty the dropdown again.
 * Returns [] on null / non-success / unknown shape — never throws.
 */
export function normaliseBankAccountsResponse(data: unknown): BankAccount[] {
  if (!data || typeof data !== 'object') return [];
  const d = data as Record<string, unknown>;
  if (d.success !== true) return [];
  const raw = Array.isArray(d.banks)
    ? d.banks
    : Array.isArray(d.accounts)
      ? d.accounts
      : Array.isArray(d.bank_accounts)
        ? d.bank_accounts
        : null;
  if (!raw) return [];
  return raw.map((b: Record<string, unknown>) => ({
    code: String(b.code ?? ''),
    // Some BE responses use `description`, others `name`. Accept
    // either so the dropdown labels stay populated.
    description: String(b.description ?? b.name ?? ''),
    sort_code: b.sort_code ? String(b.sort_code) : '',
    account_number: b.account_number ? String(b.account_number) : '',
  }));
}

/**
 * Fetches `/api/cashbook/bank-accounts` once per session (cached by
 * react-query) and normalises the response into a stable
 * `BankAccount[]` via `normaliseBankAccountsResponse`.
 */
export function useBankAccounts(): UseBankAccountsResult {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['bank-accounts'],
    queryFn: async () => {
      const res = await authFetch(`/api/cashbook/bank-accounts`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000, // 5 minutes — bank list rarely changes mid-session
  });

  const accounts = useMemo<BankAccount[]>(
    () => normaliseBankAccountsResponse(data),
    [data],
  );

  return {
    accounts,
    isLoading,
    isError,
    error: error ? (error instanceof Error ? error.message : String(error)) : null,
    refresh: () => {
      void refetch();
    },
  };
}

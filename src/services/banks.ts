/**
 * Bank account listing — faithful port of `get_bank_accounts()` from
 * apps/bank_reconcile/api/routes.py:280.
 *
 * Returns the bank accounts available for reconciliation, sourced from
 * Opera's nbank table. Read-only.
 */
import type { Knex } from 'knex';

export interface BankAccount {
  account_code: string;
  description: string;
  sort_code: string;
  account_number: string;
}

export interface BanksResponse {
  success: boolean;
  banks: BankAccount[];
  error?: string;
}

export async function listBanks(operaDb: Knex): Promise<BanksResponse> {
  try {
    const rows = (await operaDb.raw(`
      SELECT nk_acnt AS account_code, RTRIM(nk_desc) AS description,
             nk_sort AS sort_code, nk_number AS account_number
      FROM nbank WITH (NOLOCK)
      ORDER BY nk_acnt
    `)) as unknown as Array<{
      account_code: string | null;
      description: string | null;
      sort_code: string | null;
      account_number: string | null;
    }>;

    const banks: BankAccount[] = (Array.isArray(rows) ? rows : []).map((b) => ({
      account_code: (b.account_code ?? '').trim(),
      description: (b.description ?? '').trim(),
      sort_code: (b.sort_code ?? '').trim(),
      account_number: (b.account_number ?? '').trim(),
    }));

    return { success: true, banks };
  } catch (err: any) {
    return { success: false, banks: [], error: err?.message ?? String(err) };
  }
}

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
export declare function listBanks(operaDb: Knex): Promise<BanksResponse>;
//# sourceMappingURL=banks.d.ts.map
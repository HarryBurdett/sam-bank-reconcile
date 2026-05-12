/**
 * Cashbook entry creation endpoints.
 *
 * Faithful ports of:
 *   - get_cashbook_bank_accounts (routes.py:11488) — list nbank
 *   - create_cashbook_entry (routes.py:11340) — manual single entry
 *   - create_bank_transfer (routes.py:11517) — at_type=8 paired
 *   - auto_match_statement_lines (routes.py:10959) — bulk match by ref
 *
 * For create-entry / create-bank-transfer, the actual posting body
 * is delegated to the existing bankImportPostingExecutor (which
 * already handles all 7 transaction types). This file just shapes
 * the request and forwards.
 */
import type { Knex } from 'knex';
export interface CashbookBankAccount {
    code: string;
    description: string;
    current_balance: number | null;
    reconciled_balance: number | null;
    sort_code: string;
    account_number: string;
}
export declare function listCashbookBankAccounts(operaDb: Knex): Promise<{
    success: boolean;
    banks: CashbookBankAccount[];
    error?: string;
}>;
export interface CreateCashbookEntryInput {
    bankCode: string;
    date: string;
    amount: number;
    matchedAccount: string;
    action: 'sales_receipt' | 'purchase_payment' | 'sales_refund' | 'purchase_refund' | 'nominal_payment' | 'nominal_receipt';
    reference?: string;
    memo?: string;
    cbtype?: string | null;
}
export declare function createCashbookEntry(operaDb: Knex, input: CreateCashbookEntryInput): Promise<{
    success: boolean;
    records_imported: number;
    errors: string[];
    warnings: string[];
}>;
export interface CreateBankTransferInput {
    sourceBank: string;
    destBank: string;
    amount: number;
    date: string;
    reference?: string;
    memo?: string;
}
export declare function createBankTransfer(operaDb: Knex, input: CreateBankTransferInput): Promise<{
    success: boolean;
    records_imported: number;
    errors: string[];
}>;
export declare function autoMatchStatementLines(operaDb: Knex, bankCode: string, importId: number): Promise<{
    success: boolean;
    matched: number;
    total: number;
    error?: string;
}>;
//# sourceMappingURL=cashbook-create.d.ts.map
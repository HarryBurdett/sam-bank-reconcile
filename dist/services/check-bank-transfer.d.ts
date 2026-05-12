/**
 * Bank-transfer detection — flag transactions that move money between
 * two Opera bank accounts (rather than to/from a customer or supplier).
 *
 * Faithful port of `_check_bank_transfer`
 * (sql_rag/bank_import.py:1229-1295) plus its helper
 * `_load_other_bank_accounts` (1198-1228).
 *
 * Match strategy (per legacy audit 2026-05-05 stages-1-2 F7):
 *   1. Account-number match (≥6 digits): highly specific — accept on
 *      its own with confidence 1.0.
 *   2. Sort-code-only match (6 digits) is risky because invoice numbers
 *      and customer references can coincidentally embed a 6-digit
 *      subsequence. Only accept a sort-code match when:
 *        (a) the unnormalised text contains the literal dashed/spaced
 *            form (e.g. "20-96-89" or "20 96 89") — banks universally
 *            print sort codes that way, so a dashed match is much more
 *            reliable than a digit-substring match against random
 *            references.
 *
 * Works on Opera SE and Opera 3 — uses Knex builder, parameter binding
 * only, no MSSQL-specific syntax.
 */
import type { Knex } from 'knex';
export interface OtherBank {
    code: string;
    description: string;
    sort_code: string;
    account_number: string;
}
export interface BankTransferResult {
    is_transfer: boolean;
    dest_bank_code: string;
    dest_bank_description: string;
    match_score: number;
    match_source: 'bank_account_number' | 'bank_sort_code_formatted' | 'none';
}
/**
 * Load every other (non-this) Opera bank account that has either a
 * sort code or an account number — those are the only banks we can
 * meaningfully match against. Petty-cash and foreign-currency banks
 * are excluded (legacy filter).
 */
export declare function loadOtherBankAccounts(operaDb: Knex, thisBankCode: string): Promise<OtherBank[]>;
/**
 * Detect whether `(memo + name + reference)` describes a transfer to
 * another Opera bank account.
 */
export declare function checkBankTransfer(otherBanks: OtherBank[], memo: string, name: string, reference: string): BankTransferResult;
//# sourceMappingURL=check-bank-transfer.d.ts.map
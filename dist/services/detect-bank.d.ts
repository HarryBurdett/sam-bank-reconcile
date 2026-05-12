/**
 * Detect the Opera bank account a bank statement file belongs to.
 *
 * Faithful port of `BankStatementImport.find_bank_account_by_details`
 * (sql_rag/bank_import.py:663-697) and the wrapping endpoint
 * `detect_bank_from_file` (apps/bank_reconcile/api/routes.py:2369-2490).
 *
 * Two detection strategies on the file's first 30 lines:
 *   Method 1: regex sniff for sort code (XX-XX-XX) AND 8-digit account
 *             number anywhere in any line
 *   Method 2: CSV header-row scan — find a row containing 'date' AND
 *             'account' headers, then read the next data row's
 *             'Account' field (format: "20-96-89 90764205")
 *
 * Once sort code + account number are extracted, look them up against
 * Opera nbank — both sides are normalised (spaces and dashes
 * stripped) before comparison so "20-96-89" matches "209689", and
 * "9076 4205" matches "90764205".
 *
 * Returns the bank code (e.g. "BC010") or null when no match.
 */
import type { Knex } from 'knex';
export interface DetectedBankDetails {
    sort_code: string | null;
    account_number: string | null;
    /** Opera bank code (nbank.nk_acnt) or null */
    bank_code: string | null;
}
/**
 * Method 1: regex-scan lines for SORT-CODE + 8-digit account number
 * pair on the same line (mirrors Python's "look for both patterns,
 * break on first hit").
 */
export declare function sniffBankByRegex(lines: string[]): {
    sort_code: string;
    account_number: string;
} | null;
/**
 * Method 2: CSV header-row scan. Finds a header row that contains both
 * 'date' and 'account' (case-insensitive), then reads the next CSV data
 * row's 'Account' field (which has format "20-96-89 90764205").
 *
 * Implements a minimal CSV parser — quoted fields with comma separator.
 * Sufficient for the bank-statement formats we see (Barclays, HSBC,
 * Lloyds, NatWest); doesn't try to be a general-purpose CSV library.
 */
export declare function sniffBankByCsvHeader(lines: string[]): {
    sort_code: string;
    account_number: string;
} | null;
export declare function findBankAccountByDetails(operaDb: Knex, sortCode: string, accountNumber: string): Promise<string | null>;
export declare function detectBankFromContent(operaDb: Knex, content: string): Promise<DetectedBankDetails>;
//# sourceMappingURL=detect-bank.d.ts.map
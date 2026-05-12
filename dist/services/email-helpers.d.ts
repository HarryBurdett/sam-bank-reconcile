/**
 * Deterministic helpers for bank-reconcile scan-emails.
 *
 * Faithful ports of the pure helpers in `api/main.py`:
 *   - BANK_STATEMENT_PATTERNS / BANK_STATEMENT_EXTENSIONS / BANK_STATEMENT_CONTENT_TYPES
 *   - detect_bank_from_email             (api/main.py:10734)
 *   - extract_statement_number_from_filename (api/main.py:10761)
 *   - is_bank_statement_attachment       (api/main.py:10835)
 *
 * These are used by the scan-emails service to filter, classify and
 * sort bank-statement attachments without needing a database or
 * external services.
 */
export declare function detectBankFromEmail(fromAddress: string | null | undefined, filename: string | null | undefined, subject?: string | null | undefined): string | null;
export type StatementSortKey = readonly [number, number, number, number];
export interface StatementDateInfo {
    sort_key: StatementSortKey;
    display_date: string | null;
}
export declare function extractStatementNumberFromFilename(filename: string | null | undefined, subject?: string | null | undefined): StatementDateInfo;
export interface IsBankStatementInput {
    filename: string | null | undefined;
    contentType?: string | null;
    fromAddress?: string | null;
    subject?: string | null;
}
export declare function isBankStatementAttachment(input: IsBankStatementInput): boolean;
export declare function compareSortKeys(a: StatementSortKey, b: StatementSortKey): number;
//# sourceMappingURL=email-helpers.d.ts.map
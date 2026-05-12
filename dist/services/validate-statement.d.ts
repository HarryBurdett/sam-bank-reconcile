/**
 * Validate that a bank statement is ready for reconciliation.
 *
 * Faithful port of OperaSQLImport.validate_statement_for_reconciliation
 * (sql_rag/opera_sql_import.py:8285-8365) wrapped by the
 * /api/bank-reconciliation/validate-statement endpoint
 * (apps/bank_reconcile/api/routes.py:10198-10238).
 *
 * Checks:
 *   1. Opening balance matches Opera's expected (nbank.nk_recbal / 100)
 *      within 1p tolerance.
 *   2. Reports next-statement-number from nk_lststno + 1 (or the
 *      number supplied by the caller).
 */
import type { Knex } from 'knex';
export interface ValidateStatementInput {
    bankAccount: string;
    openingBalance: number;
    closingBalance: number;
    /** Statement number from the bank (optional). */
    statementNumber?: number | null;
    /** ISO date string YYYY-MM-DD. */
    statementDate?: string | null;
}
export interface ValidateStatementResponse {
    valid: boolean;
    expected_opening?: number;
    statement_opening?: number;
    statement_closing?: number;
    difference?: number;
    opening_matches?: boolean;
    next_statement_number?: number;
    statement_date?: string | null;
    error_message: string | null;
}
export declare function validateStatementForReconciliation(operaDb: Knex, input: ValidateStatementInput): Promise<ValidateStatementResponse>;
//# sourceMappingURL=validate-statement.d.ts.map
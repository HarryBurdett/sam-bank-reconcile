/**
 * Strict input validators for parameters that flow into Opera SQL.
 *
 * Faithful port of `sql_rag/sql_input_validator.py`. Used at every
 * route boundary that takes an Opera identifier from URL/query/body
 * before it reaches a query builder. Even though all routes are
 * auth-gated, an authorised user could craft a `bank_code` like
 * `BC010'; DROP TABLE atran--` — these validators reject anything
 * that isn't a documented Opera identifier shape.
 *
 * Each validator throws `SqlInputValidationError` on failure. Router
 * handlers should catch these and return 400 with the message.
 *
 * Patterns mirror Python's exactly:
 *   bank_code      [A-Z0-9_-]{1,12}              (case-insensitive)
 *   account_code   [A-Z0-9_./-]{1,16}            (case-insensitive)
 *   entry_number   [A-Z0-9_./-]{1,20}            (case-insensitive)
 *   cbtype         [A-Z0-9]{1,4}                 (case-insensitive)
 *   payment_ref    [A-Z0-9 _./\-]{1,30}          (case-insensitive)
 *   reference      [A-Z0-9 _./\-:#&,]{0,40}      (case-insensitive)
 *   batch_number   \d{1,9}
 *
 * Forbidden tokens (belt-and-braces beyond the regex):
 *   ' " ; -- /* *​/ \
 */
export declare class SqlInputValidationError extends Error {
    readonly statusCode: number;
    constructor(message: string);
}
export declare function validateBankCode(value: string | null | undefined): string;
export declare function validateAccountCode(value: string | null | undefined): string;
export declare function validateEntryNumber(value: string | null | undefined): string;
export declare function validateCbtype(value: string | null | undefined): string;
export declare function validatePaymentRef(value: string | null | undefined): string;
export declare function validateReference(value: string | null | undefined): string;
export declare function validateBatchNumber(value: string | number): number;
//# sourceMappingURL=sql-input-validators.d.ts.map
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

export class SqlInputValidationError extends Error {
  readonly statusCode: number = 400;
  constructor(message: string) {
    super(message);
    this.name = 'SqlInputValidationError';
  }
}

const BANK_CODE_RE = /^[A-Z0-9_-]{1,12}$/i;
const ACCOUNT_CODE_RE = /^[A-Z0-9_./-]{1,16}$/i;
const ENTRY_NUMBER_RE = /^[A-Z0-9_./-]{1,20}$/i;
const CBTYPE_RE = /^[A-Z0-9]{1,4}$/i;
const PAYMENT_REF_RE = /^[A-Z0-9 _./\-]{1,30}$/i;
const REFERENCE_RE = /^[A-Z0-9 _./\-:#&,]{0,40}$/i;
const BATCH_NUMBER_RE = /^\d{1,9}$/;

const FORBIDDEN_TOKENS = ["'", '"', ';', '--', '/*', '*/', '\\'];

function hasForbidden(value: string): string | null {
  for (const tok of FORBIDDEN_TOKENS) {
    if (value.includes(tok)) return tok;
  }
  return null;
}

export function validateBankCode(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    throw new SqlInputValidationError('bank_code required');
  }
  if (!BANK_CODE_RE.test(value)) {
    throw new SqlInputValidationError(
      `bank_code '${value}' is not a valid Opera bank code ` +
        '(alphanumeric/underscore/dash, max 12 chars).',
    );
  }
  const bad = hasForbidden(value);
  if (bad) {
    throw new SqlInputValidationError(
      `bank_code contains forbidden character '${bad}'.`,
    );
  }
  return value.trim();
}

export function validateAccountCode(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    throw new SqlInputValidationError('account code required');
  }
  if (!ACCOUNT_CODE_RE.test(value)) {
    throw new SqlInputValidationError(
      `account code '${value}' is not valid ` +
        '(alphanumeric/_/./-/, max 16 chars).',
    );
  }
  const bad = hasForbidden(value);
  if (bad) {
    throw new SqlInputValidationError(
      `account code contains forbidden character '${bad}'.`,
    );
  }
  return value.trim();
}

export function validateEntryNumber(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    throw new SqlInputValidationError('entry number required');
  }
  if (!ENTRY_NUMBER_RE.test(value)) {
    throw new SqlInputValidationError(
      `entry number '${value}' is not a valid Opera entry reference.`,
    );
  }
  const bad = hasForbidden(value);
  if (bad) {
    throw new SqlInputValidationError(
      `entry number contains forbidden character '${bad}'.`,
    );
  }
  return value.trim();
}

export function validateCbtype(value: string | null | undefined): string {
  if (!value) return '';
  if (!CBTYPE_RE.test(value)) {
    throw new SqlInputValidationError(
      `cbtype '${value}' is not valid (max 4 alphanumeric chars).`,
    );
  }
  return value.trim().toUpperCase();
}

export function validatePaymentRef(value: string | null | undefined): string {
  if (!value) {
    throw new SqlInputValidationError('payment_ref required');
  }
  if (!PAYMENT_REF_RE.test(value)) {
    throw new SqlInputValidationError(
      `payment_ref '${value}' contains invalid characters.`,
    );
  }
  const bad = hasForbidden(value);
  if (bad) {
    throw new SqlInputValidationError(
      `payment_ref contains forbidden character '${bad}'.`,
    );
  }
  return value.trim();
}

export function validateReference(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (!REFERENCE_RE.test(s)) {
    throw new SqlInputValidationError(
      `reference '${s}' contains invalid characters.`,
    );
  }
  const bad = hasForbidden(s);
  if (bad) {
    throw new SqlInputValidationError(
      `reference contains forbidden character '${bad}'.`,
    );
  }
  return s.trim();
}

export function validateBatchNumber(value: string | number): number {
  const s = String(value);
  if (!BATCH_NUMBER_RE.test(s)) {
    throw new SqlInputValidationError(
      `batch number '${value}' must be digits only (max 9 chars).`,
    );
  }
  return parseInt(s, 10);
}

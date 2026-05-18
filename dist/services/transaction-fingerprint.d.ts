/**
 * Stable fingerprint for a bank-statement transaction line, used to
 * detect "is this the same line we've already stored?" when a
 * cumulative bank (Monzo etc.) re-issues a statement extending an
 * earlier one.
 *
 * Components:
 *   - post_date         (YYYY-MM-DD)
 *   - amount.toFixed(2) (signed, 2 decimal places — accounting
 *                         amounts are always integer pence)
 *   - description       (trimmed, lowercased, first 64 chars)
 *
 * The description trim/lowercase is tolerant of minor bank
 * re-normalisation between pulls (Monzo sometimes trims trailing
 * spaces or re-cases payee names). 64-char truncation handles
 * cases where the bank later adds extra detail to a previously-
 * short description.
 */
export declare function fingerprintTransactionLine(postDate: string, amount: number, description: string | null | undefined): string;
//# sourceMappingURL=transaction-fingerprint.d.ts.map
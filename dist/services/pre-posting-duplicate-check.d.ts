/**
 * Pre-posting cashbook duplicate check.
 *
 * Faithful port of `OperaSQLImport.check_duplicate_before_posting`
 * (sql_rag/opera_sql_import.py:8099) + the cashbook leg of
 * `check_for_duplicate` (sql_rag/duplicate_check.py:139) +
 * `OperaSEDataSource.find_aentry_by_signed_value`
 * (sql_rag/duplicate_check_se.py:21).
 *
 * The legacy import loop (routes.py:4317-4348) calls this before
 * every cashbook write. It catches duplicates that appeared between
 * the time the statement was matched and the time the import is
 * actually run — e.g. an Opera user posted a receipt manually in the
 * intervening minutes. The `excludeEntryNumbers` set lets the loop
 * tell the check "I already claimed these aentries earlier in this
 * batch — don't re-detect them" so two identical-amount transactions
 * on one statement allocate to different existing aentries.
 *
 * Type-aware AND sign-aware: a +£X receipt is never a duplicate of a
 * -£X refund. We filter aentry by at_type for the action and compare
 * ae_value (signed pence) to the signed transaction amount.
 *
 * Only handles the CASHBOOK branch — the legacy LEDGER_ALLOCATION_TARGET
 * (stran/ptran refund hint) is informational and the caller posts
 * anyway. Not yet ported.
 */
import type { Knex } from 'knex';
export interface PrePostingDuplicateCheckArgs {
    operaDb: Knex;
    bankCode: string;
    transactionDate: string;
    /** Signed pounds — receipts positive, payments negative. */
    signedAmountPounds: number;
    action: string;
    /** Aentries already claimed earlier in this batch. Excluded from the
     *  match so identical-amount transactions hit distinct existing rows. */
    excludeEntryNumbers?: Iterable<string>;
    /** Default 1 — matches the routes.py:4327 call site. The wider
     *  default in duplicate_check.py (14) is for offline analysis. */
    dateToleranceDays?: number;
    description?: string;
    /** Customer/supplier code from the matcher. Required for the
     *  LEDGER_ALLOCATION_TARGET branch — refunds against an unknown
     *  account can't look up a credit-note target. */
    accountCode?: string | null;
}
export interface PrePostingDuplicateCheckResult {
    isDuplicate: boolean;
    entryNumber: string | null;
    reason: string;
    /**
     * Informational hint surfaced for refund actions when the cashbook
     * is clean but a matching credit-note row exists in stran/ptran.
     * Caller still posts the refund — this row is the suggested
     * allocation target, mirroring the legacy
     * LEDGER_ALLOCATION_TARGET branch (duplicate_check.py:205-241).
     */
    ledgerAllocationHint?: {
        table: 'stran' | 'ptran';
        ref: string | null;
        trtype: string;
        value: number;
        reason: string;
    } | null;
}
export declare function checkCashbookDuplicateBeforePosting(args: PrePostingDuplicateCheckArgs): Promise<PrePostingDuplicateCheckResult>;
//# sourceMappingURL=pre-posting-duplicate-check.d.ts.map
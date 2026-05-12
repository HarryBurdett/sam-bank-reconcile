/**
 * Record a "user-confirmed not a duplicate" override.
 *
 * Faithful port of `override_duplicate` in
 * `apps/bank_reconcile/api/routes.py:2961-3003`.
 *
 * When the duplicate-detection pipeline flags a bank statement line as
 * a possible duplicate but the user chooses to import it anyway, we
 * record the decision so:
 *   - the same line never gets re-flagged in subsequent imports
 *   - we have an audit trail of who-bypassed-what-and-why
 *
 * Stored in `duplicate_overrides` (per-app DB) keyed by transaction
 * hash. Upsert semantics: re-overriding the same hash updates the
 * reason and timestamp.
 */
import type { Knex } from 'knex';
export interface RecordDuplicateOverrideInput {
    transactionHash: string;
    reason: string;
    userCode?: string | null;
}
export interface RecordDuplicateOverrideResponse {
    success: boolean;
    message?: string;
    error?: string;
}
export declare function recordDuplicateOverride(appDb: Knex, input: RecordDuplicateOverrideInput): Promise<RecordDuplicateOverrideResponse>;
/**
 * Look up an override by transaction hash. Returns null when no
 * override has been recorded — the matching pipeline uses this to
 * decide whether to re-flag the transaction.
 */
export interface DuplicateOverrideRow {
    id: number;
    transaction_hash: string;
    override_reason: string;
    user_code: string | null;
    created_at: string | Date;
}
export declare function getDuplicateOverride(appDb: Knex, transactionHash: string): Promise<DuplicateOverrideRow | null>;
//# sourceMappingURL=duplicate-override.d.ts.map
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

export async function recordDuplicateOverride(
  appDb: Knex,
  input: RecordDuplicateOverrideInput,
): Promise<RecordDuplicateOverrideResponse> {
  const transactionHash = (input.transactionHash ?? '').trim();
  const reason = (input.reason ?? '').trim();
  if (!transactionHash) {
    return { success: false, error: 'transaction_hash is required' };
  }
  if (!reason) {
    return { success: false, error: 'reason is required' };
  }

  try {
    // Mirror Python's INSERT OR REPLACE semantics: if a row exists for
    // this hash, update its reason + timestamp; otherwise insert. MSSQL
    // doesn't have INSERT OR REPLACE so we do an explicit
    // existence-check + update/insert pair.
    const existing = (await appDb('duplicate_overrides')
      .where({ transaction_hash: transactionHash })
      .first()) as { id: number } | undefined;

    if (existing) {
      await appDb('duplicate_overrides')
        .where({ id: existing.id })
        .update({
          override_reason: reason,
          user_code: input.userCode ?? null,
          created_at: appDb.fn.now(),
        });
    } else {
      await appDb('duplicate_overrides').insert({
        transaction_hash: transactionHash,
        override_reason: reason,
        user_code: input.userCode ?? null,
      });
    }

    return { success: true, message: 'Duplicate override recorded' };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

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

export async function getDuplicateOverride(
  appDb: Knex,
  transactionHash: string,
): Promise<DuplicateOverrideRow | null> {
  if (!transactionHash) return null;
  try {
    const row = (await appDb('duplicate_overrides')
      .where({ transaction_hash: transactionHash })
      .first()) as DuplicateOverrideRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

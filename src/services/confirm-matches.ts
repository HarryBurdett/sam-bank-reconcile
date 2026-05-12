/**
 * Confirm matched transactions + mark them as reconciled.
 *
 * Faithful port of `confirm_statement_matches` (apps/bank_reconcile/
 * api/routes.py:1935-2035). Wraps mark-reconciled with two pieces of
 * extra setup the caller doesn't have to provide:
 *
 *   1. statement_line numbers — Opera convention is 10, 20, 30...
 *      so we set them automatically based on the matches list order.
 *
 *   2. statement_number — next from nbank.nk_lststno + 1. We read
 *      nbank with NOLOCK (markEntriesReconciled re-reads with UPDLOCK
 *      under a transaction so the value is correct at write time).
 *      Per CLAUDE.md, never use MAX(...)+1 to derive a sequence —
 *      this comes from nbank's stored counter.
 *
 * The actual reconciliation work — locking, validation, ae_reclnum
 * write, nbank update — happens inside markEntriesReconciled (which
 * has its own bank lock + UPDLOCK + ROWLOCK + transaction).
 */
import type { Knex } from 'knex';
import {
  validateBankCode,
  SqlInputValidationError,
} from '../_shared/index.js';
import {
  markEntriesReconciled,
  type MarkReconciledResponse,
} from './mark-reconciled.js';

export interface ConfirmMatchInput {
  ae_entry?: string;
  /** Older clients nest the entry inside opera_entry.ae_entry. */
  opera_entry?: { ae_entry?: string };
}

export interface ConfirmMatchesInput {
  bankCode: string;
  matches: ConfirmMatchInput[];
  /** closing balance in pounds (used for nk_reccfwd in partial mode;
   *  pass-through to mark-reconciled). */
  statementBalance: number;
  /** YYYY-MM-DD */
  statementDate: string;
}

export interface ConfirmMatchesResponse extends MarkReconciledResponse {
  reconciled_count?: number;
  batch_number?: number;
  statement_balance?: number;
}

export async function confirmStatementMatches(
  appDb: Knex,
  operaDb: Knex,
  input: ConfirmMatchesInput,
): Promise<ConfirmMatchesResponse> {
  let bankCode: string;
  try {
    bankCode = validateBankCode(input.bankCode);
  } catch (e) {
    if (e instanceof SqlInputValidationError) {
      return { success: false, error: e.message };
    }
    throw e;
  }

  const entryIds = (input.matches ?? [])
    .map((m) => (m.ae_entry ?? m.opera_entry?.ae_entry ?? '').toString().trim())
    .filter((e) => e.length > 0);
  if (entryIds.length === 0) {
    return { success: false, error: 'No valid entry IDs provided' };
  }

  // Read next statement number from nbank.nk_lststno + 1
  const nbankRows = (await operaDb.raw(
    `SELECT ISNULL(nk_lststno, 0) AS lststno
     FROM nbank WITH (NOLOCK)
     WHERE RTRIM(nk_acnt) = ?`,
    [bankCode],
  )) as unknown as Array<{ lststno: number | null }>;
  if (!Array.isArray(nbankRows) || nbankRows.length === 0) {
    return {
      success: false,
      error: `Bank account ${bankCode} not found in nbank`,
    };
  }
  const nextStatementNumber = Number(nbankRows[0]?.lststno ?? 0) + 1;

  // Build entries with Opera-convention statement lines (10, 20, 30, ...)
  const entries = entryIds.map((eid, i) => ({
    entry_number: eid,
    statement_line: (i + 1) * 10,
  }));

  const result = await markEntriesReconciled(appDb, operaDb, {
    bankCode,
    entries,
    statementNumber: nextStatementNumber,
    statementDate: input.statementDate ?? null,
    reconciliationDate: new Date().toISOString().slice(0, 10),
    partial: false,
    closingBalance: input.statementBalance,
  });

  if (!result.success) {
    return result;
  }

  return {
    ...result,
    reconciled_count: entries.length,
    batch_number: nextStatementNumber - 1,
    statement_balance: input.statementBalance,
    message: `Reconciled ${entries.length} entries`,
  };
}

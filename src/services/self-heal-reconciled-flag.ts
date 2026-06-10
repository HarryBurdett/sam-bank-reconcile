/**
 * Self-heal: flip `bank_statement_imports.is_reconciled=1` when
 * Opera's nk_recbal proves the statement was reconciled.
 *
 * The data-flow invariant the operator relies on:
 *
 *   "Once a statement is reconciled to completion, Opera's
 *    nk_recbal is updated to that statement's closing balance."
 *
 * So whenever Opera's nk_recbal differs from SAM's most-recently-
 * reconciled closing AND exactly one unreconciled SAM statement
 * matches that nk_recbal — the statement IS reconciled. The Opera
 * postings happened; SAM's bookkeeping just didn't get updated.
 * (The audit identified the audit-bookkeeping-update bug at
 * src/router.ts:2209 — silent UPDATE swallow + missing import_id
 * from the file-picker path.)
 *
 * In that case, asking the operator to click a "Recover" button is
 * busywork. SAM should self-heal silently on every scan / status
 * check, and only show a banner for cases that genuinely need
 * human review.
 *
 * Safety conditions (all must hold) before auto-promoting:
 *   1. Opera and SAM diverge in the "extra" direction (Opera ahead).
 *   2. Exactly ONE unreconciled SAM statement has closing == nk_recbal.
 *      Zero matches → can't heal (Fork B: banner asks operator).
 *      Multiple matches → ambiguous, refuse (banner asks operator).
 *   3. The matching statement's statement_date is at-or-after SAM's
 *      most-recently-reconciled statement_date. Refuse to promote an
 *      OLDER statement that happens to share the balance.
 *
 * When all three hold, the function flips is_reconciled=1,
 * stamps reconciled_at, and writes reconciled_by='sync-with-opera'.
 *
 * Idempotent: when there's nothing to heal (already in sync, no
 * match, ambiguous, or stale), returns `{ promoted: false }` and
 * mutates nothing.
 */

import type { Knex } from 'knex';
import { companyScope } from '../_shared/get-company.js';

export interface SelfHealResult {
  promoted: boolean;
  /** When promoted=true, the bank_statement_imports.id that got flipped. */
  import_id?: number;
  /** When promoted=true, the closing_balance that matched nk_recbal. */
  closing_balance?: number;
  /** When promoted=false, a short diagnostic explaining why.
   *  Useful for logging / FE messaging. */
  reason?:
    | 'already_in_sync'
    | 'no_matching_unreconciled_statement'
    | 'ambiguous_multiple_matches'
    | 'matching_statement_is_older'
    | 'bank_not_found'
    | 'sam_ahead_of_opera';
}

function dateToYmd(d: Date | string | null | undefined): string {
  if (!d) return '';
  if (d instanceof Date) {
    if (Number.isNaN(d.getTime())) return '';
    const yr = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    return `${yr}-${mo}-${da}`;
  }
  return String(d).slice(0, 10);
}

export async function selfHealBalanceMatch(
  operaDb: Knex,
  appDb: Knex,
  companyCode: string,
  bankCode: string,
  opts: { user?: string } = {},
): Promise<SelfHealResult> {
  const scope = companyScope(companyCode);
  // 1. Opera's reconciled balance — the source of truth.
  const nbank = (await operaDb('nbank')
    .select(operaDb.raw('nk_recbal / 100.0 AS reconciled_balance'))
    .where('nk_acnt', bankCode)
    .first()) as { reconciled_balance: number | string | null } | undefined;
  if (!nbank) return { promoted: false, reason: 'bank_not_found' };
  const recBal = Number(nbank.reconciled_balance ?? 0);

  // 2. SAM's most-recently-reconciled statement.
  const mostRecent = (await appDb('bank_statement_imports')
    .select('id', 'statement_date', 'closing_balance')
    .where(scope)
    .andWhere('bank_code', bankCode)
    .andWhere('is_reconciled', 1)
    .orderBy('reconciled_at', 'desc')
    .orderBy('statement_date', 'desc')
    .orderBy('id', 'desc')
    .first()) as
    | {
        id: number;
        statement_date: Date | string | null;
        closing_balance: number | string | null;
      }
    | undefined;

  // Already in sync — nothing to heal.
  if (
    mostRecent &&
    Math.abs(Number(mostRecent.closing_balance ?? 0) - recBal) <= 0.005
  ) {
    return { promoted: false, reason: 'already_in_sync' };
  }

  // SAM ahead of Opera — that's the "restore" direction, handled by
  // a different recovery flow (recoverFromOperaDivergence). Don't
  // touch state here.
  if (
    mostRecent &&
    Number(mostRecent.closing_balance ?? 0) > recBal
  ) {
    return { promoted: false, reason: 'sam_ahead_of_opera' };
  }

  // 3. Find unreconciled SAM statements whose closing matches
  //    nk_recbal exactly.
  const candidates = (await appDb('bank_statement_imports')
    .select('id', 'filename', 'statement_date', 'closing_balance')
    .where(scope)
    .andWhere('bank_code', bankCode)
    .andWhere('is_reconciled', 0)
    .andWhereRaw('ABS(closing_balance - ?) < 0.005', [recBal])
    .orderBy('statement_date', 'desc')) as Array<{
    id: number;
    filename: string | null;
    statement_date: Date | string | null;
    closing_balance: number | string | null;
  }>;

  if (candidates.length === 0) {
    // Fork B: Opera nk_recbal doesn't correspond to anything SAM
    // knows about. Genuinely manual review needed.
    return { promoted: false, reason: 'no_matching_unreconciled_statement' };
  }
  if (candidates.length > 1) {
    // Ambiguous: two unreconciled statements share the same closing.
    // Could be a coincidence or a duplicate import — operator must
    // disambiguate via the normal Reconcile flow.
    return { promoted: false, reason: 'ambiguous_multiple_matches' };
  }

  const target = candidates[0]!;

  // 4. Safety check: the candidate must be at-or-after the
  //    most-recently-reconciled statement in time. Refuse to
  //    promote a statement that's OLDER than the anchor.
  if (mostRecent) {
    const tDate = dateToYmd(target.statement_date);
    const mDate = dateToYmd(mostRecent.statement_date);
    if (tDate && mDate && tDate < mDate) {
      return { promoted: false, reason: 'matching_statement_is_older' };
    }
  }

  // All safety conditions met. Promote.
  const recCountRow = (await appDb('bank_statement_transactions')
    .where(scope)
    .andWhere('import_id', target.id)
    .count<{ c: number }[]>({ c: '*' })
    .first()) as { c: number } | undefined;
  const reconciledCount = Number(recCountRow?.c ?? 0);

  await appDb('bank_statement_imports').where({ ...scope, id: target.id }).update({
    is_reconciled: 1,
    reconciled_count: reconciledCount,
    reconciled_at: appDb.fn.now(),
    reconciled_by: opts.user ?? 'sync-with-opera',
  });

  return {
    promoted: true,
    import_id: Number(target.id),
    closing_balance: Number(target.closing_balance ?? 0),
  };
}

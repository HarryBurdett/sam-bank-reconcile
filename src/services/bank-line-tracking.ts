/**
 * Lookup of per-line tracking on bank_statement_transactions, scoped
 * to a window around the statement being previewed/processed.
 *
 * Used by both `preview-from-pdf` and `process-statement` to learn
 * two facts about each (date, amount) bank line in this statement:
 *
 *   1. **posted_entry_number** — the authoritative "is this posted to
 *      Opera" signal for lines SAM has imported before. Overrides
 *      Opera-side findDuplicates so that orphan-clear / re-analysis
 *      flows don't re-flag a line as posted just because a same-amount
 *      Opera entry exists within ±14 days.
 *
 *   2. **is_reconciled** — when set on the stored row, the bank line
 *      has been definitively reconciled. The matcher (Stage-0
 *      repeat-entry check, customer/supplier fuzzy match, etc.) MUST
 *      NOT run on it. As the operator put it: "anything reconciled is
 *      correct". Reclassifying a reconciled line is a regression risk
 *      with no upside — the operator already pinned that line.
 *
 * Scope guard: only look at imports whose `statement_date` falls
 * within ±7 days of the preview's anchor (statement_date / period_end
 * / period_start). Without this scope, a brand-new statement could
 * pick up unrelated tracking from a historical statement that
 * happened to have a line with the same (date, amount). With it, we
 * only override findDuplicates for tracking that genuinely belongs to
 * the statement being analysed.
 *
 * Ambiguity guard: when multiple stored rows share the same
 * (date, amount) key within the scope window, we increment `count`
 * but don't trust any single row's flags. The caller checks
 * `count === 1` before applying overrides.
 */
import type { Knex } from 'knex';
import { companyScope } from '../_shared/get-company.js';

export interface BankLineTrackingEntry {
  /** Opera entry number this stored line was posted to, or null. */
  posted_entry_number: string | null;
  /** True iff the stored line carries is_reconciled = 1. */
  is_reconciled: boolean;
  /**
   * Number of stored rows that share this (date, amount) key within
   * the scope window. Callers should only treat the flags as
   * authoritative when this is 1 — otherwise the (date, amount)
   * collision is ambiguous and we can't safely pick a row.
   */
  count: number;
}

export type BankLineTrackingMap = Map<string, BankLineTrackingEntry>;

export interface BuildBankLineTrackingInput {
  /** Per-company app DB. Pass null/undefined to skip (returns empty map). */
  appDb: Knex | null | undefined;
  /** Opera company code (e.g. 'C', 'I', 'Z'). Required when appDb is set. */
  companyCode: string;
  /** Bank code (e.g. "BB005"). Must already be validated upstream. */
  bankCode: string;
  /**
   * Anchor date for the ±7-day scope window. Typically
   * statement_info.statement_date, falling back to period_end or
   * period_start. Pass null to skip the lookup (returns empty map).
   */
  scopeAnchor: string | null;
  /** Tolerance window around the anchor (days). Default 7. */
  toleranceDays?: number;
}

/**
 * Build the (date|amount) → tracking map for one bank statement.
 * Best-effort: any error short-circuits to an empty map and the
 * matcher falls back to Opera-only findDuplicates.
 */
export async function buildBankLineTracking(
  input: BuildBankLineTrackingInput,
): Promise<BankLineTrackingMap> {
  const out: BankLineTrackingMap = new Map();
  const { appDb, companyCode, bankCode, scopeAnchor, toleranceDays = 7 } = input;
  if (!appDb || !scopeAnchor) return out;
  const scope = companyScope(companyCode);

  const anchorMs = Date.parse(scopeAnchor);
  if (!Number.isFinite(anchorMs)) return out;

  try {
    const lo = new Date(anchorMs - toleranceDays * 86400000)
      .toISOString()
      .slice(0, 10);
    const hi = new Date(anchorMs + toleranceDays * 86400000)
      .toISOString()
      .slice(0, 10);

    const stored = (await appDb('bank_statement_transactions')
      .join(
        'bank_statement_imports',
        'bank_statement_transactions.import_id',
        'bank_statement_imports.id',
      )
      .where('bank_statement_imports.company_code', scope.company_code)
      .andWhere('bank_statement_transactions.company_code', scope.company_code)
      .andWhere('bank_statement_imports.bank_code', bankCode)
      .andWhere('bank_statement_imports.statement_date', '>=', lo)
      .andWhere('bank_statement_imports.statement_date', '<=', hi)
      .select(
        'bank_statement_transactions.post_date as post_date',
        'bank_statement_transactions.amount as amount',
        'bank_statement_transactions.posted_entry_number as posted_entry_number',
        'bank_statement_transactions.is_reconciled as is_reconciled',
      )) as unknown as Array<{
      post_date: Date | string | null;
      amount: number | string | null;
      posted_entry_number: string | null;
      is_reconciled: number | boolean | null;
    }>;

    for (const row of stored) {
      const ymd =
        row.post_date instanceof Date
          ? row.post_date.toISOString().slice(0, 10)
          : String(row.post_date ?? '').slice(0, 10);
      if (!ymd) continue;
      const amt = Number(row.amount ?? 0);
      const key = `${ymd}|${amt.toFixed(2)}`;
      const pen = (row.posted_entry_number ?? '').trim() || null;
      const reconciled = !!row.is_reconciled;
      const existing = out.get(key);
      if (!existing) {
        out.set(key, {
          posted_entry_number: pen,
          is_reconciled: reconciled,
          count: 1,
        });
      } else {
        // Multiple stored rows share this (date, amount) — ambiguous.
        // Increment count; callers gate on count === 1 before trusting
        // the override. We still OR-in the flags so a reconciled twin
        // can be reported through other channels if needed.
        existing.count += 1;
        if (pen && !existing.posted_entry_number) {
          existing.posted_entry_number = pen;
        }
        if (reconciled) existing.is_reconciled = true;
      }
    }
  } catch {
    // Tracking lookup is best-effort; fall through to Opera-only
    // findDuplicates if anything goes wrong.
    return out;
  }

  return out;
}

/**
 * Standard (date, amount) key used everywhere `BankLineTrackingMap`
 * is indexed. Centralised so callers don't drift on formatting.
 */
export function bankLineTrackingKey(
  dateYmd: string,
  amountPounds: number,
): string {
  return `${dateYmd.slice(0, 10)}|${Number(amountPounds ?? 0).toFixed(2)}`;
}

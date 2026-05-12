/**
 * Repeat-entry detection — match a bank transaction against an
 * unposted Opera repeat entry in arhead/arline.
 *
 * Faithful port of `_check_repeat_entry`
 * (sql_rag/bank_import.py:943-1134) including the alias fast-path
 * (961-1020) and the amount/reference/date matching (1022-1134).
 *
 * Two phases:
 *   1. Alias fast-path: if `repeat_entry_aliases` has a previously
 *      learned mapping for this payee + bank, validate the linked
 *      arhead row is still active and use it.
 *   2. Otherwise scan arhead+arline rows for this bank where the
 *      entry is unposted (ae_topost=0 or ae_posted<ae_topost) and
 *      either the amount matches within 10p OR a search-term LIKE
 *      hits ae_desc / at_comment. Prefer amount matches; secondary
 *      ordering by date proximity to ae_nxtpost.
 *
 * Date validation: reject when the transaction is >10 days BEFORE the
 * next-post date (legacy says "too far before" — old historical txn
 * shouldn't grab a future-dated repeat).
 *
 * Implementation notes (Opera SE + Opera 3 portable):
 *   - Knex builder + parameter binding throughout
 *   - No `WITH (NOLOCK)` (perf-only, omitting is correct)
 *   - Date proximity sort: we fetch the candidates and order in JS
 *     to avoid backend-specific DATEDIFF/JULIANDAY differences
 */
import type { Knex } from 'knex';
import { lookupRepeatEntryAlias } from './bank-aliases.js';

export interface RepeatEntryMatch {
  is_match: boolean;
  entry_ref: string;
  entry_desc: string;
  next_post_date: string | null;
  posted: number;
  topost: number;
  freq: string;
  every: number;
  match_kind: 'alias' | 'amount' | 'reference' | 'unknown' | 'none';
}

const NO_MATCH: RepeatEntryMatch = {
  is_match: false,
  entry_ref: '',
  entry_desc: '',
  next_post_date: null,
  posted: 0,
  topost: 0,
  freq: '',
  every: 1,
  match_kind: 'none',
};

function dateToYmd(d: unknown): string | null {
  if (!d) return null;
  if (d instanceof Date) {
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
  return String(d).slice(0, 10);
}

function withinToleranceDays(
  txnDate: string,
  nextPostDate: string | null,
  toleranceDays = 10,
): boolean {
  if (!nextPostDate) return true; // no date to compare against — accept
  const t = Date.parse(`${txnDate}T00:00:00Z`);
  const n = Date.parse(`${nextPostDate}T00:00:00Z`);
  if (!Number.isFinite(t) || !Number.isFinite(n)) return true;
  return t >= n - toleranceDays * 86_400_000;
}

interface ArheadRow {
  ae_entry: string | null;
  ae_desc: string | null;
  ae_nxtpost: string | Date | null;
  ae_freq: string | null;
  ae_every: number | null;
  ae_posted: number | null;
  ae_topost: number | null;
}

interface ArlineRow extends ArheadRow {
  at_value: number;
  at_comment: string | null;
}

async function validateAliasMatch(
  operaDb: Knex,
  entryRef: string,
  bankCode: string,
): Promise<ArheadRow | null> {
  try {
    const row = (await operaDb('arhead')
      .select(
        'ae_entry',
        'ae_desc',
        'ae_nxtpost',
        'ae_freq',
        'ae_every',
        'ae_posted',
        'ae_topost',
      )
      .where('ae_entry', entryRef)
      .andWhereRaw('RTRIM(ae_acnt) = ?', [bankCode])
      .andWhere(function unposted(this: Knex.QueryBuilder) {
        this.where('ae_topost', 0).orWhereRaw('ae_posted < ae_topost');
      })
      .first()) as ArheadRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

function buildMatch(row: ArheadRow, kind: RepeatEntryMatch['match_kind']): RepeatEntryMatch {
  return {
    is_match: true,
    entry_ref: (row.ae_entry ?? '').toString().trim(),
    entry_desc: (row.ae_desc ?? '').toString().trim(),
    next_post_date: dateToYmd(row.ae_nxtpost),
    posted: Number(row.ae_posted ?? 0),
    topost: Number(row.ae_topost ?? 0),
    freq: (row.ae_freq ?? '').toString().trim().toUpperCase(),
    every: Number(row.ae_every ?? 1) || 1,
    match_kind: kind,
  };
}

function escapeLike(s: string): string {
  // Opera uses MSSQL LIKE — escape the wildcards and brackets so
  // a literal '%' in a payee doesn't act as a wildcard. FoxPro LIKE
  // also accepts these in a forgiving fashion (it ignores [] entirely
  // but doesn't error). Same approach as legacy audit 2026-05-05 F9.
  return s.replace(/'/g, "''").replace(/\[/g, '[[]').replace(/%/g, '[%]').replace(/_/g, '[_]');
}

export async function checkRepeatEntry(
  operaDb: Knex,
  appDb: Knex | null,
  txn: {
    bankCode: string;
    /** YYYY-MM-DD transaction date. */
    date: string;
    /** Signed amount in pounds (sign ignored — matched on absolute). */
    amountPounds: number;
    name: string;
    reference: string;
    memo: string;
  },
): Promise<RepeatEntryMatch> {
  // === Phase 1 — alias fast-path ===
  if (appDb) {
    try {
      const alias = await lookupRepeatEntryAlias(appDb, txn.name, txn.bankCode);
      if (alias?.entry_ref) {
        const row = await validateAliasMatch(
          operaDb,
          alias.entry_ref,
          txn.bankCode,
        );
        if (row) {
          const nextDate = dateToYmd(row.ae_nxtpost);
          if (withinToleranceDays(txn.date, nextDate)) {
            return buildMatch(row, 'alias');
          }
        }
      }
    } catch {
      // fall through to scan
    }
  }

  // === Phase 2 — amount / reference scan ===
  try {
    const amountPenceAbs = Math.abs(Math.round(Number(txn.amountPounds) * 100));

    // Build search terms from name/reference/memo (≥3 chars, first 3 words each).
    const searchTerms: string[] = [];
    for (const text of [txn.name, txn.reference, txn.memo]) {
      if (text && text.trim().length >= 3) {
        const escaped = escapeLike(text.trim().toUpperCase());
        const words = escaped.split(/\s+/).filter((w) => w.length >= 3);
        searchTerms.push(...words.slice(0, 3));
      }
    }
    const terms = searchTerms.slice(0, 5);

    let query = operaDb({ h: 'arhead' })
      .join({ l: 'arline' }, function joinHL(this: Knex.JoinClause) {
        this.on('h.ae_entry', '=', 'l.at_entry').andOn(
          'h.ae_acnt',
          '=',
          'l.at_acnt',
        );
      })
      .select(
        'h.ae_entry',
        'h.ae_desc',
        'h.ae_nxtpost',
        'h.ae_freq',
        'h.ae_every',
        'h.ae_posted',
        'h.ae_topost',
        'l.at_value',
        'l.at_comment',
      )
      .whereRaw('RTRIM(h.ae_acnt) = ?', [txn.bankCode])
      .andWhere(function unposted(this: Knex.QueryBuilder) {
        this.where('h.ae_topost', 0).orWhereRaw('h.ae_posted < h.ae_topost');
      });

    if (terms.length > 0) {
      query = query.andWhere(function matchAmountOrTerms(this: Knex.QueryBuilder) {
        this.whereRaw('ABS(ABS(l.at_value) - ?) < 10', [amountPenceAbs]);
        for (const t of terms) {
          this.orWhereRaw(`UPPER(h.ae_desc) LIKE '%${t}%'`)
              .orWhereRaw(`UPPER(l.at_comment) LIKE '%${t}%'`);
        }
      });
    } else {
      query = query.andWhereRaw('ABS(ABS(l.at_value) - ?) < 10', [amountPenceAbs]);
    }

    const rows = (await query.limit(20)) as unknown as ArlineRow[];
    if (!rows.length) return NO_MATCH;

    // Score in JS: amount-match > ref-match; then date proximity.
    const txnTs = Date.parse(`${txn.date}T00:00:00Z`);
    const scored = rows.map((r) => {
      const amountMatch = Math.abs(Math.abs(Number(r.at_value)) - amountPenceAbs) < 10;
      const desc = (r.ae_desc ?? '').toString().toUpperCase();
      const comment = (r.at_comment ?? '').toString().toUpperCase();
      let refMatch = false;
      for (const t of terms) {
        if (desc.includes(t) || comment.includes(t)) {
          refMatch = true;
          break;
        }
      }
      const nextTs = (() => {
        const d = dateToYmd(r.ae_nxtpost);
        if (!d) return Number.POSITIVE_INFINITY;
        const ts = Date.parse(`${d}T00:00:00Z`);
        return Number.isFinite(ts) ? ts : Number.POSITIVE_INFINITY;
      })();
      const dateGap = Number.isFinite(txnTs) ? Math.abs(nextTs - txnTs) : 0;
      return { row: r, amountMatch, refMatch, dateGap };
    });

    scored.sort((a, b) => {
      // Amount-match preferred over ref-match
      if (a.amountMatch !== b.amountMatch) return a.amountMatch ? -1 : 1;
      // Then closest date
      return a.dateGap - b.dateGap;
    });

    const best = scored[0]!;
    const nextDate = dateToYmd(best.row.ae_nxtpost);
    if (!withinToleranceDays(txn.date, nextDate)) return NO_MATCH;

    const kind: RepeatEntryMatch['match_kind'] = best.amountMatch
      ? 'amount'
      : best.refMatch
        ? 'reference'
        : 'unknown';
    return buildMatch(best.row, kind);
  } catch {
    return NO_MATCH;
  }
}

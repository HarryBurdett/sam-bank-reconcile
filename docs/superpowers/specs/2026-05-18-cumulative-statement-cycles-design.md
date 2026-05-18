# Cumulative-statement cycles — progressive import support

**Date**: 2026-05-18
**Status**: Design — pending review

## Problem

Some banks (Monzo, Wise, certain Tide configurations) produce statements
that **grow within a month**. Each pull during the month contains the
same `period_start` (1st of the month) but a later `period_end`. Example
sequence for May 2026 BC010:

| Pull date | period_start | period_end | tx count | closing |
|---|---|---|---|---|
| 8 May    | 2026-05-01 | 2026-05-08 | 12 | £100,000.00 |
| 15 May   | 2026-05-01 | 2026-05-15 | 24 | £86,000.00 |
| 22 May   | 2026-05-01 | 2026-05-22 | 36 | £75,000.00 |
| 1 Jun    | 2026-05-01 | 2026-05-31 | 48 | £80,000.00 |

The operator wants to **import progressively** so the accounts system
(Opera) reflects current bank activity throughout the month, not just
in arrears at month-end. Reconciliation happens once, after the final
end-of-month pull.

The existing SAM workflow assumes each `bank_statement_imports` row
represents one discrete statement period. Progressive cumulative pulls
break that assumption:

1. **Audit-row duplication**: each pull would create its own row,
   producing 4 rows for the same logical "May statement".
2. **Sequential gating confusion**: every pull's `opening_balance`
   matches the cycle start (£X), not the prior pull's closing — the
   chain check would mis-classify each pull as a candidate "next
   statement" rather than a continuation.
3. **Reconcile confusion**: which of the 4 rows gets reconciled? If
   the operator reconciles the May 1-15 pull and then May 1-22
   arrives, the Hub shows two "May" rows with conflicting state.

## Constraint

**Do not break the existing traditional-statement workflow** (Barclays
monthly, Lloyds monthly, etc.). Every existing customer's Import →
Reconcile flow must be byte-identical after this change.

## Solution: Cycle-aware import

A **cycle** is identified by `(bank_code, period_start)`. One
`bank_statement_imports` row per cycle. Subsequent pulls within the
same cycle UPDATE the existing row rather than creating a new one.

The system never needs to know which banks are "cumulative" — the
data tells it:

- **Traditional bank** (Barclays): each statement has a unique
  `period_start` (1-APR, 1-MAY, 1-JUN…). No cycle row ever matches.
  New row each time. **Identical to current behaviour.**
- **Cumulative bank** (Monzo): every pull within May shares
  `period_start = 2026-05-01`. The first pull creates the row;
  subsequent pulls find and update it. **New cycle-merge behaviour
  triggers only here.**

### Import step decision tree

```
extract PDF → get (bank_code, period_start, period_end, closing, lines)

look up bank_statement_imports WHERE (bank_code, period_start) match

  if NO MATCH:
    → INSERT new row (current behaviour, no change)
    → INSERT bank_statement_transactions lines (current behaviour)
    → post lines to Opera with per-line duplicate detection

  if MATCH AND row.is_reconciled = 0:
    → UPDATE row:
        - period_end = max(row.period_end, new period_end)
        - closing_balance = new closing_balance
        - transactions_imported = (final count after append)
        - imported_at = now()
        - imported_by = current user
    → INSERT new bank_statement_transactions rows for new lines
        (idempotent — skip lines already present by
        line_number + post_date + amount + description-hash)
    → post NEW lines to Opera (existing per-line duplicate detection
        skips lines already posted under this import_id or a different
        one matching the same bank+date+amount fingerprint)

  if MATCH AND row.is_reconciled = 1:
    → refuse with clear message:
        "The May 2026 cycle is already reconciled. To add
         transactions from a later pull, unreconcile the cycle
         first in Reconcile, then re-import."
    → operator can manually unreconcile via existing Cleardown UI
        or a future "unreconcile cycle" button (out of scope here)
```

### Reconcile step — UNCHANGED

Reconcile operates on the cycle row as it stands now. The operator
sees one statement, one closing balance, one set of transactions —
the underlying progressive history is invisible at reconcile time.

### Sequential gating — UNCHANGED

The chain check at scan-all-banks already uses `is_reconciled` and
`closing_balance`. Once May's cycle row is reconciled (with final
`period_end = 2026-05-31`, `closing = £80,000`), June's cycle starts.
This logic doesn't need to know whether May involved one pull or four.

### Scan / Hub display — already shipped

Earlier work (`scan-all-banks.ts` start-date supersession) already
keeps only the **longest** pull visible per cycle in the Hub. The
operator never sees the May 1-7 PDF once May 1-15 arrives in the
inbox. No new scan logic needed.

## Architecture

### Data model

`bank_statement_imports` schema gains nothing new. The existing
`bank_code` and `period_start` columns are the cycle key.

**New index** (migration `016_cycle_lookup_index.ts`):

```sql
CREATE INDEX bank_statement_imports_bank_code_period_start_idx
  ON bank_statement_imports (bank_code, period_start);
```

This makes the cycle lookup O(log N) on growth.

### Components changed

| File | Change | Lines |
|---|---|---|
| `db/migrations/016_cycle_lookup_index.ts` | new — index migration | ~25 |
| `src/services/import-from-pdf.ts` | cycle-row lookup before INSERT; UPDATE branch when found | ~60 |
| `src/services/import-from-pdf.ts` | idempotent bank_statement_transactions append | ~30 |
| `tests/import-cumulative-cycle.test.ts` | new — cycle merge test | ~180 |
| `tests/fixtures/statements/monzo-cumulative-may/` | new fixture (two progressive pulls) | ~30 |

### Cycle-row lookup logic

```ts
async function findExistingCycleRow(
  appDb: Knex,
  bankCode: string,
  periodStart: string | null,
): Promise<{ id: number; is_reconciled: number; period_end: string | null;
              closing_balance: number | null } | null> {
  if (!periodStart) return null;  // cycle requires period_start
  const row = await appDb('bank_statement_imports')
    .select('id', 'is_reconciled', 'period_end', 'closing_balance')
    .where({ bank_code: bankCode, period_start: periodStart })
    .orderBy('id', 'desc')
    .first();
  return row ?? null;
}
```

If `period_start` is null (extraction couldn't determine it), fall
through to current INSERT-new-row behaviour. The cycle-merge is best-
effort; missing data shouldn't break the import.

### Idempotent line append

When a cycle row already exists, the new pull's transactions overlap
with what's already stored. The append logic:

```ts
async function appendCycleTransactions(
  appDb: Knex,
  importId: number,
  newTransactions: PdfExtractionResult['transactions'],
): Promise<{ added: number; skipped: number }> {
  // Read existing lines for this import
  const existing = await appDb('bank_statement_transactions')
    .select('post_date', 'amount', 'description')
    .where({ import_id: importId });
  // Build a fingerprint set
  const fingerprints = new Set(
    existing.map(r => fingerprint(r.post_date, r.amount, r.description))
  );
  let added = 0, skipped = 0;
  for (const t of newTransactions) {
    const fp = fingerprint(t.date, t.amount, t.description ?? '');
    if (fingerprints.has(fp)) { skipped++; continue; }
    // INSERT new line
    await appDb('bank_statement_transactions').insert({ import_id, ... });
    added++;
  }
  return { added, skipped };
}
```

Fingerprint = `${date}|${amount.toFixed(2)}|${description.trim().toLowerCase().slice(0,64)}`.

This handles the case where Monzo restates a line slightly (e.g.
description normalisation) — we don't get duplicate rows in
`bank_statement_transactions`.

### Per-line duplicate detection (Opera-side)

Unchanged. The existing `duplicate-detection.ts` matches each
extracted line against Opera atran/stran/ptran. Lines that match an
existing Opera entry are flagged `is_duplicate` and skipped at post
time. This already works correctly for progressive imports — a line
posted in the 8-May pull is in Opera, so the 15-May pull's same line
gets duplicate-flagged.

## Edge cases

| Case | Behaviour |
|---|---|
| First pull, no existing row | INSERT new row (current behaviour) |
| Second pull, same period_start, row exists, not reconciled | UPDATE row, append new lines |
| Second pull, period_start missing/null | Fall through to INSERT (best-effort fallback) |
| Second pull, period_end EARLIER than existing | Refuse with message: "shorter pull than already imported — re-import not needed" |
| Second pull, row exists AND is_reconciled=1 | Refuse with message: "cycle already reconciled — unreconcile first" |
| Different month (period_start changed) | New row (correct cycle boundary) |
| Cycle spans non-calendar-month (e.g. 5th-to-5th) | Works — `period_start` is the source of truth, not the calendar |
| Same period_start across two banks | Different cycles (cycle key includes bank_code) |

## Testing strategy

### Unit tests

1. **First-pull-of-cycle (Monzo)**: INSERT new row, lines posted.
2. **Second-pull-of-cycle (Monzo)**: UPDATE existing row, only new
   lines appended, period_end extended, closing updated.
3. **Reconciled-cycle re-import**: refuses with clear message.
4. **Shorter-pull-than-existing**: refuses with clear message.
5. **Traditional bank regression (Barclays)**: each statement has
   unique period_start → INSERT new row each time. Byte-identical
   to current behaviour.
6. **Missing period_start**: falls through to current INSERT path.

### Fixture-based regression test

Add `tests/fixtures/statements/monzo-cumulative-may/` with two
extraction-cache JSON files representing the 8-May (12 txns) and
22-May (36 txns) pulls. Test that the second pull only adds 24 new
lines, period_end advances to 22-May, closing_balance updates.

### Integration test against live BE

After ship, manually verify against the BC010 Monzo flow:
1. Import the 8-May pull → row created with 12 txns
2. Import the 22-May pull → same row updated, period_end=22-May,
   transactions_imported=36 (12 existing + 24 new)
3. Reconcile → row marked reconciled, closing matches Opera nk_recbal
4. Next month: June pull triggers fresh cycle row

## What's NOT in scope (deferred)

- **Mid-cycle reconcile**: refuse-with-message handles this for now.
  If operator demand grows, add an "unreconcile cycle" button in
  Reconcile that flips `is_reconciled=0`.
- **Auto-detection of cumulative format**: not needed. The cycle-merge
  triggers organically when two pulls share `period_start`.
- **UI badge on the Hub**: showing "cumulative — N pulls so far"
  could be helpful but isn't required for the workflow to work.
  Could ship in a follow-on.
- **Cumulative-cycle balance solver tweaks**: the existing
  constraint-based solver works on each pull independently.

## Risk assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| Existing Barclays workflow breaks | Very low | Cycle-merge only fires when row already exists with matching `(bank_code, period_start)`. Traditional banks never collide. Regression fixture pins behaviour. |
| Cycle row stuck in is_reconciled=1 with new transactions arriving | Low | Refuse-with-message tells operator exact remediation step. Future "unreconcile cycle" button removes friction. |
| Line fingerprint collision (two genuinely-different lines with same date+amount+desc) | Low | The fingerprint matches the bank's own behaviour (if the bank says these are the same line, we treat them as the same). Worst case: one line dropped per pull — operator catches at reconcile time. |
| Migration index creation locks table on large data | Very low | `bank_statement_imports` is small (~100s of rows per company). Index creation is sub-second. |

## Migration path for existing data

No data migration needed. The cycle-merge logic only activates on
NEW imports. Existing rows continue to work as today. If a tenant
already has multiple `bank_statement_imports` rows for the same
cycle (e.g. they imported two Monzo pulls manually before this
ship), the new logic doesn't retroactively merge them — they stay
as separate rows. Operator can clean up via the existing Delete
Import History UI if they want.

## Effort estimate

| Phase | Effort |
|---|---|
| Schema migration | 1 hour |
| Import service changes | 4 hours |
| Idempotent line append | 2 hours |
| Tests + fixture | 4 hours |
| Manual verification | 2 hours |
| **Total** | **~13 hours / 1.5 days** |

## Open questions for review

1. **Period_end extension semantics**: when the new pull's
   period_end is earlier than the existing row's period_end (i.e.
   a shorter pull arrived after a longer one), should we
   (a) refuse with message, (b) silently keep the longer period_end
   and just merge any genuinely-new lines (unlikely but possible),
   or (c) accept and overwrite? **Default: (a) refuse.**

2. **Line-fingerprint description handling**: Monzo sometimes
   normalises descriptions between pulls (e.g. trims trailing
   whitespace, changes capitalisation). The fingerprint lowercases
   and slices to 64 chars — should be tolerant enough. If false
   positives appear, fingerprint can drop description entirely and
   rely on (date + amount + line_number) instead.

3. **Operator visibility**: should the Hub show "in progress" badge
   for cycles where the latest pull's period_end is not yet
   month-end? Helpful UX hint but not required for correctness.
   **Default: no badge in v1, add in a follow-on if operators
   ask.**

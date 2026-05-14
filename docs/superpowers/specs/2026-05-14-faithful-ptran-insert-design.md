# Faithful `ptran` INSERT replication for purchase_payment / purchase_refund

**Date:** 2026-05-14
**Status:** Approved by user; ready for implementation
**Scope:** One INSERT statement in `repo/src/services/import-posting-executor.ts` (inside `postOneTransaction`, the purchase-ledger branch).

## Problem

The audit on 2026-05-14 found one drift area between the TS port and the canonical
Opera transaction definitions. `postOneTransaction → INSERT INTO ptran` currently
writes 27 columns. The Opera transaction snapshot for `purchase_payment` shows the
canonical resulting row has 54 fields. The legacy Python implementation at
`llmragsql/sql_rag/opera_sql_import.py:3432` writes 44 of those explicitly; the
remaining 10 are populated by Opera triggers (audit/timestamp fields).

The 17 fields the TS port omits (after today's column-name fix) cluster into:

- Settlement / prompt-payment discount: `pt_advance, pt_payflag, pt_set1day, pt_set1, pt_set2day, pt_set2, pt_payadvl, pt_pyroute`
- Held / advance posting: `pt_held, pt_adval, pt_fadval`
- Foreign currency / EU: `pt_euro, pt_origcur, pt_eurind, pt_fcvat`
- VAT / reverse-charge: `pt_revchrg, pt_vatset1, pt_vatset2, pt_adjsv`

The TS port currently also writes two columns the legacy does NOT (`pt_dueday`, `pt_memo`).

## Approach

Re-derive the `INSERT INTO ptran` statement column-by-column from the central
knowledge base. Per-column source citation lives in this document. No
guessing, no analogy from sibling tables, no inferred field names.

## Source of truth (in priority order)

1. **Schema:** `llmragsql/scripts/opera_snapshot.json` — confirms each column exists on `ptran`.
2. **Transaction-library snapshot:** `~/opera-knowledge-ref/packages/opera-knowledge/transaction-library/opera_se/purchase_ledger_purchase_payment_bacs_20260401_144136.json` — canonical post-Opera state of a `purchase_payment` row.
3. **Same snapshot's `modified_rows`** — for fields Opera mutates *during* the same transaction (allocation effects), the BEFORE value of the modified existing row reveals Opera's "neutral" state for that column.

## Column-by-column mapping

Legend:
- `S` = direct citation from snapshot `added_rows[0].<col>`
- `M` = derived from snapshot `modified_rows[0].changes.<col>.before` (Opera's "pre-allocation" state for that column)
- `I` = input data from the transaction we're posting (entry number, dates, amounts, etc.)
- `INF` = inferred from snapshot evidence (cited explicitly)

| Column | Source | Value | Notes |
|---|---|---|---|
| `id` | I | `ledgerId` | from `getNextId('ptran')` |
| `pt_account` | I | `party.account` | supplier code |
| `pt_trdate` | I | `txn.date` | post date |
| `pt_trref` | I | `reference` (already sliced to ≤20) | bank-side reference |
| `pt_supref` | S | `'BACS'` | snapshot literal. Hard-coded for now; bank-statement payment-method derivation is a follow-on improvement |
| `pt_trtype` | S/I | `'P'` for payment, `'F'` for refund | snapshot row shows `'P'`; refund branch uses `'F'` |
| `pt_trvalue` | I | `ptValue` (signed pounds) | -amount for payment, +amount for refund |
| `pt_vatval` | S | `0` | snapshot literal |
| `pt_trbal` | INF | `ptValue` | INFERRED: snapshot post-allocation value is `0.0`; pre-allocation must equal `pt_trvalue` (full unallocated balance). Same as Opera's own pre-allocation state for an unallocated payment. |
| `pt_paid` | M | `''` | snapshot `modified_rows[0].changes.pt_paid.before = ''` — Opera's "unallocated" state for this column |
| `pt_crdate` | I | `txn.date` | |
| `pt_advance` | S | `'N'` | snapshot literal |
| `pt_payflag` | M | `0` | snapshot `modified_rows[0].changes.pt_payflag.before = 0` — Opera's "unallocated" flag value |
| `pt_set1day` | S | `0` | snapshot literal |
| `pt_set1` | S | `0` | snapshot literal |
| `pt_set2day` | S | `0` | snapshot literal |
| `pt_set2` | S | `0` | snapshot literal |
| `pt_held` | S | `''` | snapshot literal |
| `pt_fcurr` | S | `''` | snapshot literal |
| `pt_fcrate` | S | `0` | snapshot literal |
| `pt_fcdec` | S | `0` | snapshot literal |
| `pt_fcval` | S | `0` | snapshot literal |
| `pt_fcbal` | S | `0` | snapshot literal |
| `pt_adval` | S | `0` | snapshot literal |
| `pt_fadval` | S | `0` | snapshot literal |
| `pt_fcmult` | S | `0` | snapshot literal |
| `pt_cbtype` | I | `cbtype` | resolved cashbook type for the action |
| `pt_entry` | I | `entryNumber` | from `incrementAtypeEntry` |
| `pt_unique` | I | `sharedUnique` | shared with atran for same posting |
| `pt_suptype` | S | `''` | snapshot literal. NOTE: superseded today's earlier behaviour of writing `pn_suptype` |
| `pt_euro` | S | `0` | snapshot literal |
| `pt_payadvl` | S | `0` | snapshot literal |
| `pt_origcur` | S | `''` | snapshot literal |
| `pt_eurind` | S | `''` | snapshot literal |
| `pt_revchrg` | S | `0` | snapshot literal |
| `pt_nlpdate` | I | `txn.date` | nominal-ledger-post date |
| `pt_adjsv` | S | `0` | snapshot literal |
| `pt_vatset1` | S | `0` | snapshot literal |
| `pt_vatset2` | S | `0` | snapshot literal |
| `pt_pyroute` | S | `0` | snapshot literal |
| `pt_fcvat` | S | `0` | snapshot literal |
| `datecreated` | I | `now.iso` | |
| `datemodified` | I | `now.iso` | |
| `state` | S | `1` | snapshot literal |

**Total: 44 columns** — matches the 44 columns of the legacy Python `INSERT INTO ptran`.

Dropped from the current TS port:
- `pt_memo` — not in legacy column list; not in the explicit INSERT path of the snapshot. Opera populates it via trigger if needed.
- `pt_dueday` — same reasoning.

## Proposed SQL

```sql
INSERT INTO ptran (
  id, pt_account, pt_trdate, pt_trref, pt_supref, pt_trtype,
  pt_trvalue, pt_vatval, pt_trbal, pt_paid, pt_crdate,
  pt_advance, pt_payflag, pt_set1day, pt_set1, pt_set2day,
  pt_set2, pt_held, pt_fcurr, pt_fcrate, pt_fcdec,
  pt_fcval, pt_fcbal, pt_adval, pt_fadval, pt_fcmult,
  pt_cbtype, pt_entry, pt_unique, pt_suptype, pt_euro,
  pt_payadvl, pt_origcur, pt_eurind, pt_revchrg, pt_nlpdate,
  pt_adjsv, pt_vatset1, pt_vatset2, pt_pyroute, pt_fcvat,
  datecreated, datemodified, state
) VALUES (
  ?, ?, ?, ?, 'BACS', ?,
  ?, 0, ?, '', ?,
  'N', 0, 0, 0, 0,
  0, '', '', 0, 0,
  0, 0, 0, 0, 0,
  ?, ?, ?, '', 0,
  0, '', '', 0, ?,
  0, 0, 0, 0, 0,
  ?, ?, 1
)
```

Bindings (in order):
1. `ledgerId`
2. `party.account`
3. `txn.date`
4. `reference`
5. `ptType` (`'P'` or `'F'`)
6. `ptValue` (signed pounds, e.g. -396.00)
7. `ptValue` (same value for pt_trbal at insert time)
8. `txn.date` (pt_crdate)
9. `cbtype`
10. `entryNumber`
11. `sharedUnique`
12. `txn.date` (pt_nlpdate)
13. `now.iso` (datecreated)
14. `now.iso` (datemodified)

## Locations to change

Single SQL block in `repo/src/services/import-posting-executor.ts`, inside the
purchase-side branch of `postOneTransaction`. The sales-side branch (`stran`)
is untouched — the audit confirmed it matches legacy.

## What will be verified after deployment

The existing Phase A in-trx verification (assertLedgerRow) and Phase C post-commit verification (verifyAentryCommitted) continue to operate. They check the row exists and the value is correct; they do not enforce the full column manifest. A follow-on build-time check that loads `opera_snapshot.json` and asserts every column referenced in TS sources exists on the target table would close this class of bug permanently; that is a separate proposal not included in this spec.

## Out of scope

- Build-time schema enforcement (separate spec).
- Bank-statement payment-method → `pt_supref` derivation (currently hard-coded `'BACS'` per snapshot).
- The other 5 helpers × table combinations confirmed by the audit to match legacy — not touched.
- Any sales-side, nominal, transfer, or gocardless code path — not touched.

## Risk

Low. The change adds 17 columns and 17 literal values to a single INSERT statement.
Every column is verified to exist on `ptran`. Every value is sourced from either the
snapshot or input data. The resulting row should be functionally identical to legacy
Python's INSERT, which has been in production use.

# Multi-Line Recurring Entry Posting — Design

**Date:** 2026-05-18
**Status:** Approved
**Owner:** bank-reconcile
**Touches:** `src/services/import-posting-executor.ts`, `src/services/post-recurring-entry.ts`, `tests/import-posting-executor.test.ts`, `tests/post-recurring-entry.test.ts`

## Goal

Restore multi-line recurring-entry posting to the SAM/TypeScript codebase. The single-line path was shipped in commit `e157705e`; multi-line entries (recurring journals where one `arhead` row has multiple `arline` rows — e.g. z_demo's REC0000018 "Customer DD Receipts" with 4 lines) are currently declined with `"Multi-line recurring entries must be posted from Opera Cashbook → Repeat Entries → Post"`. This spec brings them on-platform.

## Background

The legacy Python reference (`sql_rag/opera_sql_import.py:9714-10594`, ~880 LoC for `post_recurring_entry`) supported multi-line. The SAM/TypeScript port shipped single-line only because the existing post helpers (`postOneTransaction`, `postNominalEntry` in `import-posting-executor.ts`, ~1100 LoC combined) bake in single-line assumptions: one `aentry` per call, one `atran`, one `ntran` pair, one `nbank` update.

Opera SE's actual transaction model is **one `aentry` header + 1..N `atran` detail lines**. Single-line is the N=1 special case. Our split is an implementation artifact, not an Opera-side one. The fix mirrors what Opera SE itself does.

## Architectural Decision — Unify

Extract the per-entry insert chain from `postOneTransaction` and `postNominalEntry` into a new core helper `postOperaCashbookEntry` that handles 1..N lines uniformly. The two existing functions become thin wrappers that build a `[oneLine]` array and delegate. Bank-import callers' API is unchanged.

**Why unify** (not duplicate, not coexist):
- Opera SE has one transaction shape. Our code should mirror that, not impose a synthetic split.
- One core helper = one place to fix any future posting bug, vs N parallel implementations drifting.
- Existing single-line callers stay callable through the same wrapper API → no caller-site churn, no breakage of well-tested bank-import paths.

**Risk mitigation:** the entire existing `tests/import-posting-executor.test.ts` suite must pass unchanged. The extraction is a refactor — same external behaviour for single-line, new behaviour for multi-line.

## Architecture

```
                        ┌────────────────────────────────────────┐
                        │ postOperaCashbookEntry  (NEW core)     │
                        │                                        │
                        │  Input: {trx, bankCode, header, lines} │
                        │                                        │
                        │  Once:                                 │
                        │    allocate entry_number, aentryId,    │
                        │      journal, sharedUnique             │
                        │    INSERT aentry (Σ signed pence)      │
                        │                                        │
                        │  Per line:                             │
                        │    INSERT atran                        │
                        │    INSERT stran/ptran + UPDATE         │
                        │      sname/pname  (sales/purchase)     │
                        │    INSERT ntran × 2-3 + UPDATE nacnt   │
                        │      (bank, target, optional VAT)      │
                        │    INSERT zvtran + nvat (if VAT)       │
                        │    INSERT anoml × 2-3                  │
                        │                                        │
                        │  Once:                                 │
                        │    UPDATE nbank (Σ bank movement)      │
                        │    Verification asserts (entry-level)  │
                        │                                        │
                        │  Returns: { entry_number, fingerprint }│
                        └────────────────────────────────────────┘
                              ▲                       ▲
                              │                       │
              ┌───────────────┴────────┐    ┌─────────┴─────────────┐
              │ postOneTransaction     │    │ postRecurringEntry    │
              │ (thin wrapper)         │    │ (orchestrator)        │
              │                        │    │                       │
              │ builds [oneLine] from  │    │ reads arhead+arline,  │
              │ PreparedTransaction,   │    │ derives header+lines, │
              │ calls core helper      │    │ calls core helper in  │
              │                        │    │ a trx, advances       │
              │ Same for               │    │ arhead.ae_posted +    │
              │ postNominalEntry.      │    │ ae_nxtpost.           │
              └────────────────────────┘    └───────────────────────┘
                       ▲                              ▲
                       │                              │
              ┌────────┴───────┐             ┌────────┴───────────┐
              │ bank-import    │             │ POST               │
              │ executor       │             │ /api/recurring-    │
              │ (unchanged)    │             │ entries/post       │
              └────────────────┘             └────────────────────┘
```

`postBankTransfer` stays as-is — it's a paired source+dest aentry/atran that doesn't fit the 1..N-lines model. Out of scope for this spec.

## Data Model

```typescript
type TxnAction =
  | 'sales_receipt' | 'sales_refund'
  | 'purchase_payment' | 'purchase_refund'
  | 'nominal_payment' | 'nominal_receipt';
// bank_transfer intentionally excluded — different posting shape

interface PreparedEntryHeader {
  /** YYYY-MM-DD posting date — shared across all lines. */
  date: string;
  /** All lines share one ae_type → one action. Mixed action across lines is rejected. */
  action: TxnAction;
  /** Cashbook type code (e.g. 'NR', 'NP', 'BP'). Resolved once per entry. */
  cbtype: string | null;
  /** Reference (ae_entref / payee reference). Used at entry level + as line default. */
  reference: string | null;
  /** Description (ae_desc / row name). Used for safe_desc on aentry. */
  comment: string;
  /** 'BANK_IMP' for bank-import callers, 'RECUR' for recurring-entry caller. ≤8 chars. */
  inputBy: string;
}

interface PreparedEntryLine {
  /** Per-line at_account: nominal / customer / supplier code. Required. */
  atAccount: string;
  /** Per-line signed value in pence. Sign by direction (receipts +, payments −). */
  signedPence: number;
  /** Per-line VAT code (empty / 0 / N / Z / E → no VAT). */
  vatCode: string | null;
  /** Per-line VAT pence (absolute). Zero when no VAT. */
  vatPence: number;
  /** Per-line reference; falls back to header.reference. ≤20 chars. */
  reference: string;
  /** Per-line at_comment / nt_cmnt. */
  comment: string;
  /** Per-line project / department (8 chars each). */
  project: string;
  department: string;
}

interface PostEntryArgs {
  trx: Knex;
  bankCode: string;
  header: PreparedEntryHeader;
  lines: PreparedEntryLine[]; // length ≥ 1
  defaults: { sl_control: string; pl_control: string };
  decision: PeriodPostingDecision;
}

interface PostEntryResult {
  entry_number: string;
  fingerprint: string;
}
```

The header carries entry-level facts (date, action, cbtype, reference, comment, inputBy). The lines array carries per-line facts (account, value, VAT, project, department). The core helper never reaches outside this shape — all DB reads (party info, control accounts, VAT rates) happen via the helper's own lookups so callers don't have to pre-fetch.

## Data Flow

```
POST /api/recurring-entries/post  { bank_code, entries: [{entry_ref, override_date}] }
  │
  ▼
postRecurringEntriesBatch (existing)
  │
  ▼ for each entry (independent transactions)
postRecurringEntry (rewritten — same external signature)
  │
  ├─ validate bank code + entry ref
  ├─ read arhead row (one)
  ├─ read arline rows (all, ordered by at_line)
  ├─ state guards (active, supported ae_type, not exhausted, has detail lines)
  ├─ derive postDate (override → composite-key date → ae_nxtpost)
  ├─ run getPeriodPostingDecision(operaDb, postDate, ledger)
  ├─ load getControlAccounts(operaDb) for defaults
  │
  ▼ in executeWithDeadlockRetry transaction
  postOperaCashbookEntry({trx, bankCode, header, lines})
    │
    ├─ allocate ids (entry_number, aentryId, journal, sharedUnique)
    ├─ INSERT aentry (totalSignedPence = Σ lines[i].signedPence)
    │
    ├─ for each line in lines:
    │   ├─ resolve target account + party info (nominal: at_account directly;
    │   │   sales: customer + sl_control; purchase: supplier + pl_control)
    │   ├─ INSERT atran (per-line signedPence)
    │   ├─ INSERT stran/ptran + UPDATE sname/pname (sales/purchase only)
    │   ├─ INSERT ntran (bank leg, per-line bank movement)
    │   ├─ UPDATE nacnt (bank balance, per-line)
    │   ├─ INSERT ntran (target leg, per-line target value)
    │   ├─ UPDATE nacnt (target balance, per-line)
    │   ├─ if hasVat:
    │   │   ├─ getVatRateForCode(trx, vatCode, 'S'|'P', postDate)
    │   │   ├─ INSERT ntran (VAT leg)
    │   │   ├─ UPDATE nacnt (VAT account)
    │   │   ├─ INSERT zvtran
    │   │   └─ INSERT nvat
    │   ├─ insertNjmemo(trx, journal, 'Cashbook Ledger Transfer (RT)')
    │   ├─ INSERT anoml (bank leg)
    │   ├─ INSERT anoml (target leg)
    │   └─ INSERT anoml (VAT leg, if hasVat)
    │
    ├─ UPDATE nbank (Σ bank movement across all lines)
    └─ Verification asserts (entry-level — see below)
  │
  └─ UPDATE arhead WITHIN SAME TRX (ae_posted++, ae_lstpost, ae_nxtpost, audit stamps)
```

## Schedule Advancement

Same transaction as the post, no separate commit. Mirrors `_advance_recurring_entry_in_txn` (`opera_sql_import.py:10490`):

```typescript
let next = ae_nxtpost; // UTC midnight Date
while (next <= postDate) {
  next = advanceByFrequency(next, ae_freq, ae_every);
}
await trx('arhead').where(...).update({
  ae_posted: trx.raw('ae_posted + 1'),
  ae_lstpost: postDate,
  ae_nxtpost: next,
  sq_amdate: trx.raw('CONVERT(DATE, GETDATE())'),
  sq_amtime: trx.raw('CONVERT(TIME, GETDATE())'),
  sq_amuser: inputBy.slice(0, 8),
});
```

Frequency arithmetic: `D` → days, `W` → weeks×7, `M` → months (with month-end clamp), `Q` → 3 months, `Y` → 12 months. Unknown frequency → defaults to monthly (matches legacy fallback at `opera_sql_import.py:10534`). The advance helper used in Phase 2 single-line (`advanceByFrequency` in `post-recurring-entry.ts`) is correct; reuse it.

## Failure Handling

**Per-entry atomic.** One recurring entry = one `executeWithDeadlockRetry` transaction. If any insert / update fails, the whole entry (including the `arhead` advance) rolls back. Matches Opera SE's posting semantics.

**Batch endpoint partial-success.** Multiple entries in one POST request are processed independently. Failure of entry X does not stop entry Y. The response aggregates per-entry results: `{ success, results: [{entry_ref, success, error?}], posted_count, failed_count }`. Matches legacy `post_recurring_entries` at `api/main.py:10569`.

**Validation errors (no transaction opened):**
- Invalid `bank_code` / `entry_ref` syntax → reject before any DB read
- `arhead` row not found for `(entry_ref, bank_code)` → reject
- `arline` empty → reject
- Exhausted template (`ae_topost > 0 AND ae_posted >= ae_topost`) → reject
- Unsupported `ae_type` (not in 1..6) → reject
- Mixed action across lines (defensive — Opera doesn't allow this) → reject
- Missing posting date (no override, no composite-key date, no `ae_nxtpost`) → reject
- Period closed for posting (`getPeriodPostingDecision.canPost = false`) → reject with the friendly blocked-reason

**Posting errors (transaction rollback):**
- Deadlock (SQL Server 1205) → retry 3× with 100/500/1500ms backoff (existing `executeWithDeadlockRetry` policy)
- Verification assert failure (unbalanced ntran, mismatched aentry total, missing atran) → `PostingVerificationError`, rollback
- Any other DB error → rollback, return error message

## Verification

After the transaction commits, the core helper runs entry-level verifications equivalent to the bank-import flow's existing helpers (`assertAentryAtran`, `assertLedgerRow`, `assertBalancedPair`):

| Assert | Multi-line shape |
|---|---|
| `assertAentryAtran` | aentry exists with `ae_value = totalSignedPence` AND `count(atran) = lines.length` for this entry_number |
| `assertLedgerRow` | for sales/purchase actions: `count(stran|ptran where entry=entry_number) = lines.length` |
| `assertBalancedPair(ntran)` | when `decision.postToNominal=true`: `count(ntran for journal) = lines.length × (2 + vat_lines_count)` AND `Σ nt_value = 0` |
| `assertBalancedPair(anoml)` | always: `count(anoml for entry/unique) = lines.length × (2 + vat_lines_count)` |

Existing single-line assertions assume exactly 2 rows in each pair; multi-line needs the count-by-formula variant. The asserts live in `_shared/post-write-verify.ts`; we extend them to take an expected-count parameter (default 2 = current behaviour). Existing single-line callers pass 2; multi-line caller passes the computed total.

## Testing

### Regression coverage (must pass unchanged)

The entire `tests/import-posting-executor.test.ts` suite. Verifies the extraction of the core helper didn't change single-line behaviour. If any case fails, the extraction has a bug — fix before shipping.

### New unit tests for multi-line

1. **Single-line through new core** — call `postOperaCashbookEntry` with a one-line array; verify writes match `postOneTransaction` output exactly. Bridge test proving the wrapper preserves behaviour.

2. **2-line nominal payment** — one aentry (sum of both line values), 2 atran rows, 4 ntran (2 pairs, journal-balanced), 4 anoml, 1 nbank delta = sum.

3. **4-line sales receipt** (mirrors REC0000018 shape) — 4 stran rows (one per customer), 4 atran/ntran pairs, sname.sn_currbal updates per customer.

4. **Per-line VAT split** — line 1 has VAT (code `1` standard 20%), line 2 has no VAT → 3 ntran for line 1 (bank/target/VAT), 2 for line 2; one zvtran/nvat for line 1; aentry total includes line 1 gross.

5. **Mixed-action rejected** — defensive guard: lines with conflicting actions → reject before any insert.

6. **arhead advance** — verify `ae_posted` increments by 1 (not by `lines.length`), `ae_lstpost` set to postDate, `ae_nxtpost` advances past every intervening cycle.

### Live verification

Operator-triggered post against one z_demo multi-line entry — recommended order: `REC0000025` (2-line "DEO Payment", smallest blast radius) → `REC0000018` (4-line "Customer DD Receipts") → `REC0000019` (3-line "Euro Customers"). After each post, inspect Opera SE Cashbook + GL to confirm the entry shape matches expectations. z_demo is the demo company — no production data risk.

## Out of Scope

- `postBankTransfer` — paired source+dest aentries don't fit the 1..N-lines model. Single bank-transfer per call only.
- Auto-allocate (`auto-allocate.ts`) for recurring entries — recurring posts don't auto-allocate to invoices; matches legacy comment `"# NOTE: No salloc created at posting time — allocation happens separately"` (`opera_sql_import.py:10030`).
- Recurring-entry types outside 1..6 (e.g. type 7 BACS-with-payslip) — declined with `"process in Opera"` message, matching legacy.

## Open Risks

1. **Extraction correctness.** Moving ~500 lines of inserts from `postOneTransaction` and ~600 lines from `postNominalEntry` into a shared helper is the bulk of the work. A subtle column-padding or sign-error introduced during extraction would break single-line bank-import silently. **Mitigation:** the regression test suite must pass at every step; do the extraction in small commits (header insert first, then per-line atran, then ledger, then ntran, then anoml) and run tests after each.

2. **VAT-rate lookup behaviour.** The legacy uses `tx_trantyp` based on `ae_type` (`'P'` for ae_type 1/5/6, `'S'` for ae_type 4) — `'P'` and `'S'` here refer to Purchase-input and Sales-output VAT, NOT the cashbook posttyp. Easy to confuse with the `nt_posttyp` field, which uses `'S'` for sales-ledger cashbook entries and `'P'` for purchase-ledger. **Mitigation:** explicit naming in the helper (e.g. `vatDirection: 'input' | 'output'`); inline comment cross-referencing both meanings.

3. **z_demo data realism.** Live verification depends on z_demo having well-formed multi-line recurring entries. The check route earlier confirmed REC0000018/REC0000025/REC0000019 exist with sensible `ae_freq`/`ae_every`/`ae_topost` values. **Mitigation:** before the live post, run the check route once more, confirm the entries still look correct, and verify the operator agrees the post should be performed against z_demo.

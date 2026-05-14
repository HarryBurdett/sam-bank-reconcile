# Bank statement balance derivation — design

**Date**: 2026-05-14
**Scope**: How the bank-reconciliation tool derives the opening balance (and validates the closing balance) of an imported PDF bank statement, regardless of bank format.

## Problem

The tool consumes PDFs from many banks (Monzo, Barclays, Tide, Lloyds, etc.). There is no standard statement format. Different banks differ on:

- Whether an opening balance is explicitly labelled, and if so what label is used ("Opening Balance", "Balance brought forward", "Previous balance", etc.).
- Whether a summary box prints `total_in`, `total_out`, `opening`, `closing`.
- Whether per-transaction running balances are present.
- Whether the running balance on a line is the *post-transaction* balance (Monzo) or the *pre-transaction* balance.
- Whether transactions are listed oldest-first or newest-first.
- Whether transactions within a single date appear in chronological order or reverse.
- Whether the PDF mixes multiple accounts (Monzo current account + savings pots in one file).

Today's port presumes a particular fact-set and a particular order, and falls back through a fixed pipeline when assumptions break. That produces incorrect or non-deterministic opening balances on at least one observed bank (Monzo).

## Principle

**There is no standard. There is always logic. Derive, don't presume.**

A bank statement is internally consistent — every printed figure must satisfy the accounting identity:

```
closing = opening + total_in − total_out
```

and every per-transaction running balance must satisfy:

```
this_line_balance = previous_line_balance ± this_line_amount
```

(where the sign depends on the bank's chosen balance semantics — post-txn or pre-txn).

The algorithm's job is to recover the opening balance by **finding the value that satisfies the most independent constraints derivable from the statement**, not by following a fixed recipe.

When constraints disagree by more than rounding tolerance (£0.01), the algorithm surfaces a discrepancy to the operator with the conflicting facts. It does **not** silently pick one.

## Architecture

### Constraint solver, not pipeline

The algorithm is a constraint solver, framed as:

1. **Gather facts** from the statement, whatever's available:
   - Labelled opening balance (only if the statement explicitly prints one with a recognisable label).
   - Labelled closing balance.
   - Summary box: `total_in`, `total_out`.
   - Per-transaction tuples: `(date, amount, balance)` — any field may be null.
   - External anchor: Opera `nbank.nk_recbal` for this bank account.

2. **Each fact independently yields a candidate opening balance**:
   - `op_labelled` ← labelled opening (when explicitly extracted).
   - `op_summary` ← `closing − (total_in − total_out)`.
   - `op_chain_fwd` ← from the first chronological transaction, using detected balance semantics: `first.balance − first.amount` if post-txn, or `first.balance` if pre-txn.
   - `op_chain_back` ← `closing − Σ(amounts of all valid txns)`.
   - `op_external` ← `nbank.nk_recbal` (only meaningful for the next-in-sequence statement).

3. **Cross-validate**: for every non-null candidate, walk the transaction chain from that opening and check it terminates at the closing within £0.01.

4. **Decide**:
   - **Single candidate, validates**: use it.
   - **Multiple candidates, all agree within £0.01**: use them (high confidence).
   - **Multiple candidates, disagree**: surface the discrepancy with all candidate values and the conflicting facts; do not silently choose.
   - **No candidate validates**: error — statement is not internally consistent or extraction failed; flag for operator review.

### Order, semantics, and direction are derived, not assumed

- **Transaction order**: date is a hint but not authoritative. Within a single date, the chain identity determines order — find the permutation of same-date transactions where every adjacent pair satisfies the balance identity. If multiple permutations work, all yield the same opening (the sum of amounts is invariant).
- **Balance semantics** (post-txn vs pre-txn): test both interpretations on the first-day transactions; the one that produces a consistent chain to the closing is correct.
- **Statement direction** (oldest-first vs newest-first listing): the chain identity reveals direction. Walk pairs and score each direction; pick the winner.
- **Phantom rows** (savings-account bleed-through into a current-account PDF): a transaction that cannot be placed anywhere in the chain from any candidate opening is rejected. The rejected set is logged but not silently dropped.

### Format library — accelerator, never authority

The first time the algorithm successfully derives the format characteristics of a particular bank, those characteristics are saved to a per-app SQLite table `bank_statement_format_profiles`:

```sql
CREATE TABLE bank_statement_format_profiles (
  id INTEGER PRIMARY KEY,
  bank_signature TEXT NOT NULL UNIQUE,  -- normalised (bank_name | sort_code) or similar fingerprint
  balance_semantics TEXT,               -- 'post_txn' | 'pre_txn'
  txn_order TEXT,                       -- 'oldest_first' | 'newest_first'
  summary_present INTEGER,              -- 0/1
  opening_label_phrases TEXT,           -- JSON array of phrases seen
  derived_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  confidence_count INTEGER DEFAULT 1,   -- how many statements have confirmed this profile
  state INTEGER DEFAULT 1
);
```

Behavior:

- On every statement, look up the profile by `bank_signature` (derived from Gemini-extracted bank name + sort code, or fall back to a hash of the header).
- If a profile exists, pass it to the constraint solver as a **prior** — the solver tries the profile's semantics/order first to speed things up.
- **The constraint check is still mandatory.** If the profile's semantics produce an inconsistent chain, fall back to deriving from scratch and update the profile.
- New profiles created automatically when an unknown bank is solved successfully.

The profile is a hint, not an authority. The algorithm's correctness never depends on the profile being right.

### Prompt updates (Gemini extractor)

The extractor prompt is updated to maximise the facts available to the solver:

- Require Gemini to emit the **summary block as a first-class output**, listing every numeric field it printed (`total_in`, `total_out`, opening, closing, plus any others labelled).
- Require Gemini to emit `transaction_order` (`oldest_first` | `newest_first`) as a detected property, not a guess.
- Keep the existing multi-account warning for fintech banks.
- Retry once with stricter instruction if both the summary block and per-txn amounts are missing.

The prompt enhancements *help* the solver by feeding it more facts; the solver remains the source of truth.

## Components

### 1. Extractor (Gemini wrapper)

`standalone/gemini-pdf-extractor.ts` — already exists. Changes:

- Prompt updated as above.
- Replace the current `calculateOpeningBalance` + ad-hoc chain walk with a call into the new constraint-solver module.

### 2. Constraint solver

New module `src/services/statement-balance-solver.ts`. Public API:

```ts
solveStatementBalance(input: {
  txns: ExtractedTxn[];            // raw, with potentially null amounts/balances
  labelledOpening: number | null;
  labelledClosing: number | null;
  summaryTotalIn: number | null;
  summaryTotalOut: number | null;
  externalReconciledBalance: number | null;  // Opera nbank.nk_recbal
  formatProfile: FormatProfile | null;
}): SolveResult;

type SolveResult =
  | { ok: true; opening: number; closing: number; usedTxns: number[]; rejectedTxns: number[]; profileUpdates: FormatProfile }
  | { ok: false; reason: string; candidates: { source: string; value: number }[]; conflictDetail: string };
```

The solver is pure: no IO, no logging side-effects (returns a structured result the caller can log). This makes it testable.

### 3. Format-profile store

New module `src/services/bank-statement-format-profiles.ts`. Public API:

```ts
loadFormatProfile(appDb: Knex, bankSignature: string): Promise<FormatProfile | null>;
saveFormatProfile(appDb: Knex, profile: FormatProfile): Promise<void>;
deriveBankSignature(extracted: { bank_name, sort_code, account_number }): string;
```

Migration: add `bank_statement_format_profiles` table to the per-app SQLite migrations.

### 4. Integration points

- **Scan-all-banks** (the eager-extraction path): runs the solver after Gemini returns, populates opening/closing on the scan response, marks the statement `pending_review` (not `ready`) if the solver returns `{ok: false}`.
- **Preview-from-pdf** (the Analyse step): same solver, same handling. The current ad-hoc opening-balance code in the preview handler is removed.
- **Cached extractions**: when an extraction is loaded from `extraction_cache`, the solver still runs (cheap, in-memory) — this protects against stale cache entries containing wrong balances.

## Error handling

- Solver returns `{ok: false}` when constraints disagree or no candidate validates. The caller surfaces this to the operator as **"Statement balances don't reconcile — review required"** with the candidate values displayed.
- A statement that fails the solver is not silently imported. It blocks at the scan listing with a clear status.
- Format-profile update failures are logged but don't fail the statement extraction.

## Out of scope

- Multi-page extraction reliability (Gemini truncation, retries) — already handled, unchanged.
- Phantom-row exclusion for non-balance reasons (e.g. duplicate transactions) — separate concern.
- Statement reconciliation against Opera's posted transactions — separate downstream step.

## Implementation order

1. Build the solver module (`statement-balance-solver.ts`) with unit tests over hand-crafted inputs covering each fact combination.
2. Add the format-profile table + module.
3. Wire solver into the Gemini extractor (replacing the existing `calculateOpeningBalance` + chain-walk block).
4. Update the prompt.
5. Update scan-all-banks + preview-from-pdf to handle the new `SolveResult` shape, surface errors to FE.
6. Test against the live Monzo + Barclays PDFs we have on disk.

Each step is independently verifiable; the solver can be tested standalone before any IO is wired.

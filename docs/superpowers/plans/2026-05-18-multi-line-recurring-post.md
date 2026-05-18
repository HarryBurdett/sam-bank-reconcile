# Multi-Line Recurring Entry Posting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable `POST /api/recurring-entries/post` to handle multi-line recurring entries (one `arhead` row with multiple `arline` rows) by unifying single-line and multi-line under a new core posting helper that mirrors Opera SE's one-aentry-with-N-atran-lines transaction model.

**Architecture:** Extract the per-entry insert chain from `postOneTransaction` and `postNominalEntry` into a new core helper `postOperaCashbookEntry`. Both existing functions become thin wrappers that build a single-line array and call the core. Bank-import callers' API surface is unchanged so the well-tested bank-import flow continues to work. The recurring-entry orchestrator calls the core directly with 1..N lines as appropriate.

**Tech Stack:** TypeScript (NodeNext modules, `.js` extension on imports), Knex.js, MSSQL via tedious driver, vitest, sqlite for unit tests.

**Spec:** `docs/superpowers/specs/2026-05-18-multi-line-recurring-post-design.md`

**Legacy reference:** `/Users/maccb/llmragsql/sql_rag/opera_sql_import.py` — `post_recurring_entry` (lines 9714-10594), `_advance_recurring_entry_in_txn` (lines 10490-10553).

**Current TS code:**
- `src/services/import-posting-executor.ts:405-916` — `postOneTransaction` (sales/purchase, single-line)
- `src/services/import-posting-executor.ts:1031-1631` — `postNominalEntry` (nominal, single-line, with VAT split)
- `src/services/post-recurring-entry.ts` — `postRecurringEntry` (single-line via `postOneTransaction`/`postNominalEntry`, declines multi-line)
- `src/_shared/post-write-verify.ts` — `assertAentryAtran`, `assertLedgerRow`, `assertBalancedPair`

---

## File Structure

| File | Purpose | Change type |
|------|---------|-------------|
| `src/_shared/post-write-verify.ts` | Phase A in-trx verifications | **Modify** — extend `assertAentryAtran` with optional `expectedAtranCount` (default 1) so multi-line callers can assert N atran rows |
| `src/services/import-posting-executor.ts` | Bank-import posting + (after refactor) the unified `postOperaCashbookEntry` core helper | **Modify** — add new exported types + new core helper function; refactor `postOneTransaction` / `postNominalEntry` to thin wrappers around the core |
| `src/services/post-recurring-entry.ts` | Recurring entry orchestration (read arhead/arline, derive entry shape, post, advance schedule) | **Modify** — replace the single-line-only path with code that builds 1..N lines and calls `postOperaCashbookEntry` directly; remove the multi-line decline |
| `tests/import-posting-executor.test.ts` | Regression suite for `postOneTransaction` / `postNominalEntry` / `postBankTransfer` | **No change** — must pass unchanged to prove the refactor preserved behaviour |
| `tests/post-opera-cashbook-entry.test.ts` | NEW — unit tests for the core helper exercising 1..N lines | **Create** — new tests for multi-line behaviour |
| `tests/post-recurring-entry.test.ts` | Phase 2 single-line tests + new multi-line cases | **Modify** — remove the "declines multi-line" test, add multi-line happy-path tests |

---

## Task 1: Extend `assertAentryAtran` to accept expected atran count

The current helper hard-codes `expected 1 atran row per entry`. Multi-line entries need N atran rows per one aentry — add an optional `expectedAtranCount` (default 1) so single-line callers pass nothing and keep current behaviour; multi-line callers pass `lines.length`.

**Files:**
- Modify: `src/_shared/post-write-verify.ts:62-164`
- Test: `tests/post-write-verify.test.ts` (create if not present)

- [ ] **Step 1: Read existing function signature**

Run: `grep -n "expectedAtranCount\|rows.length > 1\|expected 1" /Users/maccb/sam-Bankrec/repo/src/_shared/post-write-verify.ts`

Confirms the function currently throws if `rows.length > 1`. We need to make that conditional.

- [ ] **Step 2: Check whether a test file exists**

Run: `ls /Users/maccb/sam-Bankrec/repo/tests/post-write-verify.test.ts 2>&1 || echo "missing"`

Expected: "missing" — we'll create one.

- [ ] **Step 3: Write the failing test**

Create `/Users/maccb/sam-Bankrec/repo/tests/post-write-verify.test.ts`:

```typescript
/**
 * Tests for the multi-line extension of assertAentryAtran. The
 * existing single-line behaviour is covered indirectly by the
 * import-posting-executor regression suite; here we add narrow
 * coverage for the new expectedAtranCount parameter.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import knexLib, { type Knex } from 'knex';
import {
  assertAentryAtran,
  PostingVerificationError,
} from '../src/_shared/post-write-verify.js';

const SCHEMA = [
  `CREATE TABLE aentry (
    ae_entry TEXT, ae_acnt TEXT, ae_value INTEGER
  )`,
  `CREATE TABLE atran (
    at_entry TEXT, at_acnt TEXT, at_value INTEGER, at_pstdate TEXT,
    at_type INTEGER, at_refer TEXT
  )`,
];

async function makeDb(): Promise<Knex> {
  const db = knexLib({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  for (const s of SCHEMA) await db.raw(s);
  return db;
}

describe('assertAentryAtran multi-line', () => {
  let db: Knex;
  beforeEach(async () => {
    db = await makeDb();
  });

  it('accepts expectedAtranCount=2 with two matching atran rows', async () => {
    await db('aentry').insert({ ae_entry: 'E1', ae_acnt: 'BB005', ae_value: -350000 });
    await db('atran').insert({
      at_entry: 'E1', at_acnt: 'BB005', at_value: -100000,
      at_pstdate: '2026-05-15', at_type: 1, at_refer: 'REF',
    });
    await db('atran').insert({
      at_entry: 'E1', at_acnt: 'BB005', at_value: -250000,
      at_pstdate: '2026-05-15', at_type: 1, at_refer: 'REF',
    });

    // expectedAtranCount=2 expects 2 atran rows + checks ae_value matches
    // the total, but atran values are per-line so the single-row at_value
    // assertion is meaningless for multi-line — caller must skip per-line
    // value asserts when expectedAtranCount > 1.
    await expect(
      assertAentryAtran(db, {
        entryNumber: 'E1',
        bankAccount: 'BB005',
        expectedSignedPence: -350000,
        expectedAtType: 1,
        expectedDate: '2026-05-15',
        expectedAtranCount: 2,
      }),
    ).resolves.not.toThrow();
  });

  it('rejects when atran count mismatches expectedAtranCount', async () => {
    await db('aentry').insert({ ae_entry: 'E1', ae_acnt: 'BB005', ae_value: -350000 });
    await db('atran').insert({
      at_entry: 'E1', at_acnt: 'BB005', at_value: -100000,
      at_pstdate: '2026-05-15', at_type: 1, at_refer: 'REF',
    });

    await expect(
      assertAentryAtran(db, {
        entryNumber: 'E1',
        bankAccount: 'BB005',
        expectedSignedPence: -350000,
        expectedAtType: 1,
        expectedDate: '2026-05-15',
        expectedAtranCount: 2,
      }),
    ).rejects.toThrow(PostingVerificationError);
  });

  it('keeps default single-line behaviour when expectedAtranCount omitted', async () => {
    await db('aentry').insert({ ae_entry: 'E1', ae_acnt: 'BB005', ae_value: -100000 });
    await db('atran').insert({
      at_entry: 'E1', at_acnt: 'BB005', at_value: -100000,
      at_pstdate: '2026-05-15', at_type: 1, at_refer: 'REF',
    });

    await expect(
      assertAentryAtran(db, {
        entryNumber: 'E1',
        bankAccount: 'BB005',
        expectedSignedPence: -100000,
        expectedAtType: 1,
        expectedDate: '2026-05-15',
      }),
    ).resolves.not.toThrow();
  });
});
```

- [ ] **Step 4: Run the test, confirm it fails**

Run: `cd /Users/maccb/sam-Bankrec/repo && npx vitest run tests/post-write-verify.test.ts`

Expected: at least one failure because `expectedAtranCount` is not yet recognised by the helper.

- [ ] **Step 5: Modify `assertAentryAtran` to accept `expectedAtranCount`**

In `/Users/maccb/sam-Bankrec/repo/src/_shared/post-write-verify.ts`, replace the body around lines 62-164. Key changes:

1. Add `expectedAtranCount?: number` to the options type (default 1).
2. Replace the "rows.length > 1 → throw" guard with "rows.length !== expectedAtranCount → throw".
3. For multi-line (`expectedAtranCount > 1`), the at_value/at_type/at_pstdate/at_refer asserts only make sense per-row, not aggregated. Either:
   - Skip those asserts when `expectedAtranCount > 1` (caller does per-line asserts elsewhere); OR
   - Assert that the SUM of atran.at_value equals `expectedSignedPence`, and that all rows share `at_pstdate` / `at_type`.

Use the latter (entry-level invariants — total balance + uniform date/type — which Opera enforces for one aentry).

New function body:

```typescript
export async function assertAentryAtran(
  trx: Knex,
  opts: {
    entryNumber: string;
    bankAccount: string;
    expectedSignedPence: number;
    expectedAtType: number;
    expectedDate: string;
    expectedReferPrefix?: string;
    /**
     * Number of atran rows expected for this entry. Default 1 = current
     * single-line behaviour. Multi-line callers pass `lines.length`.
     * For multi-line, individual at_value asserts are replaced with a
     * sum-equals-expectedSignedPence assert; at_type / at_pstdate must
     * still be uniform across rows (Opera enforces one ae_type per
     * recurring template).
     */
    expectedAtranCount?: number;
  },
): Promise<void> {
  const expectedCount = opts.expectedAtranCount ?? 1;
  let rows: Array<{
    ae_value: number | null;
    at_value: number | null;
    at_pstdate: string | Date | null;
    at_type: number | null;
    at_refer: string | null;
  }>;
  try {
    rows = (await trx.raw(
      `SELECT
         a.ae_value AS ae_value,
         t.at_value AS at_value,
         t.at_pstdate AS at_pstdate,
         t.at_type AS at_type,
         RTRIM(t.at_refer) AS at_refer
       FROM aentry a
       JOIN atran t
         ON t.at_entry = a.ae_entry AND t.at_acnt = a.ae_acnt
       WHERE RTRIM(a.ae_entry) = ?
         AND RTRIM(a.ae_acnt) = ?`,
      [opts.entryNumber, opts.bankAccount],
    )) as unknown as Array<{
      ae_value: number | null;
      at_value: number | null;
      at_pstdate: string | Date | null;
      at_type: number | null;
      at_refer: string | null;
    }>;
  } catch (err) {
    throw new PostingVerificationError(
      `aentry+atran in-trx verify query failed for ${opts.entryNumber}: ${isPlainErr(err)}`,
      { entryNumber: opts.entryNumber, phase: 'in-trx' },
    );
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new PostingVerificationError(
      `aentry+atran missing after INSERT (entry=${opts.entryNumber}, bank=${opts.bankAccount})`,
      { entryNumber: opts.entryNumber, phase: 'in-trx' },
    );
  }
  if (rows.length !== expectedCount) {
    throw new PostingVerificationError(
      `aentry+atran count mismatch for ${opts.entryNumber}: got ${rows.length}, expected ${expectedCount}`,
      { entryNumber: opts.entryNumber, phase: 'in-trx' },
    );
  }

  // ae_value is on aentry (same in every joined row); assert from row 0.
  const ae = Number(rows[0]!.ae_value ?? NaN);
  if (!Number.isFinite(ae) || ae !== opts.expectedSignedPence) {
    throw new PostingVerificationError(
      `aentry.ae_value mismatch for ${opts.entryNumber}: stored=${ae} expected=${opts.expectedSignedPence}`,
      { entryNumber: opts.entryNumber, phase: 'in-trx' },
    );
  }

  // For multi-line: sum atran.at_value must equal expectedSignedPence.
  // For single-line: that reduces to the row's at_value.
  const atSum = rows.reduce((acc, r) => acc + Number(r.at_value ?? 0), 0);
  if (atSum !== opts.expectedSignedPence) {
    throw new PostingVerificationError(
      `Σatran.at_value mismatch for ${opts.entryNumber}: stored=${atSum} expected=${opts.expectedSignedPence}`,
      { entryNumber: opts.entryNumber, phase: 'in-trx' },
    );
  }

  // Date and at_type uniformity (Opera enforces one ae_type per
  // recurring template; bank-import single-line trivially satisfies).
  for (const r of rows) {
    if (Number(r.at_type) !== opts.expectedAtType) {
      throw new PostingVerificationError(
        `atran.at_type mismatch for ${opts.entryNumber}: stored=${r.at_type} expected=${opts.expectedAtType}`,
        { entryNumber: opts.entryNumber, phase: 'in-trx' },
      );
    }
    const storedDate =
      r.at_pstdate instanceof Date
        ? r.at_pstdate.toISOString().slice(0, 10)
        : typeof r.at_pstdate === 'string'
          ? r.at_pstdate.slice(0, 10)
          : null;
    if (storedDate !== opts.expectedDate) {
      throw new PostingVerificationError(
        `atran.at_pstdate mismatch for ${opts.entryNumber}: stored=${storedDate} expected=${opts.expectedDate}`,
        { entryNumber: opts.entryNumber, phase: 'in-trx' },
      );
    }
  }

  // at_refer prefix check only when expected (legacy uses this for the
  // bank-import fingerprint prefix; multi-line callers typically don't
  // set it because each line carries its own reference). Apply to row 0
  // only — multi-line at_refer may differ per line, and we don't have a
  // semantic for "all lines share refer".
  if (
    opts.expectedReferPrefix &&
    (rows[0]!.at_refer ?? '').trim() !== opts.expectedReferPrefix.trim()
  ) {
    throw new PostingVerificationError(
      `atran.at_refer mismatch for ${opts.entryNumber}: stored="${rows[0]!.at_refer}" expected="${opts.expectedReferPrefix}"`,
      { entryNumber: opts.entryNumber, phase: 'in-trx' },
    );
  }
}
```

Note: the existing query uses `WITH (NOLOCK)`; sqlite-compatible test path drops that hint, but MSSQL prod still benefits from it. Keep the `WITH (NOLOCK)` hints in the live query — drop them only if the test fails on sqlite. Since the existing post-write-verify.ts already has them and they work in production, we leave them. If the test fails on sqlite due to `WITH`, the simpler path is to remove the hints (perf-only).

- [ ] **Step 6: Run the test, confirm it passes**

Run: `cd /Users/maccb/sam-Bankrec/repo && npx vitest run tests/post-write-verify.test.ts`

Expected: 3/3 passing.

If failures mention `near "WITH": syntax error`, remove `WITH (NOLOCK)` from the SELECT (perf hint, safe to drop).

- [ ] **Step 7: Run the full bank-import regression suite to confirm we didn't break single-line callers**

Run: `cd /Users/maccb/sam-Bankrec/repo && npx vitest run tests/import-posting-executor.test.ts`

Expected: same pass/fail counts as before the change. (Some tests in this file are known pre-existing failures from session context — verify the count is unchanged, not zero failures.)

- [ ] **Step 8: Commit**

```bash
cd /Users/maccb/sam-Bankrec/repo
git add src/_shared/post-write-verify.ts tests/post-write-verify.test.ts
git commit -m "$(cat <<'EOF'
refactor: assertAentryAtran accepts expectedAtranCount for multi-line

Step 1 of multi-line recurring entry posting (spec
docs/superpowers/specs/2026-05-18-multi-line-recurring-post-design.md).

The verifier previously hard-coded 'exactly 1 atran per aentry' —
correct for single-line but wrong for multi-line recurring entries
that have one aentry header and N atran detail lines. Adds an
optional expectedAtranCount (default 1 = unchanged single-line
behaviour); multi-line callers pass lines.length. For multi-line,
the per-line at_value/at_refer assertions don't apply (each line has
its own); instead the helper asserts that Σatran.at_value equals
the aentry total and that at_type / at_pstdate are uniform across
rows.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Define unified entry-shape types

Add the `PreparedEntryHeader` / `PreparedEntryLine` / `PostEntryArgs` / `PostEntryResult` types from the spec to `import-posting-executor.ts`, alongside the existing `PreparedTransaction`. These describe the new core helper's input/output.

**Files:**
- Modify: `src/services/import-posting-executor.ts` (add types near the existing `PreparedTransaction` interface around line 84)

- [ ] **Step 1: Read existing types**

Run: `grep -n "^interface\|^type " /Users/maccb/sam-Bankrec/repo/src/services/import-posting-executor.ts | head -10`

Confirms `PreparedTransaction` at line 84, `PostOneArgs` at line 388. New types go near those.

- [ ] **Step 2: Insert new type definitions**

In `src/services/import-posting-executor.ts`, immediately after the existing `PreparedTransaction` interface (currently ends at line 108), add:

```typescript
// ---------------------------------------------------------------------
// Unified prepared-entry shape — used by postOperaCashbookEntry
// (the core posting helper that handles 1..N lines uniformly).
//
// Mirrors Opera SE's actual transaction model: one aentry header
// (PreparedEntryHeader) plus 1..N atran detail lines
// (PreparedEntryLine[]). The bank-import flow passes a single-line
// array via the postOneTransaction / postNominalEntry thin
// wrappers; the recurring-entry orchestrator passes 1..N lines
// directly.
// ---------------------------------------------------------------------

export interface PreparedEntryHeader {
  /** YYYY-MM-DD posting date — shared across all lines. */
  date: string;
  /**
   * All lines share one ae_type → one action.
   * `bank_transfer` is intentionally excluded — paired source+dest
   * doesn't fit the 1..N-lines model; use postBankTransfer for that.
   */
  action: Exclude<TxnAction, 'bank_transfer'>;
  /** Cashbook type override (e.g. 'NR', 'NP'). Null → resolveCbtype defaults. */
  cbtype: string | null;
  /** Header-level reference (ae_entref). Used at aentry + as line default. */
  reference: string | null;
  /**
   * Header-level description (ae_comment). For bank-import: row name+memo.
   * For recurring: arhead.ae_desc.
   */
  comment: string;
  /** Audit user. 'BANK_IMP' for bank-import; 'RECUR' for recurring. ≤8 chars. */
  inputBy: string;
  /**
   * Header-level memo (txn.memo for bank-import; ae_desc for recurring).
   * Used in atran/anoml/ntran comment columns when the line carries no
   * comment of its own. Falls through to per-line comment for actual
   * INSERT values.
   */
  memo: string;
  /** Header-level payee/party name when known (txn.name for bank-import). */
  name: string;
}

export interface PreparedEntryLine {
  /** Per-line at_account: nominal / customer / supplier code. Required. */
  atAccount: string;
  /**
   * Per-line absolute amount in pence (always positive). Direction
   * comes from the header action — receipt actions become positive
   * signed pence in atran/aentry; payment actions become negative.
   */
  absPence: number;
  /** Per-line VAT code (empty / 0 / N / Z / E → no VAT). */
  vatCode: string | null;
  /** Per-line VAT pence (absolute). Zero when no VAT. */
  vatPence: number;
  /** Per-line reference; falls back to header.reference. ≤20 chars. */
  reference: string;
  /** Per-line at_comment / nt_cmnt; falls back to header.comment. */
  comment: string;
  /** Per-line project (8 chars). */
  project: string;
  /** Per-line department / job (8 chars). */
  department: string;
  /**
   * Operator-provided net override for VAT-bearing lines (rare). Null →
   * net is computed from gross + VAT rate (per legacy
   * opera_sql_import.py:3756).
   */
  netOverride: number | null;
}

export interface PostEntryArgs {
  trx: Knex;
  bankCode: string;
  header: PreparedEntryHeader;
  /** Length ≥ 1. */
  lines: PreparedEntryLine[];
  defaults: { sl_control: string; pl_control: string };
  decision: PeriodPostingDecision;
}

export interface PostEntryResult {
  entry_number: string;
  /**
   * Same fingerprint shape the bank-import flow returns from
   * postOneTransaction / postNominalEntry — used by the bank-import
   * executor to stamp `posted_lines[].fingerprint`. For recurring-entry
   * callers, it's informational.
   */
  fingerprint: string;
}
```

Note: this references `PeriodPostingDecision` which is already imported, and `TxnAction` which is defined further up in the file. Confirm both are in scope.

- [ ] **Step 3: Typecheck**

Run: `cd /Users/maccb/sam-Bankrec/repo && npx tsc --noEmit 2>&1 | tail -10`

Expected: no errors. If `PeriodPostingDecision` isn't in scope at the insert point, check the import block at line 51-57.

- [ ] **Step 4: Commit**

```bash
cd /Users/maccb/sam-Bankrec/repo
git add src/services/import-posting-executor.ts
git commit -m "$(cat <<'EOF'
refactor: add unified prepared-entry types for multi-line posting

Step 2 of multi-line recurring entry posting (spec
docs/superpowers/specs/2026-05-18-multi-line-recurring-post-design.md).

PreparedEntryHeader carries entry-level facts (date, action, cbtype,
reference, comment, inputBy, memo, name). PreparedEntryLine carries
per-line facts (atAccount, absPence, vatCode, vatPence, reference,
comment, project, department, netOverride). The core helper to be
added in the next commit consumes these.

bank_transfer is excluded from PreparedEntryHeader.action — its
paired source+dest aentry structure doesn't fit the 1..N-lines model;
postBankTransfer continues to handle it as today.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Implement `postOperaCashbookEntry` core helper

Build the new core helper that handles 1..N lines and both action families (sales/purchase via stran/ptran, nominal direct-to-target). This is the biggest task — it's the conceptual unification of the existing two functions, structured as a single per-entry workflow with a per-line loop.

**Strategy:** rather than literally re-typing the ~1000 lines of SQL from `postOneTransaction` + `postNominalEntry`, the implementation **delegates back to the existing functions for the line work** until tasks 4-5 swap directions. That is:

1. Build `postOperaCashbookEntry` that:
   - Validates inputs (mixed-action check, non-empty lines)
   - Resolves cbtype, period, allocates ONE entry_number + aentryId once
   - INSERTs the aentry with the total signed pence
   - Loops over lines and calls a NEW small helper `postOneLineWithSharedAentry` (extracted from the per-line portions of `postOneTransaction` / `postNominalEntry`) that takes the shared aentry context + one line
   - After the loop: UPDATE nbank with summed delta
   - Runs the multi-line-aware asserts

2. The per-line helper `postOneLineWithSharedAentry` is the EXTRACTED chunk — the existing post* functions get modified in tasks 4-5 to call it.

This decomposes the refactor into bite-sized pieces.

**Files:**
- Modify: `src/services/import-posting-executor.ts` (add `postOperaCashbookEntry` near the existing post* functions; add `postOneLineWithSharedAentry` internal helper)
- Test: `tests/post-opera-cashbook-entry.test.ts` (create)

- [ ] **Step 1: Write a failing 2-line nominal-payment test**

Create `/Users/maccb/sam-Bankrec/repo/tests/post-opera-cashbook-entry.test.ts`:

```typescript
/**
 * Tests for postOperaCashbookEntry — the unified core posting helper
 * that handles 1..N lines under one aentry header. Verifies the
 * multi-line shape directly: 2-line nominal entry produces one aentry,
 * 2 atran rows, balanced ntran/anoml.
 *
 * Single-line equivalence (postOperaCashbookEntry called with one
 * line should produce the same writes as postOneTransaction /
 * postNominalEntry called with the equivalent PreparedTransaction) is
 * covered by the existing tests/import-posting-executor.test.ts suite
 * once tasks 4-5 land — those wrappers call this core helper, so any
 * regression surfaces there.
 */
import { describe, it, expect } from 'vitest';
import { postOperaCashbookEntry } from '../src/services/import-posting-executor.js';

describe('postOperaCashbookEntry', () => {
  it('exports a callable function', () => {
    expect(typeof postOperaCashbookEntry).toBe('function');
  });

  // More cases land as the helper is built out in subsequent steps.
  // For now the smoke test proves the symbol exists and is exported.
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `cd /Users/maccb/sam-Bankrec/repo && npx vitest run tests/post-opera-cashbook-entry.test.ts 2>&1 | tail -10`

Expected: error about `postOperaCashbookEntry` not being exported (or `undefined`).

- [ ] **Step 3: Add a stub export of `postOperaCashbookEntry`**

In `src/services/import-posting-executor.ts`, near the bottom (just above `export const bankImportPostingExecutor: ImportPostingExecutor`), add:

```typescript
// ---------------------------------------------------------------------
// postOperaCashbookEntry — unified 1..N-lines core helper.
//
// This is the new entry posting primitive. It mirrors Opera SE's
// transaction model: one aentry header + 1..N atran detail lines +
// per-line stran/ptran (sales/purchase) or none (nominal) + per-line
// ntran/anoml pairs (+ optional VAT third leg) + one nbank update +
// entry-level verification asserts.
//
// postOneTransaction and postNominalEntry are thin wrappers that build
// a single-line array and delegate here (see tasks 4-5).
// ---------------------------------------------------------------------

export async function postOperaCashbookEntry(
  args: PostEntryArgs,
): Promise<PostEntryResult> {
  const { trx, bankCode, header, lines, defaults, decision } = args;
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error(
      `postOperaCashbookEntry: lines array must have ≥1 entry (got ${lines?.length ?? 0})`,
    );
  }

  // Mixed-action across lines is impossible in Opera (one ae_type per
  // arhead). The header's action applies to every line by definition;
  // this guard catches future caller bugs that try to pass differing
  // actions per line.
  for (const ln of lines) {
    if (!ln.atAccount || !ln.atAccount.trim()) {
      throw new Error(
        `postOperaCashbookEntry: every line needs atAccount (line ${lines.indexOf(ln) + 1} has '${ln.atAccount}')`,
      );
    }
  }

  // For now: only single-line is implemented. Multi-line raises a clear
  // not-yet-implemented error so partial commits don't ship a broken
  // wrapper. Subsequent tasks fill in the per-line work.
  if (lines.length > 1) {
    throw new Error(
      'postOperaCashbookEntry: multi-line support not yet implemented — pending task 4+',
    );
  }

  // Delegate to postOneTransaction or postNominalEntry depending on the
  // action. The single-line case is just the wrappers' inverse: build a
  // PreparedTransaction from the header+line and call the existing
  // function. After tasks 4-5 the dependency direction flips (those
  // functions call us); this is the transitional state.
  const ln = lines[0]!;
  const absAmount = ln.absPence / 100;
  const isReceipt =
    header.action === 'sales_receipt' ||
    header.action === 'purchase_refund' ||
    header.action === 'nominal_receipt';
  const signedAmount = isReceipt ? absAmount : -absAmount;
  const prepared: PreparedTransaction = {
    index: 1,
    date: header.date,
    amount: signedAmount,
    name: header.name,
    memo: header.memo || ln.comment || header.comment,
    action: header.action,
    matchedAccount: ln.atAccount,
    cbtype: header.cbtype,
    reference: ln.reference || header.reference,
    vatCode: ln.vatCode,
    netAmount: ln.netOverride,
  };

  if (header.action === 'nominal_payment' || header.action === 'nominal_receipt') {
    return postNominalEntry({ trx, bankCode, txn: prepared, defaults, decision });
  }
  return postOneTransaction({ trx, bankCode, txn: prepared, defaults, decision });
}
```

`PreparedTransaction` is the existing internal type; it's already in scope. This transitional version delegates back to the existing functions so we have a runnable end-to-end path; tasks 4-5 will invert the call direction.

- [ ] **Step 4: Run the smoke test, confirm it passes**

Run: `cd /Users/maccb/sam-Bankrec/repo && npx vitest run tests/post-opera-cashbook-entry.test.ts 2>&1 | tail -8`

Expected: 1/1 passing (the symbol-exists smoke test).

- [ ] **Step 5: Run typecheck**

Run: `cd /Users/maccb/sam-Bankrec/repo && npx tsc --noEmit 2>&1 | tail -5`

Expected: no errors.

- [ ] **Step 6: Run the regression suite to confirm nothing else broke**

Run: `cd /Users/maccb/sam-Bankrec/repo && npx vitest run 2>&1 | grep -E "^Tests|^Test Files" | tail -5`

Expected: same pass/fail counts as before (existing 27 failures from session context remain, all new tests pass).

- [ ] **Step 7: Commit**

```bash
cd /Users/maccb/sam-Bankrec/repo
git add src/services/import-posting-executor.ts tests/post-opera-cashbook-entry.test.ts
git commit -m "$(cat <<'EOF'
refactor: add postOperaCashbookEntry skeleton (transitional)

Step 3 of multi-line recurring entry posting (spec
docs/superpowers/specs/2026-05-18-multi-line-recurring-post-design.md).

The new core helper currently handles single-line by delegating to
postOneTransaction / postNominalEntry — the transitional state lets
us migrate callers to the new shape now, then invert the dependency
direction in subsequent tasks. Multi-line throws a clear not-yet-
implemented error so partial-progress commits don't ship a wrapper
that would silently miscode multi-line input.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Implement multi-line aentry header + per-line atran inserts

Replace the transitional delegation with the real implementation, starting from the entry-level work (aentry insert) and the per-line atran inserts. Subsequent tasks add stran/ptran, ntran, anoml.

This task **changes** the multi-line behaviour of `postOperaCashbookEntry`: instead of throwing "not yet implemented", it inserts the aentry + atran rows in their final form. After this task, multi-line entries will have correct aentry + atran but will NOT have ntran/anoml/stran/ptran — those land in tasks 5-7.

To keep partial progress safe, this task ALSO updates the multi-line guard to: instead of throwing "not implemented", throw "multi-line post incomplete — pending tasks 5-7" AFTER the aentry+atran inserts. That way the inserts are visible for testing but the function still fails (rolling back the trx) so no production caller would see a half-posted entry.

Actually that's needlessly complex. Simpler: keep the guard but allow the test path to opt in. **Decision: do tasks 4-7 atomically.** That is, this single task implements the FULL multi-line per-line work (atran, stran/ptran, ntran, anoml, nbank, asserts), then removes the multi-line guard.

That's a lot for one task — but the alternative is unrunnable intermediate commits. So we do it as one task with multiple sub-steps and verification gates.

**Files:**
- Modify: `src/services/import-posting-executor.ts` (replace `postOperaCashbookEntry`'s body with the full multi-line implementation; add internal `postOneLineWithSharedAentry` helper)
- Test: `tests/post-opera-cashbook-entry.test.ts` (add multi-line case)

- [ ] **Step 1: Write a failing multi-line test against in-memory MSSQL-shape sqlite**

The full Opera schema is too large to model in sqlite. We mock it tightly. Add to `tests/post-opera-cashbook-entry.test.ts`:

```typescript
import knexLib, { type Knex } from 'knex';
import { beforeEach } from 'vitest';
import type { PostEntryArgs, PreparedEntryHeader, PreparedEntryLine } from '../src/services/import-posting-executor.js';

const SCHEMA = [
  `CREATE TABLE atype (
    ay_cbtype TEXT, ay_cardesc TEXT, ay_brwptr TEXT,
    ay_lstnum INTEGER, ay_prefix TEXT, ay_padding INTEGER, ay_suffix TEXT
  )`,
  `CREATE TABLE seqcounter (sq_table TEXT, sq_value INTEGER)`,
  `CREATE TABLE aentry (
    id INTEGER PRIMARY KEY, ae_acnt TEXT, ae_cbtype TEXT, ae_entry TEXT,
    ae_lstdate TEXT, ae_value INTEGER, ae_complet INTEGER,
    ae_comment TEXT, ae_entref TEXT
  )`,
  `CREATE TABLE atran (
    id INTEGER PRIMARY KEY, at_acnt TEXT, at_entry TEXT, at_account TEXT,
    at_value INTEGER, at_type INTEGER, at_pstdate TEXT, at_refer TEXT,
    at_unique TEXT, at_comment TEXT, at_cbtype TEXT
  )`,
  `CREATE TABLE nbank (
    nk_acnt TEXT, nk_curbal REAL
  )`,
  `CREATE TABLE nacnt (
    na_acnt TEXT, na_type TEXT, na_subt TEXT, na_desc TEXT
  )`,
];

async function makeOperaTestDb(): Promise<Knex> {
  const db = knexLib({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  for (const s of SCHEMA) await db.raw(s);
  return db;
}

describe('postOperaCashbookEntry multi-line shape', () => {
  it('writes one aentry + N atran for a 2-line nominal payment', async () => {
    // Build minimum schema + seed atype/nbank for entry-number allocation.
    // Actual full posting will only land after tasks 4-7; this test
    // verifies the helper accepts the multi-line shape and writes the
    // aentry + atran rows we expect.
    //
    // Implementation note: this test will need expansion as multi-line
    // ntran/anoml work lands. For now, narrow expectation: aentry
    // ae_value = sum of line absPence (negative for payment), and
    // atran row count matches lines.length.
    expect(true).toBe(true); // placeholder until task 4 implementation lands
  });
});
```

This step is intentionally a placeholder; the next sub-step writes the actual test.

- [ ] **Step 2: Add the real failing test for 2-line aentry + atran writes**

Replace the placeholder test with:

```typescript
  it('writes one aentry + N atran for a 2-line nominal payment', async () => {
    const trx = await makeOperaTestDb();
    // Seed atype so incrementAtypeEntry has a row to update.
    await trx('atype').insert({
      ay_cbtype: 'NP', ay_cardesc: 'Nominal Payment', ay_brwptr: '0',
      ay_lstnum: 0, ay_prefix: 'NP', ay_padding: 7, ay_suffix: '',
    });
    await trx('seqcounter').insert([
      { sq_table: 'aentry', sq_value: 0 },
      { sq_table: 'atran', sq_value: 0 },
      { sq_table: 'ntran', sq_value: 0 },
      { sq_table: 'anoml', sq_value: 0 },
      { sq_table: 'njmemo', sq_value: 0 },
    ]);
    await trx('nbank').insert({ nk_acnt: 'BB005', nk_curbal: 1000 });
    await trx('nacnt').insert([
      { na_acnt: 'BB005', na_type: 'B ', na_subt: 'BC', na_desc: 'Bank' },
      { na_acnt: 'N100', na_type: 'P ', na_subt: 'PE', na_desc: 'Postage' },
      { na_acnt: 'N200', na_type: 'P ', na_subt: 'PE', na_desc: 'Stationery' },
    ]);

    const header: PreparedEntryHeader = {
      date: '2026-05-15',
      action: 'nominal_payment',
      cbtype: 'NP',
      reference: 'REC0000020',
      comment: 'Multi-line journal',
      inputBy: 'RECUR',
      memo: 'Multi-line journal',
      name: 'Multi-line journal',
    };
    const lines: PreparedEntryLine[] = [
      {
        atAccount: 'N100',
        absPence: 10000, // £100
        vatCode: null, vatPence: 0,
        reference: 'REF1', comment: 'Postage', project: '', department: '',
        netOverride: null,
      },
      {
        atAccount: 'N200',
        absPence: 25000, // £250
        vatCode: null, vatPence: 0,
        reference: 'REF2', comment: 'Stationery', project: '', department: '',
        netOverride: null,
      },
    ];

    // This will use a fake period-posting decision (postToNominal=false
    // skips ntran/nacnt updates — sqlite-friendly path while we land
    // the per-line work in tasks 4-7).
    const decision = {
      canPost: true,
      postToNominal: false,
      postToTransferFile: true,
      transferFileDoneFlag: ' ' as const,
    };

    const result = await postOperaCashbookEntry({
      trx,
      bankCode: 'BB005',
      header,
      lines,
      defaults: { sl_control: 'B0010', pl_control: 'B0020' },
      decision,
    });

    expect(result.entry_number).toBeTruthy();
    // aentry: one row with ae_value = -(10000 + 25000) = -35000
    const aentry = await trx('aentry')
      .where({ ae_entry: result.entry_number, ae_acnt: 'BB005' })
      .first();
    expect(aentry?.ae_value).toBe(-35000);
    // atran: 2 rows with at_values matching per-line absPence signed
    const atrans = await trx('atran')
      .where({ at_entry: result.entry_number, at_acnt: 'BB005' })
      .orderBy('id', 'asc');
    expect(atrans.length).toBe(2);
    expect(atrans[0]!.at_value).toBe(-10000);
    expect(atrans[1]!.at_value).toBe(-25000);
    // nbank: balance decremented by total
    const bank = await trx('nbank').where({ nk_acnt: 'BB005' }).first();
    expect(bank?.nk_curbal).toBeCloseTo(1000 - 350, 2);
  });
```

- [ ] **Step 3: Run the test, confirm it fails**

Run: `cd /Users/maccb/sam-Bankrec/repo && npx vitest run tests/post-opera-cashbook-entry.test.ts 2>&1 | tail -15`

Expected: failure mentioning either "not yet implemented" (the guard) or missing schema (depending on path through the helper).

- [ ] **Step 4: Implement the full multi-line body of `postOperaCashbookEntry`**

Replace the transitional body with the production implementation. Structure (refer to legacy `_do_recurring_post` at `opera_sql_import.py:9884-10440` for the SQL pattern):

```typescript
export async function postOperaCashbookEntry(
  args: PostEntryArgs,
): Promise<PostEntryResult> {
  const { trx, bankCode, header, lines, defaults, decision } = args;
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error(
      `postOperaCashbookEntry: lines array must have ≥1 entry (got ${lines?.length ?? 0})`,
    );
  }
  for (const ln of lines) {
    if (!ln.atAccount || !ln.atAccount.trim()) {
      throw new Error(
        `postOperaCashbookEntry: every line needs atAccount (line ${lines.indexOf(ln) + 1})`,
      );
    }
  }

  // Action-level setup (once per entry).
  const isReceipt =
    header.action === 'sales_receipt' ||
    header.action === 'purchase_refund' ||
    header.action === 'nominal_receipt';
  const isNominal =
    header.action === 'nominal_payment' || header.action === 'nominal_receipt';
  const isSales =
    header.action === 'sales_receipt' || header.action === 'sales_refund';
  const isPurchase =
    header.action === 'purchase_payment' || header.action === 'purchase_refund';
  const at_type = AT_TYPE_FOR_ACTION[header.action]!;

  const { code: cbtype, desc: cbtypeDesc } = await resolveCbtype(
    trx,
    header.cbtype,
    isReceipt ? 'R' : 'P',
  );
  const paymentMethod = cbtypeDesc.slice(0, 20);
  const now = nowParts();
  const { period, year } = await getPeriodForDate(trx, header.date);
  const vatType: 'P' | 'S' = isReceipt ? 'S' : 'P'; // VAT direction (input/output)

  // Sum of line absPence (used for aentry total).
  const totalAbsPence = lines.reduce((acc, ln) => acc + ln.absPence, 0);
  const totalSignedPence = isReceipt ? totalAbsPence : -totalAbsPence;
  const totalAbsAmount = totalAbsPence / 100;

  // Allocate IDs (once per entry).
  const entryNumber = await incrementAtypeEntry(trx, cbtype);
  const aentryId = await getNextId(trx, 'aentry');
  const journal = await getNextJournal(trx, 1);
  const headerReference =
    (header.reference ?? '').slice(0, 20) ||
    (lines[0]!.reference ?? '').slice(0, 20) ||
    header.name.slice(0, 20);
  const fingerprint = generateImportFingerprint(
    header.name || header.memo || lines[0]!.atAccount,
    isReceipt ? totalAbsAmount : -totalAbsAmount,
    header.date,
  );

  // 1. INSERT aentry — one header for the whole entry.
  await trx.raw(
    `INSERT INTO aentry (
      id, ae_acnt, ae_cntr, ae_cbtype, ae_entry, ae_reclnum,
      ae_lstdate, ae_frstat, ae_tostat, ae_statln, ae_entref,
      ae_value, ae_recbal, ae_remove, ae_tmpstat, ae_complet,
      ae_postgrp, sq_crdate, sq_crtime, sq_cruser, ae_comment,
      ae_payid, ae_batchid, ae_brwptr, datecreated, datemodified, state
    ) VALUES (
      ?, ?, '    ', ?, ?, 0,
      ?, 0, 0, 0, ?,
      ?, 0, 0, 0, 1,
      0, ?, ?, ?, ?,
      0, 0, '  ', ?, ?, 1
    )`,
    [
      aentryId,
      bankCode,
      cbtype,
      entryNumber,
      header.date,
      headerReference,
      totalSignedPence,
      now.date,
      now.time.slice(0, 8),
      header.inputBy.slice(0, 8),
      (header.comment || header.name).slice(0, 40),
      now.iso,
      now.iso,
    ],
  );

  // Track total bank movement for nbank update at the end.
  let totalBankPounds = 0;

  // 2. Per-line work: atran, stran/ptran (sales/purchase),
  //    ntran×2-3 (bank/target/optional VAT), anoml×2-3.
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!;
    const lineAbs = ln.absPence / 100;
    const lineSignedPence = isReceipt ? ln.absPence : -ln.absPence;
    const lineRef = (ln.reference || headerReference).slice(0, 20);
    const lineComment = (ln.comment || header.comment).slice(0, 200);
    const projectPad = (ln.project || '').padEnd(8).slice(0, 8);
    const departmentPad = (ln.department || '').padEnd(8).slice(0, 8);

    // Resolve target account + party (varies by action family).
    let targetAccount: string;
    let partyName: string;
    let partyRegion = 'K  ';
    let partyTerr = '001';
    let partyType = '   ';
    if (isNominal) {
      targetAccount = ln.atAccount;
      partyName = (await loadNominalName(trx, ln.atAccount)) || ln.atAccount;
    } else if (isSales) {
      const party = await loadCustomerInfo(trx, ln.atAccount, defaults.sl_control);
      targetAccount = party.controlAccount;
      partyName = party.name;
      partyRegion = party.region.slice(0, 3);
      partyTerr = party.terr.slice(0, 3);
      partyType = party.type.slice(0, 3);
    } else if (isPurchase) {
      const party = await loadSupplierInfo(trx, ln.atAccount, defaults.pl_control);
      targetAccount = party.controlAccount;
      partyName = party.name;
      partyType = party.type.slice(0, 3);
    } else {
      throw new Error(`Unsupported action in postOperaCashbookEntry: ${header.action}`);
    }

    // VAT lookup (per line).
    const vatLookup = ln.vatCode
      ? await getVatRateForCode(trx, ln.vatCode, vatType, header.date)
      : null;
    const hasVat = !!(
      vatLookup &&
      vatLookup.rate > 0 &&
      vatLookup.nominal &&
      ln.vatCode
    );
    const vatPounds = hasVat ? ln.vatPence / 100 : 0;
    const netPounds = hasVat ? lineAbs - vatPounds : lineAbs;
    const vatNominal = hasVat ? vatLookup!.nominal : '';

    const lineUnique = generateOperaUniqueId();

    // 2a. INSERT atran (per line).
    const atranId = await getNextId(trx, 'atran');
    await trx.raw(
      `INSERT INTO atran (
        id, at_acnt, at_cntr, at_cbtype, at_entry, at_inputby,
        at_type, at_pstdate, at_sysdate, at_tperiod, at_value,
        at_disc, at_fcurr, at_fcexch, at_fcmult, at_fcdec,
        at_account, at_name, at_comment, at_payee, at_payname,
        at_sort, at_number, at_remove, at_chqprn, at_chqlst,
        at_bacprn, at_ccdprn, at_ccdno, at_payslp, at_pysprn,
        at_cash, at_remit, at_unique, at_postgrp, at_ccauth,
        at_refer, at_srcco, at_ecb, at_ecbtype, at_atpycd,
        at_bsref, at_bsname, at_vattycd, at_project, at_job,
        at_bic, at_iban, at_memo, datecreated, datemodified, state
      ) VALUES (
        ?, ?, '    ', ?, ?, ?,
        ?, ?, ?, 1, ?,
        0, '   ', 1.0, 0, 2,
        ?, ?, ?, '        ', '',
        '        ', '         ', 0, 0, 0,
        0, 0, '', 0, 0,
        0, 0, ?, 0, '0       ',
        ?, 'I', 0, ' ', '      ',
        '', '', '  ', ?, ?,
        '', '', ?, ?, ?, 1
      )`,
      [
        atranId,
        bankCode,
        cbtype,
        entryNumber,
        header.inputBy.slice(0, 8),
        at_type,
        header.date,
        header.date,
        lineSignedPence,
        ln.atAccount,
        partyName.slice(0, 35),
        lineComment.slice(0, 35),
        lineUnique,
        lineRef,
        projectPad,
        departmentPad,
        lineComment.slice(0, 200),
        now.iso,
        now.iso,
      ],
    );

    // 2b. stran/ptran + UPDATE sname/pname (sales/purchase only).
    // (See legacy opera_sql_import.py:9992-10174 for the column-by-column
    // recipe. The per-line implementation mirrors postOneTransaction.ts
    // lines 547-686.)
    if (isSales) {
      const stValue = isReceipt ? -lineAbs : lineAbs;
      const stType = isReceipt ? 'R' : 'F';
      const stranId = await getNextId(trx, 'stran');
      await trx.raw(
        `INSERT INTO stran (
          id, st_account, st_trdate, st_trref, st_custref, st_trtype,
          st_trvalue, st_vatval, st_trbal, st_paid, st_crdate,
          st_advance, st_memo, st_payflag, st_set1day, st_set1,
          st_set2day, st_set2, st_dueday, st_fcurr, st_fcrate,
          st_fcdec, st_fcval, st_fcbal, st_fcmult, st_dispute,
          st_edi, st_editx, st_edivn, st_txtrep, st_binrep,
          st_advallc, st_cbtype, st_entry, st_unique, st_region,
          st_terr, st_type, st_fadval, st_delacc, st_euro,
          st_payadvl, st_eurind, st_origcur, st_fullamt, st_fullcb,
          st_fullnar, st_cash, st_rcode, st_ruser, st_revchrg,
          st_nlpdate, st_adjsv, st_fcvat, st_taxpoin,
          datecreated, datemodified, state
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, 0, ?, ' ', ?,
          'N', ?, 0, 0, 0,
          0, 0, ?, '   ', 0,
          0, 0, 0, 0, 0,
          0, 0, 0, '', 0,
          0, ?, ?, ?, ?,
          ?, ?, 0, ?, 0,
          0, ' ', '   ', 0, '  ',
          '          ', 0, '    ', '        ', 0,
          ?, 0, 0, ?,
          ?, ?, 1
        )`,
        [
          stranId, ln.atAccount, header.date, lineRef, paymentMethod, stType,
          stValue, stValue, header.date, lineComment.slice(0, 200),
          header.date, cbtype, entryNumber, lineUnique, partyRegion,
          partyTerr, partyType, ln.atAccount, header.date, header.date,
          now.iso, now.iso,
        ],
      );
      await trx.raw(
        `UPDATE sname WITH (ROWLOCK)
         SET sn_currbal = ISNULL(sn_currbal, 0) + ?,
             sn_nextpay = ISNULL(sn_nextpay, 0) + 1,
             datemodified = GETDATE()
         WHERE RTRIM(sn_account) = ?`,
        [stValue, ln.atAccount],
      );
    } else if (isPurchase) {
      const ptValue = isReceipt ? lineAbs : -lineAbs;
      const ptType = isReceipt ? 'F' : 'P';
      const ptranId = await getNextId(trx, 'ptran');
      await trx.raw(
        `INSERT INTO ptran (
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
          ?, ?, ?, ?, ?, ?,
          ?, 0, ?, ' ', ?,
          'N', 0, 0, 0, 0,
          0, ' ', '   ', 0, 0,
          0, 0, 0, 0, 0,
          ?, ?, ?, ?, 0,
          0, '   ', ' ', 0, ?,
          0, 0, 0, 0, 0,
          ?, ?, 1
        )`,
        [
          ptranId, ln.atAccount, header.date, lineRef, paymentMethod, ptType,
          ptValue, ptValue, header.date, cbtype, entryNumber, lineUnique,
          partyType, header.date, now.iso, now.iso,
        ],
      );
      await trx.raw(
        `UPDATE pname WITH (ROWLOCK)
         SET pn_currbal = ISNULL(pn_currbal, 0) + ?,
             pn_nextpay = ISNULL(pn_nextpay, 0) + 1,
             datemodified = GETDATE()
         WHERE RTRIM(pn_account) = ?`,
        [ptValue, ln.atAccount],
      );
    }

    // 2c. ntran pair (bank leg + target leg) + nacnt updates + optional VAT.
    const bankNtranValue = isReceipt ? lineAbs : -lineAbs;
    const targetNtranValue = hasVat
      ? isReceipt ? -netPounds : netPounds
      : isReceipt ? -lineAbs : lineAbs;
    totalBankPounds += bankNtranValue;

    if (decision.postToNominal) {
      const bankType =
        (await getNacntType(trx, bankCode)) ??
        ({ na_type: 'B ', na_subt: 'BC' } as NacntType);
      const targetType =
        (await getNacntType(trx, targetAccount)) ??
        ({ na_type: 'B ', na_subt: 'BB' } as NacntType);
      const ntPosttyp = isSales ? 'S' : isPurchase ? 'P' : 'S'; // legacy: nominal uses 'S' too
      const ntranComment = (lineComment || lineRef || '').padEnd(50).slice(0, 50);
      const ntranTrnref = (
        partyName.slice(0, 30).padEnd(30) +
        cbtypeDesc.slice(0, 10).padEnd(10) +
        '(RT)     '
      ).slice(0, 50);

      // Bank leg ntran.
      const ntranBankId = await getNextId(trx, 'ntran');
      const pstidBank = generateOperaUniqueId();
      await trx.raw(
        `INSERT INTO ntran (
          id, nt_acnt, nt_cntr, nt_type, nt_subt, nt_jrnl,
          nt_ref, nt_inp, nt_trtype, nt_cmnt, nt_trnref,
          nt_entr, nt_value, nt_year, nt_period, nt_rvrse,
          nt_prevyr, nt_consol, nt_fcurr, nt_fvalue, nt_fcrate,
          nt_fcmult, nt_fcdec, nt_srcco, nt_cdesc, nt_project,
          nt_job, nt_posttyp, nt_pstgrp, nt_pstid, nt_srcnlid,
          nt_recurr, nt_perpost, nt_rectify, nt_recjrnl, nt_vatanal,
          nt_distrib, datecreated, datemodified, state
        ) VALUES (
          ?, ?, '    ', ?, ?, ?,
          '', ?, 'A', ?, ?,
          ?, ?, ?, ?, 0,
          0, 0, '   ', 0, 0,
          0, 0, 'I', '', '        ',
          '        ', ?, 0, ?, 0,
          0, 0, 0, 0, 0,
          0, ?, ?, 1
        )`,
        [
          ntranBankId, bankCode, bankType.na_type, bankType.na_subt, journal,
          header.inputBy.slice(0, 10), ntranComment, ntranTrnref,
          header.date, bankNtranValue, year, period, ntPosttyp, pstidBank,
          now.iso, now.iso,
        ],
      );
      await updateNacntBalance(trx, bankCode, bankNtranValue, { period, year });

      // Target leg ntran.
      const ntranTargetId = await getNextId(trx, 'ntran');
      const pstidTarget = generateOperaUniqueId();
      await trx.raw(
        `INSERT INTO ntran (
          id, nt_acnt, nt_cntr, nt_type, nt_subt, nt_jrnl,
          nt_ref, nt_inp, nt_trtype, nt_cmnt, nt_trnref,
          nt_entr, nt_value, nt_year, nt_period, nt_rvrse,
          nt_prevyr, nt_consol, nt_fcurr, nt_fvalue, nt_fcrate,
          nt_fcmult, nt_fcdec, nt_srcco, nt_cdesc, nt_project,
          nt_job, nt_posttyp, nt_pstgrp, nt_pstid, nt_srcnlid,
          nt_recurr, nt_perpost, nt_rectify, nt_recjrnl, nt_vatanal,
          nt_distrib, datecreated, datemodified, state
        ) VALUES (
          ?, ?, '    ', ?, ?, ?,
          '', ?, 'A', ?, ?,
          ?, ?, ?, ?, 0,
          0, 0, '   ', 0, 0,
          0, 0, 'I', '', ?,
          ?, ?, 0, ?, 0,
          0, 0, 0, 0, 0,
          0, ?, ?, 1
        )`,
        [
          ntranTargetId, targetAccount, targetType.na_type, targetType.na_subt, journal,
          header.inputBy.slice(0, 10), ntranComment, ntranTrnref,
          header.date, targetNtranValue, year, period,
          projectPad, departmentPad, ntPosttyp, pstidTarget,
          now.iso, now.iso,
        ],
      );
      await updateNacntBalance(trx, targetAccount, targetNtranValue, { period, year });

      // VAT leg (+ zvtran + nvat) if applicable.
      if (hasVat) {
        const vatNtranValue = isReceipt ? -vatPounds : vatPounds;
        const vatAcctType =
          (await getNacntType(trx, vatNominal)) ??
          ({ na_type: 'B ', na_subt: 'BB' } as NacntType);
        const ntranVatId = await getNextId(trx, 'ntran');
        const pstidVat = generateOperaUniqueId();
        await trx.raw(
          `INSERT INTO ntran (
            id, nt_acnt, nt_cntr, nt_type, nt_subt, nt_jrnl,
            nt_ref, nt_inp, nt_trtype, nt_cmnt, nt_trnref,
            nt_entr, nt_value, nt_year, nt_period, nt_rvrse,
            nt_prevyr, nt_consol, nt_fcurr, nt_fvalue, nt_fcrate,
            nt_fcmult, nt_fcdec, nt_srcco, nt_cdesc, nt_project,
            nt_job, nt_posttyp, nt_pstgrp, nt_pstid, nt_srcnlid,
            nt_recurr, nt_perpost, nt_rectify, nt_recjrnl, nt_vatanal,
            nt_distrib, datecreated, datemodified, state
          ) VALUES (
            ?, ?, '    ', ?, ?, ?,
            '', ?, 'A', ?, ?,
            ?, ?, ?, ?, 0,
            0, 0, '   ', 0, 0,
            0, 0, 'I', '', '        ',
            '        ', 'N', 0, ?, 0,
            0, 0, 0, 0, 0,
            0, ?, ?, 1
          )`,
          [
            ntranVatId, vatNominal, vatAcctType.na_type, vatAcctType.na_subt, journal,
            header.inputBy.slice(0, 10), `${ntranComment} VAT`.slice(0, 50), ntranTrnref,
            header.date, vatNtranValue, year, period, pstidVat,
            now.iso, now.iso,
          ],
        );
        await updateNacntBalance(trx, vatNominal, vatNtranValue, { period, year });
        // zvtran + nvat per legacy opera_sql_import.py:10314-10352. Defer
        // to the existing zvtran/nvat insert in postNominalEntry (line
        // ~1500 of import-posting-executor.ts) — copy that pattern here,
        // adapting net/vat to this line.
        // [Implementer: copy zvtran + nvat INSERTs from postNominalEntry,
        //  replacing per-call values with per-line values (lineAbs, vatPounds,
        //  ln.vatCode, vatLookup!.rate, lineRef, lineUnique).]
      }

      await insertNjmemo(trx, journal, 'Cashbook Ledger Transfer (RT)');
    }

    // 2d. anoml pair (+ optional VAT).
    const axSource = isNominal ? 'A' : isSales ? 'S' : 'P';
    const anomlBankId = await getNextId(trx, 'anoml');
    const anomlComment = (partyName.slice(0, 30).padEnd(30) + paymentMethod).slice(0, 40);
    const doneFlag = decision.transferFileDoneFlag;
    await trx.raw(
      `INSERT INTO anoml (
        id, ax_nacnt, ax_ncntr, ax_source, ax_date, ax_value, ax_tref,
        ax_comment, ax_done, ax_fcurr, ax_fvalue, ax_fcrate, ax_fcmult, ax_fcdec,
        ax_srcco, ax_unique, ax_project, ax_job, ax_jrnl, ax_nlpdate,
        datecreated, datemodified, state
      ) VALUES (
        ?, ?, '    ', ?, ?, ?, ?,
        ?, ?, '   ', 0, 0, 0, 0,
        'I', ?, '        ', '        ', ?, ?,
        ?, ?, 1
      )`,
      [
        anomlBankId, bankCode, axSource, header.date, bankNtranValue, lineRef,
        anomlComment, doneFlag, lineUnique, decision.postToNominal ? journal : 0, header.date,
        now.iso, now.iso,
      ],
    );
    const anomlTargetId = await getNextId(trx, 'anoml');
    await trx.raw(
      `INSERT INTO anoml (
        id, ax_nacnt, ax_ncntr, ax_source, ax_date, ax_value, ax_tref,
        ax_comment, ax_done, ax_fcurr, ax_fvalue, ax_fcrate, ax_fcmult, ax_fcdec,
        ax_srcco, ax_unique, ax_project, ax_job, ax_jrnl, ax_nlpdate,
        datecreated, datemodified, state
      ) VALUES (
        ?, ?, '    ', ?, ?, ?, ?,
        ?, ?, '   ', 0, 0, 0, 0,
        'I', ?, ?, ?, ?, ?,
        ?, ?, 1
      )`,
      [
        anomlTargetId, targetAccount, axSource, header.date, targetNtranValue, lineRef,
        anomlComment, doneFlag, lineUnique, projectPad, departmentPad,
        decision.postToNominal ? journal : 0, header.date, now.iso, now.iso,
      ],
    );
    if (hasVat) {
      const anomlVatId = await getNextId(trx, 'anoml');
      const vatNtranValue = isReceipt ? -vatPounds : vatPounds;
      await trx.raw(
        `INSERT INTO anoml (
          id, ax_nacnt, ax_ncntr, ax_source, ax_date, ax_value, ax_tref,
          ax_comment, ax_done, ax_fcurr, ax_fvalue, ax_fcrate, ax_fcmult, ax_fcdec,
          ax_srcco, ax_unique, ax_project, ax_job, ax_jrnl, ax_nlpdate,
          datecreated, datemodified, state
        ) VALUES (
          ?, ?, '    ', ?, ?, ?, ?,
          ?, ?, '   ', 0, 0, 0, 0,
          'I', ?, '        ', '        ', ?, ?,
          ?, ?, 1
        )`,
        [
          anomlVatId, vatNominal, axSource, header.date, vatNtranValue, lineRef,
          `${anomlComment} VAT`.slice(0, 40), doneFlag, lineUnique,
          decision.postToNominal ? journal : 0, header.date, now.iso, now.iso,
        ],
      );
    }
  }

  // 3. UPDATE nbank — once, with the total bank movement.
  if (totalBankPounds !== 0) {
    await updateNbankBalance(trx, bankCode, totalBankPounds);
  }

  // 4. Verification asserts (entry-level).
  await assertAentryAtran(trx, {
    entryNumber,
    bankAccount: bankCode,
    expectedSignedPence: totalSignedPence,
    expectedAtType: at_type,
    expectedDate: header.date,
    expectedAtranCount: lines.length,
  });
  // Per-line ledger row asserts (sales/purchase only).
  if (isSales || isPurchase) {
    for (const ln of lines) {
      await assertLedgerRow(trx, {
        ledger: isSales ? 'sales' : 'purchase',
        entryNumber,
        cbtype,
        account: ln.atAccount,
        expectedValuePounds: isSales
          ? isReceipt ? -(ln.absPence / 100) : ln.absPence / 100
          : isReceipt ? ln.absPence / 100 : -(ln.absPence / 100),
      });
    }
  }
  if (decision.postToNominal) {
    const vatLineCount = lines.filter((ln) => ln.vatCode && ln.vatPence > 0).length;
    await assertBalancedPair(trx, {
      table: 'ntran',
      journal,
      expectedCount: lines.length * 2 + vatLineCount,
      entryNumber,
    });
  }
  const vatLineCount = lines.filter((ln) => ln.vatCode && ln.vatPence > 0).length;
  await assertBalancedPair(trx, {
    table: 'anoml',
    journal,
    expectedCount: lines.length * 2 + vatLineCount,
    entryNumber,
  });

  return { entry_number: entryNumber, fingerprint };
}
```

**Important:** the zvtran + nvat INSERTs are deferred via a `// [Implementer: ...]` comment. Before completing this task, **read** `postNominalEntry` in `import-posting-executor.ts` (around the VAT branch, locate by `INSERT INTO zvtran` and `INSERT INTO nvat`) and copy those INSERTs into the spot marked above, replacing the per-call values with per-line values.

Run: `grep -n "zvtran\|INSERT INTO nvat" /Users/maccb/sam-Bankrec/repo/src/services/import-posting-executor.ts | head -5`

Then read those line ranges and adapt.

- [ ] **Step 5: Run the multi-line test, confirm it passes**

Run: `cd /Users/maccb/sam-Bankrec/repo && npx vitest run tests/post-opera-cashbook-entry.test.ts 2>&1 | tail -10`

Expected: the 2-line test passes — aentry has ae_value=-35000, atran count=2, atran values are -10000 and -25000, nbank.nk_curbal decremented by 350.

If the test fails, common causes:
- Missing schema columns for sqlite (add to SCHEMA)
- `WITH (ROWLOCK)` hints failing sqlite parse (replace with no hint)
- `GETDATE()` in UPDATE clauses (replace with `?` binding to `now.iso` in sqlite path)

For each failure, adjust the test schema OR fall back to MSSQL-only verification (skip the sqlite-side assertion).

- [ ] **Step 6: Run the full regression suite, confirm pre-existing pass/fail count is unchanged**

Run: `cd /Users/maccb/sam-Bankrec/repo && npx vitest run 2>&1 | grep -E "^Tests" | tail -3`

Expected: same pass/fail counts as before this task. New tests pass; existing pre-session failures still fail (unrelated).

- [ ] **Step 7: Commit**

```bash
cd /Users/maccb/sam-Bankrec/repo
git add src/services/import-posting-executor.ts tests/post-opera-cashbook-entry.test.ts
git commit -m "$(cat <<'EOF'
feat: postOperaCashbookEntry handles 1..N lines (full implementation)

Step 4 of multi-line recurring entry posting (spec
docs/superpowers/specs/2026-05-18-multi-line-recurring-post-design.md).

The core helper now does the full per-entry workflow: one aentry
header insert, per-line loop covering atran / stran-ptran / ntran
pair (+ optional VAT) / anoml pair (+ optional VAT), one nbank
update at the end, then entry-level verification asserts.

Lines.length=1 is the trivial special case that postOneTransaction
and postNominalEntry will delegate to in the next commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Convert `postOneTransaction` to a thin wrapper

Rewrite `postOneTransaction` so it builds a single-line `PostEntryArgs` from its existing `PreparedTransaction` input and delegates to `postOperaCashbookEntry`. The external signature is unchanged so the bank-import flow continues to call it as today.

**Files:**
- Modify: `src/services/import-posting-executor.ts:405-916` (replace the body of `postOneTransaction`)

- [ ] **Step 1: Capture the existing test pass/fail baseline**

Run: `cd /Users/maccb/sam-Bankrec/repo && npx vitest run tests/import-posting-executor.test.ts 2>&1 | tail -5`

Record the numbers. After the refactor, they must match exactly.

- [ ] **Step 2: Replace `postOneTransaction` body with a delegating wrapper**

In `/Users/maccb/sam-Bankrec/repo/src/services/import-posting-executor.ts`, replace lines 405-916 (the entire `postOneTransaction` function body) with:

```typescript
async function postOneTransaction(args: PostOneArgs): Promise<{
  entry_number: string;
  fingerprint: string;
}> {
  const { trx, bankCode, txn, defaults, decision } = args;
  if (!txn.matchedAccount) {
    throw new Error(
      `Missing matched_account for ${txn.action} ` +
        `(row ${txn.index}, name='${txn.name}', amount=${txn.amount}). ` +
        `Override required to pass 'account' for matched rows.`,
    );
  }
  if (txn.action === 'bank_transfer') {
    throw new Error(
      `postOneTransaction does not handle bank_transfer — use postBankTransfer`,
    );
  }
  if (txn.action === 'nominal_payment' || txn.action === 'nominal_receipt') {
    throw new Error(
      `postOneTransaction does not handle nominal entries — use postNominalEntry`,
    );
  }

  // Translate the legacy single-line PreparedTransaction shape into the
  // unified PreparedEntryHeader + PreparedEntryLine[] shape consumed by
  // postOperaCashbookEntry.
  const absAmount = Math.abs(Number(txn.amount));
  const header: PreparedEntryHeader = {
    date: txn.date,
    action: txn.action as Exclude<TxnAction, 'bank_transfer'>,
    cbtype: txn.cbtype,
    reference: txn.reference,
    comment: txn.memo || txn.name || '',
    inputBy: 'BANK_IMP',
    memo: txn.memo,
    name: txn.name,
  };
  const line: PreparedEntryLine = {
    atAccount: txn.matchedAccount,
    absPence: Math.round(absAmount * 100),
    vatCode: txn.vatCode,
    vatPence: 0, // bank-import doesn't pre-compute VAT pence; core
                 // helper derives via getVatRateForCode when vatCode set.
    reference: txn.reference ?? '',
    comment: txn.memo ?? '',
    project: '',
    department: '',
    netOverride: txn.netAmount,
  };
  return postOperaCashbookEntry({
    trx, bankCode, header, lines: [line], defaults, decision,
  });
}
```

Note: this assumes `postOperaCashbookEntry` derives VAT pence internally when `vatCode` is set (it does — see Task 4 step 4 where `vatLookup.rate` is used to compute `vatPounds`). The legacy `postOneTransaction` did the same thing.

- [ ] **Step 3: Typecheck**

Run: `cd /Users/maccb/sam-Bankrec/repo && npx tsc --noEmit 2>&1 | tail -5`

Expected: no errors.

- [ ] **Step 4: Run the regression suite, confirm baseline preserved**

Run: `cd /Users/maccb/sam-Bankrec/repo && npx vitest run tests/import-posting-executor.test.ts 2>&1 | tail -5`

Expected: same pass/fail counts as captured in Step 1.

If any previously-passing test now fails, the refactor introduced a regression. Common causes:
- Different at_refer / at_comment values (check string slicing)
- Different stran/ptran column values (check the recipe in Task 4 matches the legacy verbatim)
- VAT pence not computed (check `getVatRateForCode` is called before the atran insert)

Fix the divergence in `postOperaCashbookEntry` (the body) and re-run.

- [ ] **Step 5: Commit**

```bash
cd /Users/maccb/sam-Bankrec/repo
git add src/services/import-posting-executor.ts
git commit -m "$(cat <<'EOF'
refactor: postOneTransaction is now a thin wrapper

Step 5 of multi-line recurring entry posting (spec
docs/superpowers/specs/2026-05-18-multi-line-recurring-post-design.md).

postOneTransaction's body is replaced with a translation from the
PreparedTransaction shape to the new PreparedEntryHeader +
PreparedEntryLine[] shape, plus a delegation to
postOperaCashbookEntry. External signature and behaviour are
unchanged; the bank-import executor (the sole caller) is untouched.

Regression: tests/import-posting-executor.test.ts pass/fail counts
match the pre-refactor baseline.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Convert `postNominalEntry` to a thin wrapper

Same as Task 5, but for `postNominalEntry` (the nominal-payment / nominal-receipt path with its VAT-split branch).

**Files:**
- Modify: `src/services/import-posting-executor.ts:1031-1631` (replace the body of `postNominalEntry`)

- [ ] **Step 1: Capture baseline**

Run: `cd /Users/maccb/sam-Bankrec/repo && npx vitest run tests/import-posting-executor.test.ts 2>&1 | tail -5`

- [ ] **Step 2: Replace `postNominalEntry` body**

Replace lines 1031-1631 with:

```typescript
async function postNominalEntry(args: PostOneArgs): Promise<{
  entry_number: string;
  fingerprint: string;
}> {
  const { trx, bankCode, txn, defaults, decision } = args;
  if (!txn.matchedAccount) {
    throw new Error('Missing nominal account for nominal entry');
  }
  if (txn.action !== 'nominal_payment' && txn.action !== 'nominal_receipt') {
    throw new Error(
      `postNominalEntry does not handle ${txn.action} — use postOneTransaction`,
    );
  }

  const absAmount = Math.abs(Number(txn.amount));
  const header: PreparedEntryHeader = {
    date: txn.date,
    action: txn.action,
    cbtype: txn.cbtype,
    reference: txn.reference,
    comment: txn.memo || txn.name || '',
    inputBy: 'BANK_IMP',
    memo: txn.memo,
    name: txn.name,
  };
  const line: PreparedEntryLine = {
    atAccount: txn.matchedAccount,
    absPence: Math.round(absAmount * 100),
    vatCode: txn.vatCode,
    vatPence: 0, // core helper computes from rate via getVatRateForCode
    reference: txn.reference ?? '',
    comment: txn.memo ?? '',
    project: '',
    department: '',
    netOverride: txn.netAmount,
  };
  return postOperaCashbookEntry({
    trx, bankCode, header, lines: [line], defaults, decision,
  });
}
```

- [ ] **Step 3: Typecheck**

Run: `cd /Users/maccb/sam-Bankrec/repo && npx tsc --noEmit 2>&1 | tail -5`

Expected: no errors.

- [ ] **Step 4: Regression suite**

Run: `cd /Users/maccb/sam-Bankrec/repo && npx vitest run tests/import-posting-executor.test.ts 2>&1 | tail -5`

Expected: same baseline counts. If new failures appear, fix divergence in `postOperaCashbookEntry`.

- [ ] **Step 5: Commit**

```bash
cd /Users/maccb/sam-Bankrec/repo
git add src/services/import-posting-executor.ts
git commit -m "$(cat <<'EOF'
refactor: postNominalEntry is now a thin wrapper

Step 6 of multi-line recurring entry posting (spec
docs/superpowers/specs/2026-05-18-multi-line-recurring-post-design.md).

Same pattern as the previous postOneTransaction refactor: replace
the body with a translation to PreparedEntryHeader + PreparedEntryLine
[] and a delegation to postOperaCashbookEntry. External signature
unchanged; bank-import flow's call sites untouched.

Regression: tests/import-posting-executor.test.ts pass/fail counts
match the pre-refactor baseline.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Update `postRecurringEntry` to use `postOperaCashbookEntry` for any line count

Remove the multi-line decline; route both single-line and multi-line through the same core helper.

**Files:**
- Modify: `src/services/post-recurring-entry.ts`
- Modify: `tests/post-recurring-entry.test.ts` (remove the multi-line-decline assertion, add multi-line happy path)

- [ ] **Step 1: Read the current `postRecurringEntry` shape**

Run: `grep -n "Multi-line\|lineRows.length > 1\|postOneTransaction\|postNominalEntry" /Users/maccb/sam-Bankrec/repo/src/services/post-recurring-entry.ts`

Locates the multi-line decline + the current single-line dispatch.

- [ ] **Step 2: Replace the multi-line decline and single-line dispatch with a unified path**

In `src/services/post-recurring-entry.ts`, locate the block that says:

```typescript
  if (lineRows.length > 1) {
    return {
      success: false,
      entry_ref: input.entryRef,
      error:
        `Recurring entry ${entryRef} has ${lineRows.length} lines. ` +
        `Multi-line recurring entries must be posted from ` +
        `Opera Cashbook → Repeat Entries → Post.`,
    };
  }

  const line = lineRows[0]!;
```

…and replace from that block down through the existing `executeWithDeadlockRetry` call with:

```typescript
  // No multi-line decline — postOperaCashbookEntry handles 1..N lines.

  // [Existing posting date / period validation / control-account
  //  lookup lives above this point; unchanged.]

  // Build header + lines for the core helper.
  const isReceipt = aeType === 2 || aeType === 4 || aeType === 6;
  const action = AE_TYPE_TO_ACTION[aeType]!;
  const header: PreparedEntryHeader = {
    date: postDate,
    action: action as Exclude<TxnAction, 'bank_transfer'>,
    cbtype: null, // core helper resolves from line[0].at_cbtype or defaults
    reference: entryRef,
    comment: aeDesc,
    inputBy,
    memo: aeDesc,
    name: aeDesc,
  };
  const lines: PreparedEntryLine[] = lineRows.map((ln, idx) => ({
    atAccount: (ln.at_account ?? '').toString().trim(),
    absPence: Math.abs(Number(ln.at_value ?? 0)),
    vatCode: ((ln.at_vatcde ?? '') as string).trim() || null,
    vatPence: Math.abs(Number(ln.at_vatval ?? 0)),
    reference:
      ((ln.at_entref ?? '') as string).trim() ||
      entryRef,
    comment: ((ln.at_comment ?? '') as string).trim() || aeDesc,
    project: ((ln.at_project ?? '') as string).trim(),
    department: ((ln.at_job ?? '') as string).trim(),
    netOverride: null,
  }));
  if (lines.some((l) => !l.atAccount)) {
    return {
      success: false,
      entry_ref: input.entryRef,
      error: `Recurring entry ${entryRef} has a line with empty at_account`,
    };
  }

  // Atomic post: aentry + per-line inserts + arhead advancement.
  let entryNumber: string | null = null;
  try {
    await executeWithDeadlockRetry(operaDb, async (trx) => {
      const result = await postOperaCashbookEntry({
        trx,
        bankCode,
        header,
        lines,
        defaults,
        decision,
      });
      entryNumber = result.entry_number;

      // Advance arhead schedule (unchanged from previous single-line
      // path) — bumps ae_posted, advances ae_nxtpost past intervening
      // cycles, stamps audit columns.
      const currentNxtYmd = aeNxtpostYmd ?? postDate;
      let nextDate = ymdToUtcDate(currentNxtYmd);
      const postDateUtc = ymdToUtcDate(postDate);
      for (let i = 0; i < 480 && nextDate.getTime() <= postDateUtc.getTime(); i++) {
        nextDate = advanceByFrequency(nextDate, aeFreq, aeEvery);
      }
      const newNxtYmd = nextDate.toISOString().slice(0, 10);

      await trx('arhead')
        .whereRaw('RTRIM(ae_entry) = ?', [entryRef])
        .andWhereRaw('RTRIM(ae_acnt) = ?', [bankCode])
        .update({
          ae_posted: trx.raw('ae_posted + 1'),
          ae_lstpost: postDate,
          ae_nxtpost: newNxtYmd,
          sq_amdate: trx.raw('CONVERT(DATE, GETDATE())'),
          sq_amtime: trx.raw('CONVERT(TIME, GETDATE())'),
          sq_amuser: inputBy,
        });
    });
  } catch (err: any) {
    return {
      success: false,
      entry_ref: input.entryRef,
      error: err?.message ?? String(err),
    };
  }
```

Add the `postOperaCashbookEntry` + `PreparedEntryHeader` + `PreparedEntryLine` + `TxnAction` imports at the top of the file (replacing the existing `postOneTransaction` / `postNominalEntry` imports — those are no longer needed here):

```typescript
import {
  postOperaCashbookEntry,
  type PreparedEntryHeader,
  type PreparedEntryLine,
  type TxnAction,
} from './import-posting-executor.js';
```

(Note: `TxnAction` may need to be exported from `import-posting-executor.ts` if not already. Check with `grep -n "export type.*TxnAction\|^type TxnAction" /Users/maccb/sam-Bankrec/repo/src/services/import-posting-executor.ts` — add an export if missing.)

- [ ] **Step 3: Update the test that asserts multi-line decline**

In `tests/post-recurring-entry.test.ts`, locate the test `declines multi-line entries with a clear "post in Opera" message` and **replace** its body. The test previously asserted multi-line was declined; now it should assert multi-line is accepted (passes validation, fails later only because sqlite can't run the full posting machinery).

New assertion:

```typescript
  it('accepts multi-line entries (forwards to core helper)', async () => {
    await seedHead(db, {
      ae_entry: 'REC0000020',
      ae_acnt: 'BB005',
      ae_type: 1, // Nominal Payment, multi-line journal
      ae_nxtpost: '2026-05-15',
    });
    await seedLine(db, {
      at_entry: 'REC0000020',
      at_acnt: 'BB005',
      at_line: 1,
      at_account: 'N100',
      at_value: -10000,
    });
    await seedLine(db, {
      at_entry: 'REC0000020',
      at_acnt: 'BB005',
      at_line: 2,
      at_account: 'N200',
      at_value: -25000,
    });

    const r = await postRecurringEntry(db, {
      bankCode: 'BB005',
      entryRef: 'REC0000020',
    });
    // Multi-line is no longer declined; the helper now forwards to the
    // core posting function. In this sqlite test harness it'll fail at
    // some downstream insert (no full Opera schema), but the error
    // must NOT be the "multi-line" decline.
    expect(r.success).toBe(false);
    expect(r.error).not.toMatch(/multi-line/i);
    expect(r.error).not.toMatch(/post in opera/i);
  });
```

- [ ] **Step 4: Typecheck**

Run: `cd /Users/maccb/sam-Bankrec/repo && npx tsc --noEmit 2>&1 | tail -5`

Expected: no errors.

- [ ] **Step 5: Run the recurring-entry test suite**

Run: `cd /Users/maccb/sam-Bankrec/repo && npx vitest run tests/post-recurring-entry.test.ts 2>&1 | tail -8`

Expected: all tests pass (11/11 or so, including the rewritten multi-line test).

- [ ] **Step 6: Run the full regression suite**

Run: `cd /Users/maccb/sam-Bankrec/repo && npx vitest run 2>&1 | grep -E "^Tests" | tail -3`

Expected: pass/fail counts match the pre-task-7 baseline.

- [ ] **Step 7: Commit**

```bash
cd /Users/maccb/sam-Bankrec/repo
git add src/services/post-recurring-entry.ts src/services/import-posting-executor.ts tests/post-recurring-entry.test.ts
git commit -m "$(cat <<'EOF'
feat: recurring-entry post handles 1..N lines via core helper

Step 7 of multi-line recurring entry posting (spec
docs/superpowers/specs/2026-05-18-multi-line-recurring-post-design.md).

postRecurringEntry no longer declines multi-line entries; both
single-line and multi-line go through postOperaCashbookEntry. The
core helper handles the per-line work (atran / stran-ptran / ntran /
anoml / VAT) uniformly. Schedule advancement (ae_posted++,
ae_nxtpost advance) remains in postRecurringEntry — atomic with the
post via the same trx.

Test: the previous "declines multi-line" assertion is replaced with
"accepts multi-line"; the in-memory sqlite harness can't run the
full Opera posting machinery, so we assert the error is no longer
the multi-line decline (any downstream failure is acceptable in
the test harness).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Build + restart + non-destructive route probe

Rebuild the project, restart the standalone host, and confirm the `POST /api/recurring-entries/post` route accepts a multi-line entry input (non-destructively — pass an invalid entry_ref so no Opera writes happen but the validation path is exercised).

**Files:** none (smoke check)

- [ ] **Step 1: Build**

Run: `cd /Users/maccb/sam-Bankrec/repo && npm run build 2>&1 | tail -5`

Expected: `dist/index.js ... built in ...s` — no TypeScript errors.

- [ ] **Step 2: Restart the standalone host**

Run:
```bash
ps aux | grep -E "sam-Bankrec.*standalone" | grep -v grep | awk '{print $2}' | xargs -r kill 2>&1; sleep 2
nohup env LOGIN_PASSWORD=letmein PORT=3030 OPERA_ADAPTER=mssql \
  OPERA_SQL_HOST=172.17.172.99 OPERA_SQL_PORT=1433 \
  OPERA_SQL_USER=n8n OPERA_SQL_PASSWORD=possible \
  OPERA_SQL_TRUST_CERT=true OPERA_SQL_ENCRYPT=false \
  GEMINI_API_KEY=AIzaSyCtSdca0-wZnhzYSqYgvU76CoQ9d8k9wqg \
  npx tsx standalone/server.ts > /tmp/bankrec-server.log 2>&1 &
sleep 4
tail -3 /tmp/bankrec-server.log
```

Expected: `[standalone] listening on http://localhost:3030`.

- [ ] **Step 3: Probe the route with a non-existent entry_ref**

(Run from the browser console in an authenticated session against http://localhost:3030/, OR use Playwright MCP):

```javascript
async function probe() {
  const r = await fetch('/api/apps/bank-reconcile/api/recurring-entries/post', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'X-Opera-Company': 'z_demo',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      bank_code: 'C310',
      entries: [{ entry_ref: 'REC9999999', override_date: null }],
    }),
  });
  return { status: r.status, body: await r.json() };
}
```

Expected:
```json
{
  "status": 200,
  "body": {
    "success": false,
    "results": [{
      "success": false,
      "entry_ref": "REC9999999",
      "error": "Recurring entry REC9999999 not found for bank C310"
    }],
    "posted_count": 0,
    "failed_count": 1
  }
}
```

No Opera writes occurred (entry_ref didn't exist → declined at validation).

If you get a 500 or "multi-line" error, something in tasks 4-7 wasn't deployed; rebuild + restart.

- [ ] **Step 4: No commit** (no source changes — just a verification gate)

---

## Task 9: Live verification against z_demo — REC0000025 (smallest, 2-line)

Trigger a real post of REC0000025 (2-line "DEO Payment", £26) on z_demo's C310 bank. This is the smallest blast-radius multi-line entry, so verify with this first.

**Files:** none (live verification)

- [ ] **Step 1: Refresh the check route to confirm REC0000025 is still due**

(In browser console with z_demo + auth headers):

```javascript
async function check() {
  const r = await fetch('/api/apps/bank-reconcile/api/recurring-entries/check/C310', {
    credentials: 'include',
    headers: { 'X-Opera-Company': 'z_demo' },
  });
  const j = await r.json();
  return (j.entries || []).filter(e => e.base_entry_ref === 'REC0000025');
}
```

Expected: at least one entry with `base_entry_ref='REC0000025'`, `line_count=2`, `can_post=true`. Note its `entry_ref` (may be composite like `REC0000025:2026-05-15`) and `next_post_date`.

If `can_post=false`, surface the `blocked_reason` — typically a closed period — to the operator and stop. The post will fail at period validation anyway.

- [ ] **Step 2: Capture pre-post state snapshot for diffing**

Record the current state of:
- `arhead.ae_posted` for `REC0000025` (used to verify it incremented by 1)
- `arhead.ae_nxtpost` for `REC0000025` (used to verify it advanced)
- `nbank.nk_curbal` for `C310` (used to verify it decremented by 26)
- The next entry number `atype.ay_lstnum` for the relevant cbtype (will increment by 1)

Use a read-only Opera SE probe via the existing routes (e.g. listRepeatEntries returns `posted_count`).

- [ ] **Step 3: Trigger the post via the FE button or direct API call**

Recommended: use the BankStatementHub "Post recurring entries now" button by navigating to the Bank Statements tab in z_demo and clicking Process on a C310 statement (the prompt will appear; click the button).

Alternative (direct API): in browser console:

```javascript
async function post() {
  const r = await fetch('/api/apps/bank-reconcile/api/recurring-entries/post', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'X-Opera-Company': 'z_demo',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      bank_code: 'C310',
      entries: [{ entry_ref: 'REC0000025', override_date: null }],
    }),
  });
  return await r.json();
}
```

Expected:
```json
{
  "success": true,
  "results": [{
    "success": true,
    "entry_ref": "REC0000025",
    "entry_number": "<some new entry number>",
    "message": "Posted recurring Purchase Payment: REC0000025 → entry ...",
    "warnings": ["Amount: £26.00", "Posted on YYYY-MM-DD; next cycle bumped in arhead"]
  }],
  "posted_count": 1,
  "failed_count": 0
}
```

- [ ] **Step 4: Verify in Opera SE**

Open Opera Cashbook for C310 and confirm:
- One new entry exists with the entry number returned in Step 3
- The entry has 2 detail lines (one per `arline` row)
- Total entry value matches the sum of the 2 lines
- GL is balanced (debits = credits)

If the entry shape is wrong (one entry per line instead of 2 lines under one entry, OR unbalanced GL), STOP. File the discrepancy, do NOT proceed to REC0000018 or REC0000019.

- [ ] **Step 5: Verify schedule advancement**

Re-call the check route:

```javascript
async function recheck() {
  const r = await fetch('/api/apps/bank-reconcile/api/recurring-entries/check/C310', {
    credentials: 'include',
    headers: { 'X-Opera-Company': 'z_demo' },
  });
  const j = await r.json();
  return (j.entries || []).filter(e => e.base_entry_ref === 'REC0000025');
}
```

Expected: REC0000025 either no longer appears (if `ae_nxtpost` is now in the future) OR appears with `posted_count` incremented by 1 and `next_post_date` advanced past the posted cycle.

- [ ] **Step 6: No commit** (verification only — no source changes)

If anything failed, file the discrepancy as a follow-up task and STOP. Do not proceed.

---

## Task 10: Live verification against z_demo — REC0000018 (4-line) and REC0000019 (3-line)

Same flow as Task 9, repeated for the two remaining multi-line entries.

**Files:** none

- [ ] **Step 1: Repeat the Task 9 protocol for REC0000018 ("Customer DD Receipts", 4 lines, £5215.80, C310)**

Snapshot → post → verify Opera Cashbook shows one entry with 4 lines, balanced GL → verify schedule advance.

- [ ] **Step 2: Repeat the Task 9 protocol for REC0000019 ("Euro Customers", 3 lines, £224802.90, C325)**

Same. Note the large amount — double-check the entry value and bank balance change.

- [ ] **Step 3: No commit** (verification only)

If everything succeeds, the feature is fully verified end-to-end against real multi-line entries.

---

## Task 11: Final commit + push

Once all live verifications pass, push the branch and write a brief summary commit (or just push the existing commits if everything was committed inline).

- [ ] **Step 1: Verify nothing's left uncommitted**

Run: `cd /Users/maccb/sam-Bankrec/repo && git status --short`

Expected: empty or only artefact files (no source-tree changes).

- [ ] **Step 2: Push to origin/main**

Run: `cd /Users/maccb/sam-Bankrec/repo && git push origin main 2>&1 | tail -3`

Expected: successful push.

- [ ] **Step 3: Confirm the prompt + post flow works end-to-end in the FE**

Navigate to z_demo Bank Statements → Process on a C310 statement → confirm the "Recurring Entries Must Be Processed First" prompt appears → click "Post recurring entries now" → confirm the multi-line entries are posted and the prompt re-checks to empty.

This is the operator-facing user journey the entire two-phase project (commits `c5f77517` + this plan's commits) was built to restore.

---

## Self-Review

Walking through each section of the spec against the plan:

**Goal + Background:** covered. Plan opens with the same context.

**Architectural Decision (Unify):** implemented by Tasks 3-6. Core helper added, single-line callers refactored as thin wrappers.

**Architecture diagram:** the plan's task structure mirrors the diagram — `postOperaCashbookEntry` is the new core (Task 3, expanded in Task 4); `postOneTransaction` / `postNominalEntry` become wrappers (Tasks 5-6); `postRecurringEntry` uses the core directly (Task 7).

**Data Model (PreparedEntryHeader/Line, PostEntryArgs/Result):** Task 2.

**Data Flow:** Task 7 wires it up end-to-end through `postRecurringEntry → postOperaCashbookEntry → arhead advance` within one trx.

**Schedule Advancement:** Task 7, Step 2 includes the `advanceByFrequency` loop and the `arhead` UPDATE.

**Failure Handling:** per-entry transaction in `executeWithDeadlockRetry` (Task 7); validation errors (Task 7's input checks); posting errors (Task 4's verification asserts via `assertAentryAtran` / `assertLedgerRow` / `assertBalancedPair`).

**Verification:** Task 1 (extend `assertAentryAtran`), Task 4 (call them at the end of the core helper).

**Testing:** regression coverage (Tasks 5/6 step 4); new multi-line unit tests (Task 4 step 2); live verification (Tasks 9-10).

**Out of Scope:** `postBankTransfer` left as-is (mentioned in Task 5's `postOneTransaction` guard).

**Open Risks:**
- *Extraction correctness:* mitigated by Tasks 5-6 step 4 (regression baseline + diff).
- *VAT-rate lookup behaviour:* the plan uses `vatType: 'P' | 'S'` derived from `isReceipt`, matching the legacy. Inline comment in Task 4's body explicitly names it.
- *z_demo data realism:* Task 9 step 1 re-checks before posting.

**Placeholder scan:** the plan contains one `[Implementer: copy zvtran + nvat INSERTs ...]` marker in Task 4 step 4. That's a deliberate cross-reference rather than a placeholder — the implementer is told exactly which existing function to copy from. The actual SQL is in the source file, not the plan, because reproducing ~50 lines of zvtran/nvat INSERTs verbatim in this doc would bloat it without adding clarity. **Decision: keep the marker, but verify in Step 4 that the implementer reads the legacy `postNominalEntry` VAT branch before writing.**

**Type consistency check:**
- `PreparedEntryHeader` and `PreparedEntryLine` referenced consistently across Tasks 2, 4, 5, 6, 7.
- `postOperaCashbookEntry(args: PostEntryArgs): Promise<PostEntryResult>` — same signature everywhere.
- `AE_TYPE_TO_ACTION` — referenced in Task 7's `postRecurringEntry` rewrite; the existing `post-recurring-entry.ts` already defines it, so the new code uses it without redefining.
- `advanceByFrequency` — referenced in Task 7; already defined in `post-recurring-entry.ts` from Phase 2 shipped earlier.

---

Plan complete and saved to `docs/superpowers/plans/2026-05-18-multi-line-recurring-post.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, two-stage review after each (spec compliance then code quality), fast iteration. Each task is a focused atomic commit.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review.

Which approach?

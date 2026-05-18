# Cumulative-Statement Cycles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow operators to import bank statements progressively from banks (Monzo, Wise, some Tide configurations) whose statements grow within a calendar month (same `period_start`, advancing `period_end`), without producing duplicate audit rows or requiring manual cleanup. Existing traditional-bank workflows (Barclays, Lloyds) remain byte-identical.

**Architecture:** Identify a logical statement "cycle" by `(bank_code, period_start)`. Existing import path INSERTs a new `bank_statement_imports` row each call; cycle-aware import looks up an existing row for the cycle first — UPDATE-and-append-new-lines when found unreconciled, INSERT-new-row otherwise. Per-line storage is idempotent via a `(post_date, amount, description-key)` fingerprint so subsequent pulls only add genuinely new lines. Traditional banks never collide because each of their statements has a unique `period_start`.

**Tech Stack:** TypeScript (NodeNext modules), Knex 3.x against SQLite (`better-sqlite3`/`sqlite3`), vitest with in-memory sqlite. The project compiles to `dist/` via `tsc -p tsconfig.json` before the standalone server (`standalone/server.ts`) reads it; runtime uses `npx tsx` for hot-loaded TypeScript. Tests live under `tests/` and run via `npx vitest run`.

**Spec:** `docs/superpowers/specs/2026-05-18-cumulative-statement-cycles-design.md`

---

## Repo Pointers (Read Before Starting)

If you are unfamiliar with this codebase:

- **`src/services/import-from-pdf.ts`** — the function `importBankStatementFromPdf()` is the entry point you'll be modifying. ~1100 lines. The audit-row INSERT/UPDATE happens around lines 695–770. Lines 700–730 are the existing `effectiveResumeImportId` UPDATE branch (different concern — keep intact).
- **`src/services/bank-import-from-email.ts`** — thin wrapper that calls `importBankStatementFromPdf` with downloaded email bytes. No changes needed there for this plan.
- **`db/migrations/015_bank_statement_transactions_fk.ts`** — the most recent migration. Read it for the SQLite dialect guard pattern (`PRAGMA foreign_key_list` idempotency check) and the recreate-table dance you do NOT need this time (we're only adding an index).
- **`tests/orphan-line-relink.test.ts`** — reference test that uses Knex against in-memory SQLite. Copy the schema-setup pattern (`db.raw(...)` once per table) when writing new tests.
- **`tests/fixture-regressions.test.ts` + `tests/_fixture-helpers.ts`** — reference for the fixture-based regression pattern. Copy this exactly when adding a new fixture for the cumulative case.
- **`src/services/scan-all-banks.ts:864-984`** — start-date supersession (already shipped). Hub display already collapses multiple Monzo pulls into one row before the operator sees them. **DO NOT touch this** — it's already correct for our case.

## File Structure

| Path | New / Modify | Responsibility |
|---|---|---|
| `db/migrations/016_cycle_lookup_index.ts` | NEW | Add `(bank_code, period_start)` index for cycle lookups |
| `src/services/cycle-row-lookup.ts` | NEW | Find existing cycle row; classify state (unreconciled / reconciled / missing) |
| `src/services/transaction-fingerprint.ts` | NEW | Pure function: `fingerprint(date, amount, description) → string` for idempotent line append |
| `src/services/import-from-pdf.ts` | MODIFY | Wire the cycle-row branch into the INSERT/UPDATE decision around lines 695-770 |
| `tests/cycle-row-lookup.test.ts` | NEW | Unit tests for the lookup helper |
| `tests/transaction-fingerprint.test.ts` | NEW | Unit tests for the fingerprint helper |
| `tests/import-cumulative-cycle.test.ts` | NEW | End-to-end test of cycle-aware import via fixtures |
| `tests/fixtures/statements/monzo-cumulative-may-pull1/` | NEW | First Monzo pull (May 1-8 cache + expected.json) |
| `tests/fixtures/statements/monzo-cumulative-may-pull2/` | NEW | Second Monzo pull (May 1-22 cache + expected.json) |

---

## Task 1: Migration — Add cycle lookup index

**Files:**
- Create: `db/migrations/016_cycle_lookup_index.ts`

- [ ] **Step 1: Write the migration file**

Create `db/migrations/016_cycle_lookup_index.ts` with this exact content:

```typescript
/**
 * Add an index on `bank_statement_imports (bank_code, period_start)`
 * to make cycle-row lookups O(log N).
 *
 * A cycle = the set of pulls of a single calendar-month statement
 * from a cumulative bank (Monzo, Wise, some Tide configurations).
 * The cycle key is `(bank_code, period_start)`. On every Import
 * call, the import service looks up the existing cycle row and
 * UPDATEs it rather than INSERTing a duplicate. Without this
 * index, every Import call would do a full-table scan of
 * bank_statement_imports — fine for now (rows in the 100s) but
 * grows linearly.
 *
 * Idempotent: knex.schema.hasIndex doesn't exist as such, so we
 * check the index by name via sqlite_master before creating.
 */
import type { Knex } from 'knex';

const INDEX_NAME = 'bank_statement_imports_bank_code_period_start_idx';

export async function up(knex: Knex): Promise<void> {
  const client = (knex.client as { config?: { client?: string } }).config?.client;
  if (client !== 'sqlite3') return;

  const existing = (await knex.raw(
    `SELECT name FROM sqlite_master WHERE type='index' AND name=?`,
    [INDEX_NAME],
  )) as Array<{ name: string }>;
  if (existing.length > 0) return;

  await knex.raw(
    `CREATE INDEX ${INDEX_NAME}
       ON bank_statement_imports (bank_code, period_start)`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
}
```

- [ ] **Step 2: Compile to catch typos**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no output (success).

- [ ] **Step 3: Verify migration runs cleanly against intsys**

Run: `lsof -i :3030 -sTCP:LISTEN -t | xargs -I{} kill -9 {}; sleep 2; cd /Users/maccb/sam-Bankrec/repo && npx tsc -p tsconfig.json && nohup env LOGIN_PASSWORD=letmein PORT=3030 OPERA_ADAPTER=mssql OPERA_SQL_HOST=172.17.172.99 OPERA_SQL_PORT=1433 OPERA_SQL_USER=n8n OPERA_SQL_PASSWORD=possible OPERA_SQL_TRUST_CERT=true OPERA_SQL_ENCRYPT=false npx tsx standalone/server.ts >/tmp/bankrec-stdout.log 2>/tmp/bankrec-stderr.log &
sleep 5; tail -10 /tmp/bankrec-stderr.log; echo "---"; sqlite3 data/intsys/bank-reconcile.sqlite "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%period_start%'"`
Expected: stderr empty (server started cleanly) + index name printed: `bank_statement_imports_bank_code_period_start_idx`.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/016_cycle_lookup_index.ts
git commit -m "feat: migration 016 — add cycle-lookup index on bank_statement_imports"
git push origin main
```

---

## Task 2: Transaction fingerprint helper

**Files:**
- Create: `src/services/transaction-fingerprint.ts`
- Test: `tests/transaction-fingerprint.test.ts`

A small pure function used by the cycle-row append path to detect "is this line already stored for this import_id?". Used as the primary key of a Set lookup.

- [ ] **Step 1: Write the failing test**

Create `tests/transaction-fingerprint.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { fingerprintTransactionLine } from '../src/services/transaction-fingerprint.js';

describe('fingerprintTransactionLine', () => {
  it('returns identical fingerprint for identical date+amount+description', () => {
    const a = fingerprintTransactionLine('2026-05-08', -54.99, 'Card Payment to Amazon');
    const b = fingerprintTransactionLine('2026-05-08', -54.99, 'Card Payment to Amazon');
    expect(a).toBe(b);
  });

  it('returns different fingerprint when amount differs by 1p', () => {
    const a = fingerprintTransactionLine('2026-05-08', -54.99, 'Amazon');
    const b = fingerprintTransactionLine('2026-05-08', -55.00, 'Amazon');
    expect(a).not.toBe(b);
  });

  it('treats whitespace and case differences in description as same', () => {
    const a = fingerprintTransactionLine('2026-05-08', -54.99, '  Card Payment To Amazon  ');
    const b = fingerprintTransactionLine('2026-05-08', -54.99, 'card payment to amazon');
    expect(a).toBe(b);
  });

  it('truncates very long descriptions to a stable prefix', () => {
    const longDesc = 'A'.repeat(500);
    const a = fingerprintTransactionLine('2026-05-08', -54.99, longDesc);
    const b = fingerprintTransactionLine('2026-05-08', -54.99, longDesc + 'EXTRA-DIFFERENT-SUFFIX');
    // Both descriptions agree on first 64 chars → fingerprints match.
    expect(a).toBe(b);
  });

  it('handles null/undefined description', () => {
    const a = fingerprintTransactionLine('2026-05-08', -54.99, null);
    const b = fingerprintTransactionLine('2026-05-08', -54.99, undefined);
    const c = fingerprintTransactionLine('2026-05-08', -54.99, '');
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('handles negative and positive amounts distinctly', () => {
    const a = fingerprintTransactionLine('2026-05-08', -54.99, 'X');
    const b = fingerprintTransactionLine('2026-05-08', 54.99, 'X');
    expect(a).not.toBe(b);
  });

  it('normalises amount to 2 decimal places', () => {
    const a = fingerprintTransactionLine('2026-05-08', -54.99, 'X');
    const b = fingerprintTransactionLine('2026-05-08', -54.9899999, 'X');
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/transaction-fingerprint.test.ts`
Expected: Failure with "Cannot find module '../src/services/transaction-fingerprint.js'"

- [ ] **Step 3: Write the implementation**

Create `src/services/transaction-fingerprint.ts`:

```typescript
/**
 * Stable fingerprint for a bank-statement transaction line, used to
 * detect "is this the same line we've already stored?" when a
 * cumulative bank (Monzo etc.) re-issues a statement extending an
 * earlier one.
 *
 * Components:
 *   - post_date         (YYYY-MM-DD)
 *   - amount.toFixed(2) (signed, 2 decimal places — accounting
 *                         amounts are always integer pence)
 *   - description       (trimmed, lowercased, first 64 chars)
 *
 * The description trim/lowercase is tolerant of minor bank
 * re-normalisation between pulls (Monzo sometimes trims trailing
 * spaces or re-cases payee names). 64-char truncation handles
 * cases where the bank later adds extra detail to a previously-
 * short description.
 */
export function fingerprintTransactionLine(
  postDate: string,
  amount: number,
  description: string | null | undefined,
): string {
  const desc = (description ?? '').trim().toLowerCase().slice(0, 64);
  return `${postDate}|${amount.toFixed(2)}|${desc}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/transaction-fingerprint.test.ts`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/transaction-fingerprint.ts tests/transaction-fingerprint.test.ts
git commit -m "feat: add transaction-line fingerprint helper for cycle-aware import"
git push origin main
```

---

## Task 3: Cycle-row lookup helper

**Files:**
- Create: `src/services/cycle-row-lookup.ts`
- Test: `tests/cycle-row-lookup.test.ts`

A small focused module that looks up an existing `bank_statement_imports` row by cycle key and returns a structured classification. The caller (`import-from-pdf.ts`) uses this to decide INSERT vs UPDATE vs REFUSE.

- [ ] **Step 1: Write the failing test**

Create `tests/cycle-row-lookup.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import knexLib, { type Knex } from 'knex';
import { findExistingCycleRow } from '../src/services/cycle-row-lookup.js';

const IMPORTS_SCHEMA = `CREATE TABLE bank_statement_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_code TEXT NOT NULL,
  statement_date DATE,
  period_start DATE,
  period_end DATE,
  closing_balance REAL,
  is_reconciled INTEGER DEFAULT 0,
  filename TEXT
)`;

async function makeDb(): Promise<Knex> {
  const db = knexLib({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  await db.raw(IMPORTS_SCHEMA);
  return db;
}

describe('findExistingCycleRow', () => {
  let db: Knex;

  beforeEach(async () => {
    db = await makeDb();
  });

  it('returns null when no row matches the cycle key', async () => {
    await db('bank_statement_imports').insert({
      bank_code: 'BC010', period_start: '2026-04-01',
      period_end: '2026-04-30', closing_balance: 100,
    });
    const r = await findExistingCycleRow(db, 'BC010', '2026-05-01');
    expect(r).toBeNull();
  });

  it('returns null when period_start is null/empty (cycle key requires it)', async () => {
    const r = await findExistingCycleRow(db, 'BC010', null);
    expect(r).toBeNull();
    const r2 = await findExistingCycleRow(db, 'BC010', '');
    expect(r2).toBeNull();
  });

  it('returns the row when bank_code + period_start match (cycle exists)', async () => {
    const [id] = await db('bank_statement_imports').insert({
      bank_code: 'BC010', period_start: '2026-05-01',
      period_end: '2026-05-08', closing_balance: 100, is_reconciled: 0,
    }).returning('id');
    const r = await findExistingCycleRow(db, 'BC010', '2026-05-01');
    expect(r).not.toBeNull();
    expect(r?.id).toBe(typeof id === 'number' ? id : (id as { id: number }).id);
    expect(r?.is_reconciled).toBe(0);
    expect(r?.period_end).toBe('2026-05-08');
    expect(r?.closing_balance).toBe(100);
  });

  it('distinguishes banks — same period_start, different bank_code', async () => {
    await db('bank_statement_imports').insert({
      bank_code: 'BC010', period_start: '2026-05-01',
      period_end: '2026-05-08', closing_balance: 100,
    });
    const r = await findExistingCycleRow(db, 'BC020', '2026-05-01');
    expect(r).toBeNull();
  });

  it('returns the most recent row when multiple share the cycle key (historical anomaly)', async () => {
    // Pre-cycle-aware data might already have two rows for the same cycle.
    // We want the most recent one — that's the operator-current state.
    await db('bank_statement_imports').insert([
      { bank_code: 'BC010', period_start: '2026-05-01', period_end: '2026-05-08',
        closing_balance: 100, is_reconciled: 1 },
      { bank_code: 'BC010', period_start: '2026-05-01', period_end: '2026-05-15',
        closing_balance: 95, is_reconciled: 0 },
    ]);
    const r = await findExistingCycleRow(db, 'BC010', '2026-05-01');
    expect(r?.period_end).toBe('2026-05-15');
    expect(r?.is_reconciled).toBe(0);
  });

  it('returns reconciled state correctly for is_reconciled=1', async () => {
    await db('bank_statement_imports').insert({
      bank_code: 'BC010', period_start: '2026-05-01',
      period_end: '2026-05-31', closing_balance: 90, is_reconciled: 1,
    });
    const r = await findExistingCycleRow(db, 'BC010', '2026-05-01');
    expect(r?.is_reconciled).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cycle-row-lookup.test.ts`
Expected: Failure with "Cannot find module '../src/services/cycle-row-lookup.js'"

- [ ] **Step 3: Write the implementation**

Create `src/services/cycle-row-lookup.ts`:

```typescript
/**
 * Cycle-row lookup for cumulative-statement banks (Monzo etc).
 *
 * A cycle = the set of pulls of a single calendar-month statement
 * from a bank whose statements grow within a month. The cycle key
 * is (bank_code, period_start). Use this lookup before the
 * INSERT/UPDATE decision in importBankStatementFromPdf — if a row
 * is found unreconciled, UPDATE it; if found reconciled, refuse
 * the import with a clear message; if missing, fall through to
 * the existing INSERT path.
 *
 * Returns null when no cycle row exists OR when periodStart is
 * missing — the latter means we can't form a cycle key, so the
 * import should fall through to the existing INSERT path
 * (best-effort fallback for extractions where period_start
 * couldn't be determined).
 */
import type { Knex } from 'knex';

export interface CycleRow {
  id: number;
  is_reconciled: number;
  period_end: string | null;
  closing_balance: number | null;
}

export async function findExistingCycleRow(
  appDb: Knex,
  bankCode: string,
  periodStart: string | null | undefined,
): Promise<CycleRow | null> {
  if (!periodStart) return null;
  const row = (await appDb('bank_statement_imports')
    .select('id', 'is_reconciled', 'period_end', 'closing_balance')
    .where({ bank_code: bankCode, period_start: periodStart })
    .orderBy('id', 'desc')
    .first()) as
    | { id: number; is_reconciled: number;
        period_end: string | null;
        closing_balance: number | string | null }
    | undefined;
  if (!row) return null;
  return {
    id: Number(row.id),
    is_reconciled: Number(row.is_reconciled),
    period_end: row.period_end ? String(row.period_end) : null,
    closing_balance:
      row.closing_balance !== null && row.closing_balance !== undefined
        ? Number(row.closing_balance)
        : null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/cycle-row-lookup.test.ts`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/cycle-row-lookup.ts tests/cycle-row-lookup.test.ts
git commit -m "feat: add cycle-row lookup helper for cumulative-statement imports"
git push origin main
```

---

## Task 4: Cycle-row branch — refuse already-reconciled

**Files:**
- Modify: `src/services/import-from-pdf.ts` (around lines 320–330, before the lock acquisition)

A focused first slice of the import-side change: when a reconciled cycle row already exists, refuse the import with a clear structured error. This task does NOT yet handle the unreconciled-update path — that's Task 5. Separating these makes the change reviewable in two small commits instead of one big one.

- [ ] **Step 1: Write the failing test**

Create `tests/import-cumulative-cycle.test.ts` with the first scenario:

```typescript
import { describe, it, expect, vi } from 'vitest';
import knexLib, { type Knex } from 'knex';
import {
  importBankStatementFromPdf,
  type PdfExtractor,
  type ImportPostingExecutor,
  type ImportLockAdapter,
  type PeriodOverlapChecker,
  type PdfExtractionResult,
} from '../src/services/import-from-pdf.js';

const IMPORTS_SCHEMA = `CREATE TABLE bank_statement_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_code TEXT NOT NULL,
  statement_date DATE,
  period_start DATE,
  period_end DATE,
  closing_balance REAL,
  opening_balance REAL,
  source TEXT,
  source_ref TEXT,
  filename TEXT,
  is_reconciled INTEGER DEFAULT 0,
  reconciled_count INTEGER DEFAULT 0,
  reconciled_at TEXT,
  reconciled_by TEXT,
  imported_at TEXT,
  imported_by TEXT,
  target_system TEXT,
  transactions_imported INTEGER DEFAULT 0,
  records_imported INTEGER DEFAULT 0,
  total_receipts REAL DEFAULT 0,
  total_payments REAL DEFAULT 0,
  account_number TEXT,
  sort_code TEXT,
  import_status TEXT
)`;
const TXNS_SCHEMA = `CREATE TABLE bank_statement_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id INTEGER NOT NULL,
  line_number INTEGER NOT NULL,
  post_date TEXT NOT NULL,
  description TEXT,
  amount REAL NOT NULL,
  balance REAL,
  transaction_type TEXT,
  reference TEXT,
  is_reconciled INTEGER DEFAULT 0,
  posted_entry_number TEXT,
  posted_at TEXT
)`;

async function makeAppDb(): Promise<Knex> {
  const db = knexLib({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  await db.raw(IMPORTS_SCHEMA);
  await db.raw(TXNS_SCHEMA);
  return db;
}

function makeOperaDb(): any {
  const db: any = (table: string) => {
    if (table !== 'nbank') throw new Error(`unexpected: ${table}`);
    const chain: any = {
      whereRaw: () => chain,
      select: () => chain,
      first: async () => ({ nk_acnt: 'BC010' }),
    };
    return chain;
  };
  db.raw = () => Promise.resolve([]);
  return db;
}

const SAMPLE_EXTRACTION: PdfExtractionResult = {
  bank_name: 'Monzo', account_number: '12345678', sort_code: '04-00-04',
  statement_date: '2026-05-22', period_start: '2026-05-01',
  period_end: '2026-05-22', opening_balance: 125912.72,
  closing_balance: 75000,
  transactions: [
    { date: '2026-05-22', name: 'Test', memo: 'Test', amount: -100,
      type: 'debit', balance: 75000 },
  ],
};

describe('cumulative-cycle import — reconciled-cycle refusal', () => {
  it('refuses a re-import when a reconciled cycle row exists', async () => {
    const appDb = await makeAppDb();
    // Pre-existing reconciled row for the same cycle.
    await appDb('bank_statement_imports').insert({
      bank_code: 'BC010',
      period_start: '2026-05-01',
      period_end: '2026-05-15',
      closing_balance: 90000,
      is_reconciled: 1,
      filename: 'May 1-15.pdf',
    });

    const extractor: PdfExtractor = {
      extractFromPdf: vi.fn().mockResolvedValue(SAMPLE_EXTRACTION),
    };
    const executor: ImportPostingExecutor = {
      postBankImport: vi.fn().mockResolvedValue({
        success: true, records_imported: 0, records_failed: 0,
        skipped_count: 0, errors: [], warnings: [],
      }),
    };
    const lock: ImportLockAdapter = {
      acquire: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const overlap: PeriodOverlapChecker = {
      checkOverlap: vi.fn().mockResolvedValue({
        overlapError: null, resumeImportId: null,
      }),
    };

    const result = await importBankStatementFromPdf(
      makeOperaDb(),
      appDb,
      {
        filePath: '/tmp/May 1-22.pdf',
        bankCode: 'BC010',
        filename: 'May 1-22.pdf',
      },
      extractor, executor, lock, overlap,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cycle is already reconciled/i);
    expect(result.error).toMatch(/2026-05-01/);
    // Critically: the executor must NOT have been called — we
    // bailed out before reaching the posting step.
    expect(executor.postBankImport).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/import-cumulative-cycle.test.ts`
Expected: failing — current code creates a second audit row rather than refusing.

- [ ] **Step 3: Find the integration point in import-from-pdf.ts**

Read lines 320–340 in `src/services/import-from-pdf.ts` to confirm the location of `effectiveResumeImportId`:

Run: `grep -n "effectiveResumeImportId" src/services/import-from-pdf.ts | head -5`
Expected output shows the variable declared around line 325.

- [ ] **Step 4: Add the import + early-refuse branch**

In `src/services/import-from-pdf.ts`, locate the imports at the top of the file (around lines 1-50) and add this line alongside the existing service imports (after the line that imports from `validate-statement` or similar — anywhere in the imports block is fine, the order is alphabetical-ish but not enforced):

```typescript
import { findExistingCycleRow } from './cycle-row-lookup.js';
```

Then, locate the `effectiveResumeImportId` declaration (around line 325):

```typescript
  const effectiveResumeImportId =
    input.resumeImportId ?? overlap.resumeImportId ?? null;
```

Immediately AFTER that block, BEFORE the `const lockKey = ` line, add:

```typescript
  // Cycle-aware import for cumulative-statement banks (Monzo et al.):
  // when a bank_statement_imports row already exists for this cycle
  // (same bank_code + same period_start) and it's already been
  // reconciled, refuse this import with a clear message. The
  // operator must unreconcile the cycle in the Reconcile UI before
  // re-importing. Without this guard, a subsequent pull from the
  // same month would silently create a duplicate audit row, then
  // confuse downstream sequencing.
  //
  // Resume-import path (effectiveResumeImportId set) bypasses this
  // — the FE/overlap-checker has already identified the specific
  // row to UPDATE, so cycle-merge is unnecessary.
  if (!effectiveResumeImportId && extracted.period_start) {
    const cycleRow = await findExistingCycleRow(
      appDb,
      bankCode,
      extracted.period_start,
    );
    if (cycleRow && cycleRow.is_reconciled === 1) {
      return {
        success: false,
        error:
          `The ${bankCode} statement cycle starting ${extracted.period_start} ` +
          `is already reconciled (closed at £${cycleRow.closing_balance?.toFixed(2) ?? '?'}). ` +
          `To import additional transactions from a later pull within the ` +
          `same cycle, unreconcile the cycle first via the Reconcile page.`,
      };
    }
  }
```

NOTE: `extracted.period_start` is only available AFTER the `extractFromPdf` call, so the new block must go AFTER that call. The `effectiveResumeImportId` block is currently positioned BEFORE extraction. Move the new check to AFTER extraction. Concretely:

Run: `grep -n "extracted = await extractor.extractFromPdf\|effectiveResumeImportId =" src/services/import-from-pdf.ts | head -5`
Expected: shows extractor call around line 276 and effectiveResumeImportId around line 325. **The new block goes around line 327** (after both, before the lock acquisition at line 328).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/import-cumulative-cycle.test.ts`
Expected: 1 test passes.

- [ ] **Step 6: Run the existing import-from-pdf tests to confirm no regression**

Run: `npx vitest run tests/import-from-pdf.test.ts`
Expected: 8 tests pass (the existing suite from before).

- [ ] **Step 7: Compile**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add src/services/import-from-pdf.ts tests/import-cumulative-cycle.test.ts
git commit -m "feat: refuse import when statement cycle already reconciled"
git push origin main
```

---

## Task 5: Cycle-row branch — UPDATE-and-append for unreconciled cycle

**Files:**
- Modify: `src/services/import-from-pdf.ts` (the INSERT/UPDATE block around lines 695–770)
- Test: `tests/import-cumulative-cycle.test.ts` (append new test case)

This is the main implementation. When an unreconciled cycle row already exists, we UPDATE its `period_end` + `closing_balance` + `transactions_imported` instead of INSERTing a new row, and we append only the genuinely-new transaction lines to `bank_statement_transactions` using the fingerprint helper.

- [ ] **Step 1: Add a new failing test for the UPDATE path**

Append the following `it()` block to `tests/import-cumulative-cycle.test.ts` (inside the existing `describe('cumulative-cycle import...', ...)` block):

```typescript
  it('UPDATEs the existing cycle row when an unreconciled cycle exists', async () => {
    const appDb = await makeAppDb();
    // Pre-existing UNreconciled cycle row from a prior pull (May 1-8).
    const [firstId] = await appDb('bank_statement_imports')
      .insert({
        bank_code: 'BC010',
        period_start: '2026-05-01',
        period_end: '2026-05-08',
        opening_balance: 125912.72,
        closing_balance: 100000,
        is_reconciled: 0,
        filename: 'May 1-8.pdf',
        source: 'email',
        target_system: 'opera_se',
        records_imported: 12,
        transactions_imported: 12,
      })
      .returning('id');
    const firstImportId = typeof firstId === 'number' ? firstId : (firstId as { id: number }).id;

    // Pre-existing transactions on the first pull (12 lines, May 1-8).
    for (let i = 1; i <= 12; i++) {
      await appDb('bank_statement_transactions').insert({
        import_id: firstImportId,
        line_number: i,
        post_date: `2026-05-0${i <= 9 ? i : i}`,
        description: `Line ${i}`,
        amount: -10,
      });
    }

    // The new pull (May 1-22) extends to May 22 with new lines.
    const extraction: PdfExtractionResult = {
      bank_name: 'Monzo',
      account_number: '12345678', sort_code: '04-00-04',
      statement_date: '2026-05-22',
      period_start: '2026-05-01',
      period_end: '2026-05-22',
      opening_balance: 125912.72,
      closing_balance: 75000,
      transactions: [
        // 12 same lines as before — should NOT be re-inserted
        ...Array.from({ length: 12 }, (_, i) => ({
          date: `2026-05-0${i + 1 <= 9 ? i + 1 : i + 1}`,
          name: `Line ${i + 1}`, memo: `Line ${i + 1}`,
          amount: -10, type: 'debit', balance: 100000,
        })),
        // 4 NEW lines for May 16-22
        ...Array.from({ length: 4 }, (_, i) => ({
          date: `2026-05-${16 + i}`,
          name: `New ${i + 1}`, memo: `New ${i + 1}`,
          amount: -20, type: 'debit', balance: 75000,
        })),
      ],
    };

    const extractor: PdfExtractor = {
      extractFromPdf: vi.fn().mockResolvedValue(extraction),
    };
    const executor: ImportPostingExecutor = {
      postBankImport: vi.fn().mockResolvedValue({
        success: true,
        records_imported: 4,  // executor posts 4 new lines
        records_failed: 0,
        skipped_count: 12,
        errors: [], warnings: [],
        posted_lines: [],
      }),
    };
    const lock: ImportLockAdapter = {
      acquire: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const overlap: PeriodOverlapChecker = {
      checkOverlap: vi.fn().mockResolvedValue({
        overlapError: null, resumeImportId: null,
      }),
    };

    const result = await importBankStatementFromPdf(
      makeOperaDb(),
      appDb,
      {
        filePath: '/tmp/May 1-22.pdf',
        bankCode: 'BC010',
        filename: 'May 1-22.pdf',
      },
      extractor, executor, lock, overlap,
    );

    expect(result.success).toBe(true);

    // Critical assertion: only ONE bank_statement_imports row exists
    // for this cycle (the original, now UPDATEd).
    const rows = await appDb('bank_statement_imports')
      .where({ bank_code: 'BC010', period_start: '2026-05-01' })
      .select('id', 'period_end', 'closing_balance', 'transactions_imported');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(firstImportId);
    expect(rows[0]?.period_end).toBe('2026-05-22');
    expect(rows[0]?.closing_balance).toBe(75000);

    // bank_statement_transactions should now have 16 rows
    // (12 original + 4 newly-appended), all under firstImportId.
    const lineRows = await appDb('bank_statement_transactions')
      .where({ import_id: firstImportId })
      .count<{ c: number }[]>({ c: '*' })
      .first();
    expect(Number(lineRows?.c)).toBe(16);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/import-cumulative-cycle.test.ts`
Expected: 1 test passes (Task 4's refusal), 1 test fails (this new one — current code INSERTs a second row).

- [ ] **Step 3: Read the existing INSERT/UPDATE block in import-from-pdf.ts**

Run: `sed -n '695,770p' src/services/import-from-pdf.ts`
Look for the block that starts with `// Resume-import: UPDATE the existing bank_statement_imports row` and ends with the INSERT block. You'll modify the `if (!importId)` branch (currently around line 740) to first check for a cycle row.

- [ ] **Step 4: Add the import for fingerprint helper**

Near the top of `src/services/import-from-pdf.ts`, alongside the cycle-row-lookup import added in Task 4, add:

```typescript
import { fingerprintTransactionLine } from './transaction-fingerprint.js';
```

- [ ] **Step 5: Modify the INSERT/UPDATE branch**

In `src/services/import-from-pdf.ts`, locate the block beginning with:

```typescript
        let importId: number | undefined;
        if (effectiveResumeImportId) {
```

(around line 702). REPLACE the entire block (from `let importId: number | undefined;` through the closing brace of `if (!importId) { ... }` — the section that does the INSERT — but BEFORE the `// Per-line tracking — faithful port` comment) with this new logic.

```typescript
        let importId: number | undefined;
        // Branch 1: resume-import path (FE / overlap-checker says
        // "this is a re-upload of an existing row"). Unchanged.
        if (effectiveResumeImportId) {
          try {
            const existing = (await appDb('bank_statement_imports')
              .where({ id: effectiveResumeImportId })
              .first()) as
              | {
                  records_imported?: number | null;
                  transactions_imported?: number | null;
                  total_receipts?: number | null;
                  total_payments?: number | null;
                }
              | undefined;
            const prevImported = Number(existing?.records_imported ?? 0);
            const prevTxImported = Number(existing?.transactions_imported ?? 0);
            const prevReceipts = Number(existing?.total_receipts ?? 0);
            const prevPayments = Number(existing?.total_payments ?? 0);
            await appDb('bank_statement_imports')
              .where({ id: effectiveResumeImportId })
              .update({
                closing_balance: extracted.closing_balance,
                total_receipts: prevReceipts + totalReceipts,
                total_payments: prevPayments + totalPayments,
                transactions_imported: prevTxImported + result.records_imported,
                records_imported: prevImported + result.records_imported,
                imported_at: appDb.fn.now(),
                imported_by: input.importedBy ?? 'system',
              });
            importId = effectiveResumeImportId;
          } catch (resumeErr) {
            console.warn(
              `[bank-reconcile] resume UPDATE failed for import_id=${effectiveResumeImportId}: ${
                resumeErr instanceof Error ? resumeErr.message : String(resumeErr)
              } — falling back to fresh INSERT`,
            );
          }
        }
        // Branch 2: cycle-merge path (cumulative-statement banks).
        // Reached only when not in resume-mode. Look up the existing
        // cycle row (bank_code, period_start). If found unreconciled,
        // UPDATE it instead of INSERTing a duplicate.
        // (Reconciled-cycle case is refused earlier — see the
        // findExistingCycleRow call at the top of this function.)
        if (!importId && extracted.period_start) {
          const cycleRow = await findExistingCycleRow(
            appDb,
            bankCode,
            extracted.period_start,
          );
          if (cycleRow && cycleRow.is_reconciled === 0) {
            // Extend the cycle row in place. period_end advances to
            // the new pull's period_end (never shrinks);
            // closing_balance reflects the latest pull;
            // running totals accumulate.
            try {
              const newPeriodEnd =
                (cycleRow.period_end ?? '') > (extracted.period_end ?? '')
                  ? cycleRow.period_end
                  : extracted.period_end;
              const existing = (await appDb('bank_statement_imports')
                .where({ id: cycleRow.id })
                .first()) as
                | {
                    records_imported?: number | null;
                    transactions_imported?: number | null;
                    total_receipts?: number | null;
                    total_payments?: number | null;
                  }
                | undefined;
              const prevImported = Number(existing?.records_imported ?? 0);
              const prevTxImported = Number(existing?.transactions_imported ?? 0);
              const prevReceipts = Number(existing?.total_receipts ?? 0);
              const prevPayments = Number(existing?.total_payments ?? 0);
              await appDb('bank_statement_imports')
                .where({ id: cycleRow.id })
                .update({
                  period_end: newPeriodEnd,
                  closing_balance: extracted.closing_balance,
                  total_receipts: prevReceipts + totalReceipts,
                  total_payments: prevPayments + totalPayments,
                  transactions_imported: prevTxImported + result.records_imported,
                  records_imported: prevImported + result.records_imported,
                  imported_at: appDb.fn.now(),
                  imported_by: input.importedBy ?? 'system',
                });
              importId = cycleRow.id;
            } catch (cycleErr) {
              console.warn(
                `[bank-reconcile] cycle-merge UPDATE failed for import_id=${cycleRow.id}: ${
                  cycleErr instanceof Error ? cycleErr.message : String(cycleErr)
                } — falling back to fresh INSERT`,
              );
            }
          }
        }
        // Branch 3: fresh INSERT (unchanged from before — traditional
        // banks always land here; cumulative banks land here only on
        // the FIRST pull of a cycle).
        if (!importId) {
          const [insertedId] = (await appDb('bank_statement_imports')
            .insert({
              bank_code: bankCode,
              source: 'file',
              source_ref: input.filename ?? input.filePath,
              statement_date: extracted.statement_date ?? null,
              account_number: extracted.account_number ?? null,
              sort_code: extracted.sort_code ?? null,
              period_start: extracted.period_start ?? null,
              period_end: extracted.period_end ?? null,
              opening_balance: extracted.opening_balance,
              closing_balance: extracted.closing_balance,
              total_receipts: totalReceipts,
              total_payments: totalPayments,
              transactions_imported: result.records_imported,
              imported_at: appDb.fn.now(),
              import_status: 'imported',
              records_imported: result.records_imported,
              filename: input.filename ?? null,
              imported_by: input.importedBy ?? 'system',
            })
            .returning('id')) as unknown as Array<{ id: number } | number>;
          importId =
            typeof insertedId === 'number'
              ? insertedId
              : (insertedId as { id: number })?.id;
        }
```

- [ ] **Step 6: Modify the per-line transaction insert to be idempotent**

Locate the block in `src/services/import-from-pdf.ts` that begins with `// Idempotent: clear any prior rows for this import_id.` (around line 781). Currently the logic DELETEs all prior rows then inserts the full set — fine for fresh imports but destroys data on cycle-merge (would lose the first pull's lines + their `posted_entry_number` references).

REPLACE the block from `// Idempotent: clear any prior rows for this import_id.` through the bulk INSERT (`await appDb('bank_statement_transactions').insert(allRows);` or similar — find the end of the block by looking for the next major comment) with this new fingerprint-aware logic:

```typescript
        // Per-line tracking. For a fresh import (first pull), insert
        // all extracted lines. For a cycle-merge (second+ pull within
        // the same cycle), only append lines whose fingerprint isn't
        // already stored — preserves the original lines' is_reconciled,
        // posted_entry_number, etc.
        if (importId) {
          // Build fingerprint set of already-stored lines for this
          // import_id. Empty set on first pull.
          const existingLines = (await appDb('bank_statement_transactions')
            .where({ import_id: importId })
            .select('post_date', 'amount', 'description')) as Array<{
            post_date: string | null;
            amount: number;
            description: string | null;
          }>;
          const existingFingerprints = new Set(
            existingLines.map((r) =>
              fingerprintTransactionLine(
                r.post_date ?? '',
                Number(r.amount ?? 0),
                r.description,
              ),
            ),
          );

          // Walk the freshly-extracted lines; insert only those not
          // already present (by fingerprint). Renumber line_number
          // continuing from existing max.
          const maxLineRow = (await appDb('bank_statement_transactions')
            .where({ import_id: importId })
            .max<{ m: number | null }[]>({ m: 'line_number' })
            .first()) as { m: number | null } | undefined;
          let nextLineNumber = Number(maxLineRow?.m ?? 0) + 1;

          const rowsToInsert: Array<Record<string, unknown>> = [];
          for (const t of extracted.transactions) {
            const fp = fingerprintTransactionLine(
              (t.date ?? '').slice(0, 10),
              Number(t.amount ?? 0),
              (t.memo ?? t.name ?? '').toString(),
            );
            if (existingFingerprints.has(fp)) continue;
            rowsToInsert.push({
              import_id: importId,
              line_number: nextLineNumber++,
              post_date: (t.date ?? '').slice(0, 10) || null,
              description: (t.memo ?? t.name ?? '').toString().slice(0, 500),
              amount: Number(t.amount ?? 0),
              balance: t.balance ?? null,
              transaction_type: String(t.type ?? ''),
              reference:
                (t as unknown as { reference?: string | null }).reference ?? null,
              posted_entry_number: null,
              posted_at: null,
            });
          }
          if (rowsToInsert.length > 0) {
            await appDb('bank_statement_transactions').insert(rowsToInsert);
          }
        }
```

CAUTION: the existing code may have an `.insert(allRows)` line you need to remove — make sure the replacement above fully supersedes the old "DELETE all + INSERT all" pattern. Search for `bank_statement_transactions').insert(allRows)` and `bank_statement_transactions').where({ import_id: importId }).delete()` to confirm both are gone after the edit.

- [ ] **Step 7: Run the cumulative-cycle test to verify it passes**

Run: `npx vitest run tests/import-cumulative-cycle.test.ts`
Expected: both tests pass (refusal + UPDATE).

- [ ] **Step 8: Run the full existing import-from-pdf test suite for regression**

Run: `npx vitest run tests/import-from-pdf.test.ts`
Expected: 8 tests pass (no regression).

- [ ] **Step 9: Compile**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no output.

- [ ] **Step 10: Commit**

```bash
git add src/services/import-from-pdf.ts tests/import-cumulative-cycle.test.ts
git commit -m "feat: cycle-merge import for cumulative-statement banks"
git push origin main
```

---

## Task 6: Refuse shorter-pull-than-existing

A defensive edge case. If the operator imports the May 1-22 pull, then accidentally imports the May 1-15 pull (out of order), we should refuse with a clear message rather than truncate `period_end` or merge stale lines.

**Files:**
- Modify: `src/services/import-from-pdf.ts` (cycle-merge branch — add a guard)
- Test: `tests/import-cumulative-cycle.test.ts` (append test)

- [ ] **Step 1: Add the failing test**

Append to `tests/import-cumulative-cycle.test.ts`:

```typescript
  it('refuses a shorter pull when a longer one is already imported', async () => {
    const appDb = await makeAppDb();
    // Existing cycle row: May 1-22 (longer pull already imported)
    await appDb('bank_statement_imports').insert({
      bank_code: 'BC010',
      period_start: '2026-05-01',
      period_end: '2026-05-22',
      closing_balance: 75000,
      is_reconciled: 0,
    });

    // Operator tries to import a SHORTER pull (May 1-15)
    const extraction: PdfExtractionResult = {
      bank_name: 'Monzo', account_number: '1', sort_code: '04-00-04',
      statement_date: '2026-05-15',
      period_start: '2026-05-01',
      period_end: '2026-05-15',  // EARLIER than existing
      opening_balance: 125912.72, closing_balance: 90000,
      transactions: [],
    };
    const extractor: PdfExtractor = {
      extractFromPdf: vi.fn().mockResolvedValue(extraction),
    };
    const executor: ImportPostingExecutor = {
      postBankImport: vi.fn().mockResolvedValue({
        success: true, records_imported: 0, records_failed: 0,
        skipped_count: 0, errors: [], warnings: [],
      }),
    };
    const lock: ImportLockAdapter = {
      acquire: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const overlap: PeriodOverlapChecker = {
      checkOverlap: vi.fn().mockResolvedValue({
        overlapError: null, resumeImportId: null,
      }),
    };
    const result = await importBankStatementFromPdf(
      makeOperaDb(), appDb,
      { filePath: '/tmp/May 1-15.pdf', bankCode: 'BC010',
        filename: 'May 1-15.pdf' },
      extractor, executor, lock, overlap,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already imported a later pull/i);
    expect(executor.postBankImport).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/import-cumulative-cycle.test.ts -t "shorter pull"`
Expected: test fails — current code doesn't refuse shorter pulls.

- [ ] **Step 3: Add the shorter-pull guard**

In `src/services/import-from-pdf.ts`, find the reconciled-cycle refusal block added in Task 4 (the `if (cycleRow && cycleRow.is_reconciled === 1)` branch). Modify it to also handle the shorter-pull case. Replace:

```typescript
  if (!effectiveResumeImportId && extracted.period_start) {
    const cycleRow = await findExistingCycleRow(
      appDb,
      bankCode,
      extracted.period_start,
    );
    if (cycleRow && cycleRow.is_reconciled === 1) {
      return {
        success: false,
        error:
          `The ${bankCode} statement cycle starting ${extracted.period_start} ` +
          `is already reconciled (closed at £${cycleRow.closing_balance?.toFixed(2) ?? '?'}). ` +
          `To import additional transactions from a later pull within the ` +
          `same cycle, unreconcile the cycle first via the Reconcile page.`,
      };
    }
  }
```

with:

```typescript
  if (!effectiveResumeImportId && extracted.period_start) {
    const cycleRow = await findExistingCycleRow(
      appDb,
      bankCode,
      extracted.period_start,
    );
    if (cycleRow && cycleRow.is_reconciled === 1) {
      return {
        success: false,
        error:
          `The ${bankCode} statement cycle starting ${extracted.period_start} ` +
          `is already reconciled (closed at £${cycleRow.closing_balance?.toFixed(2) ?? '?'}). ` +
          `To import additional transactions from a later pull within the ` +
          `same cycle, unreconcile the cycle first via the Reconcile page.`,
      };
    }
    // Shorter-pull guard: if the existing cycle row's period_end
    // is LATER than the new pull's period_end, the operator is
    // trying to import an older pull (out of order). Refuse —
    // merging would either shrink period_end or skip new lines
    // that aren't actually new.
    if (
      cycleRow &&
      cycleRow.period_end &&
      extracted.period_end &&
      cycleRow.period_end > extracted.period_end
    ) {
      return {
        success: false,
        error:
          `The ${bankCode} statement cycle starting ${extracted.period_start} ` +
          `has already imported a later pull (through ${cycleRow.period_end}). ` +
          `This pull only covers up to ${extracted.period_end}, so it has ` +
          `nothing new to add. Re-import the latest pull (period_end >= ` +
          `${cycleRow.period_end}) instead.`,
      };
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/import-cumulative-cycle.test.ts`
Expected: all three cumulative-cycle tests pass (refusal, UPDATE, shorter-pull-refusal).

- [ ] **Step 5: Run the existing tests for regression**

Run: `npx vitest run tests/import-from-pdf.test.ts`
Expected: 8 pass (no regression).

- [ ] **Step 6: Commit**

```bash
git add src/services/import-from-pdf.ts tests/import-cumulative-cycle.test.ts
git commit -m "feat: refuse out-of-order shorter pull on cumulative-statement cycle"
git push origin main
```

---

## Task 7: Fixture-based regression for cumulative-pull solver behaviour

Pin the cumulative case through the fixture harness. This catches solver-side regressions that would corrupt the cycle data even if cycle-merge works.

**Files:**
- Create: `tests/fixtures/statements/monzo-cumulative-may-pull1/extraction-cache.json`
- Create: `tests/fixtures/statements/monzo-cumulative-may-pull1/expected.json`
- Create: `tests/fixtures/statements/monzo-cumulative-may-pull2/extraction-cache.json`
- Create: `tests/fixtures/statements/monzo-cumulative-may-pull2/expected.json`

- [ ] **Step 1: Create pull-1 fixture (May 1-14 — borrowed from existing monzo fixture)**

The existing `tests/fixtures/statements/monzo-2026-05/extraction-cache.json` already represents the May 1-14 Monzo pull (period_end=2026-05-14). Copy it as pull-1:

```bash
mkdir -p tests/fixtures/statements/monzo-cumulative-may-pull1
cp tests/fixtures/statements/monzo-2026-05/extraction-cache.json tests/fixtures/statements/monzo-cumulative-may-pull1/extraction-cache.json
cp tests/fixtures/statements/monzo-2026-05/expected.json tests/fixtures/statements/monzo-cumulative-may-pull1/expected.json
```

- [ ] **Step 2: Create pull-2 fixture (May 1-21 — synthesised)**

Create `tests/fixtures/statements/monzo-cumulative-may-pull2/extraction-cache.json` by extending pull-1 with 5 additional synthetic transactions after 2026-05-14:

```bash
python3 -c "
import json, copy
with open('tests/fixtures/statements/monzo-cumulative-may-pull1/extraction-cache.json') as f:
    d = json.load(f)
d['statement_info']['period_end'] = '2026-05-21'
d['statement_info']['statement_date'] = '2026-05-21'
# Add 5 new transactions May 15-21
new_txns = [
    {'date': '2026-05-15', 'description': 'Card Payment to Test 1',
     'money_out': 50.00, 'money_in': None, 'balance': 11096.95,
     'type': 'card_payment', 'reference': None},
    {'date': '2026-05-17', 'description': 'Card Payment to Test 2',
     'money_out': 25.00, 'money_in': None, 'balance': 11071.95,
     'type': 'card_payment', 'reference': None},
    {'date': '2026-05-18', 'description': 'Transfer in',
     'money_out': None, 'money_in': 500.00, 'balance': 11571.95,
     'type': 'transfer', 'reference': None},
    {'date': '2026-05-20', 'description': 'Direct Debit Test',
     'money_out': 100.00, 'money_in': None, 'balance': 11471.95,
     'type': 'dd', 'reference': None},
    {'date': '2026-05-21', 'description': 'Card Payment to Test 3',
     'money_out': 75.00, 'money_in': None, 'balance': 11396.95,
     'type': 'card_payment', 'reference': None},
]
# Pull-1 had newest-first ordering — prepend new txns
d['transactions'] = new_txns + d['transactions']
d['statement_info']['closing_balance'] = 11396.95
d['statement_info']['summary']['closing_balance'] = 11396.95
print(json.dumps(d, indent=2))
" > tests/fixtures/statements/monzo-cumulative-may-pull2/extraction-cache.json
```

- [ ] **Step 3: Create pull-2 expected.json**

Create `tests/fixtures/statements/monzo-cumulative-may-pull2/expected.json`:

```json
{
  "opening_balance": 82557.56,
  "closing_balance": 11396.95,
  "transaction_count": 18,
  "statement_date": "2026-05-21",
  "period_start": "2026-05-01",
  "period_end": "2026-05-21",
  "notes": "Cumulative Monzo pull 2 of 2 (May 1-21). Extends pull-1 (May 1-14) by 5 additional transactions May 15-21. Tests that the solver handles a cumulative pull with the same period_start and an extended period_end. Closing 11396.95 = pull-1 closing 11146.95 + 5 new lines (net £250 outflow). Opening (82557.56) derived from chain — same as pull-1."
}
```

- [ ] **Step 4: Run fixture regression test**

Run: `npx vitest run tests/fixture-regressions.test.ts`
Expected: 3 new fixture suites (pull1, pull2, plus the existing monzo-2026-05) all pass. The opening_balance, closing_balance, transaction_count assertions hold.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/statements/monzo-cumulative-may-pull1 tests/fixtures/statements/monzo-cumulative-may-pull2
git commit -m "test: cumulative-Monzo fixture pair pins solver behaviour across pulls"
git push origin main
```

---

## Task 8: Traditional-bank regression confirmation

Explicit regression test confirming that traditional fixed-period statements (Barclays-style) never trigger the cycle-merge branch — each statement remains its own audit row.

**Files:**
- Test: `tests/import-cumulative-cycle.test.ts` (append)

- [ ] **Step 1: Add the regression test**

Append to `tests/import-cumulative-cycle.test.ts`:

```typescript
  it('traditional bank: each statement creates a new row (no cycle merge)', async () => {
    const appDb = await makeAppDb();
    // Existing row for April 17 statement (reconciled).
    await appDb('bank_statement_imports').insert({
      bank_code: 'BC010',
      period_start: '2026-04-13',
      period_end: '2026-04-17',
      closing_balance: 119822.40,
      is_reconciled: 1,
    });

    // Operator now imports the May 24 statement — different
    // period_start (2026-04-20) per Barclays' weekly cadence.
    // This MUST create a fresh row, not trip the cycle-merge.
    const extraction: PdfExtractionResult = {
      bank_name: 'Barclays', account_number: '90764205',
      sort_code: '20-00-00',
      statement_date: '2026-04-24',
      period_start: '2026-04-20',     // different cycle key
      period_end: '2026-04-24',
      opening_balance: 119822.40, closing_balance: 116726.07,
      transactions: [
        { date: '2026-04-21', name: 'X', memo: 'X', amount: -100,
          type: 'debit', balance: 119722.40 },
      ],
    };
    const extractor: PdfExtractor = {
      extractFromPdf: vi.fn().mockResolvedValue(extraction),
    };
    const executor: ImportPostingExecutor = {
      postBankImport: vi.fn().mockResolvedValue({
        success: true, records_imported: 1, records_failed: 0,
        skipped_count: 0, errors: [], warnings: [],
        posted_lines: [],
      }),
    };
    const lock: ImportLockAdapter = {
      acquire: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const overlap: PeriodOverlapChecker = {
      checkOverlap: vi.fn().mockResolvedValue({
        overlapError: null, resumeImportId: null,
      }),
    };
    const result = await importBankStatementFromPdf(
      makeOperaDb(), appDb,
      { filePath: '/tmp/Statement 24-APR.pdf', bankCode: 'BC010',
        filename: 'Statement 24-APR.pdf' },
      extractor, executor, lock, overlap,
    );

    expect(result.success).toBe(true);
    // Two rows: the original April 17, plus a NEW April 24.
    const rows = await appDb('bank_statement_imports')
      .where({ bank_code: 'BC010' })
      .orderBy('id')
      .select('period_start', 'period_end');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.period_start).toBe('2026-04-13');  // April 17 stmt
    expect(rows[1]?.period_start).toBe('2026-04-20');  // April 24 stmt
  });
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/import-cumulative-cycle.test.ts`
Expected: all 4 cumulative-cycle tests pass.

- [ ] **Step 3: Run the full vitest suite for sanity**

Run: `npx vitest run`
Expected: all currently-passing tests still pass. Don't worry about the 23 pre-existing failures (they were failing before this work — confirm the count hasn't grown).

- [ ] **Step 4: Commit**

```bash
git add tests/import-cumulative-cycle.test.ts
git commit -m "test: traditional-bank statements bypass cycle-merge (regression)"
git push origin main
```

---

## Task 9: Live-server end-to-end verification

Manual smoke test against the running standalone server, in case the in-memory test schema misses an interaction (e.g. column-default behaviour, datetime coercion, real-bank fixture).

**Files:** none — verification only.

- [ ] **Step 1: Rebuild and restart server**

Run: `lsof -i :3030 -sTCP:LISTEN -t | xargs -I{} kill -9 {}; sleep 2; cd /Users/maccb/sam-Bankrec/repo && npx tsc -p tsconfig.json && nohup env LOGIN_PASSWORD=letmein PORT=3030 OPERA_ADAPTER=mssql OPERA_SQL_HOST=172.17.172.99 OPERA_SQL_PORT=1433 OPERA_SQL_USER=n8n OPERA_SQL_PASSWORD=possible OPERA_SQL_TRUST_CERT=true OPERA_SQL_ENCRYPT=false GEMINI_API_KEY=$GEMINI_API_KEY npx tsx standalone/server.ts >/tmp/bankrec-stdout.log 2>/tmp/bankrec-stderr.log &
sleep 6; lsof -i :3030 -sTCP:LISTEN -t | head -1; tail -5 /tmp/bankrec-stderr.log`
Expected: PID printed, stderr empty.

- [ ] **Step 2: Verify the index migration ran**

Run: `sqlite3 data/intsys/bank-reconcile.sqlite "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%period_start%'"`
Expected: `bank_statement_imports_bank_code_period_start_idx`

- [ ] **Step 3: Manually exercise the cycle-merge via API**

Sketch (replace placeholders with current cloudsis Monzo statement IDs as needed):

```bash
rm -f /tmp/cookies.txt
curl -sS -c /tmp/cookies.txt -X POST http://localhost:3030/auth/login \
  -H "Content-Type: application/json" \
  -d '{"company":"cloudsis","password":"letmein"}' >/dev/null

# 1. Pre-state — note row count
sqlite3 data/cloudsis/bank-reconcile.sqlite \
  "SELECT COUNT(*) FROM bank_statement_imports WHERE bank_code='BB005'"

# 2. Trigger an import via the operator UI (cloudsis Monzo) or via
# the API endpoint directly. Confirm that re-importing the same
# statement (or a slightly-extended one) doesn't duplicate rows.

# 3. Post-state — row count should not increase if it's the same cycle
sqlite3 data/cloudsis/bank-reconcile.sqlite \
  "SELECT COUNT(*) FROM bank_statement_imports WHERE bank_code='BB005'"
```

Expected: when re-importing within the same cycle, the row count stays the same. When importing a different-cycle statement (different period_start), row count increases by 1.

- [ ] **Step 4: Commit (no code change — this is a verification step, no commit needed)**

This task has no commit. If you find an issue during the smoke test, file a follow-up task — don't try to fix here.

---

## Self-Review Checklist (for the plan-writer, run after writing)

- [x] Each task has a focused responsibility.
- [x] Every step shows the actual code or command — no "TBD" or "as appropriate".
- [x] Test code is concrete and runnable.
- [x] File paths are absolute or repo-relative consistently.
- [x] Type definitions and method signatures are consistent across tasks (CycleRow shape, fingerprintTransactionLine signature, findExistingCycleRow signature).
- [x] Tasks order respects dependencies (migration → helpers → main wiring → fixtures → regression).
- [x] Spec coverage: refused-reconciled-cycle (Task 4), UPDATE-when-unreconciled (Task 5), shorter-pull-guard (Task 6), traditional-regression (Task 8), fixture-test (Task 7), live verification (Task 9). All spec requirements have a task.
- [x] The "open questions" in the spec are resolved: period_end uses MAX (Task 5), fingerprint includes description (Task 2), no UI changes in v1 (deferred — confirmed in spec).

---

## Out of Scope (deferred — do NOT add tasks for these)

- **Unreconcile-cycle button in Reconcile UI** — relies on the existing refusal message to guide the operator. Add later if friction warrants.
- **Hub "in progress" badge** — visual polish, not required for correctness.
- **Auto-detection of cumulative-format banks** — not needed; cycle-merge is data-driven, no per-bank flags.
- **Backfill of historical multi-row cycles** — operators can clean up manually via the existing Delete Import History UI if they want.

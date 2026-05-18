/**
 * Helpers for fixture-based regression tests on the Gemini → solver
 * pipeline.
 *
 * A fixture is a directory under `tests/fixtures/statements/<name>/`
 * containing:
 *
 *   statement.pdf          — the real PDF (kept out of the repo if
 *                            it contains real bank data; .gitignore'd)
 *   extraction-cache.json  — raw Gemini output saved from a
 *                            known-good run. Shape:
 *                            { statement_info: {...},
 *                              transactions: [...] }
 *                            This file IS committed — it's redacted
 *                            (account numbers, sort codes, names)
 *                            but the balance arithmetic remains
 *                            verifiable.
 *   expected.json          — the asserted output:
 *                            { opening_balance: number,
 *                              closing_balance: number,
 *                              transaction_count: number,
 *                              statement_date?: string,
 *                              period_start?: string,
 *                              period_end?: string,
 *                              notes?: string }
 *
 * The harness exists because every fix to the solver/parser has so
 * far broken a previously-working bank format. A fixture per bank
 * with redacted-but-real numbers gives us a fast regression net.
 *
 * Add a fixture when:
 *  - A new bank format is encountered (Lloyds, HSBC, Starling, etc).
 *  - A bug fix changes solver behaviour — capture both the
 *    pre-bug-fix WRONG output (as a separate failing fixture) and
 *    the corrected output.
 *  - A particular PDF tripped up Gemini in production — save the
 *    cached extraction so the parsing/solver path is testable
 *    against that exact input forever.
 *
 * To capture a new fixture:
 *  1. Run a real scan that successfully extracts the PDF.
 *  2. SELECT extraction_json FROM extraction_cache WHERE content_hash = ?
 *     in the per-company app.db, save as extraction-cache.json.
 *  3. Redact account numbers + sort codes by global-replacing the
 *     real values with X's. Keep ALL numbers (balances + amounts)
 *     intact — they're what's being asserted.
 *  4. Write expected.json with the opening/closing/count from a
 *     known-good run.
 *  5. Add a describe() block in fixture-regressions.test.ts.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURES_ROOT = join(__dirname, 'fixtures', 'statements');

export interface FixtureExpected {
  opening_balance: number;
  closing_balance: number;
  transaction_count: number;
  statement_date?: string;
  period_start?: string;
  period_end?: string;
  notes?: string;
  /** Optional — assert the names of the first N transactions to
   *  catch txn-list regressions without a full row-by-row dump. */
  first_transactions?: Array<{
    date: string;
    amount: number;
    name?: string;
  }>;
}

export interface LoadedFixture {
  name: string;
  cachedExtraction: Record<string, unknown>;
  expected: FixtureExpected;
}

/** Load a fixture from `tests/fixtures/statements/<name>/`. */
export function loadFixture(name: string): LoadedFixture {
  const dir = join(FIXTURES_ROOT, name);
  if (!existsSync(dir)) {
    throw new Error(`Fixture not found: ${dir}`);
  }
  const cachePath = join(dir, 'extraction-cache.json');
  if (!existsSync(cachePath)) {
    throw new Error(`Missing extraction-cache.json in ${dir}`);
  }
  const expectedPath = join(dir, 'expected.json');
  if (!existsSync(expectedPath)) {
    throw new Error(`Missing expected.json in ${dir}`);
  }
  const cachedExtraction = JSON.parse(readFileSync(cachePath, 'utf8'));
  const expected = JSON.parse(readFileSync(expectedPath, 'utf8')) as FixtureExpected;
  return { name, cachedExtraction, expected };
}

/** Approximate equality for currency comparisons (2dp tolerance). */
export function approximatelyEqual(
  actual: number | null | undefined,
  expected: number,
  tolerance = 0.01,
): boolean {
  if (actual === null || actual === undefined) return false;
  return Math.abs(actual - expected) <= tolerance;
}

/** List all fixture names — useful for parameterised tests. */
export function listFixtures(): string[] {
  if (!existsSync(FIXTURES_ROOT)) return [];
  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
  return readdirSync(FIXTURES_ROOT)
    .filter((entry: string) => {
      const sub = join(FIXTURES_ROOT, entry);
      return statSync(sub).isDirectory();
    })
    .sort();
}

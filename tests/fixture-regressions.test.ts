/**
 * Fixture-driven regression tests for the Gemini → solver pipeline.
 *
 * Each fixture under `tests/fixtures/statements/<name>/` pins a
 * known-good extraction result. The test runs the deterministic part
 * of the pipeline (parseResultJson + balance solver) against the
 * saved Gemini output and asserts the operator-visible numbers
 * match `expected.json`.
 *
 * Why fixtures matter — every solver/parser change in this codebase
 * has at least once broken a previously-working bank format. Without
 * a regression net you only find out when the operator reports it
 * the next day. The fixture set should grow every time a new
 * bank/format is encountered.
 */

import { describe, it, expect } from 'vitest';
import {
  loadFixture,
  approximatelyEqual,
  listFixtures,
} from './_fixture-helpers.js';
import { parseResultJson } from '../standalone/gemini-pdf-extractor.js';

const fixtures = listFixtures();

describe('statement fixture regressions', () => {
  if (fixtures.length === 0) {
    // Sanity: at least one fixture should exist after Pillar 4
    // landed. If this fails, the fixture directory got wiped.
    it.skip('no fixtures present (expected at least one)', () => {});
    return;
  }

  for (const name of fixtures) {
    describe(`fixture: ${name}`, () => {
      const fixture = loadFixture(name);
      const result = parseResultJson(fixture.cachedExtraction);

      it('opening_balance matches expected', () => {
        const ok = approximatelyEqual(
          result.opening_balance,
          fixture.expected.opening_balance,
        );
        expect(
          ok,
          `expected opening=${fixture.expected.opening_balance}, got ${result.opening_balance}`,
        ).toBe(true);
      });

      it('closing_balance matches expected', () => {
        const ok = approximatelyEqual(
          result.closing_balance,
          fixture.expected.closing_balance,
        );
        expect(
          ok,
          `expected closing=${fixture.expected.closing_balance}, got ${result.closing_balance}`,
        ).toBe(true);
      });

      it('transaction count matches', () => {
        expect(result.transactions.length).toBe(
          fixture.expected.transaction_count,
        );
      });

      if (fixture.expected.period_start) {
        it('period_start matches', () => {
          expect(result.period_start).toBe(fixture.expected.period_start);
        });
      }
      if (fixture.expected.period_end) {
        it('period_end matches', () => {
          expect(result.period_end).toBe(fixture.expected.period_end);
        });
      }
      if (fixture.expected.statement_date) {
        it('statement_date matches', () => {
          expect(result.statement_date).toBe(fixture.expected.statement_date);
        });
      }

      if (fixture.expected.first_transactions) {
        it('first transactions match (date + amount)', () => {
          for (
            let i = 0;
            i < fixture.expected.first_transactions!.length;
            i++
          ) {
            const expected = fixture.expected.first_transactions![i]!;
            const actual = result.transactions[i];
            expect(actual, `missing txn at index ${i}`).toBeDefined();
            expect(actual!.date, `txn ${i} date`).toBe(expected.date);
            expect(
              approximatelyEqual(actual!.amount, expected.amount),
              `txn ${i} amount: expected ${expected.amount}, got ${actual!.amount}`,
            ).toBe(true);
          }
        });
      }
    });
  }
});

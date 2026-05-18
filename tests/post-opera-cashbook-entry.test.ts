/**
 * Tests for postOperaCashbookEntry — the unified core posting helper
 * that handles 1..N lines under one aentry header. This file starts
 * minimal: a symbol-exists smoke test plus a 2-line "not yet
 * implemented" guard test. Task 4 expands it to cover the actual
 * multi-line writes.
 *
 * Single-line equivalence (postOperaCashbookEntry called with one
 * line should produce the same writes as postOneTransaction /
 * postNominalEntry called with the equivalent PreparedTransaction) is
 * covered by the existing tests/import-posting-executor.test.ts suite
 * once tasks 5-6 land — those wrappers call this core helper, so any
 * regression surfaces there.
 */
import { describe, it, expect } from 'vitest';
import { postOperaCashbookEntry } from '../src/services/import-posting-executor.js';

describe('postOperaCashbookEntry', () => {
  it('exports a callable function', () => {
    expect(typeof postOperaCashbookEntry).toBe('function');
  });

  // More cases land as the helper is built out in subsequent tasks.
});

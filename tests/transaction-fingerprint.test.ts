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

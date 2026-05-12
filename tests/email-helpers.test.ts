import { describe, it, expect } from 'vitest';
import {
  detectBankFromEmail,
  extractStatementNumberFromFilename,
  isBankStatementAttachment,
  compareSortKeys,
} from '../src/services/email-helpers.js';

describe('detectBankFromEmail', () => {
  it('detects barclays from sender domain', () => {
    expect(detectBankFromEmail('alerts@barclays.co.uk', 'statement.pdf')).toBe('barclays');
  });
  it('detects natwest from filename', () => {
    expect(detectBankFromEmail('noreply@example.com', 'natwest_apr.pdf')).toBe('natwest');
  });
  it('detects tide from subject when filename is generic', () => {
    expect(detectBankFromEmail('alerts@something.com', 'attachment.pdf', 'Tide statement')).toBe('tide');
  });
  it('returns null when no patterns match', () => {
    expect(detectBankFromEmail('a@b.com', 'foo.pdf', 'x')).toBeNull();
  });
});

describe('extractStatementNumberFromFilename', () => {
  it('parses DD-MMM-YY (08-JAN-26)', () => {
    const r = extractStatementNumberFromFilename('statement_08-JAN-26.pdf');
    expect(r.sort_key).toEqual([2026, 1, 8, 0]);
    expect(r.display_date).toBe('08-JAN-2026');
  });
  it('parses DD/MM/YYYY (02/02/2026)', () => {
    const r = extractStatementNumberFromFilename('barclays_02/02/2026.pdf');
    expect(r.sort_key).toEqual([2026, 2, 2, 0]);
    expect(r.display_date).toBe('02-FEB-2026');
  });
  it('parses YYYY-MM-DD ISO format (2026-04-15)', () => {
    const r = extractStatementNumberFromFilename('lloyds-2026-04-15.pdf');
    expect(r.sort_key).toEqual([2026, 4, 15, 0]);
  });
  it('parses month-name + year (jan2026)', () => {
    const r = extractStatementNumberFromFilename('hsbc_jan2026.pdf');
    expect(r.sort_key).toEqual([2026, 1, 1, 0]);
  });
  it('parses YYYY-MM (2026-04)', () => {
    const r = extractStatementNumberFromFilename('statement_2026-04.pdf');
    expect(r.sort_key).toEqual([2026, 4, 1, 0]);
  });
  it('falls back to deterministic hash when no date matches', () => {
    const r = extractStatementNumberFromFilename('mystery.pdf');
    expect(r.sort_key[0]).toBe(9999);
    expect(r.display_date).toBeNull();
  });
  it('returns sentinel for empty filename', () => {
    const r = extractStatementNumberFromFilename(null);
    expect(r.sort_key).toEqual([9999, 99, 99, 0]);
  });
  it('uses subject text when filename has no date', () => {
    const r = extractStatementNumberFromFilename(
      'attachment.pdf',
      'Statement for 30/04/2026',
    );
    expect(r.sort_key).toEqual([2026, 4, 30, 0]);
  });
});

describe('isBankStatementAttachment', () => {
  it('accepts known bank sender', () => {
    expect(
      isBankStatementAttachment({
        filename: 'monthly.pdf',
        fromAddress: 'alerts@barclays.co.uk',
      }),
    ).toBe(true);
  });
  it('accepts statement keyword + 8-digit account', () => {
    expect(
      isBankStatementAttachment({
        filename: 'statement_12345678.pdf',
      }),
    ).toBe(true);
  });
  it('accepts bank name in filename', () => {
    expect(
      isBankStatementAttachment({
        filename: 'natwest_april.pdf',
      }),
    ).toBe(true);
  });
  it('accepts subject "your statement" + PDF', () => {
    expect(
      isBankStatementAttachment({
        filename: 'attachment.pdf',
        subject: 'Your statement is ready',
      }),
    ).toBe(true);
  });
  it('rejects non-PDF non-statement attachments', () => {
    expect(
      isBankStatementAttachment({
        filename: 'invoice.pdf',
        subject: 'invoice attached',
      }),
    ).toBe(false);
  });
  it('rejects png attachments', () => {
    expect(
      isBankStatementAttachment({
        filename: 'photo.png',
        fromAddress: 'alerts@barclays.co.uk',
      }),
    ).toBe(false);
  });
  it('accepts when content-type matches even if extension is missing', () => {
    expect(
      isBankStatementAttachment({
        filename: 'statement_12345678',
        contentType: 'application/pdf',
      }),
    ).toBe(true);
  });
});

describe('compareSortKeys', () => {
  it('orders earlier dates first', () => {
    const a = [2026, 1, 8, 0] as const;
    const b = [2026, 4, 15, 0] as const;
    expect(compareSortKeys(a, b)).toBeLessThan(0);
  });
  it('treats equal keys as 0', () => {
    const a = [2026, 1, 8, 0] as const;
    expect(compareSortKeys(a, a)).toBe(0);
  });
  it('sentinel sorts after real dates', () => {
    const real = [2026, 1, 1, 0] as const;
    const sentinel = [9999, 99, 99, 0] as const;
    expect(compareSortKeys(real, sentinel)).toBeLessThan(0);
  });
});

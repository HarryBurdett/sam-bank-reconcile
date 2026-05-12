import { describe, it, expect } from 'vitest';
import {
  sniffBankByRegex,
  sniffBankByCsvHeader,
  findBankAccountByDetails,
  detectBankFromContent,
} from '../src/services/detect-bank.js';

interface MockState {
  rows: Array<{
    code: string | null;
    sort_code: string | null;
    account_number: string | null;
  }>;
}

function makeOperaDb(state: MockState): any {
  return {
    raw: (_sql: string) => Promise.resolve(state.rows),
  };
}

// =====================================================================
// sniffBankByRegex
// =====================================================================

describe('sniffBankByRegex', () => {
  it('extracts sort code and 8-digit account from a single line', () => {
    const out = sniffBankByRegex(['Account Number:,20-96-89,90764205']);
    expect(out).toEqual({ sort_code: '20-96-89', account_number: '90764205' });
  });

  it('rejects 9-digit numbers (must be exactly 8 digits)', () => {
    const out = sniffBankByRegex(['Sort: 20-96-89, Acct: 123456789']);
    // The 8-digit lookbehind/lookahead should reject 123456789 entirely
    expect(out).toBeNull();
  });

  it('returns null when only sort code present', () => {
    expect(sniffBankByRegex(['Sort: 20-96-89'])).toBeNull();
  });

  it('returns null when only account number present', () => {
    expect(sniffBankByRegex(['Acct 90764205'])).toBeNull();
  });

  it('takes first matching line', () => {
    const out = sniffBankByRegex([
      'header\n',
      '11-11-11 12345678',
      '22-22-22 87654321',
    ]);
    expect(out).toEqual({ sort_code: '11-11-11', account_number: '12345678' });
  });
});

// =====================================================================
// sniffBankByCsvHeader
// =====================================================================

describe('sniffBankByCsvHeader', () => {
  it('extracts from "Account" column with "sort acct" format', () => {
    const lines = [
      'Some preamble',
      'Date,Account,Amount,Description',
      '2026-04-15,20-96-89 90764205,100.00,Payment',
    ];
    const out = sniffBankByCsvHeader(lines);
    expect(out).toEqual({ sort_code: '20-96-89', account_number: '90764205' });
  });

  it('handles quoted CSV fields', () => {
    const lines = [
      '"Date","Account","Description"',
      '"2026-04-15","20-96-89 90764205","Some, payment"',
    ];
    const out = sniffBankByCsvHeader(lines);
    expect(out).toEqual({ sort_code: '20-96-89', account_number: '90764205' });
  });

  it('returns null when no row has both date+account headers', () => {
    expect(
      sniffBankByCsvHeader(['Random,Headers,Here', 'a,b,c']),
    ).toBeNull();
  });

  it('returns null when account field doesn\'t contain a space', () => {
    const lines = ['Date,Account', '2026-04-15,JUSTANUMBER'];
    expect(sniffBankByCsvHeader(lines)).toBeNull();
  });
});

// =====================================================================
// findBankAccountByDetails
// =====================================================================

describe('findBankAccountByDetails', () => {
  it('matches when sort+account are normalised (dashes/spaces stripped)', async () => {
    const db = makeOperaDb({
      rows: [
        { code: 'BC010', sort_code: '20-96-89', account_number: '90764205' },
      ],
    });
    expect(await findBankAccountByDetails(db, '209689', '90764205')).toBe(
      'BC010',
    );
    expect(await findBankAccountByDetails(db, '20-96-89', '9076 4205')).toBe(
      'BC010',
    );
  });

  it('returns null when no match', async () => {
    const db = makeOperaDb({
      rows: [
        { code: 'BC010', sort_code: '20-96-89', account_number: '90764205' },
      ],
    });
    expect(await findBankAccountByDetails(db, '99-99-99', '11111111')).toBeNull();
  });

  it('returns null on empty input', async () => {
    const db = makeOperaDb({ rows: [] });
    expect(await findBankAccountByDetails(db, '', '')).toBeNull();
    expect(await findBankAccountByDetails(db, '20-96-89', '')).toBeNull();
  });

  it('iterates rows and returns the matching code (trimmed)', async () => {
    const db = makeOperaDb({
      rows: [
        { code: 'BC001', sort_code: '11-11-11', account_number: '11111111' },
        { code: 'BC010 ', sort_code: '20-96-89', account_number: '90764205' },
        { code: 'BC020', sort_code: '30-30-30', account_number: '30303030' },
      ],
    });
    expect(await findBankAccountByDetails(db, '20-96-89', '90764205')).toBe(
      'BC010',
    );
  });
});

// =====================================================================
// detectBankFromContent — top-level
// =====================================================================

describe('detectBankFromContent', () => {
  it('finds bank via regex method when regex match exists', async () => {
    const db = makeOperaDb({
      rows: [
        { code: 'BC010', sort_code: '20-96-89', account_number: '90764205' },
      ],
    });
    const content =
      'Some Bank Statement\nAccount Number:,20-96-89,90764205\nDate,Amount\n';
    const result = await detectBankFromContent(db, content);
    expect(result).toEqual({
      sort_code: '20-96-89',
      account_number: '90764205',
      bank_code: 'BC010',
    });
  });

  it('successfully detects from a clean Barclays-style CSV', async () => {
    const db = makeOperaDb({
      rows: [
        { code: 'BC020', sort_code: '30-30-30', account_number: '30303030' },
      ],
    });
    const content =
      'Account Number:,30-30-30,30303030\n' +
      'Date,Description,Amount\n' +
      '15/04/2026,Payment,100.00\n';
    const result = await detectBankFromContent(db, content);
    expect(result.bank_code).toBe('BC020');
  });

  it('returns nulls when neither method matches', async () => {
    const db = makeOperaDb({ rows: [] });
    const result = await detectBankFromContent(db, 'no bank details here\n');
    expect(result).toEqual({
      sort_code: null,
      account_number: null,
      bank_code: null,
    });
  });

  it('returns extracted details + null code when bank not in Opera', async () => {
    const db = makeOperaDb({
      rows: [
        { code: 'BC010', sort_code: '20-96-89', account_number: '90764205' },
      ],
    });
    const content = 'Account Number:,99-99-99,11111111\n';
    const result = await detectBankFromContent(db, content);
    expect(result.sort_code).toBe('99-99-99');
    expect(result.account_number).toBe('11111111');
    expect(result.bank_code).toBeNull();
  });

  it('only scans the first 30 lines', async () => {
    const db = makeOperaDb({
      rows: [
        { code: 'BC010', sort_code: '20-96-89', account_number: '90764205' },
      ],
    });
    // Bank details on line 31 — should NOT be picked up
    const lines = Array.from({ length: 30 }, () => 'noise');
    lines.push('20-96-89 90764205');
    const result = await detectBankFromContent(db, lines.join('\n'));
    expect(result.bank_code).toBeNull();
  });
});

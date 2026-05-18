/**
 * Tests for normaliseBankAccountsResponse — the pure function inside
 * the shared useBankAccounts hook that turns the BE response into a
 * stable BankAccount[].
 *
 * The recurring class of dropdown-empty bugs in this project came
 * from each page parsing the response differently. One normaliser +
 * one test suite means a future endpoint rename or shape drift gets
 * caught in CI rather than by the operator on a Friday afternoon.
 */
import { describe, it, expect } from 'vitest';
import { normaliseBankAccountsResponse } from '../frontend/src/hooks/useBankAccounts';

describe('normaliseBankAccountsResponse', () => {
  it('returns [] for null / undefined / non-object', () => {
    expect(normaliseBankAccountsResponse(null)).toEqual([]);
    expect(normaliseBankAccountsResponse(undefined)).toEqual([]);
    expect(normaliseBankAccountsResponse('not an object')).toEqual([]);
    expect(normaliseBankAccountsResponse(42)).toEqual([]);
  });

  it('returns [] when success is false', () => {
    expect(
      normaliseBankAccountsResponse({ success: false, banks: [{ code: 'X' }] }),
    ).toEqual([]);
  });

  it('returns [] when success is missing', () => {
    expect(normaliseBankAccountsResponse({ banks: [{ code: 'X' }] })).toEqual(
      [],
    );
  });

  it('parses response with `banks` array (current cashbook endpoint)', () => {
    const result = normaliseBankAccountsResponse({
      success: true,
      banks: [
        {
          code: 'BB005',
          description: 'Monzo',
          sort_code: '04-00-04',
          account_number: '39913585',
        },
      ],
    });
    expect(result).toEqual([
      {
        code: 'BB005',
        description: 'Monzo',
        sort_code: '04-00-04',
        account_number: '39913585',
      },
    ]);
  });

  it('parses response with `accounts` array (legacy field name)', () => {
    const result = normaliseBankAccountsResponse({
      success: true,
      accounts: [
        {
          code: 'BC010',
          description: 'Barclays',
          sort_code: '20-00-00',
          account_number: '12345678',
        },
      ],
    });
    expect(result.length).toBe(1);
    expect(result[0]?.code).toBe('BC010');
  });

  it('parses response with `bank_accounts` array (other legacy field name)', () => {
    const result = normaliseBankAccountsResponse({
      success: true,
      bank_accounts: [{ code: 'BC030', description: 'Petty Cash' }],
    });
    expect(result.length).toBe(1);
    expect(result[0]?.code).toBe('BC030');
  });

  it('falls back to `name` when `description` is missing', () => {
    const result = normaliseBankAccountsResponse({
      success: true,
      banks: [{ code: 'BB005', name: 'Monzo (via name field)' }],
    });
    expect(result[0]?.description).toBe('Monzo (via name field)');
  });

  it('prefers `description` over `name` when both present', () => {
    const result = normaliseBankAccountsResponse({
      success: true,
      banks: [{ code: 'BB005', description: 'Real', name: 'Fallback' }],
    });
    expect(result[0]?.description).toBe('Real');
  });

  it('returns [] when no recognised array key is present', () => {
    const result = normaliseBankAccountsResponse({
      success: true,
      other_field: [{ code: 'X' }],
    });
    expect(result).toEqual([]);
  });

  it('normalises missing sort_code / account_number to empty string', () => {
    const result = normaliseBankAccountsResponse({
      success: true,
      banks: [{ code: 'BB005', description: 'Monzo' }],
    });
    expect(result[0]?.sort_code).toBe('');
    expect(result[0]?.account_number).toBe('');
  });

  it('coerces non-string fields to strings (defensive)', () => {
    const result = normaliseBankAccountsResponse({
      success: true,
      banks: [
        {
          code: 'BB005',
          description: 'Monzo',
          sort_code: 4040,
          account_number: 39913585,
        },
      ],
    });
    expect(result[0]?.sort_code).toBe('4040');
    expect(result[0]?.account_number).toBe('39913585');
  });

  it('preserves order from the BE response', () => {
    const result = normaliseBankAccountsResponse({
      success: true,
      banks: [
        { code: 'A', description: 'First' },
        { code: 'B', description: 'Second' },
        { code: 'C', description: 'Third' },
      ],
    });
    expect(result.map((b) => b.code)).toEqual(['A', 'B', 'C']);
  });

  it('prefers `banks` when multiple recognised keys are present', () => {
    // Defensive: if BE drift ever sends both, the canonical key wins.
    const result = normaliseBankAccountsResponse({
      success: true,
      banks: [{ code: 'CANONICAL' }],
      accounts: [{ code: 'LEGACY' }],
    });
    expect(result.length).toBe(1);
    expect(result[0]?.code).toBe('CANONICAL');
  });
});

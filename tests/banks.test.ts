import { describe, it, expect } from 'vitest';
import { listBanks } from '../src/services/banks.js';

function makeMockOpera(rows: unknown[]): any {
  const db: any = () => ({});
  db.raw = async () => rows;
  return db;
}

describe('listBanks', () => {
  it('returns trimmed bank accounts from nbank', async () => {
    const db = makeMockOpera([
      {
        account_code: 'BC010 ',
        description: 'Barclays Current',
        sort_code: '20-30-40',
        account_number: '12345678',
      },
      {
        account_code: 'BC020',
        description: 'Barclays Savings  ',
        sort_code: '20-30-40',
        account_number: '87654321',
      },
    ]);
    const result = await listBanks(db);
    expect(result.success).toBe(true);
    expect(result.banks).toHaveLength(2);
    expect(result.banks[0]?.account_code).toBe('BC010');
    expect(result.banks[0]?.description).toBe('Barclays Current');
    expect(result.banks[1]?.description).toBe('Barclays Savings');
  });

  it('returns empty list when no banks configured', async () => {
    const db = makeMockOpera([]);
    const result = await listBanks(db);
    expect(result.success).toBe(true);
    expect(result.banks).toEqual([]);
  });

  it('handles null fields gracefully', async () => {
    const db = makeMockOpera([
      {
        account_code: null,
        description: null,
        sort_code: null,
        account_number: null,
      },
    ]);
    const result = await listBanks(db);
    expect(result.banks[0]?.account_code).toBe('');
    expect(result.banks[0]?.description).toBe('');
  });

  it('returns success=false on query error', async () => {
    const db: any = {
      raw: async () => {
        throw new Error('connection lost');
      },
    };
    const result = await listBanks(db);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/connection lost/);
  });
});

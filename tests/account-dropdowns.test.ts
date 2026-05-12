import { describe, it, expect } from 'vitest';
import {
  getCustomersForDropdown,
  getSuppliersForDropdown,
} from '../src/services/account-dropdowns.js';

interface MockState {
  rows: Array<Record<string, string | null>>;
  capturedSql?: string;
}

function makeOperaDb(state: MockState): any {
  return {
    raw: (sql: string) => {
      state.capturedSql = sql;
      return Promise.resolve(state.rows);
    },
  };
}

describe('getCustomersForDropdown', () => {
  it('builds simplified rows with display field', async () => {
    const state: MockState = {
      rows: [
        { code: 'CUST01', name: 'Acme Ltd', search_key: 'ACME' },
        { code: 'CUST02', name: 'Beta', search_key: '' },
      ],
    };
    const result = await getCustomersForDropdown(makeOperaDb(state));
    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    expect(result.accounts[0]).toEqual({
      code: 'CUST01',
      name: 'Acme Ltd',
      search_key: 'ACME',
      display: 'CUST01 - Acme Ltd',
    });
  });

  it('trims whitespace', async () => {
    const result = await getCustomersForDropdown(
      makeOperaDb({
        rows: [{ code: '  CUST01  ', name: '  Acme Ltd  ', search_key: '  K1  ' }],
      }),
    );
    expect(result.accounts[0]?.code).toBe('CUST01');
    expect(result.accounts[0]?.name).toBe('Acme Ltd');
    expect(result.accounts[0]?.search_key).toBe('K1');
  });

  it('SQL includes dormant + stopped filters per CLAUDE.md', async () => {
    const state: MockState = { rows: [] };
    await getCustomersForDropdown(makeOperaDb(state));
    expect(state.capturedSql).toMatch(/sn_dormant = 0/);
    expect(state.capturedSql).toMatch(/sn_stop = 0/);
    expect(state.capturedSql).toMatch(/NOLOCK/);
  });

  it('returns empty array on no rows', async () => {
    const result = await getCustomersForDropdown(makeOperaDb({ rows: [] }));
    expect(result.success).toBe(true);
    expect(result.accounts).toEqual([]);
    expect(result.count).toBe(0);
  });

  it('returns success=false on DB error', async () => {
    const db: any = { raw: () => Promise.reject(new Error('connection lost')) };
    const result = await getCustomersForDropdown(db);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/connection lost/);
  });
});

describe('getSuppliersForDropdown', () => {
  it('builds simplified rows with payee', async () => {
    const result = await getSuppliersForDropdown(
      makeOperaDb({
        rows: [
          { code: 'SUPP01', name: 'WidgetCo', payee: 'Widget Co Ltd' },
          { code: 'SUPP02', name: 'Beta Supply', payee: '' },
        ],
      }),
    );
    expect(result.count).toBe(2);
    expect(result.accounts[0]).toEqual({
      code: 'SUPP01',
      name: 'WidgetCo',
      payee: 'Widget Co Ltd',
      display: 'SUPP01 - WidgetCo',
    });
  });

  it('SQL includes pn_dormant + pn_stop filters', async () => {
    const state: MockState = { rows: [] };
    await getSuppliersForDropdown(makeOperaDb(state));
    expect(state.capturedSql).toMatch(/pn_dormant = 0/);
    expect(state.capturedSql).toMatch(/pn_stop = 0/);
  });

  it('returns success=false on error', async () => {
    const db: any = { raw: () => Promise.reject(new Error('boom')) };
    const result = await getSuppliersForDropdown(db);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/boom/);
  });
});

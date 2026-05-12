import { describe, it, expect } from 'vitest';
import {
  getUnreconciledEntries,
  getReconciliationStatus,
} from '../src/services/reconciliation-status.js';

function makeMockOpera(canned: Record<string, unknown[]>): any {
  const db: any = () => ({});
  db.raw = async (sql: string) => {
    if (sql.includes('FROM aentry') && sql.includes('value_pounds')) {
      return canned.aentry ?? [];
    }
    if (sql.includes('FROM nbank')) return canned.nbank ?? [];
    if (sql.includes('FROM aentry') && sql.includes('SUM(ae_value)')) {
      return canned.unrec ?? [];
    }
    return [];
  };
  return db;
}

describe('getUnreconciledEntries', () => {
  it('returns trimmed entries with is_complete flag', async () => {
    const db = makeMockOpera({
      aentry: [
        {
          ae_entry: 'P10000123 ',
          value_pounds: 1500.5,
          ae_lstdate: '2026-04-15',
          ae_cbtype: 'GC',
          ae_entref: 'TEST  ',
          ae_comment: 'GoCardless batch',
          ae_complet: 1,
        },
        {
          ae_entry: 'P10000124',
          value_pounds: 200,
          ae_lstdate: '2026-04-16',
          ae_cbtype: 'BT',
          ae_entref: '',
          ae_comment: '',
          ae_complet: 0,
        },
      ],
    });
    const result = await getUnreconciledEntries(db, 'BC010', true);
    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    expect(result.entries[0]?.ae_entry).toBe('P10000123');
    expect(result.entries[0]?.ae_entref).toBe('TEST');
    expect(result.entries[0]?.is_complete).toBe(true);
    expect(result.entries[1]?.is_complete).toBe(false);
  });

  it('returns empty when no unreconciled', async () => {
    const db = makeMockOpera({ aentry: [] });
    const result = await getUnreconciledEntries(db, 'BC010');
    expect(result.success).toBe(true);
    expect(result.count).toBe(0);
  });

  it('reports error gracefully', async () => {
    const db: any = {
      raw: async () => {
        throw new Error('connection lost');
      },
    };
    const result = await getUnreconciledEntries(db, 'BC010');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/connection lost/);
  });
});

describe('getReconciliationStatus', () => {
  it('returns reconciled balance + derived current balance', async () => {
    const db = makeMockOpera({
      nbank: [
        {
          reconciled_balance: 10000,
          current_balance: 9999, // intentionally wrong — should be ignored
          last_rec_line: 5,
          last_stmt_no: 86918,
          last_stmt_date: '2026-04-30',
          last_rec_date: '2026-04-30',
          rec_cfwd_balance: 10000,
        },
      ],
      unrec: [{ count: 3, total: 500 }],
    });

    const result = await getReconciliationStatus(db, 'BC010');

    expect(result.success).toBe(true);
    expect(result.bank_account).toBe('BC010');
    expect(result.reconciled_balance).toBe(10000);
    // Derived: 10000 + 500 (NOT 9999 from nbank.nk_curbal)
    expect(result.current_balance).toBe(10500);
    expect(result.unreconciled_count).toBe(3);
    expect(result.unreconciled_total).toBe(500);
    expect(result.last_stmt_no).toBe(86918);
  });

  it('returns 404-style response when bank not found', async () => {
    const db = makeMockOpera({ nbank: [] });
    const result = await getReconciliationStatus(db, 'GHOST');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/'GHOST' not found|GHOST not found/);
  });

  it('handles null/zero unreconciled total gracefully', async () => {
    const db = makeMockOpera({
      nbank: [
        {
          reconciled_balance: 5000,
          current_balance: 5000,
          last_rec_line: 1,
          last_stmt_no: null,
          last_stmt_date: null,
          last_rec_date: null,
          rec_cfwd_balance: 5000,
        },
      ],
      unrec: [{ count: 0, total: null }],
    });
    const result = await getReconciliationStatus(db, 'BC010');
    expect(result.success).toBe(true);
    expect(result.current_balance).toBe(5000);
    expect(result.unreconciled_count).toBe(0);
    expect(result.unreconciled_total).toBe(0);
    expect(result.last_stmt_no).toBeNull();
  });
});

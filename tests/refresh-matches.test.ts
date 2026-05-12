import { describe, it, expect } from 'vitest';
import {
  refreshMatches,
  type RefreshTransactionInput,
} from '../src/services/refresh-matches.js';
import { generateImportFingerprint } from '../src/services/duplicate-detection.js';

interface AtranRow {
  at_unique: string;
  at_pstdate: string;
  at_value: number;
  at_refer: string;
  at_acnt: string;
}

interface AentryRow {
  ae_entry: string;
  ae_value: number;
  ae_lstdate: string;
  ae_entref: string;
  ae_comment: string;
  ae_acnt: string;
}

interface State {
  atran: AtranRow[];
  aentry?: AentryRow[];
}

function makeOperaDb(state: State): any {
  const empty: any[] = [];
  const db: any = (table: string) => {
    let pattern: string | null = null;
    let bankCodeFilter: string | null = null;
    let dateRange: [string, string] | null = null;
    let signedAmount: number | null = null;
    let limitN: number | null = null;

    const builder: any = {
      where: (col: any, op?: any) => {
        if (typeof col === 'function') {
          col.call(builder);
          return builder;
        }
        if (typeof col === 'string') {
          if (
            (col === 'at_refer' || col === 'st_trref' || col === 'pt_trref') &&
            op === 'like'
          ) {
            pattern = arguments.length >= 3 ? (arguments[2] as string) : null;
          } else if (col === 'at_acnt' || col === 'ae_acnt') {
            bankCodeFilter = op;
          }
        }
        return builder;
      },
      andWhere: (col: any, op?: any, val?: any) => {
        if (col === 'at_refer' && op === 'like') {
          pattern = val as string;
        } else if (col === 'ae_acnt' || col === 'at_acnt') {
          bankCodeFilter = op;
        }
        return builder;
      },
      andWhereBetween: (col: string, range: [string, string]) => {
        if (col === 'ae_lstdate') dateRange = range;
        return builder;
      },
      whereRaw: () => builder,
      andWhereRaw: (sql: string, params: any[]) => {
        if (sql.includes('ABS(ae_value - ?)')) signedAmount = params?.[0] ?? null;
        return builder;
      },
      orderBy: () => builder,
      limit: (n: number) => {
        limitN = n;
        return builder;
      },
      select: () => builder,
      then: async (resolve: any) => {
        const matchPattern = (s: string) => {
          if (!pattern) return true;
          const prefix = pattern.replace(/^%/, '').replace(/%$/, '');
          if (pattern.startsWith('%') && pattern.endsWith('%')) return s.includes(prefix);
          if (pattern.endsWith('%')) return s.startsWith(prefix);
          return s === prefix;
        };
        const inRange = (d: string) => {
          if (!dateRange) return true;
          return d >= dateRange[0] && d <= dateRange[1];
        };
        if (table === 'atran') {
          const filtered = state.atran.filter((r) => {
            if (pattern && !matchPattern(r.at_refer)) return false;
            if (bankCodeFilter && r.at_acnt !== bankCodeFilter) return false;
            return true;
          });
          return resolve(limitN ? filtered.slice(0, limitN) : filtered);
        }
        if (table === 'aentry') {
          const aentry = state.aentry ?? [];
          const filtered = aentry.filter((r) => {
            if (bankCodeFilter && r.ae_acnt !== bankCodeFilter) return false;
            if (dateRange && !inRange(r.ae_lstdate)) return false;
            if (
              signedAmount !== null &&
              Math.abs(r.ae_value - signedAmount) >= 1
            )
              return false;
            return true;
          });
          return resolve(filtered);
        }
        return resolve(empty);
      },
    };
    return builder;
  };
  return db;
}

describe('refreshMatches', () => {
  it('returns no-transactions response when input is empty', async () => {
    const result = await refreshMatches(
      makeOperaDb({ atran: [] }),
      'BC010',
      [],
    );
    expect(result.success).toBe(true);
    expect(result.matched_count).toBe(0);
    expect(result.total).toBe(0);
  });

  it('flags fingerprint matches as duplicates with skip action', async () => {
    const fp = generateImportFingerprint('Acme', 100, '2026-04-30');
    const hash = fp.split(':')[1]!;
    const state: State = {
      atran: [
        {
          at_unique: 'A-1',
          at_pstdate: '2026-04-30',
          at_value: 10000,
          at_refer: `BKIMP:${hash}:20260430`,
          at_acnt: 'BC010',
        },
      ],
    };
    const txns: RefreshTransactionInput[] = [
      { name: 'Acme', amount: 100, date: '2026-04-30' },
    ];
    const result = await refreshMatches(makeOperaDb(state), 'BC010', txns);
    expect(result.matched_count).toBe(1);
    expect(result.transactions[0]?.is_duplicate).toBe(true);
    expect(result.transactions[0]?.action).toBe('skip');
    expect(result.transactions[0]?.skip_reason).toMatch(/already posted/);
  });

  it('preserves non-duplicate transactions with their existing action', async () => {
    const txns: RefreshTransactionInput[] = [
      { name: 'NewVendor', amount: -50, date: '2026-04-30', action: 'purchase_payment' },
    ];
    const result = await refreshMatches(
      makeOperaDb({ atran: [] }),
      'BC010',
      txns,
    );
    expect(result.matched_count).toBe(0);
    expect(result.transactions[0]?.is_duplicate).toBe(false);
    expect(result.transactions[0]?.action).toBe('purchase_payment');
  });

  it('respects custom posted_threshold to ignore low-confidence matches', async () => {
    const state: State = {
      atran: [],
      aentry: [
        {
          ae_entry: 'E-1',
          ae_value: 10000,
          ae_lstdate: '2026-04-15', // 15 days off → confidence 0.95-15*0.05=0.20, floored 0.5
          ae_entref: '',
          ae_comment: '',
          ae_acnt: 'BC010',
        },
      ],
    };
    const txns: RefreshTransactionInput[] = [
      { name: 'Acme', amount: 100, date: '2026-04-30' },
    ];
    // High threshold (0.95) — bank_amount with 15-day diff floors at 0.5,
    // below threshold, so transaction NOT flagged as duplicate.
    const result = await refreshMatches(
      makeOperaDb(state),
      'BC010',
      txns,
      { posted_threshold: 0.95 },
    );
    expect(result.matched_count).toBe(0);
  });
});

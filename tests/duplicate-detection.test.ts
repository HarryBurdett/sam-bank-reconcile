import { describe, it, expect } from 'vitest';
import {
  generateImportFingerprint,
  extractHashFromFingerprint,
  findDuplicates,
  checkBatch,
} from '../src/services/duplicate-detection.js';

interface AtranRow {
  at_unique: string;
  at_pstdate: string;
  at_value: number;
  at_refer: string;
  at_acnt: string;
}

interface StranRow {
  st_unique: string;
  st_trdate: string;
  st_trvalue: number;
  st_trref: string;
  st_account: string;
  st_trtype: string;
}

interface PtranRow {
  pt_unique: string;
  pt_trdate: string;
  pt_trvalue: number;
  pt_trref: string;
  pt_account: string;
  pt_trtype: string;
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
  stran: StranRow[];
  ptran: PtranRow[];
  aentry?: AentryRow[];
}

function makeOperaDb(state: State): any {
  function tableBuilder(table: string) {
    let pattern: string | null = null;
    let bankCodeFilter: string | null = null;
    let dateFilter: string | null = null;
    let dateNotEqFilter: string | null = null;
    let dateRange: [string, string] | null = null;
    let typeFilter: string | null = null;
    let accountFilter: string | null = null;
    let rawAmountValue: number | null = null;
    let rawAmountKind: 'sub' | 'add' | null = null;
    let fuzzyAbs: number | null = null;
    let fuzzyTolerance: number | null = null;
    let fuzzyExclude01: number | null = null;
    let fitIdEqual: string | null = null;
    let limitN: number | null = null;

    const builder: any = {
      where: (col: any, op?: any, val?: any) => {
        if (typeof col === 'function') {
          // Sub-query filter — Knex calls the function with `this`
          // bound to a sub-builder. Replicate that.
          const subBuilder: any = {
            where: (c: any, o?: any) => {
              if (c === 'at_refer' && o !== undefined && typeof o !== 'function') {
                fitIdEqual = (o ?? '').toString();
              }
              return subBuilder;
            },
            orWhere: (c: any, op2?: any, v?: any) => {
              if (c === 'at_refer' && op2 === 'like' && typeof v === 'string') {
                fitIdEqual = (v.replace(/^%/, '').replace(/%$/, '')) || fitIdEqual;
              }
              return subBuilder;
            },
          };
          col.call(subBuilder);
          return builder;
        }
        if (typeof col === 'string') {
          if ((col === 'at_refer' || col === 'st_trref' || col === 'pt_trref') && op === 'like') {
            pattern = val.toString();
          } else if (col === 'at_acnt' || col === 'ae_acnt') {
            bankCodeFilter = op;
          } else if (col === 'at_pstdate' || col === 'st_trdate' || col === 'pt_trdate') {
            if (op === '!=') {
              dateNotEqFilter = val;
            } else {
              dateFilter = op;
            }
          } else if (col === 'st_trtype' || col === 'pt_trtype') {
            typeFilter = op;
          } else if (col === 'at_refer' && (op === undefined || typeof op === 'string')) {
            fitIdEqual = (op ?? '').toString();
          }
        }
        return builder;
      },
      andWhere: (col: any, op?: any, val?: any) => builder.where(col, op, val),
      andWhereBetween: (col: string, range: [string, string]) => {
        if (col === 'st_trdate' || col === 'pt_trdate' || col === 'ae_lstdate') {
          dateRange = range;
        }
        return builder;
      },
      whereRaw: (sql: string, params: any[]) => {
        if (sql.includes('RTRIM(st_account)') || sql.includes('RTRIM(pt_account)')) {
          accountFilter = params?.[0] ?? null;
        }
        return builder;
      },
      andWhereRaw: (sql: string, params: any[]) => {
        if (sql.includes('ABS(ABS(st_trvalue) - ?) <= ?')) {
          fuzzyAbs = params?.[0] ?? null;
          fuzzyTolerance = params?.[1] ?? null;
        } else if (sql.includes('ABS(ABS(st_trvalue) - ?) > 0.01')) {
          fuzzyExclude01 = params?.[0] ?? null;
        } else if (sql.includes('ABS(ABS(pt_trvalue) - ?) <= ?')) {
          fuzzyAbs = params?.[0] ?? null;
          fuzzyTolerance = params?.[1] ?? null;
        } else if (sql.includes('ABS(ABS(pt_trvalue) - ?) > 0.01')) {
          fuzzyExclude01 = params?.[0] ?? null;
        } else if (sql.includes('ABS(ABS(st_trvalue) - ?) < 0.01')) {
          fuzzyAbs = params?.[0] ?? null;
        } else if (sql.includes('ABS(ABS(pt_trvalue) - ?) < 0.01')) {
          fuzzyAbs = params?.[0] ?? null;
        } else if (sql.includes('ABS(at_value - ?)')) {
          rawAmountValue = params?.[0] ?? null;
          rawAmountKind = 'sub';
        } else if (sql.includes('ABS(st_trvalue + ?)')) {
          rawAmountValue = params?.[0] ?? null;
          rawAmountKind = 'add';
        } else if (sql.includes('ABS(pt_trvalue - ?)')) {
          rawAmountValue = params?.[0] ?? null;
          rawAmountKind = 'sub';
        } else if (sql.includes('ABS(ae_value - ?)')) {
          rawAmountValue = params?.[0] ?? null;
          rawAmountKind = 'sub';
        }
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
          // %text% is "contains", BKIMP:HASH% is "startsWith"
          if (pattern.startsWith('%') && pattern.endsWith('%')) {
            return s.includes(prefix);
          }
          if (pattern.endsWith('%')) {
            return s.startsWith(prefix);
          }
          return s === prefix;
        };
        const inDateRange = (d: string) => {
          if (!dateRange) return true;
          return d >= dateRange[0] && d <= dateRange[1];
        };
        if (table === 'atran') {
          const filtered = state.atran.filter((r) => {
            if (fitIdEqual !== null) {
              if (
                r.at_refer !== fitIdEqual &&
                !r.at_refer.includes(fitIdEqual)
              )
                return false;
              return true;
            }
            if (pattern && !matchPattern(r.at_refer)) return false;
            if (bankCodeFilter && r.at_acnt !== bankCodeFilter) return false;
            if (dateFilter && r.at_pstdate !== dateFilter) return false;
            if (
              rawAmountValue !== null &&
              rawAmountKind === 'sub' &&
              Math.abs(r.at_value - rawAmountValue) >= 1
            )
              return false;
            return true;
          });
          return resolve(filtered);
        }
        if (table === 'stran') {
          const filtered = state.stran.filter((r) => {
            if (pattern && !matchPattern(r.st_trref)) return false;
            if (accountFilter && r.st_account.trim() !== accountFilter)
              return false;
            if (dateFilter && r.st_trdate !== dateFilter) return false;
            if (dateNotEqFilter && r.st_trdate === dateNotEqFilter)
              return false;
            if (dateRange && !inDateRange(r.st_trdate)) return false;
            if (typeFilter && r.st_trtype !== typeFilter) return false;
            if (
              rawAmountValue !== null &&
              rawAmountKind === 'add' &&
              Math.abs(r.st_trvalue + rawAmountValue) >= 0.01
            )
              return false;
            // Cross-period amount check: ABS(ABS(st_trvalue)-?)<0.01
            if (
              fuzzyAbs !== null &&
              fuzzyTolerance === null &&
              Math.abs(Math.abs(r.st_trvalue) - fuzzyAbs) >= 0.01
            )
              return false;
            // Fuzzy amount check: <= tolerance, > 0.01
            if (
              fuzzyAbs !== null &&
              fuzzyTolerance !== null &&
              !(
                Math.abs(Math.abs(r.st_trvalue) - fuzzyAbs) <= fuzzyTolerance &&
                Math.abs(Math.abs(r.st_trvalue) - fuzzyAbs) > 0.01
              )
            )
              return false;
            if (
              fuzzyExclude01 !== null &&
              Math.abs(Math.abs(r.st_trvalue) - fuzzyExclude01) <= 0.01
            )
              return false;
            return true;
          });
          const limited = limitN ? filtered.slice(0, limitN) : filtered;
          return resolve(limited);
        }
        if (table === 'ptran') {
          const filtered = state.ptran.filter((r) => {
            if (pattern && !matchPattern(r.pt_trref)) return false;
            if (accountFilter && r.pt_account.trim() !== accountFilter)
              return false;
            if (dateFilter && r.pt_trdate !== dateFilter) return false;
            if (dateNotEqFilter && r.pt_trdate === dateNotEqFilter)
              return false;
            if (dateRange && !inDateRange(r.pt_trdate)) return false;
            if (typeFilter && r.pt_trtype !== typeFilter) return false;
            if (
              rawAmountValue !== null &&
              rawAmountKind === 'sub' &&
              Math.abs(r.pt_trvalue - rawAmountValue) >= 0.01
            )
              return false;
            if (
              fuzzyAbs !== null &&
              fuzzyTolerance === null &&
              Math.abs(Math.abs(r.pt_trvalue) - fuzzyAbs) >= 0.01
            )
              return false;
            if (
              fuzzyAbs !== null &&
              fuzzyTolerance !== null &&
              !(
                Math.abs(Math.abs(r.pt_trvalue) - fuzzyAbs) <= fuzzyTolerance &&
                Math.abs(Math.abs(r.pt_trvalue) - fuzzyAbs) > 0.01
              )
            )
              return false;
            if (
              fuzzyExclude01 !== null &&
              Math.abs(Math.abs(r.pt_trvalue) - fuzzyExclude01) <= 0.01
            )
              return false;
            return true;
          });
          const limited = limitN ? filtered.slice(0, limitN) : filtered;
          return resolve(limited);
        }
        if (table === 'aentry') {
          const aentry = state.aentry ?? [];
          const filtered = aentry.filter((r) => {
            if (bankCodeFilter && r.ae_acnt !== bankCodeFilter) return false;
            if (dateRange && !inDateRange(r.ae_lstdate)) return false;
            if (
              rawAmountValue !== null &&
              rawAmountKind === 'sub' &&
              Math.abs(r.ae_value - rawAmountValue) >= 1
            )
              return false;
            return true;
          });
          return resolve(filtered);
        }
        return resolve([]);
      },
    };
    return builder;
  }

  const db: any = (table: string) => tableBuilder(table);
  return db;
}

// ---------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------

describe('generateImportFingerprint', () => {
  it('produces a stable BKIMP:HASH:DATE format', () => {
    const fp = generateImportFingerprint('Acme', 100, '2026-04-30');
    expect(fp).toMatch(/^BKIMP:[A-F0-9]{8}:\d{8}$/);
  });

  it('is deterministic for the same inputs', () => {
    const a = generateImportFingerprint('Acme', 100, '2026-04-30');
    const b = generateImportFingerprint('Acme', 100, '2026-04-30');
    // Same date components even if generated on the same import day
    expect(a.split(':').slice(0, 2).join(':')).toBe(
      b.split(':').slice(0, 2).join(':'),
    );
  });

  it('changes when the name changes', () => {
    const a = generateImportFingerprint('Acme', 100, '2026-04-30');
    const b = generateImportFingerprint('Beta', 100, '2026-04-30');
    expect(a.split(':')[1]).not.toBe(b.split(':')[1]);
  });
});

describe('extractHashFromFingerprint', () => {
  it('returns the hash portion', () => {
    const fp = 'BKIMP:A7F3B2C1:20260206';
    expect(extractHashFromFingerprint(fp)).toBe('A7F3B2C1');
  });
  it('returns null for non-BKIMP strings', () => {
    expect(extractHashFromFingerprint('something else')).toBeNull();
  });
  it('returns null for empty', () => {
    expect(extractHashFromFingerprint('')).toBeNull();
  });
});

// ---------------------------------------------------------------------
// findDuplicates — fingerprint
// ---------------------------------------------------------------------

describe('findDuplicates (fingerprint)', () => {
  it('detects already-imported transaction in atran', async () => {
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
      stran: [],
      ptran: [],
    };
    const result = await findDuplicates(makeOperaDb(state), {
      name: 'Acme',
      amount: 100,
      date: '2026-04-30',
      bank_code: 'BC010',
    });
    expect(result.length).toBe(1);
    expect(result[0]?.match_type).toBe('fingerprint');
    expect(result[0]?.confidence).toBe(1);
    expect(result[0]?.table).toBe('atran');
  });

  it('skips fingerprint matches in a different bank account', async () => {
    const fp = generateImportFingerprint('Acme', 100, '2026-04-30');
    const hash = fp.split(':')[1]!;
    const state: State = {
      atran: [
        {
          at_unique: 'A-1',
          at_pstdate: '2026-04-30',
          at_value: 10000,
          at_refer: `BKIMP:${hash}:20260430`,
          at_acnt: 'BC020', // different bank
        },
      ],
      stran: [],
      ptran: [],
    };
    const result = await findDuplicates(makeOperaDb(state), {
      name: 'Acme',
      amount: 100,
      date: '2026-04-30',
      bank_code: 'BC010',
    });
    expect(result.length).toBe(0);
  });

  it('returns empty when no fingerprint or exact match', async () => {
    const result = await findDuplicates(
      makeOperaDb({ atran: [], stran: [], ptran: [] }),
      {
        name: 'Acme',
        amount: 100,
        date: '2026-04-30',
        bank_code: 'BC010',
      },
    );
    expect(result.length).toBe(0);
  });
});

// ---------------------------------------------------------------------
// findDuplicates — exact match
// ---------------------------------------------------------------------

describe('findDuplicates (exact)', () => {
  it('matches stran for a positive (receipt) amount with account', async () => {
    const state: State = {
      atran: [],
      stran: [
        {
          st_unique: 'S-1',
          st_trdate: '2026-04-30',
          st_trvalue: -100, // sales receipt stored negative
          st_trref: 'something',
          st_account: 'A001',
          st_trtype: 'R',
        },
      ],
      ptran: [],
    };
    const result = await findDuplicates(makeOperaDb(state), {
      name: 'Acme',
      amount: 100,
      date: '2026-04-30',
      account: 'A001',
    });
    expect(result.length).toBe(1);
    expect(result[0]?.match_type).toBe('exact');
    expect(result[0]?.table).toBe('stran');
    expect(result[0]?.confidence).toBe(0.9);
  });

  it('matches ptran for a negative (payment) amount with account', async () => {
    const state: State = {
      atran: [],
      stran: [],
      ptran: [
        {
          pt_unique: 'P-1',
          pt_trdate: '2026-04-30',
          pt_trvalue: -100,
          pt_trref: 'something',
          pt_account: 'B001',
          pt_trtype: 'P',
        },
      ],
    };
    const result = await findDuplicates(makeOperaDb(state), {
      name: 'Energy Co',
      amount: -100,
      date: '2026-04-30',
      account: 'B001',
    });
    expect(result.length).toBe(1);
    expect(result[0]?.match_type).toBe('exact');
    expect(result[0]?.table).toBe('ptran');
  });

  it('opposite-sign transactions are NOT exact matches', async () => {
    const state: State = {
      atran: [],
      stran: [
        {
          st_unique: 'S-1',
          st_trdate: '2026-04-30',
          st_trvalue: -100,
          st_trref: 'something',
          st_account: 'A001',
          st_trtype: 'R',
        },
      ],
      ptran: [],
    };
    const result = await findDuplicates(makeOperaDb(state), {
      name: 'Acme',
      amount: -100, // payment, but stran is a receipt
      date: '2026-04-30',
      account: 'A001',
    });
    // Negative amount routes to ptran exact, not stran. ptran is empty so no match.
    expect(result.filter((r) => r.match_type === 'exact').length).toBe(0);
  });

  it('skips exact match when fingerprint already matched', async () => {
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
      stran: [
        {
          st_unique: 'S-1',
          st_trdate: '2026-04-30',
          st_trvalue: -100,
          st_trref: 'something',
          st_account: 'A001',
          st_trtype: 'R',
        },
      ],
      ptran: [],
    };
    const result = await findDuplicates(makeOperaDb(state), {
      name: 'Acme',
      amount: 100,
      date: '2026-04-30',
      bank_code: 'BC010',
      account: 'A001',
    });
    // Only fingerprint, not exact (skipped because fingerprint matched)
    expect(result.every((r) => r.match_type === 'fingerprint')).toBe(true);
  });
});

// ---------------------------------------------------------------------
// findDuplicates — fit_id
// ---------------------------------------------------------------------

describe('findDuplicates (fit_id)', () => {
  it('matches when at_refer equals the FIT id', async () => {
    const state: State = {
      atran: [
        {
          at_unique: 'A-1',
          at_pstdate: '2026-04-30',
          at_value: 10000,
          at_refer: 'OFX-FITID-9988',
          at_acnt: 'BC010',
        },
      ],
      stran: [],
      ptran: [],
    };
    const result = await findDuplicates(makeOperaDb(state), {
      name: 'Acme',
      amount: 100,
      date: '2026-04-30',
      bank_code: 'BC010',
      fit_id: 'OFX-FITID-9988',
    });
    expect(result.length).toBe(1);
    expect(result[0]?.match_type).toBe('fit_id');
    expect(result[0]?.confidence).toBe(0.95);
  });
});

// ---------------------------------------------------------------------
// findDuplicates — fuzzy amount
// ---------------------------------------------------------------------

describe('findDuplicates (fuzzy_amount)', () => {
  it('matches a stran row within 5% tolerance (positive amount)', async () => {
    const state: State = {
      atran: [],
      stran: [
        {
          st_unique: 'S-1',
          st_trdate: '2026-04-30',
          st_trvalue: -103, // 3% off £100
          st_trref: 'something',
          st_account: 'A001',
          st_trtype: 'R',
        },
      ],
      ptran: [],
    };
    const result = await findDuplicates(makeOperaDb(state), {
      name: 'Acme',
      amount: 100,
      date: '2026-04-30',
      account: 'A001',
    });
    expect(result.some((r) => r.match_type === 'fuzzy_amount')).toBe(true);
    const fuzzy = result.find((r) => r.match_type === 'fuzzy_amount');
    expect(fuzzy?.confidence).toBeGreaterThanOrEqual(0.5);
    expect(fuzzy?.confidence).toBeLessThanOrEqual(0.7);
  });

  it('skips rows within 0.01 (those go to exact match instead)', async () => {
    const state: State = {
      atran: [],
      stran: [
        {
          st_unique: 'S-1',
          st_trdate: '2026-04-30',
          st_trvalue: -100, // exact
          st_trref: '',
          st_account: 'A001',
          st_trtype: 'R',
        },
      ],
      ptran: [],
    };
    const result = await findDuplicates(makeOperaDb(state), {
      name: 'Acme',
      amount: 100,
      date: '2026-04-30',
      account: 'A001',
    });
    expect(result.some((r) => r.match_type === 'fuzzy_amount')).toBe(false);
    expect(result.some((r) => r.match_type === 'exact')).toBe(true);
  });
});

// ---------------------------------------------------------------------
// findDuplicates — reference
// ---------------------------------------------------------------------

describe('findDuplicates (reference)', () => {
  it('matches by partial reference on stran', async () => {
    const state: State = {
      atran: [],
      stran: [
        {
          st_unique: 'S-1',
          st_trdate: '2026-03-15',
          st_trvalue: -50,
          st_trref: 'CUST-INV-12345',
          st_account: 'A001',
          st_trtype: 'R',
        },
      ],
      ptran: [],
    };
    const result = await findDuplicates(makeOperaDb(state), {
      name: 'Acme',
      amount: 999, // doesn't match stran row
      date: '2026-04-30',
      account: 'A001',
      reference: 'INV-12345',
    });
    const refMatch = result.find((r) => r.match_type === 'reference');
    expect(refMatch).toBeDefined();
    expect(refMatch?.confidence).toBe(0.6);
  });

  it('skips reference < 3 chars', async () => {
    const state: State = {
      atran: [],
      stran: [
        {
          st_unique: 'S-1',
          st_trdate: '2026-03-15',
          st_trvalue: -50,
          st_trref: 'AB',
          st_account: 'A001',
          st_trtype: 'R',
        },
      ],
      ptran: [],
    };
    const result = await findDuplicates(makeOperaDb(state), {
      name: 'Acme',
      amount: 999,
      date: '2026-04-30',
      account: 'A001',
      reference: 'AB',
    });
    expect(result.filter((r) => r.match_type === 'reference').length).toBe(0);
  });
});

// ---------------------------------------------------------------------
// findDuplicates — cross-period
// ---------------------------------------------------------------------

describe('findDuplicates (cross_period)', () => {
  it('matches a stran row 5 days off', async () => {
    const state: State = {
      atran: [],
      stran: [
        {
          st_unique: 'S-1',
          st_trdate: '2026-04-25', // 5 days before 2026-04-30
          st_trvalue: -100,
          st_trref: '',
          st_account: 'A001',
          st_trtype: 'R',
        },
      ],
      ptran: [],
    };
    const result = await findDuplicates(makeOperaDb(state), {
      name: 'Acme',
      amount: 100,
      date: '2026-04-30',
      account: 'A001',
    });
    const cp = result.find((r) => r.match_type === 'cross_period');
    expect(cp).toBeDefined();
    expect(cp?.confidence).toBeCloseTo(0.5, 1); // 0.75 - 5*0.05 = 0.5
  });

  it('skips dates outside the ±7 day window', async () => {
    const state: State = {
      atran: [],
      stran: [
        {
          st_unique: 'S-1',
          st_trdate: '2026-04-15', // 15 days before
          st_trvalue: -100,
          st_trref: '',
          st_account: 'A001',
          st_trtype: 'R',
        },
      ],
      ptran: [],
    };
    const result = await findDuplicates(makeOperaDb(state), {
      name: 'Acme',
      amount: 100,
      date: '2026-04-30',
      account: 'A001',
    });
    expect(result.filter((r) => r.match_type === 'cross_period').length).toBe(0);
  });
});

// ---------------------------------------------------------------------
// findDuplicates — bank_amount (fallback when no account match)
// ---------------------------------------------------------------------

describe('findDuplicates (bank_amount)', () => {
  it('matches aentry by signed amount + bank when no account', async () => {
    const state: State = {
      atran: [],
      stran: [],
      ptran: [],
      aentry: [
        {
          ae_entry: 'E-1',
          ae_value: 10000, // £100 in pence
          ae_lstdate: '2026-04-28',
          ae_entref: 'HMRC-VAT',
          ae_comment: 'HMRC VAT return',
          ae_acnt: 'BC010',
        },
      ],
    };
    const result = await findDuplicates(makeOperaDb(state), {
      name: 'HMRC',
      amount: 100,
      date: '2026-04-30',
      bank_code: 'BC010',
    });
    expect(result.length).toBe(1);
    expect(result[0]?.match_type).toBe('bank_amount');
    expect(result[0]?.table).toBe('aentry');
  });

  it('opposite-sign aentry rows are not duplicates', async () => {
    const state: State = {
      atran: [],
      stran: [],
      ptran: [],
      aentry: [
        {
          ae_entry: 'E-1',
          ae_value: -10000, // £100 PAYMENT
          ae_lstdate: '2026-04-28',
          ae_entref: 'HMRC-PAY',
          ae_comment: '',
          ae_acnt: 'BC010',
        },
      ],
    };
    const result = await findDuplicates(makeOperaDb(state), {
      name: 'HMRC',
      amount: 100, // RECEIPT
      date: '2026-04-30',
      bank_code: 'BC010',
    });
    expect(result.length).toBe(0);
  });

  it('does not run when account-level matches found', async () => {
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
      stran: [],
      ptran: [],
      aentry: [
        {
          ae_entry: 'E-1',
          ae_value: 10000,
          ae_lstdate: '2026-04-30',
          ae_entref: '',
          ae_comment: '',
          ae_acnt: 'BC010',
        },
      ],
    };
    const result = await findDuplicates(makeOperaDb(state), {
      name: 'Acme',
      amount: 100,
      date: '2026-04-30',
      bank_code: 'BC010',
    });
    // Fingerprint short-circuits, bank_amount fallback NOT triggered
    expect(result.every((r) => r.match_type === 'fingerprint')).toBe(true);
  });
});

// ---------------------------------------------------------------------
// checkBatch
// ---------------------------------------------------------------------

describe('checkBatch', () => {
  it('flags only transactions with candidates', async () => {
    const fp1 = generateImportFingerprint('Acme', 100, '2026-04-30');
    const hash = fp1.split(':')[1]!;
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
      stran: [],
      ptran: [],
    };
    const result = await checkBatch(
      makeOperaDb(state),
      [
        { name: 'Acme', amount: 100, date: '2026-04-30' },
        { name: 'Beta', amount: 50, date: '2026-04-30' },
      ],
      'BC010',
    );
    expect(result.success).toBe(true);
    expect(result.duplicates_found).toBe(1);
    expect(result.results['0']?.length).toBe(1);
    expect(result.results['0']?.[0]?.confidence).toBe(100);
    expect(result.results['1']).toBeUndefined();
  });
});

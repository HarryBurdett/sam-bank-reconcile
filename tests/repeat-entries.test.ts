import { describe, it, expect } from 'vitest';
import {
  updateRepeatEntryDate,
  listRepeatEntries,
} from '../src/services/repeat-entries.js';

const TEST_COMPANY = 'C';

interface AppLockRow {
  id: number;
  company_code: string;
  bank_code: string;
  locked_at: Date;
  locked_by: string;
  endpoint: string;
  description: string;
}

interface AliasRow {
  id: number;
  bank_code: string;
  memo_pattern: string;
  opera_repeat_ref: string;
}

interface AppMockState {
  lockRows: AppLockRow[];
  aliases: AliasRow[];
  nextLockId: number;
  nextAliasId: number;
}

function makeAppDb(state: AppMockState): any {
  const db: any = (table: string) => {
    if (table === 'import_locks') {
      let conds: any = {};
      let lessThanCol: any = null;
      let lessThanVal: any = null;
      const builder: any = {
        where: (cond: any, op?: any, val?: any) => {
          if (typeof cond === 'string' && op === '<') {
            lessThanCol = cond;
            lessThanVal = val;
          } else if (typeof cond === 'object') {
            conds = { ...conds, ...cond };
          }
          return builder;
        },
        andWhere: (cond: any, op?: any, val?: any) => builder.where(cond, op, val),
        first: () =>
          Promise.resolve(
            state.lockRows.find((r) =>
              Object.entries(conds).every(([k, v]) => (r as any)[k] === v),
            ),
          ),
        delete: () => {
          if (lessThanCol && lessThanVal) {
            const before = state.lockRows.length;
            state.lockRows = state.lockRows.filter(
              (r) => (r as any)[lessThanCol].getTime() >= lessThanVal.getTime(),
            );
            return Promise.resolve(before - state.lockRows.length);
          }
          const before = state.lockRows.length;
          state.lockRows = state.lockRows.filter(
            (r) =>
              !Object.entries(conds).every(([k, v]) => (r as any)[k] === v),
          );
          return Promise.resolve(before - state.lockRows.length);
        },
        insert: (row: any) => {
          state.lockRows.push({
            id: state.nextLockId++,
            company_code: String(row.company_code ?? ''),
            bank_code: row.bank_code,
            locked_at: new Date(),
            locked_by: row.locked_by ?? 'unknown',
            endpoint: row.endpoint ?? 'unknown',
            description: row.description ?? '',
          });
          return Promise.resolve([state.nextLockId - 1]);
        },
      };
      return builder;
    }
    if (table === 'repeat_entry_aliases') {
      let conds: any = {};
      const builder: any = {
        where: (cond: any) => {
          conds = { ...conds, ...cond };
          return builder;
        },
        first: () =>
          Promise.resolve(
            state.aliases.find((r) =>
              Object.entries(conds).every(([k, v]) => (r as any)[k] === v),
            ),
          ),
        update: (data: any) => {
          for (const r of state.aliases) {
            if (
              Object.entries(conds).every(([k, v]) => (r as any)[k] === v)
            ) {
              Object.assign(r, data);
            }
          }
          return Promise.resolve(1);
        },
        insert: (row: any) => {
          state.aliases.push({
            id: state.nextAliasId++,
            bank_code: String(row.bank_code ?? ''),
            memo_pattern: String(row.memo_pattern ?? ''),
            opera_repeat_ref: String(row.opera_repeat_ref ?? ''),
          });
          return Promise.resolve([state.nextAliasId - 1]);
        },
      };
      return builder;
    }
    throw new Error(`Unexpected table: ${table}`);
  };
  db.fn = { now: () => new Date() };
  return db;
}

interface OperaState {
  arhead: Array<{
    ae_entry: string;
    ae_acnt: string;
    ae_desc: string;
    ae_nxtpost: string;
  }>;
  capturedSql: string[];
}

function makeOperaDb(
  state: OperaState,
  joinRows?: Array<Record<string, unknown>>,
): any {
  return {
    raw: (sql: string, params?: unknown[]) => {
      state.capturedSql.push(sql);
      // listRepeatEntries — joins arhead + arline
      if (sql.includes('JOIN arline')) {
        const bank = String((params ?? [])[0]);
        const matched = (joinRows ?? []).filter(
          (r) => String(r.ae_acnt ?? '').trim() === bank.trim(),
        );
        return Promise.resolve(matched);
      }
      if (sql.includes('FROM arhead')) {
        const entry = String((params ?? [])[0]);
        const bank = String((params ?? [])[1]);
        const found = state.arhead.find(
          (a) => a.ae_entry.trim() === entry && a.ae_acnt.trim() === bank,
        );
        return Promise.resolve(found ? [found] : []);
      }
      if (sql.includes('UPDATE arhead')) {
        const newDate = String((params ?? [])[0]);
        const entry = String((params ?? [])[1]);
        const bank = String((params ?? [])[2]);
        const found = state.arhead.find(
          (a) => a.ae_entry.trim() === entry && a.ae_acnt.trim() === bank,
        );
        if (found) {
          found.ae_nxtpost = newDate;
          return Promise.resolve({ rowCount: 1 });
        }
        return Promise.resolve({ rowCount: 0 });
      }
      return Promise.resolve([]);
    },
  };
}

describe('updateRepeatEntryDate - validation', () => {
  it('rejects bad bank_code', async () => {
    const result = await updateRepeatEntryDate(
      makeAppDb({ lockRows: [], aliases: [], nextLockId: 1, nextAliasId: 1 }),
      TEST_COMPANY,
      makeOperaDb({ arhead: [], capturedSql: [] }),
      {
        bankCode: "BC';--",
        entryRef: 'PR00000534',
        newDate: '2026-04-15',
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/bank_code/);
  });

  it('rejects bad entry_ref', async () => {
    const result = await updateRepeatEntryDate(
      makeAppDb({ lockRows: [], aliases: [], nextLockId: 1, nextAliasId: 1 }),
      TEST_COMPANY,
      makeOperaDb({ arhead: [], capturedSql: [] }),
      {
        bankCode: 'BC010',
        entryRef: "P';DROP",
        newDate: '2026-04-15',
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/entry/);
  });

  it('rejects bad date format', async () => {
    const result = await updateRepeatEntryDate(
      makeAppDb({ lockRows: [], aliases: [], nextLockId: 1, nextAliasId: 1 }),
      TEST_COMPANY,
      makeOperaDb({ arhead: [], capturedSql: [] }),
      {
        bankCode: 'BC010',
        entryRef: 'PR00000534',
        newDate: '15/04/2026',
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid date format/);
  });
});

describe('updateRepeatEntryDate - happy path', () => {
  it('updates ae_nxtpost on existing entry', async () => {
    const operaState: OperaState = {
      arhead: [
        {
          ae_entry: 'PR00000534',
          ae_acnt: 'BC010',
          ae_desc: 'Office Rent',
          ae_nxtpost: '2026-04-01',
        },
      ],
      capturedSql: [],
    };
    const result = await updateRepeatEntryDate(
      makeAppDb({ lockRows: [], aliases: [], nextLockId: 1, nextAliasId: 1 }),
      TEST_COMPANY,
      makeOperaDb(operaState),
      {
        bankCode: 'BC010',
        entryRef: 'PR00000534',
        newDate: '2026-04-15',
      },
    );
    expect(result.success).toBe(true);
    expect(result.entry_ref).toBe('PR00000534');
    expect(result.old_date).toBe('2026-04-01');
    expect(result.new_date).toBe('2026-04-15');
    expect(operaState.arhead[0]?.ae_nxtpost).toBe('2026-04-15');
    // Confirm ROWLOCK was used on the UPDATE
    const updateSql = operaState.capturedSql.find((s) =>
      s.includes('UPDATE arhead'),
    );
    expect(updateSql).toMatch(/UPDATE arhead WITH \(ROWLOCK\)/);
  });

  it('saves alias when statement_name supplied', async () => {
    const appState: AppMockState = {
      lockRows: [],
      aliases: [],
      nextLockId: 1,
      nextAliasId: 1,
    };
    const result = await updateRepeatEntryDate(
      makeAppDb(appState),
      TEST_COMPANY,
      makeOperaDb({
        arhead: [
          {
            ae_entry: 'PR00000534',
            ae_acnt: 'BC010',
            ae_desc: 'Rent',
            ae_nxtpost: '2026-04-01',
          },
        ],
        capturedSql: [],
      }),
      {
        bankCode: 'BC010',
        entryRef: 'PR00000534',
        newDate: '2026-04-15',
        statementName: 'OFFICE RENT PAY',
      },
    );
    expect(result.success).toBe(true);
    expect(result.alias_saved).toBe(true);
    expect(appState.aliases).toHaveLength(1);
    expect(appState.aliases[0]?.memo_pattern).toBe('OFFICE RENT PAY');
    expect(appState.aliases[0]?.opera_repeat_ref).toBe('PR00000534');
  });

  it('updates existing alias rather than duplicating', async () => {
    const appState: AppMockState = {
      lockRows: [],
      aliases: [
        {
          id: 99,
          bank_code: 'BC010',
          memo_pattern: 'OFFICE RENT',
          opera_repeat_ref: 'OLD_REF',
        },
      ],
      nextLockId: 1,
      nextAliasId: 100,
    };
    await updateRepeatEntryDate(
      makeAppDb(appState),
      TEST_COMPANY,
      makeOperaDb({
        arhead: [
          {
            ae_entry: 'PR00000534',
            ae_acnt: 'BC010',
            ae_desc: 'Rent',
            ae_nxtpost: '2026-04-01',
          },
        ],
        capturedSql: [],
      }),
      {
        bankCode: 'BC010',
        entryRef: 'PR00000534',
        newDate: '2026-04-15',
        statementName: 'OFFICE RENT',
      },
    );
    expect(appState.aliases).toHaveLength(1);
    expect(appState.aliases[0]?.opera_repeat_ref).toBe('PR00000534');
  });

  it('returns error when entry not found', async () => {
    const result = await updateRepeatEntryDate(
      makeAppDb({ lockRows: [], aliases: [], nextLockId: 1, nextAliasId: 1 }),
      TEST_COMPANY,
      makeOperaDb({ arhead: [], capturedSql: [] }),
      {
        bankCode: 'BC010',
        entryRef: 'PR99999999',
        newDate: '2026-04-15',
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });
});

describe('updateRepeatEntryDate - locking', () => {
  it('refuses when bank already locked', async () => {
    const result = await updateRepeatEntryDate(
      makeAppDb({
        lockRows: [
          {
            id: 1,
            company_code: TEST_COMPANY,
            bank_code: 'BC010',
            locked_at: new Date(),
            locked_by: 'other',
            endpoint: 'other',
            description: '',
          },
        ],
        aliases: [],
        nextLockId: 2,
        nextAliasId: 1,
      }),
      TEST_COMPANY,
      makeOperaDb({ arhead: [], capturedSql: [] }),
      {
        bankCode: 'BC010',
        entryRef: 'PR00000534',
        newDate: '2026-04-15',
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/being imported/);
  });
});

describe('listRepeatEntries', () => {
  it('returns rows with status, amount conversion + description fallback', async () => {
    const opera = makeOperaDb(
      { arhead: [], capturedSql: [] },
      [
        {
          ae_entry: 'PR00000534',
          ae_acnt: 'BC010',
          ae_desc: 'Office Rent',
          ae_nxtpost: '2026-04-15',
          ae_freq: 'M',
          ae_every: 1,
          ae_posted: 5,
          ae_topost: 12,
          at_value: 50000,
          at_account: 'NL_RENT',
          at_cbtype: 'NP',
          at_comment: 'fallback comment',
          status: 'Active',
        },
        {
          ae_entry: 'PR99999999',
          ae_acnt: 'BC010',
          ae_desc: '', // fallback to at_comment
          ae_nxtpost: null,
          ae_freq: 'A',
          ae_every: 1,
          ae_posted: 1,
          ae_topost: 1,
          at_value: 100000,
          at_account: 'NL_INS',
          at_cbtype: 'NP',
          at_comment: 'Insurance Premium',
          status: 'Completed',
        },
      ],
    );
    const result = await listRepeatEntries(opera, 'BC010');
    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    expect(result.repeat_entries[0]?.description).toBe('Office Rent');
    expect(result.repeat_entries[0]?.amount_pounds).toBe(500);
    expect(result.repeat_entries[1]?.description).toBe('Insurance Premium');
    expect(result.repeat_entries[1]?.status).toBe('Completed');
  });

  it('returns empty list with message when no entries', async () => {
    const opera = makeOperaDb(
      { arhead: [], capturedSql: [] },
      [],
    );
    const result = await listRepeatEntries(opera, 'BC010');
    expect(result.success).toBe(true);
    expect(result.count).toBe(0);
    expect(result.message).toMatch(/No repeat entries/);
  });

  it('rejects bad bank_code', async () => {
    const result = await listRepeatEntries(
      makeOperaDb({ arhead: [], capturedSql: [] }, []),
      "BC';--",
    );
    expect(result.success).toBe(false);
  });
});

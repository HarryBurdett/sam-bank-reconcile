/**
 * Tests for postOperaCashbookEntry — the unified core posting helper
 * that handles 1..N lines under one aentry header.
 *
 * Uses a real SQLite backing DB for the tables that the new function
 * writes directly (aentry, atran, anoml, nbank, nacnt), and a
 * transparent proxy trx that intercepts MSSQL-specific helper calls
 * (getNextId, getNextJournal, incrementAtypeEntry, getPeriodForDate,
 * loadNominalName, etc.) and returns canned responses.
 *
 * The decision.postToNominal = false path is the primary test vector
 * because it skips the ntran/nacnt balance update path, which relies
 * on updateNacntBalance (complex multi-table MSSQL writes that would
 * require a much larger schema to mock). The anoml pair IS written
 * regardless of postToNominal so we verify 2×N anoml rows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import knexLib, { type Knex } from 'knex';
import {
  postOperaCashbookEntry,
  type PostEntryArgs,
  type PreparedEntryHeader,
  type PreparedEntryLine,
} from '../src/services/import-posting-executor.js';

// ---------------------------------------------------------------------------
// SQLite schema — only the columns the new function writes or the verify
// helpers read.  MSSQL-only defaults (GETDATE, ISNULL) are absent; the
// proxy trx rewrites those expressions before forwarding to SQLite.
// ---------------------------------------------------------------------------
const SCHEMA = [
  // atype — needed by resolveCbtype & incrementAtypeEntry
  `CREATE TABLE IF NOT EXISTS atype (
    ay_cbtype TEXT, ay_desc TEXT, ay_type TEXT, ay_entry TEXT
  )`,
  // aentry — written by postOperaCashbookEntry + read by assertAentryAtran
  `CREATE TABLE IF NOT EXISTS aentry (
    id INTEGER, ae_acnt TEXT, ae_cntr TEXT, ae_cbtype TEXT, ae_entry TEXT,
    ae_reclnum INTEGER, ae_lstdate TEXT, ae_frstat INTEGER, ae_tostat INTEGER,
    ae_statln INTEGER, ae_entref TEXT, ae_value INTEGER, ae_recbal INTEGER,
    ae_remove INTEGER, ae_tmpstat INTEGER, ae_complet INTEGER,
    ae_postgrp INTEGER, sq_crdate TEXT, sq_crtime TEXT, sq_cruser TEXT,
    ae_comment TEXT, ae_payid INTEGER, ae_batchid INTEGER, ae_brwptr TEXT,
    datecreated TEXT, datemodified TEXT, state INTEGER
  )`,
  // atran — written per-line + read by assertAentryAtran
  `CREATE TABLE IF NOT EXISTS atran (
    id INTEGER, at_acnt TEXT, at_cntr TEXT, at_cbtype TEXT, at_entry TEXT,
    at_inputby TEXT, at_type INTEGER, at_pstdate TEXT, at_sysdate TEXT,
    at_tperiod INTEGER, at_value INTEGER, at_disc INTEGER, at_fcurr TEXT,
    at_fcexch REAL, at_fcmult INTEGER, at_fcdec INTEGER,
    at_account TEXT, at_name TEXT, at_comment TEXT, at_payee TEXT,
    at_payname TEXT, at_sort TEXT, at_number TEXT, at_remove INTEGER,
    at_chqprn INTEGER, at_chqlst INTEGER, at_bacprn INTEGER, at_ccdprn INTEGER,
    at_ccdno TEXT, at_payslp INTEGER, at_pysprn INTEGER, at_cash INTEGER,
    at_remit INTEGER, at_unique TEXT, at_postgrp INTEGER, at_ccauth TEXT,
    at_refer TEXT, at_srcco TEXT, at_ecb INTEGER, at_ecbtype TEXT,
    at_atpycd TEXT, at_bsref TEXT, at_bsname TEXT, at_vattycd TEXT,
    at_project TEXT, at_job TEXT, at_bic TEXT, at_iban TEXT, at_memo TEXT,
    datecreated TEXT, datemodified TEXT, state INTEGER
  )`,
  // anoml — written per-line (bank leg + target leg)
  `CREATE TABLE IF NOT EXISTS anoml (
    id INTEGER, ax_nacnt TEXT, ax_ncntr TEXT, ax_source TEXT, ax_date TEXT,
    ax_value REAL, ax_tref TEXT, ax_comment TEXT, ax_done TEXT, ax_fcurr TEXT,
    ax_fvalue REAL, ax_fcrate REAL, ax_fcmult INTEGER, ax_fcdec REAL,
    ax_srcco TEXT, ax_unique TEXT, ax_project TEXT, ax_job TEXT,
    ax_jrnl INTEGER, ax_nlpdate TEXT, datecreated TEXT, datemodified TEXT,
    state INTEGER
  )`,
  // nbank — read by updateNbankBalance (knex builder path), written back
  `CREATE TABLE IF NOT EXISTS nbank (
    nk_acnt TEXT, nk_curbal REAL, datemodified TEXT
  )`,
  // nacnt — read by loadNominalName + getNacntType
  `CREATE TABLE IF NOT EXISTS nacnt (
    na_acnt TEXT, na_type TEXT, na_subt TEXT, na_desc TEXT
  )`,
  // ztax — read by getVatRateForCode
  `CREATE TABLE IF NOT EXISTS ztax (
    tx_code TEXT, tx_trantyp TEXT, tx_ctrytyp TEXT,
    tx_rate1 REAL, tx_rate2 REAL, tx_rate2dy TEXT, tx_nominal TEXT
  )`,
];

// ---------------------------------------------------------------------------
// Counter state used by the proxy trx to hand out incrementing IDs.
// ---------------------------------------------------------------------------
interface ProxyState {
  nextIds: Record<string, number>;
  nextJournal: number;
  atypeEntry: Record<string, number>; // cbtype → next entry seq number
}

function makeProxyState(): ProxyState {
  return {
    nextIds: { aentry: 100, atran: 200, anoml: 300, ntran: 400, stran: 500, ptran: 600, njmemo: 700, nhist: 800, nvat: 900 },
    nextJournal: 1000,
    atypeEntry: { NP: 0, NR: 0, R1: 0, P1: 0 },
  };
}

// ---------------------------------------------------------------------------
// Build the SQLite test DB and a proxy trx that intercepts MSSQL helpers.
// ---------------------------------------------------------------------------
async function makeTestDb(): Promise<{ db: Knex; state: ProxyState }> {
  const db = knexLib({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  for (const s of SCHEMA) await db.raw(s);
  const state = makeProxyState();
  return { db, state };
}

/**
 * Build a proxy `trx` that:
 * 1. Intercepts MSSQL-specific raw queries (UPDLOCK, ROWLOCK, TOP 1,
 *    GETDATE, ISNULL, NOLOCK) and returns canned responses.
 * 2. Rewrites MSSQL function calls in INSERT statements before passing
 *    them to SQLite (GETDATE() → datetime('now'), ISNULL → COALESCE).
 * 3. Passes all other raw queries to the real SQLite db after stripping
 *    MSSQL query hints.
 * 4. Passes knex-builder calls (trx('table')) directly to SQLite.
 */
function makeProxyTrx(db: Knex, state: ProxyState): Knex {
  // Detect whether a raw() call is a SQL fragment builder (e.g. `ISNULL(col,0)+?`)
  // vs a full statement (SELECT/INSERT/UPDATE/DELETE).  Fragment builder calls
  // should be forwarded to the real db.raw so they produce a knex Raw object
  // usable in .update({col: trx.raw(...)}).
  const isFragmentExpr = (sql: string): boolean => {
    const first = sql.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
    return !['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'WITH'].includes(first);
  };

  // Raw query interceptor
  const rawProxy = (sql: string, params: unknown[] = []): unknown => {
    // Fragment expressions (used as values in .update()) → forward to db.raw
    // so knex treats them as embedded SQL fragments, not as full queries.
    if (isFragmentExpr(sql)) {
      // Rewrite MSSQL functions to SQLite equivalents before passing to real db.
      const cleanSql = sql
        .replace(/\bISNULL\(([^,]+),\s*0\)\s*\+\s*\?/gi, 'COALESCE($1, 0) + ?')
        .replace(/\bISNULL\(([^,]+),\s*([^)]+)\)/gi, 'COALESCE($1, $2)')
        .replace(/\bGETDATE\(\)/gi, "datetime('now')");
      return db.raw(cleanSql, params);
    }

    // Full SQL statements: run async interceptor logic.
    return rawProxyAsync(sql, params);
  };

  const rawProxyAsync = async (sql: string, params: unknown[] = []): Promise<unknown> => {
    const lower = sql.toLowerCase().trim();

    // --- getNextJournal: SELECT np_nexjrnl FROM nparm ---
    if (lower.includes('select np_nexjrnl from nparm') ||
        lower.includes('np_nexjrnl')) {
      if (lower.startsWith('update')) {
        return { rowCount: 1 };
      }
      const j = state.nextJournal;
      // nparm SELECT returns an array; UPDATE is a no-op
      return [{ np_nexjrnl: j }];
    }

    // --- getNextId: SELECT nextid FROM nextid ---
    if (lower.includes('from nextid')) {
      if (lower.startsWith('update')) {
        return { rowCount: 1 };
      }
      const tableName = ((params?.[0] ?? '') as string).toString().trim();
      const id = state.nextIds[tableName] ?? 1;
      // Allocate as many as needed by the count in the UPDATE (not tracked
      // here; instead we just hand out incrementing IDs on each SELECT call).
      state.nextIds[tableName] = id + 1;
      return [{ nextid: id }];
    }

    // --- incrementAtypeEntry: SELECT ay_entry FROM atype WITH (UPDLOCK) ---
    if (lower.includes('select ay_entry from atype')) {
      const cbtypeParam = ((params?.[0] ?? '') as string).toString().trim();
      const seq = state.atypeEntry[cbtypeParam] ?? 0;
      const padded = seq.toString().padStart(8, '0');
      return [{ ay_entry: `${cbtypeParam}${padded}` }];
    }

    // --- UPDATE atype SET ay_entry ---
    if (lower.startsWith('update atype')) {
      const cbtypeParam = ((params?.[1] ?? '') as string).toString().trim();
      const newEntry = ((params?.[0] ?? '') as string).toString().trim();
      const prefixLen = cbtypeParam.length;
      const newSeq = parseInt(newEntry.slice(prefixLen), 10);
      if (!isNaN(newSeq)) state.atypeEntry[cbtypeParam] = newSeq - 1;
      return { rowCount: 1 };
    }

    // --- incrementAtypeEntry: SELECT 1 AS x FROM aentry (duplicate check) ---
    if (lower.includes('select 1 as x from aentry')) {
      return []; // no duplicates
    }

    // --- resolveCbtype: SELECT TOP 1 ... FROM atype ---
    if (lower.includes('from atype')) {
      // Find the cbtype param
      const code = ((params?.[0] ?? '') as string).toString().trim();
      const ayType = ((params?.[1] ?? params?.[0] ?? '') as string).toString().trim();
      // Return a minimal row
      const desc = code === 'NP' ? 'Nominal Payment' : code === 'NR' ? 'Nominal Receipt' : code;
      return [{ ay_cbtype: code || 'NP', ay_desc: desc }];
    }

    // --- getPeriodForDate: SELECT TOP 1 ncd_period ... ---
    if (lower.includes('ncd_period') || lower.includes('from nclndd')) {
      return [{ ncd_period: 5, ncd_year: 2026 }];
    }

    // --- loadNominalName: SELECT TOP 1 RTRIM(ISNULL(na_desc ...)) FROM nacnt ---
    if (lower.includes('na_desc') && lower.includes('from nacnt')) {
      // Forward to SQLite with MSSQL hints stripped
      const cleanSql = sql
        .replace(/\bTOP\s+1\b/gi, '')
        .replace(/\bRTRIM\(ISNULL\(([^,]+),\s*'[^']*'\)\)/gi, 'COALESCE(TRIM($1), \'\')')
        .replace(/\bRTRIM\(([^)]+)\)/gi, 'TRIM($1)')
        .replace(/\bWITH\s*\(NOLOCK\)/gi, '')
        .replace(/\bWITH\s*\(ROWLOCK\)/gi, '')
        .replace(/\bWITH\s*\(UPDLOCK,\s*ROWLOCK\)/gi, '');
      try {
        return await db.raw(cleanSql, params);
      } catch {
        return [];
      }
    }

    // --- getNacntType: SELECT na_type, na_subt FROM nacnt ---
    if (lower.includes('na_type') && lower.includes('from nacnt')) {
      const cleanSql = sql
        .replace(/\bRTRIM\(([^)]+)\)/gi, 'TRIM($1)')
        .replace(/\bWITH\s*\(NOLOCK\)/gi, '')
        .replace(/\bWITH\s*\(ROWLOCK\)/gi, '');
      try {
        return await db.raw(cleanSql, params);
      } catch {
        return [];
      }
    }

    // --- insertNjmemo: SELECT nextid for njmemo + INSERT INTO njmemo ---
    if (lower.includes('from njmemo') || lower.includes('into njmemo')) {
      if (lower.startsWith('insert')) {
        return { rowCount: 1 }; // silently skip njmemo inserts
      }
      return [];
    }

    // --- assertAentryAtran SELECT (the inner-trx verify) ---
    if (lower.includes('from aentry a') || lower.includes('join atran t')) {
      // Let this through to SQLite (aentry + atran are real tables)
      const cleanSql = sql
        .replace(/\bRTRIM\(([^)]+)\)/gi, 'TRIM($1)')
        .replace(/\bWITH\s*\(NOLOCK\)/gi, '')
        .replace(/\bWITH\s*\(ROWLOCK\)/gi, '');
      return await db.raw(cleanSql, params);
    }

    // --- assertBalancedPair: SELECT COUNT(*), SUM FROM anoml/ntran ---
    if ((lower.includes('count(*) as cnt') || lower.includes('sum(')) &&
        (lower.includes('from anoml') || lower.includes('from ntran'))) {
      const cleanSql = sql
        .replace(/\bWITH\s*\(NOLOCK\)/gi, '')
        .replace(/\bWITH\s*\(ROWLOCK\)/gi, '');
      return await db.raw(cleanSql, params);
    }

    // --- All INSERT statements: strip MSSQL hints, pass to SQLite ---
    if (lower.startsWith('insert into')) {
      // Strip hints only — column lists are unchanged
      const cleanSql = sql
        .replace(/\bWITH\s*\(NOLOCK\)/gi, '')
        .replace(/\bWITH\s*\(ROWLOCK\)/gi, '')
        .replace(/\bWITH\s*\(UPDLOCK,\s*ROWLOCK\)/gi, '');
      return await db.raw(cleanSql, params);
    }

    // --- UPDATE nbank (via raw if called directly) ---
    if (lower.startsWith('update nbank')) {
      const cleanSql = sql
        .replace(/\bWITH\s*\(ROWLOCK\)/gi, '')
        .replace(/\bISNULL\(([^,]+),\s*0\)\s*\+\s*\?/gi, 'COALESCE($1, 0) + ?')
        .replace(/\bGETDATE\(\)/gi, "datetime('now')");
      return await db.raw(cleanSql, params);
    }

    // --- Generic fallback: strip hints and forward ---
    const cleanSql = sql
      .replace(/\bTOP\s+\d+\b/gi, '')
      .replace(/\bWITH\s*\(NOLOCK\)/gi, '')
      .replace(/\bWITH\s*\(ROWLOCK\)/gi, '')
      .replace(/\bWITH\s*\(UPDLOCK,\s*ROWLOCK\)/gi, '')
      .replace(/\bISNULL\(/gi, 'COALESCE(')
      .replace(/\bGETDATE\(\)/gi, "datetime('now')");
    try {
      return await db.raw(cleanSql, params);
    } catch {
      return [];
    }
  };

  // Build a proxy that wraps db but overrides raw() and also re-routes
  // knex-builder calls (trx('table')) so they hit the real SQLite db.
  // updateNbankBalance uses knex-builder: trx('nbank').whereRaw(...).update({..GETDATE..})
  // We need to intercept the .update() call to rewrite GETDATE.
  const makeTableProxy = (table: string) => {
    // Build a chainable proxy that eventually forwards to db(table)
    const dbTable = db(table);
    const handler: ProxyHandler<Knex.QueryBuilder> = {
      get(target, prop) {
        if (prop === 'update') {
          return (obj: Record<string, unknown>) => {
            // Rewrite MSSQL raw expressions in the update object
            const cleaned: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(obj)) {
              if (v && typeof v === 'object' && 'toSQL' in (v as object)) {
                // It's a Knex raw expression — rewrite its SQL
                const raw = v as { toSQL: () => { sql: string; bindings: unknown[] } };
                const s = raw.toSQL();
                const newSql = s.sql
                  .replace(/\bISNULL\(([^,]+),\s*0\)\s*\+\s*\?/gi, 'COALESCE($1, 0) + ?')
                  .replace(/\bGETDATE\(\)/gi, "datetime('now')");
                cleaned[k] = db.raw(newSql, s.bindings);
              } else {
                cleaned[k] = v;
              }
            }
            return (target as Knex.QueryBuilder).update(cleaned);
          };
        }
        const val = (target as unknown as Record<string | symbol, unknown>)[prop];
        if (typeof val === 'function') {
          return (...args: unknown[]) => {
            const result = (val as Function).call(target, ...args);
            // Return proxy for chained calls
            if (result && typeof result === 'object' && 'then' in result) {
              return result; // Promise — let it resolve
            }
            return new Proxy(result, handler);
          };
        }
        return val;
      },
    };
    return new Proxy(dbTable, handler);
  };

  // Build the final proxy object
  const proxy: Knex = new Proxy(db, {
    apply(_target, _thisArg, args) {
      const table = args[0] as string;
      return makeTableProxy(table);
    },
    get(target, prop) {
      if (prop === 'raw') return rawProxy;
      if (prop === 'transaction') return target.transaction.bind(target);
      const val = (target as unknown as Record<string | symbol, unknown>)[prop];
      if (typeof val === 'function') {
        return val.bind(target);
      }
      return val;
    },
  }) as unknown as Knex;

  // Make the proxy callable as a function (trx('tableName'))
  const callableProxy = new Proxy(
    Object.assign(function ProxyTrx(table: string) {
      return makeTableProxy(table);
    }, proxy),
    {
      get(_target, prop) {
        if (prop === 'raw') return rawProxy;
        if (prop === 'transaction') return db.transaction.bind(db);
        const val = (db as unknown as Record<string | symbol, unknown>)[prop];
        if (typeof val === 'function') {
          return val.bind(db);
        }
        return val;
      },
    },
  ) as unknown as Knex;

  return callableProxy;
}

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

function makeDecision(postToNominal = false) {
  return {
    canPost: true,
    postToNominal,
    postToTransferFile: true,
    transferFileDoneFlag: ' ' as const,
  };
}

/**
 * Seed a VAT rate row into ztax so getVatRateForCode returns the expected rate.
 * tx_ctrytyp must be 'H' (home country) to match the WHERE clause.
 */
async function seedVatRate(
  db: Knex,
  code: string,
  trantyp: string,
  rate: number,
  nominal: string,
): Promise<void> {
  await db('ztax').insert({
    tx_code: code,
    tx_trantyp: trantyp,
    tx_ctrytyp: 'H',
    tx_rate1: rate,
    tx_rate2: null,
    tx_rate2dy: null,
    tx_nominal: nominal,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('postOperaCashbookEntry', () => {
  it('exports a callable function', () => {
    expect(typeof postOperaCashbookEntry).toBe('function');
  });
});

describe('postOperaCashbookEntry multi-line shape', () => {
  let db: Knex;
  let state: ProxyState;
  let trx: Knex;

  beforeEach(async () => {
    ({ db, state } = await makeTestDb());
    trx = makeProxyTrx(db, state);

    // Seed nacnt for bank + nominal accounts
    await db('nacnt').insert([
      { na_acnt: 'BB005', na_type: 'B ', na_subt: 'BC', na_desc: 'Bank' },
      { na_acnt: 'N100', na_type: 'P ', na_subt: 'PE', na_desc: 'Postage' },
      { na_acnt: 'N200', na_type: 'P ', na_subt: 'PE', na_desc: 'Stationery' },
    ]);

    // Seed nbank
    await db('nbank').insert({ nk_acnt: 'BB005', nk_curbal: 100000 }); // 1000.00 in pence
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('writes one aentry + 2 atran rows for a 2-line nominal payment', async () => {
    const header: PreparedEntryHeader = {
      date: '2026-05-15',
      action: 'nominal_payment',
      cbtype: 'NP',
      reference: 'REC0000020',
      comment: 'Multi-line journal',
      inputBy: 'RECUR',
      memo: 'Multi-line journal',
      name: 'Multi-line journal',
    };
    const lines: PreparedEntryLine[] = [
      {
        atAccount: 'N100',
        absPence: 10000, // £100
        vatCode: null,
        vatPence: 0,
        reference: 'REF1',
        comment: 'Postage',
        project: '',
        department: '',
        netOverride: null,
      },
      {
        atAccount: 'N200',
        absPence: 25000, // £250
        vatCode: null,
        vatPence: 0,
        reference: 'REF2',
        comment: 'Stationery',
        project: '',
        department: '',
        netOverride: null,
      },
    ];

    const args: PostEntryArgs = {
      trx,
      bankCode: 'BB005',
      header,
      lines,
      defaults: { sl_control: 'B0010', pl_control: 'B0020' },
      decision: makeDecision(false),
    };

    const result = await postOperaCashbookEntry(args);

    expect(result.entry_number).toBeTruthy();
    expect(result.fingerprint).toBeTruthy();

    // 1. aentry: one row, ae_value = -(10000 + 25000) = -35000 pence
    const aentryRows = await db('aentry')
      .where({ ae_acnt: 'BB005' })
      .select('ae_entry', 'ae_value', 'ae_cbtype');
    expect(aentryRows).toHaveLength(1);
    expect(aentryRows[0]!.ae_value).toBe(-35000);
    expect(aentryRows[0]!.ae_entry).toBe(result.entry_number);

    // 2. atran: 2 rows with per-line at_values (negative for payment)
    const atranRows = await db('atran')
      .where({ at_acnt: 'BB005' })
      .orderBy('id', 'asc')
      .select('at_value', 'at_account', 'at_type', 'at_pstdate', 'at_refer');
    expect(atranRows).toHaveLength(2);
    expect(atranRows[0]!.at_value).toBe(-10000);
    expect(atranRows[0]!.at_account).toBe('N100');
    expect(atranRows[0]!.at_type).toBe(1); // nominal_payment at_type=1
    expect(atranRows[0]!.at_pstdate).toBe('2026-05-15');
    expect(atranRows[1]!.at_value).toBe(-25000);
    expect(atranRows[1]!.at_account).toBe('N200');

    // 3. anoml: 2 rows per line = 4 rows total (bank leg + target leg per line)
    const anomlRows = await db('anoml').select('ax_nacnt', 'ax_value', 'ax_source');
    expect(anomlRows).toHaveLength(4);
    // All should have ax_source = 'A' (nominal)
    for (const r of anomlRows) {
      expect(r.ax_source).toBe('A');
    }

    // 4. nbank: balance decremented by £350 = 35000 pence
    const bank = await db('nbank').where({ nk_acnt: 'BB005' }).first();
    expect(bank?.nk_curbal).toBeCloseTo(100000 - 35000, 0);
  });

  it('writes correct at_type for nominal_receipt (at_type=2)', async () => {
    const header: PreparedEntryHeader = {
      date: '2026-05-15',
      action: 'nominal_receipt',
      cbtype: 'NR',
      reference: 'REC0000021',
      comment: 'Multi-line receipt',
      inputBy: 'RECUR',
      memo: 'Multi-line receipt',
      name: 'Multi-line receipt',
    };
    const lines: PreparedEntryLine[] = [
      {
        atAccount: 'N100',
        absPence: 5000,
        vatCode: null,
        vatPence: 0,
        reference: 'REF1',
        comment: 'Line 1',
        project: '',
        department: '',
        netOverride: null,
      },
      {
        atAccount: 'N200',
        absPence: 5000,
        vatCode: null,
        vatPence: 0,
        reference: 'REF2',
        comment: 'Line 2',
        project: '',
        department: '',
        netOverride: null,
      },
    ];

    state.atypeEntry['NR'] = 0;
    const args: PostEntryArgs = {
      trx,
      bankCode: 'BB005',
      header,
      lines,
      defaults: { sl_control: 'B0010', pl_control: 'B0020' },
      decision: makeDecision(false),
    };
    const result = await postOperaCashbookEntry(args);

    const aentry = await db('aentry').where({ ae_entry: result.entry_number }).first();
    expect(aentry?.ae_value).toBe(10000); // positive for receipt

    const atranRows = await db('atran').where({ at_acnt: 'BB005' }).orderBy('id');
    expect(atranRows).toHaveLength(2);
    expect(atranRows[0]!.at_value).toBe(5000);
    expect(atranRows[0]!.at_type).toBe(2); // nominal_receipt at_type=2
    expect(atranRows[1]!.at_value).toBe(5000);
  });

  it('rejects if lines array is empty', async () => {
    const header: PreparedEntryHeader = {
      date: '2026-05-15',
      action: 'nominal_payment',
      cbtype: 'NP',
      reference: null,
      comment: '',
      inputBy: 'RECUR',
      memo: '',
      name: '',
    };
    const args: PostEntryArgs = {
      trx,
      bankCode: 'BB005',
      header,
      lines: [],
      defaults: { sl_control: 'B0010', pl_control: 'B0020' },
      decision: makeDecision(false),
    };
    await expect(postOperaCashbookEntry(args)).rejects.toThrow('lines array must have');
  });

  it('writes one aentry + 3 atran for a 2-line nominal entry where line 1 has VAT', async () => {
    // line 1: £100 gross (£83.33 net + £16.67 VAT at 20%) — 2 atran rows
    // line 2: £250, no VAT — 1 atran row
    // total atran: 3 rows; ae_value = -35000 (payment)
    await seedVatRate(db, '1', 'P', 20, 'V100');
    // Seed VAT nominal account so loadNominalName doesn't fail
    await db('nacnt').insert({ na_acnt: 'V100', na_type: 'P ', na_subt: 'PV', na_desc: 'VAT' });

    const header: PreparedEntryHeader = {
      date: '2026-05-15',
      action: 'nominal_payment',
      cbtype: 'NP',
      reference: 'REC0000099',
      comment: 'VAT mixed test',
      inputBy: 'RECUR',
      memo: 'VAT mixed test',
      name: 'VAT mixed test',
    };
    const lines: PreparedEntryLine[] = [
      {
        atAccount: 'N100',
        absPence: 10000, // £100 gross; VAT = round(100*20/120*100)/100 = £16.67 → 1667 pence
        vatCode: '1',
        vatPence: 1667,
        reference: 'REF1',
        comment: 'Postage',
        project: '',
        department: '',
        netOverride: null,
      },
      {
        atAccount: 'N200',
        absPence: 25000, // £250, no VAT
        vatCode: null,
        vatPence: 0,
        reference: 'REF2',
        comment: 'Stationery',
        project: '',
        department: '',
        netOverride: null,
      },
    ];

    const args: PostEntryArgs = {
      trx,
      bankCode: 'BB005',
      header,
      lines,
      defaults: { sl_control: 'B0010', pl_control: 'B0020' },
      decision: makeDecision(false),
    };

    const result = await postOperaCashbookEntry(args);
    expect(result.entry_number).toBeTruthy();

    // aentry: one row, ae_value = -35000
    const aentry = await db('aentry')
      .where({ ae_entry: result.entry_number, ae_acnt: 'BB005' })
      .first();
    expect(aentry?.ae_value).toBe(-35000);

    // atran: 3 rows (line 1 net + VAT split = 2; line 2 = 1)
    const atrans = await db('atran')
      .where({ at_acnt: 'BB005' })
      .orderBy('id', 'asc');
    expect(atrans).toHaveLength(3);

    // Sum of at_value across all 3 rows must equal ae_value
    const atranSum = atrans.reduce((acc: number, r: { at_value: number }) => acc + Number(r.at_value), 0);
    expect(atranSum).toBe(-35000);

    // anoml: (2 lines × 2 legs) + 1 extra for VAT leg = 5 anoml rows
    const anomlRows = await db('anoml').select('ax_nacnt', 'ax_value');
    expect(anomlRows).toHaveLength(5);
  });

  it('single-line nominal_payment still works (delegation to full path)', async () => {
    const header: PreparedEntryHeader = {
      date: '2026-05-15',
      action: 'nominal_payment',
      cbtype: 'NP',
      reference: 'SINGLE001',
      comment: 'Single line',
      inputBy: 'RECUR',
      memo: 'Single line',
      name: 'Single line',
    };
    const lines: PreparedEntryLine[] = [
      {
        atAccount: 'N100',
        absPence: 7500,
        vatCode: null,
        vatPence: 0,
        reference: 'SINGLE001',
        comment: 'Single line',
        project: '',
        department: '',
        netOverride: null,
      },
    ];

    const args: PostEntryArgs = {
      trx,
      bankCode: 'BB005',
      header,
      lines,
      defaults: { sl_control: 'B0010', pl_control: 'B0020' },
      decision: makeDecision(false),
    };

    const result = await postOperaCashbookEntry(args);
    expect(result.entry_number).toBeTruthy();

    const aentry = await db('aentry').where({ ae_entry: result.entry_number }).first();
    expect(aentry?.ae_value).toBe(-7500);

    const atranRows = await db('atran').where({ at_acnt: 'BB005' });
    expect(atranRows).toHaveLength(1);
    expect(atranRows[0]!.at_value).toBe(-7500);
  });
});

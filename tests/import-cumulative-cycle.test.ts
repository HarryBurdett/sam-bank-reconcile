import { describe, it, expect, vi } from 'vitest';
import knexLib, { type Knex } from 'knex';
import {
  importBankStatementFromPdf,
  type PdfExtractor,
  type ImportPostingExecutor,
  type ImportLockAdapter,
  type PeriodOverlapChecker,
  type PdfExtractionResult,
} from '../src/services/import-from-pdf.js';

const TEST_COMPANY = 'C';

const IMPORTS_SCHEMA = `CREATE TABLE bank_statement_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_code TEXT,
  bank_code TEXT NOT NULL,
  statement_date DATE,
  period_start DATE,
  period_end DATE,
  closing_balance REAL,
  opening_balance REAL,
  source TEXT,
  source_ref TEXT,
  filename TEXT,
  is_reconciled INTEGER DEFAULT 0,
  reconciled_count INTEGER DEFAULT 0,
  reconciled_at TEXT,
  reconciled_by TEXT,
  imported_at TEXT,
  imported_by TEXT,
  target_system TEXT,
  transactions_imported INTEGER DEFAULT 0,
  records_imported INTEGER DEFAULT 0,
  total_receipts REAL DEFAULT 0,
  total_payments REAL DEFAULT 0,
  account_number TEXT,
  sort_code TEXT,
  import_status TEXT
)`;
const TXNS_SCHEMA = `CREATE TABLE bank_statement_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_code TEXT,
  import_id INTEGER NOT NULL,
  line_number INTEGER NOT NULL,
  post_date TEXT NOT NULL,
  description TEXT,
  amount REAL NOT NULL,
  balance REAL,
  transaction_type TEXT,
  reference TEXT,
  is_reconciled INTEGER DEFAULT 0,
  posted_entry_number TEXT,
  posted_at TEXT
)`;

async function makeAppDb(): Promise<Knex> {
  const db = knexLib({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  await db.raw(IMPORTS_SCHEMA);
  await db.raw(TXNS_SCHEMA);
  return db;
}

function makeOperaDb(): any {
  const db: any = (table: string) => {
    if (table !== 'nbank') throw new Error(`unexpected: ${table}`);
    const chain: any = {
      whereRaw: () => chain,
      select: () => chain,
      first: async () => ({ nk_acnt: 'BC010' }),
    };
    return chain;
  };
  db.raw = () => Promise.resolve([]);
  return db;
}

const SAMPLE_EXTRACTION: PdfExtractionResult = {
  bank_name: 'Monzo', account_number: '12345678', sort_code: '04-00-04',
  statement_date: '2026-05-22', period_start: '2026-05-01',
  period_end: '2026-05-22', opening_balance: 125912.72,
  closing_balance: 75000,
  transactions: [
    { date: '2026-05-22', name: 'Test', memo: 'Test', amount: -100,
      type: 'debit', balance: 75000 },
  ],
};

describe('cumulative-cycle import — reconciled-cycle refusal', () => {
  it('refuses a re-import when a reconciled cycle row exists', async () => {
    const appDb = await makeAppDb();
    // Pre-existing reconciled row for the same cycle.
    await appDb('bank_statement_imports').insert({
      company_code: TEST_COMPANY, bank_code: 'BC010',
      period_start: '2026-05-01',
      period_end: '2026-05-15',
      closing_balance: 90000,
      is_reconciled: 1,
      filename: 'May 1-15.pdf',
    });

    const extractor: PdfExtractor = {
      extractFromPdf: vi.fn().mockResolvedValue(SAMPLE_EXTRACTION),
    };
    const executor: ImportPostingExecutor = {
      postBankImport: vi.fn().mockResolvedValue({
        success: true, records_imported: 0, records_failed: 0,
        skipped_count: 0, errors: [], warnings: [],
      }),
    };
    const lock: ImportLockAdapter = {
      acquire: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const overlap: PeriodOverlapChecker = {
      checkOverlap: vi.fn().mockResolvedValue({
        overlapError: null, resumeImportId: null,
      }),
    };

    const result = await importBankStatementFromPdf(
      makeOperaDb(),
      appDb,
      {
        filePath: '/tmp/May 1-22.pdf',
        bankCode: 'BC010', companyCode: TEST_COMPANY,
        filename: 'May 1-22.pdf',
      },
      extractor, executor, lock, overlap,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cycle is already reconciled/i);
    expect(result.error).toMatch(/2026-05-01/);
    // Critically: the executor must NOT have been called — we
    // bailed out before reaching the posting step.
    expect(executor.postBankImport).not.toHaveBeenCalled();
  });

  it('preserves reconciled rows across cycle-merge with newest-first extraction order', async () => {
    const appDb = await makeAppDb();
    const [firstId] = await appDb('bank_statement_imports').insert({
      company_code: TEST_COMPANY, bank_code: 'BC010', period_start:'2026-05-01', period_end: '2026-05-08',
      opening_balance: 125912.72, closing_balance: 100000,
      is_reconciled: 0, filename: 'May 1-8.pdf', source: 'email',
      target_system: 'opera_se',
      records_imported: 12, transactions_imported: 12,
      total_receipts: 0, total_payments: 120,
    }).returning('id');
    const firstImportId = typeof firstId === 'number' ? firstId : (firstId as { id: number }).id;

    // Pre-existing pull-1 lines, with line_numbers 1-12 in extraction order.
    // Lines 1-8 are reconciled with posted_entry_number stamped (Monzo
    // "reconciled" through Opera).
    for (let i = 1; i <= 12; i++) {
      await appDb('bank_statement_transactions').insert({
        company_code: TEST_COMPANY,
        import_id: firstImportId,
        line_number: i,
        post_date: `2026-05-${String(i).padStart(2, '0')}`,
        description: `Line ${i}`,
        amount: -10,
        is_reconciled: i <= 8 ? 1 : 0,
        posted_entry_number: i <= 8 ? `STAMP-${i}` : null,
        posted_at: i <= 8 ? '2026-05-08T12:00:00' : null,
      });
    }

    // Pull-2 (May 1-22) extracted in NEWEST-FIRST order (Monzo's natural
    // ordering): 4 new lines (May 19, 18, 17, 16) at positions 1-4, then
    // 12 dup lines (May 12 .. May 1) at positions 5-16.
    const extraction: PdfExtractionResult = {
      bank_name: 'Monzo', account_number: '12345678', sort_code: '04-00-04',
      statement_date: '2026-05-22',
      period_start: '2026-05-01', period_end: '2026-05-22',
      opening_balance: 125912.72, closing_balance: 75000,
      transactions: [
        ...Array.from({ length: 4 }, (_, i) => ({
          date: `2026-05-${19 - i}`, name: `New ${i + 1}`, memo: `New ${i + 1}`,
          amount: -20, type: 'debit', balance: 75000,
        })),
        ...Array.from({ length: 12 }, (_, i) => ({
          date: `2026-05-${String(12 - i).padStart(2, '0')}`,
          name: `Line ${12 - i}`, memo: `Line ${12 - i}`,
          amount: -10, type: 'debit', balance: 100000,
        })),
      ],
    };

    const extractor: PdfExtractor = {
      extractFromPdf: vi.fn().mockResolvedValue(extraction),
    };
    const executor: ImportPostingExecutor = {
      postBankImport: vi.fn().mockResolvedValue({
        success: true, records_imported: 4, records_failed: 0,
        skipped_count: 12, errors: [], warnings: [], posted_lines: [],
      }),
    };
    const lock: ImportLockAdapter = {
      acquire: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const overlap: PeriodOverlapChecker = {
      checkOverlap: vi.fn().mockResolvedValue({ overlapError: null, resumeImportId: null }),
    };

    const result = await importBankStatementFromPdf(
      makeOperaDb(), appDb,
      { filePath: '/tmp/May 1-22.pdf', bankCode: 'BC010', companyCode: TEST_COMPANY, filename: 'May 1-22.pdf' },
      extractor, executor, lock, overlap,
    );
    expect(result.success).toBe(true);

    // Critical: the 8 previously-reconciled rows (now at positions 8-16,
    // since extraction is newest-first) must STILL have their
    // posted_entry_number and is_reconciled preserved.
    const reconciledNow = await appDb('bank_statement_transactions')
      .where({ import_id: firstImportId })
      .andWhere('is_reconciled', 1)
      .select('description', 'posted_entry_number');
    expect(reconciledNow).toHaveLength(8);
    for (const r of reconciledNow) {
      // The reconciled rows should be the original "Line 1" .. "Line 8"
      // (now stored at new line_number positions due to reorder).
      const m = (r.description as string).match(/^Line (\d+)$/);
      expect(m).not.toBeNull();
      const n = Number(m![1]);
      expect(n).toBeLessThanOrEqual(8);
      expect(r.posted_entry_number).toBe(`STAMP-${n}`);
    }
  });

  it('accumulates running totals on cycle-merge UPDATE', async () => {
    const appDb = await makeAppDb();
    await appDb('bank_statement_imports').insert({
      company_code: TEST_COMPANY, bank_code: 'BC010', period_start: '2026-05-01', period_end: '2026-05-08',
      opening_balance: 125912.72, closing_balance: 100000,
      is_reconciled: 0, filename: 'May 1-8.pdf', source: 'email',
      target_system: 'opera_se',
      records_imported: 5, transactions_imported: 5,
      total_receipts: 200.50, total_payments: 100.00,
    });
    const extraction: PdfExtractionResult = {
      bank_name: 'Monzo', account_number: '1', sort_code: '04-00-04',
      statement_date: '2026-05-22',
      period_start: '2026-05-01', period_end: '2026-05-22',
      opening_balance: 125912.72, closing_balance: 75000,
      transactions: [{
        date: '2026-05-22', name: 'New', memo: 'New',
        amount: -50, type: 'debit', balance: 75000,
      }],
    };
    const extractor: PdfExtractor = {
      extractFromPdf: vi.fn().mockResolvedValue(extraction),
    };
    const executor: ImportPostingExecutor = {
      postBankImport: vi.fn().mockResolvedValue({
        success: true, records_imported: 3, records_failed: 0,
        skipped_count: 0, errors: [], warnings: [], posted_lines: [],
      }),
    };
    const lock: ImportLockAdapter = {
      acquire: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const overlap: PeriodOverlapChecker = {
      checkOverlap: vi.fn().mockResolvedValue({ overlapError: null, resumeImportId: null }),
    };

    const result = await importBankStatementFromPdf(
      makeOperaDb(), appDb,
      { filePath: '/tmp/X.pdf', bankCode: 'BC010', companyCode: TEST_COMPANY, filename: 'X.pdf' },
      extractor, executor, lock, overlap,
    );
    expect(result.success).toBe(true);

    // Note: totalReceipts/totalPayments are computed inside
    // importBankStatementFromPdf from result.posted_lines, which is
    // empty in this mock, so the test asserts only that pre-existing
    // values are PRESERVED (prev + 0 = prev), not the addition.
    // The accumulation logic (prev + new) is the relevant assertion —
    // records_imported should be 5 + 3 = 8.
    const row = await appDb('bank_statement_imports')
      .where({ bank_code: 'BC010', period_start: '2026-05-01' })
      .first();
    expect(row?.records_imported).toBe(5 + 3); // 8
    expect(row?.transactions_imported).toBe(5 + 3); // 8
    // total_receipts/total_payments: prev was 200.50 / 100.00, new is 0/0
    // (empty posted_lines), so preserved at the original values.
    expect(row?.total_receipts).toBe(200.50);
    expect(row?.total_payments).toBe(100.00);
  });

  it('refuses a shorter pull when a longer one is already imported', async () => {
    const appDb = await makeAppDb();
    // Existing cycle row: May 1-22 (longer pull already imported)
    await appDb('bank_statement_imports').insert({
      company_code: TEST_COMPANY, bank_code: 'BC010',
      period_start: '2026-05-01',
      period_end: '2026-05-22',
      closing_balance: 75000,
      is_reconciled: 0,
    });

    // Operator tries to import a SHORTER pull (May 1-15)
    const extraction: PdfExtractionResult = {
      bank_name: 'Monzo', account_number: '1', sort_code: '04-00-04',
      statement_date: '2026-05-15',
      period_start: '2026-05-01',
      period_end: '2026-05-15',  // EARLIER than existing
      opening_balance: 125912.72, closing_balance: 90000,
      transactions: [],
    };
    const extractor: PdfExtractor = {
      extractFromPdf: vi.fn().mockResolvedValue(extraction),
    };
    const executor: ImportPostingExecutor = {
      postBankImport: vi.fn().mockResolvedValue({
        success: true, records_imported: 0, records_failed: 0,
        skipped_count: 0, errors: [], warnings: [],
      }),
    };
    const lock: ImportLockAdapter = {
      acquire: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const overlap: PeriodOverlapChecker = {
      checkOverlap: vi.fn().mockResolvedValue({
        overlapError: null, resumeImportId: null,
      }),
    };
    const result = await importBankStatementFromPdf(
      makeOperaDb(), appDb,
      { filePath: '/tmp/May 1-15.pdf', bankCode: 'BC010', companyCode: TEST_COMPANY,
        filename: 'May 1-15.pdf' },
      extractor, executor, lock, overlap,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already imported a later pull/i);
    expect(executor.postBankImport).not.toHaveBeenCalled();
  });

  it('traditional bank: each statement creates a new row (no cycle merge)', async () => {
    const appDb = await makeAppDb();
    // Existing row for April 17 statement (reconciled).
    await appDb('bank_statement_imports').insert({
      company_code: TEST_COMPANY, bank_code: 'BC010',
      period_start: '2026-04-13',
      period_end: '2026-04-17',
      closing_balance: 119822.40,
      is_reconciled: 1,
    });

    // Operator now imports the May 24 statement — different
    // period_start (2026-04-20) per Barclays' weekly cadence.
    // This MUST create a fresh row, not trip the cycle-merge.
    const extraction: PdfExtractionResult = {
      bank_name: 'Barclays', account_number: '90764205',
      sort_code: '20-00-00',
      statement_date: '2026-04-24',
      period_start: '2026-04-20',     // different cycle key
      period_end: '2026-04-24',
      opening_balance: 119822.40, closing_balance: 116726.07,
      transactions: [
        { date: '2026-04-21', name: 'X', memo: 'X', amount: -100,
          type: 'debit', balance: 119722.40 },
      ],
    };
    const extractor: PdfExtractor = {
      extractFromPdf: vi.fn().mockResolvedValue(extraction),
    };
    const executor: ImportPostingExecutor = {
      postBankImport: vi.fn().mockResolvedValue({
        success: true, records_imported: 1, records_failed: 0,
        skipped_count: 0, errors: [], warnings: [],
        posted_lines: [],
      }),
    };
    const lock: ImportLockAdapter = {
      acquire: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const overlap: PeriodOverlapChecker = {
      checkOverlap: vi.fn().mockResolvedValue({
        overlapError: null, resumeImportId: null,
      }),
    };
    const result = await importBankStatementFromPdf(
      makeOperaDb(), appDb,
      { filePath: '/tmp/Statement 24-APR.pdf', bankCode: 'BC010', companyCode: TEST_COMPANY,
        filename: 'Statement 24-APR.pdf' },
      extractor, executor, lock, overlap,
    );

    expect(result.success).toBe(true);
    // Two rows: the original April 17, plus a NEW April 24.
    const rows = await appDb('bank_statement_imports')
      .where({ bank_code: 'BC010' })
      .orderBy('id')
      .select('period_start', 'period_end');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.period_start).toBe('2026-04-13');  // April 17 stmt
    expect(rows[1]?.period_start).toBe('2026-04-20');  // April 24 stmt
  });

  it('UPDATEs the existing cycle row when an unreconciled cycle exists', async () => {
    const appDb = await makeAppDb();
    // Pre-existing UNreconciled cycle row from a prior pull (May 1-8).
    const [firstId] = await appDb('bank_statement_imports')
      .insert({
        company_code: TEST_COMPANY,
        bank_code: 'BC010',
        period_start: '2026-05-01',
        period_end: '2026-05-08',
        opening_balance: 125912.72,
        closing_balance: 100000,
        is_reconciled: 0,
        filename: 'May 1-8.pdf',
        source: 'email',
        target_system: 'opera_se',
        records_imported: 12,
        transactions_imported: 12,
      })
      .returning('id');
    const firstImportId = typeof firstId === 'number' ? firstId : (firstId as { id: number }).id;

    // Pre-existing transactions on the first pull (12 lines, May 1-8).
    for (let i = 1; i <= 12; i++) {
      await appDb('bank_statement_transactions').insert({
        company_code: TEST_COMPANY,
        import_id: firstImportId,
        line_number: i,
        post_date: `2026-05-0${i <= 9 ? i : i}`,
        description: `Line ${i}`,
        amount: -10,
      });
    }

    // The new pull (May 1-22) extends to May 22 with new lines.
    const extraction: PdfExtractionResult = {
      bank_name: 'Monzo',
      account_number: '12345678', sort_code: '04-00-04',
      statement_date: '2026-05-22',
      period_start: '2026-05-01',
      period_end: '2026-05-22',
      opening_balance: 125912.72,
      closing_balance: 75000,
      transactions: [
        // 12 same lines as before — should NOT be re-inserted
        ...Array.from({ length: 12 }, (_, i) => ({
          date: `2026-05-0${i + 1 <= 9 ? i + 1 : i + 1}`,
          name: `Line ${i + 1}`, memo: `Line ${i + 1}`,
          amount: -10, type: 'debit', balance: 100000,
        })),
        // 4 NEW lines for May 16-22
        ...Array.from({ length: 4 }, (_, i) => ({
          date: `2026-05-${16 + i}`,
          name: `New ${i + 1}`, memo: `New ${i + 1}`,
          amount: -20, type: 'debit', balance: 75000,
        })),
      ],
    };

    const extractor: PdfExtractor = {
      extractFromPdf: vi.fn().mockResolvedValue(extraction),
    };
    const executor: ImportPostingExecutor = {
      postBankImport: vi.fn().mockResolvedValue({
        success: true,
        records_imported: 4,  // executor posts 4 new lines
        records_failed: 0,
        skipped_count: 12,
        errors: [], warnings: [],
        posted_lines: [],
      }),
    };
    const lock: ImportLockAdapter = {
      acquire: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
    };
    const overlap: PeriodOverlapChecker = {
      checkOverlap: vi.fn().mockResolvedValue({
        overlapError: null, resumeImportId: null,
      }),
    };

    const result = await importBankStatementFromPdf(
      makeOperaDb(),
      appDb,
      {
        filePath: '/tmp/May 1-22.pdf',
        bankCode: 'BC010', companyCode: TEST_COMPANY,
        filename: 'May 1-22.pdf',
      },
      extractor, executor, lock, overlap,
    );

    expect(result.success).toBe(true);

    // Critical assertion: only ONE bank_statement_imports row exists
    // for this cycle (the original, now UPDATEd).
    const rows = await appDb('bank_statement_imports')
      .where({ bank_code: 'BC010', period_start: '2026-05-01' })
      .select('id', 'period_end', 'closing_balance', 'transactions_imported');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(firstImportId);
    expect(rows[0]?.period_end).toBe('2026-05-22');
    expect(rows[0]?.closing_balance).toBe(75000);

    // bank_statement_transactions should now have 16 rows
    // (12 original + 4 newly-appended), all under firstImportId.
    const lineRows = await appDb('bank_statement_transactions')
      .where({ import_id: firstImportId })
      .count<{ c: number }[]>({ c: '*' })
      .first();
    expect(Number(lineRows?.c)).toBe(16);
  });
});

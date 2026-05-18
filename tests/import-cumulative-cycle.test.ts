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

const IMPORTS_SCHEMA = `CREATE TABLE bank_statement_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      bank_code: 'BC010',
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
        bankCode: 'BC010',
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

  it('UPDATEs the existing cycle row when an unreconciled cycle exists', async () => {
    const appDb = await makeAppDb();
    // Pre-existing UNreconciled cycle row from a prior pull (May 1-8).
    const [firstId] = await appDb('bank_statement_imports')
      .insert({
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
        bankCode: 'BC010',
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

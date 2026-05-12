import { describe, it, expect, vi } from 'vitest';
import {
  importBankStatementFromPdf,
  type PdfExtractor,
  type ImportPostingExecutor,
  type ImportLockAdapter,
  type PeriodOverlapChecker,
  type PdfExtractionResult,
} from '../src/services/import-from-pdf.js';

interface OperaState {
  banks: string[];
}

function makeOperaDb(state: OperaState): any {
  const db: any = (table: string) => {
    if (table !== 'nbank') {
      throw new Error(`Unexpected table: ${table}`);
    }
    let codeFilter: string | null = null;
    const builder: any = {
      whereRaw: (sql: string, params: any[]) => {
        if (sql.includes('RTRIM(nk_acnt)')) codeFilter = params?.[0] ?? null;
        return builder;
      },
      select: () => builder,
      first: async () =>
        codeFilter && state.banks.includes(codeFilter)
          ? { nk_acnt: codeFilter }
          : undefined,
    };
    return builder;
  };
  return db;
}

function makeAppDb(): any {
  const db: any = (_table: string) => ({
    insert: async () => [1],
  });
  db.fn = { now: () => '__NOW__' };
  return db;
}

const SAMPLE_EXTRACTION: PdfExtractionResult = {
  bank_name: 'Barclays',
  account_number: '12345678',
  sort_code: '20-00-00',
  statement_date: '2026-04-30',
  period_start: '2026-04-01',
  period_end: '2026-04-30',
  opening_balance: 1000,
  closing_balance: 2000,
  transactions: [
    {
      date: '2026-04-15',
      name: 'Acme',
      memo: 'Customer payment',
      amount: 500,
      type: 'credit',
      line_number: 1,
    },
    {
      date: '2026-04-20',
      name: 'Energy Co',
      memo: 'Direct debit',
      amount: -100,
      type: 'debit',
      line_number: 2,
    },
  ],
};

describe('importBankStatementFromPdf', () => {
  it('rejects missing file path', async () => {
    const extractor: PdfExtractor = {
      extractFromPdf: vi.fn(),
    };
    const executor: ImportPostingExecutor = {
      postBankImport: vi.fn(),
    };
    const lock: ImportLockAdapter = {
      acquire: vi.fn(),
      release: vi.fn(),
    };
    const overlap: PeriodOverlapChecker = {
      checkOverlap: vi.fn(),
    };
    const result = await importBankStatementFromPdf(
      makeOperaDb({ banks: ['BC010'] }),
      makeAppDb(),
      { filePath: '', bankCode: 'BC010' },
      extractor,
      executor,
      lock,
      overlap,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/file_path is required/);
  });

  it('rejects when bank not in Opera', async () => {
    const extractor: PdfExtractor = {
      extractFromPdf: vi.fn(),
    };
    const executor: ImportPostingExecutor = {
      postBankImport: vi.fn(),
    };
    const lock: ImportLockAdapter = {
      acquire: vi.fn(),
      release: vi.fn(),
    };
    const overlap: PeriodOverlapChecker = {
      checkOverlap: vi.fn(),
    };
    const result = await importBankStatementFromPdf(
      makeOperaDb({ banks: [] }),
      makeAppDb(),
      { filePath: '/tmp/stmt.pdf', bankCode: 'BC010' },
      extractor,
      executor,
      lock,
      overlap,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found in Opera/);
  });

  it('returns error when PDF extraction fails', async () => {
    const extractor: PdfExtractor = {
      extractFromPdf: vi.fn().mockRejectedValue(new Error('AI down')),
    };
    const executor: ImportPostingExecutor = {
      postBankImport: vi.fn(),
    };
    const lock: ImportLockAdapter = {
      acquire: vi.fn(),
      release: vi.fn(),
    };
    const overlap: PeriodOverlapChecker = {
      checkOverlap: vi.fn(),
    };
    const result = await importBankStatementFromPdf(
      makeOperaDb({ banks: ['BC010'] }),
      makeAppDb(),
      { filePath: '/tmp/stmt.pdf', bankCode: 'BC010' },
      extractor,
      executor,
      lock,
      overlap,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/PDF extraction failed/);
    expect(executor.postBankImport).not.toHaveBeenCalled();
  });

  it('returns overlap error when checker reports overlap', async () => {
    const extractor: PdfExtractor = {
      extractFromPdf: async () => SAMPLE_EXTRACTION,
    };
    const executor: ImportPostingExecutor = {
      postBankImport: vi.fn(),
    };
    const lock: ImportLockAdapter = {
      acquire: vi.fn(),
      release: vi.fn(),
    };
    const overlap: PeriodOverlapChecker = {
      checkOverlap: async () => ({
        overlapError: {
          success: false,
          error: 'overlapping period already imported',
        },
        resumeImportId: 42,
      }),
    };
    const result = await importBankStatementFromPdf(
      makeOperaDb({ banks: ['BC010'] }),
      makeAppDb(),
      { filePath: '/tmp/stmt.pdf', bankCode: 'BC010' },
      extractor,
      executor,
      lock,
      overlap,
    );
    expect(result.success).toBe(false);
    expect(result.resume_import_id).toBe(42);
    expect(executor.postBankImport).not.toHaveBeenCalled();
  });

  it('rejects when lock cannot be acquired', async () => {
    const extractor: PdfExtractor = {
      extractFromPdf: async () => SAMPLE_EXTRACTION,
    };
    const executor: ImportPostingExecutor = {
      postBankImport: vi.fn(),
    };
    const lock: ImportLockAdapter = {
      acquire: async () => false,
      release: vi.fn(),
    };
    const overlap: PeriodOverlapChecker = {
      checkOverlap: async () => ({ resumeImportId: null }),
    };
    const result = await importBankStatementFromPdf(
      makeOperaDb({ banks: ['BC010'] }),
      makeAppDb(),
      { filePath: '/tmp/stmt.pdf', bankCode: 'BC010' },
      extractor,
      executor,
      lock,
      overlap,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/currently being imported/);
  });

  it('happy path: extracts → posts → audits → releases lock', async () => {
    const extractor: PdfExtractor = {
      extractFromPdf: async () => SAMPLE_EXTRACTION,
    };
    const executor: ImportPostingExecutor = {
      postBankImport: async () => ({
        success: true,
        records_imported: 2,
        records_failed: 0,
        skipped_count: 0,
        errors: [],
        warnings: [],
        import_id: 99,
      }),
    };
    const acquire = vi.fn().mockResolvedValue(true);
    const release = vi.fn().mockResolvedValue(undefined);
    const lock: ImportLockAdapter = { acquire, release };
    const overlap: PeriodOverlapChecker = {
      checkOverlap: async () => ({ resumeImportId: null }),
    };
    const result = await importBankStatementFromPdf(
      makeOperaDb({ banks: ['BC010'] }),
      makeAppDb(),
      {
        filePath: '/tmp/stmt.pdf',
        bankCode: 'BC010',
        autoAllocate: true,
      },
      extractor,
      executor,
      lock,
      overlap,
    );
    expect(result.success).toBe(true);
    expect(result.records_imported).toBe(2);
    expect(result.import_id).toBe(99);
    expect(acquire).toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });

  it('releases lock when executor throws', async () => {
    const extractor: PdfExtractor = {
      extractFromPdf: async () => SAMPLE_EXTRACTION,
    };
    const executor: ImportPostingExecutor = {
      postBankImport: async () => {
        throw new Error('database down');
      },
    };
    const acquire = vi.fn().mockResolvedValue(true);
    const release = vi.fn().mockResolvedValue(undefined);
    const lock: ImportLockAdapter = { acquire, release };
    const overlap: PeriodOverlapChecker = {
      checkOverlap: async () => ({ resumeImportId: null }),
    };
    await expect(
      importBankStatementFromPdf(
        makeOperaDb({ banks: ['BC010'] }),
        makeAppDb(),
        { filePath: '/tmp/stmt.pdf', bankCode: 'BC010' },
        extractor,
        executor,
        lock,
        overlap,
      ),
    ).rejects.toThrow('database down');
    expect(release).toHaveBeenCalled();
  });
});

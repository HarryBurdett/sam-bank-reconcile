import { describe, it, expect, vi } from 'vitest';
import {
  importBankStatementFromPdf,
  type PdfExtractor,
  type ImportPostingExecutor,
  type ImportLockAdapter,
  type PeriodOverlapChecker,
  type PdfExtractionResult,
} from '../src/services/import-from-pdf.js';

const TEST_COMPANY = 'C';

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
  const db: any = (_table: string) => {
    // Minimal query-chain: supports .insert() for audit-row writes and
    // the full .select().where().orderBy().first() chain used by
    // findExistingCycleRow (returns undefined → no cycle row, fall through).
    const chain: any = {
      insert: async () => [1],
      select: () => chain,
      where: () => chain,
      whereRaw: () => chain,
      orderBy: () => chain,
      first: async () => undefined,
    };
    return chain;
  };
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
      { filePath: '', bankCode: 'BC010', companyCode: TEST_COMPANY },
      extractor,
      executor,
      lock,
      overlap,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/file_path or bytes is required/);
  });

  it('accepts bytes without a real filePath (email-source path)', async () => {
    // Simulates bank-import-from-email passing a synthetic filePath
    // plus the actual attachment bytes. The extractor should receive
    // the bytes and not attempt to readFileSync the email:// URI.
    const extractorMock = vi.fn().mockResolvedValue({
      bank_name: 'X', account_number: '1', sort_code: '00-00-00',
      statement_date: '2026-05-15', period_start: '2026-05-09',
      period_end: '2026-05-15', opening_balance: 0, closing_balance: 0,
      transactions: [],
    });
    const extractor: PdfExtractor = { extractFromPdf: extractorMock };
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
      checkOverlap: vi.fn().mockResolvedValue({ overlapError: null, resumeImportId: null }),
    };
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    const result = await importBankStatementFromPdf(
      makeOperaDb({ banks: ['BC010'] }),
      makeAppDb(),
      {
        filePath: 'email://812/2',
        bytes,
        bankCode: 'BC010', companyCode: TEST_COMPANY,
        filename: 'Statement 15-MAY-26.pdf',
      },
      extractor,
      executor,
      lock,
      overlap,
    );
    expect(result.success).toBe(true);
    // Critical: extractor must see bytes (not filePath) so it skips
    // the readFileSync that would fail on 'email://812/2'.
    expect(extractorMock).toHaveBeenCalledTimes(1);
    const passed = extractorMock.mock.calls[0]![0] as { bytes?: Uint8Array; filePath?: string };
    expect(passed.bytes).toBe(bytes);
    expect(passed.filePath).toBeUndefined();
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
      { filePath: '/tmp/stmt.pdf', bankCode: 'BC010', companyCode: TEST_COMPANY },
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
      { filePath: '/tmp/stmt.pdf', bankCode: 'BC010', companyCode: TEST_COMPANY },
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
      { filePath: '/tmp/stmt.pdf', bankCode: 'BC010', companyCode: TEST_COMPANY },
      extractor,
      executor,
      lock,
      overlap,
    );
    expect(result.success).toBe(false);
    // Legacy returns the overlap error verbatim — resume_import_id is
    // only meaningful on the same-filename branch, which the
    // orchestrator handles internally and never surfaces to the
    // client (routes.py:4108-4109). The error shape is the legacy
    // contract; FE keys off success === false, not on a top-level
    // resume_import_id.
    expect(result.error).toMatch(/overlap/i);
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
      { filePath: '/tmp/stmt.pdf', bankCode: 'BC010', companyCode: TEST_COMPANY },
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
        bankCode: 'BC010', companyCode: TEST_COMPANY,
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
        { filePath: '/tmp/stmt.pdf', bankCode: 'BC010', companyCode: TEST_COMPANY },
        extractor,
        executor,
        lock,
        overlap,
      ),
    ).rejects.toThrow('database down');
    expect(release).toHaveBeenCalled();
  });
});

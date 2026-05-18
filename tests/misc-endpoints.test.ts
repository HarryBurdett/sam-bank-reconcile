import { describe, it, expect, vi } from 'vitest';
import {
  listCsvFiles,
  listPdfFiles,
  getPdfContent,
  scanFolder,
  fetchEmailsToFolder,
  scanAllBanks,
  rawPreviewFromPdf,
  previewMultiformat,
  validateCsv,
  getStatementReview,
  type PdfContentReader,
  type MultiformatParser,
} from '../src/services/misc-endpoints.js';
import type { LlmService } from '../src/services/preview-from-pdf.js';
import type { FileStorageAdapter } from '../src/services/archive.js';
import type { EmailAttachmentProvider } from '../src/services/preview-from-email.js';

function makeStorage(files: any[] = []): FileStorageAdapter {
  return {
    archive: vi.fn(),
    restore: vi.fn(),
    listPending: vi.fn(async () => files),
  };
}

function makeLlm(text: string): LlmService {
  return {
    chat() {
      async function* gen(): AsyncIterable<unknown> {
        yield text;
      }
      return gen();
    },
  };
}

describe('list-csv / list-pdf / scan-folder', () => {
  const files = [
    { path: '/x/a.csv', filename: 'a.csv', folder: 'x', size: 100, modified: '' },
    { path: '/x/b.pdf', filename: 'b.pdf', folder: 'x', size: 200, modified: '' },
  ];

  it('listCsv returns csv only', async () => {
    const r = await listCsvFiles(makeStorage(files));
    expect(r.files.length).toBe(1);
  });

  it('listPdf returns pdf only', async () => {
    const r = await listPdfFiles(makeStorage(files));
    expect(r.files.length).toBe(1);
  });

  it('scanFolder returns all', async () => {
    const r = await scanFolder(makeStorage(files));
    expect(r.count).toBe(2);
  });

  it('all 503 when storage missing', async () => {
    expect((await listCsvFiles(null)).success).toBe(false);
    expect((await listPdfFiles(null)).success).toBe(false);
    expect((await scanFolder(null)).success).toBe(false);
  });
});

describe('getPdfContent', () => {
  it('503 when reader missing', async () => {
    const r = await getPdfContent(null, '/x/a.pdf');
    expect(r.success).toBe(false);
  });

  it('returns base64 pdf_data + filename when reader supplies bytes', async () => {
    const reader: PdfContentReader = {
      readBytes: async () => new Uint8Array([1, 2, 3]),
    };
    const r = await getPdfContent(reader, '/x/a.pdf');
    expect(r.success).toBe(true);
    expect(r.size).toBe(3);
    expect(r.filename).toBe('a.pdf');
    // Base64 of [1,2,3] is 'AQID'
    expect(r.pdf_data).toBe('AQID');
  });

  it('strips directory prefix from filename', async () => {
    const reader: PdfContentReader = {
      readBytes: async () => new Uint8Array([0]),
    };
    const r = await getPdfContent(reader, '/var/data/cloudsis/Monzo_Statement.pdf');
    expect(r.filename).toBe('Monzo_Statement.pdf');
  });

  it('falls back to document.pdf when path is empty', async () => {
    const reader: PdfContentReader = {
      readBytes: async () => new Uint8Array([0]),
    };
    const r = await getPdfContent(reader, '');
    expect(r.filename).toBe('document.pdf');
  });

  it('404-equivalent when reader returns null', async () => {
    const reader: PdfContentReader = { readBytes: async () => null };
    const r = await getPdfContent(reader, '/x/missing.pdf');
    expect(r.success).toBe(false);
  });
});

describe('scanAllBanks', () => {
  it('returns banks dict keyed by bank_code from operaDb', async () => {
    const db: any = (_t: string) => ({});
    db.raw = async () => [
      {
        bank_code: 'BC010',
        description: 'Barclays',
        sort_code: '',
        account_number: '',
        reconciled_balance: 0,
        current_balance: 0,
      },
    ];
    const r = await scanAllBanks(db);
    expect(r.success).toBe(true);
    // banks is a dict keyed by bank_code, matching legacy
    // routes.py:6688. Empty banks are filtered out via the
    // scanAllBanks-faithful path; the older entry point in
    // misc-endpoints still returns all banks with statements: [].
    expect(Object.keys(r.banks).length).toBeGreaterThanOrEqual(1);
    expect(r.banks.BC010).toBeDefined();
    expect(r.banks.BC010!.description).toBe('Barclays');
  });
});

describe('fetchEmailsToFolder', () => {
  it('503 when adapters missing', async () => {
    const r = await fetchEmailsToFolder(null, null, []);
    expect(r.success).toBe(false);
  });

  it('downloads each email', async () => {
    const provider: EmailAttachmentProvider = {
      fetchAttachment: vi.fn(async () => ({
        bytes: new Uint8Array(),
        filename: 'x.pdf',
        contentType: 'application/pdf',
      })),
    };
    const r = await fetchEmailsToFolder(provider, makeStorage(), [
      { emailId: 1, attachmentId: 'a' },
      { emailId: 2, attachmentId: 'b' },
    ]);
    expect(r.downloaded).toBe(2);
  });
});

describe('rawPreviewFromPdf', () => {
  it('503 when llm missing', async () => {
    const r = await rawPreviewFromPdf(null, null, '/x/a.pdf');
    expect(r.success).toBe(false);
  });
  it('returns text from llm stream', async () => {
    const r = await rawPreviewFromPdf(makeLlm('extracted text'), null, '/x/a.pdf');
    expect(r.success).toBe(true);
    expect(r.text).toBe('extracted text');
  });
});

describe('previewMultiformat / validateCsv', () => {
  const parser: MultiformatParser = {
    detectFormat: (content) => (content.startsWith('Date,') ? 'csv' : 'unknown'),
    parse: () => [
      { date: '2026-04-15', name: 'Acme', memo: '', amount: 100, type: 'credit' },
    ],
  };
  it('previewMultiformat returns format + transactions', async () => {
    const r = await previewMultiformat(parser, 'Date,Amount\n2026-04-15,100');
    expect(r.success).toBe(true);
    expect(r.format).toBe('csv');
    expect(r.transactions?.length).toBe(1);
  });
  it('validateCsv returns valid for CSV input', async () => {
    const r = await validateCsv(parser, 'Date,Amount\n2026-04-15,100');
    expect(r.success).toBe(true);
    expect(r.valid).toBe(true);
  });
  it('validateCsv returns invalid for non-CSV', async () => {
    const r = await validateCsv(parser, '<html>not csv</html>');
    expect(r.valid).toBe(false);
  });
});

describe('getStatementReview', () => {
  it('rejects invalid import_id', async () => {
    const db: any = () => ({ where: () => ({ first: async () => undefined }) });
    db.raw = async () => [];
    const r = await getStatementReview(db, 0);
    expect(r.success).toBe(false);
  });
  it('returns mapped row', async () => {
    const db: any = (_table: string) => ({
      where: () => ({
        first: async () => ({
          id: 99,
          bank_code: 'BC010',
          source_ref: '/x/stmt.pdf',
          imported_at: '2026-04-15T00:00:00Z',
          records_imported: 5,
          records_failed: 0,
          opening_balance: 1000,
          closing_balance: 1500,
          import_status: 'imported',
        }),
      }),
    });
    db.raw = async () => [];
    const r = await getStatementReview(db, 99);
    expect(r.success).toBe(true);
    expect(r.review?.records_imported).toBe(5);
  });
});

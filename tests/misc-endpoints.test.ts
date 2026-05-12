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

  it('returns bytes when reader supplies them', async () => {
    const reader: PdfContentReader = {
      readBytes: async () => new Uint8Array([1, 2, 3]),
    };
    const r = await getPdfContent(reader, '/x/a.pdf');
    expect(r.success).toBe(true);
    expect(r.size).toBe(3);
  });

  it('404-equivalent when reader returns null', async () => {
    const reader: PdfContentReader = { readBytes: async () => null };
    const r = await getPdfContent(reader, '/x/missing.pdf');
    expect(r.success).toBe(false);
  });
});

describe('scanAllBanks', () => {
  it('returns banks from operaDb', async () => {
    const db: any = (_t: string) => ({});
    db.raw = async () => [{ bank_code: 'BC010', description: 'Barclays' }];
    const r = await scanAllBanks(db);
    expect(r.success).toBe(true);
    expect(r.banks.length).toBe(1);
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

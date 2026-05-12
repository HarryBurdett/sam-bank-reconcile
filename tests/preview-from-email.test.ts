import { describe, it, expect, vi } from 'vitest';
import {
  previewBankImportFromEmail,
  type EmailAttachmentProvider,
} from '../src/services/preview-from-email.js';
import type { LlmService } from '../src/services/preview-from-pdf.js';

function makeOperaDb(): any {
  const tableBuilder = (_table: string) => {
    const builder: any = {
      select: () => builder,
      whereRaw: () => builder,
      andWhereRaw: () => builder,
      first: async () => ({
        code: 'BC010',
        description: 'Barclays',
        sort_code: '20-00-00',
        account_number: '12345678',
        reconciled_balance: 1000,
      }),
    };
    return builder;
  };
  const db: any = (table: string) => tableBuilder(table);
  db.raw = (s: string) => s;
  return db;
}

function makeLlm(json: string): LlmService {
  return {
    chat() {
      async function* gen(): AsyncIterable<unknown> {
        yield json;
      }
      return gen();
    },
  };
}

describe('previewBankImportFromEmail', () => {
  it('rejects when email_id missing', async () => {
    const result = await previewBankImportFromEmail(
      makeOperaDb(),
      makeLlm('{}'),
      { fetchAttachment: vi.fn() },
      { emailId: 0, attachmentId: 'a-1', bankCode: 'BC010' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/email_id/);
  });

  it('rejects when attachment_id missing', async () => {
    const result = await previewBankImportFromEmail(
      makeOperaDb(),
      makeLlm('{}'),
      { fetchAttachment: vi.fn() },
      { emailId: 42, attachmentId: '', bankCode: 'BC010' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/attachment_id/);
  });

  it('returns error when attachment download fails', async () => {
    const provider: EmailAttachmentProvider = {
      fetchAttachment: vi.fn().mockResolvedValue(null),
    };
    const result = await previewBankImportFromEmail(
      makeOperaDb(),
      makeLlm('{}'),
      provider,
      { emailId: 42, attachmentId: 'a-1', bankCode: 'BC010' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Attachment not found/);
  });

  it('downloads and delegates to preview-from-pdf', async () => {
    const json = JSON.stringify({
      bank_name: 'Barclays',
      account_number: '12345678',
      sort_code: '20-00-00',
      opening_balance: 1000,
      closing_balance: 1500,
      transactions: [],
    });
    const provider: EmailAttachmentProvider = {
      fetchAttachment: vi.fn().mockResolvedValue({
        bytes: new Uint8Array([1, 2, 3]),
        filename: 'statement.pdf',
        contentType: 'application/pdf',
      }),
    };
    const result = await previewBankImportFromEmail(
      makeOperaDb(),
      makeLlm(json),
      provider,
      { emailId: 42, attachmentId: 'a-1', bankCode: 'BC010' },
    );
    expect(result.success).toBe(true);
    expect(provider.fetchAttachment).toHaveBeenCalledWith({
      emailId: 42,
      attachmentId: 'a-1',
    });
    expect(result.statement_info?.bank_name).toBe('Barclays');
  });

  it('surfaces fetch errors as messages', async () => {
    const provider: EmailAttachmentProvider = {
      fetchAttachment: vi.fn().mockRejectedValue(new Error('graph 503')),
    };
    const result = await previewBankImportFromEmail(
      makeOperaDb(),
      makeLlm('{}'),
      provider,
      { emailId: 42, attachmentId: 'a-1', bankCode: 'BC010' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/graph 503/);
  });
});

import { describe, it, expect } from 'vitest';
import {
  scanEmailsForBankStatements,
  type BankMailboxAdapter,
  type MailboxEmail,
  type ReconciledKeyStore,
} from '../src/services/scan-emails.js';

interface OperaState {
  bank: {
    reconciled_balance: number | null;
    sort_code: string;
    account_number: string;
  } | null;
}

function makeOperaDb(state: OperaState): any {
  const db: any = (table: string) => {
    if (table !== 'nbank') {
      throw new Error(`Unexpected operaDb table: ${table}`);
    }
    const builder: any = {
      select: () => builder,
      whereRaw: () => builder,
      first: async () => state.bank ?? undefined,
    };
    return builder;
  };
  db.raw = (s: string) => s;
  return db;
}

function makeAppDb(): any {
  return (() => ({})) as any;
}

function makeMailbox(emails: MailboxEmail[]): BankMailboxAdapter {
  return {
    sync: async () => undefined,
    list: async () => ({ emails }),
    getById: async (emailId: number) =>
      emails.find((e) => e.id === emailId) ?? null,
  };
}

function makeReconciledStore(opts: {
  keys?: string[];
  filenames?: string[];
}): ReconciledKeyStore {
  return {
    getReconciledKeys: async () => new Set(opts.keys ?? []),
    getReconciledFilenames: async () => new Set(opts.filenames ?? []),
  };
}

const SAMPLE_EMAIL: MailboxEmail = {
  id: 1,
  subject: 'Your Barclays statement is ready',
  from_address: 'alerts@barclays.co.uk',
  received_at: '2026-04-15T08:00:00Z',
  has_attachments: true,
  attachments: [
    {
      attachment_id: 'att-1',
      filename: 'barclays_30-APR-26.pdf',
      content_type: 'application/pdf',
      size_bytes: 12345,
    },
  ],
};

describe('scanEmailsForBankStatements', () => {
  it('errors when bank not in Opera', async () => {
    const result = await scanEmailsForBankStatements(
      makeOperaDb({ bank: null }),
      makeAppDb(),
      makeMailbox([]),
      makeReconciledStore({}),
      { bankCode: 'GHOST' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found in Opera/);
  });

  it('returns the bank metadata when no emails found', async () => {
    const result = await scanEmailsForBankStatements(
      makeOperaDb({
        bank: {
          reconciled_balance: 1234.56,
          sort_code: '20-00-00',
          account_number: '12345678',
        },
      }),
      makeAppDb(),
      makeMailbox([]),
      makeReconciledStore({}),
      { bankCode: 'BARC' },
    );
    expect(result.success).toBe(true);
    expect(result.reconciled_balance).toBe(1234.56);
    expect(result.opera_sort_code).toBe('20-00-00');
    expect(result.opera_account_number).toBe('12345678');
    expect(result.statements).toEqual([]);
  });

  it('classifies a barclays statement attachment as a candidate', async () => {
    const result = await scanEmailsForBankStatements(
      makeOperaDb({
        bank: {
          reconciled_balance: 1000,
          sort_code: '20-00-00',
          account_number: '12345678',
        },
      }),
      makeAppDb(),
      makeMailbox([SAMPLE_EMAIL]),
      makeReconciledStore({}),
      { bankCode: 'BARC' },
    );
    expect(result.statements.length).toBe(1);
    const stmt = result.statements[0];
    expect(stmt?.detected_bank).toBe('barclays');
    expect(stmt?.attachments[0]?.filename).toBe('barclays_30-APR-26.pdf');
    expect(stmt?.statement_date).toBe('30-APR-2026');
    expect(stmt?.validation_status).toBe('pending');
  });

  it('skips already-reconciled statements via key store', async () => {
    const result = await scanEmailsForBankStatements(
      makeOperaDb({
        bank: {
          reconciled_balance: 1000,
          sort_code: '20-00-00',
          account_number: '12345678',
        },
      }),
      makeAppDb(),
      makeMailbox([SAMPLE_EMAIL]),
      makeReconciledStore({ keys: ['1:att-1'] }),
      { bankCode: 'BARC' },
    );
    expect(result.statements.length).toBe(0);
    expect(result.already_processed_count).toBe(1);
    expect(result.skipped_reasons[0]).toMatch(/already reconciled/);
  });

  it('skips by reconciled filename even when key differs', async () => {
    const result = await scanEmailsForBankStatements(
      makeOperaDb({
        bank: {
          reconciled_balance: 1000,
          sort_code: '20-00-00',
          account_number: '12345678',
        },
      }),
      makeAppDb(),
      makeMailbox([SAMPLE_EMAIL]),
      makeReconciledStore({ filenames: ['barclays_30-APR-26.pdf'] }),
      { bankCode: 'BARC' },
    );
    expect(result.statements.length).toBe(0);
    expect(result.already_processed_count).toBe(1);
  });

  it('include_processed bypasses dedupe', async () => {
    const result = await scanEmailsForBankStatements(
      makeOperaDb({
        bank: {
          reconciled_balance: 1000,
          sort_code: '20-00-00',
          account_number: '12345678',
        },
      }),
      makeAppDb(),
      makeMailbox([SAMPLE_EMAIL]),
      makeReconciledStore({ keys: ['1:att-1'] }),
      { bankCode: 'BARC', includeProcessed: true },
    );
    expect(result.statements.length).toBe(1);
    expect(result.already_processed_count).toBe(0);
  });

  it('drops emails without attachments', async () => {
    const noAtt: MailboxEmail = {
      id: 2,
      subject: 'Marketing email',
      from_address: 'news@somewhere.com',
      has_attachments: false,
    };
    const result = await scanEmailsForBankStatements(
      makeOperaDb({
        bank: {
          reconciled_balance: 1000,
          sort_code: '20-00-00',
          account_number: '12345678',
        },
      }),
      makeAppDb(),
      makeMailbox([noAtt]),
      makeReconciledStore({}),
      { bankCode: 'BARC' },
    );
    expect(result.statements.length).toBe(0);
    expect(result.total_emails_scanned).toBe(0);
  });

  it('drops attachments that fail isBankStatementAttachment', async () => {
    const invoice: MailboxEmail = {
      id: 3,
      subject: 'Invoice attached',
      from_address: 'billing@example.com',
      has_attachments: true,
      attachments: [
        {
          attachment_id: 'inv-1',
          filename: 'invoice.pdf',
          content_type: 'application/pdf',
        },
      ],
    };
    const result = await scanEmailsForBankStatements(
      makeOperaDb({
        bank: {
          reconciled_balance: 1000,
          sort_code: '20-00-00',
          account_number: '12345678',
        },
      }),
      makeAppDb(),
      makeMailbox([invoice]),
      makeReconciledStore({}),
      { bankCode: 'BARC' },
    );
    expect(result.statements.length).toBe(0);
  });

  it('orders multiple statements by extracted date', async () => {
    const apr: MailboxEmail = {
      ...SAMPLE_EMAIL,
      id: 10,
      attachments: [
        {
          attachment_id: 'a',
          filename: 'barclays_30-APR-26.pdf',
          content_type: 'application/pdf',
        },
      ],
    };
    const jan: MailboxEmail = {
      ...SAMPLE_EMAIL,
      id: 20,
      attachments: [
        {
          attachment_id: 'b',
          filename: 'barclays_31-JAN-26.pdf',
          content_type: 'application/pdf',
        },
      ],
    };
    const result = await scanEmailsForBankStatements(
      makeOperaDb({
        bank: {
          reconciled_balance: 1000,
          sort_code: '20-00-00',
          account_number: '12345678',
        },
      }),
      makeAppDb(),
      makeMailbox([apr, jan]),
      makeReconciledStore({}),
      { bankCode: 'BARC' },
    );
    expect(result.statements.length).toBe(2);
    expect(result.statements[0]?.email_id).toBe(20);
    expect(result.statements[1]?.email_id).toBe(10);
  });
});

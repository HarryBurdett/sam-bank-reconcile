import { describe, it, expect, vi } from 'vitest';
import { createDefaultEmailIngestAdapter } from '../src/services/default-email-ingest.js';
import type { SamEmailIngestService } from '../src/app-context.js';

interface FakeIngest extends SamEmailIngestService {
  push: (msg: unknown, mailboxId?: string) => void;
  fireOwnership: (event: {
    mailboxId: string;
    emailAddress?: string;
    previousOwnerAppId?: string | null;
    newOwnerAppId?: string | null;
  }) => Promise<void>;
}

function makeIngest(opts: {
  myMailboxes?: Array<{ id: string; email_address: string }>;
} = {}): FakeIngest {
  const handlersByMailbox = new Map<string, (msg: unknown) => unknown>();
  const ownershipListeners: Array<(event: unknown) => Promise<void>> = [];
  const myMailboxes = opts.myMailboxes ?? [];
  return {
    async claimMailbox() {
      return { mailboxId: 'mb-claim' };
    },
    async releaseMailbox() {},
    async listMyMailboxes() {
      return myMailboxes;
    },
    registerHandler(id: string, fn) {
      handlersByMailbox.set(id, fn as (msg: unknown) => unknown);
      return () => {
        handlersByMailbox.delete(id);
      };
    },
    fetchAttachment: vi.fn(async (_msg: unknown, attId: string) => ({
      bytes: Buffer.from(`bytes-for-${attId}`),
      name: `att-${attId}.pdf`,
      contentType: 'application/pdf',
    })),
    async getAttachmentText() {
      return { name: 'x', contentType: 'application/pdf', text: '', truncated: false };
    },
    onOwnershipChange(fn) {
      ownershipListeners.push(fn as (event: unknown) => Promise<void>);
      return () => {
        const i = ownershipListeners.indexOf(fn as (event: unknown) => Promise<void>);
        if (i >= 0) ownershipListeners.splice(i, 1);
      };
    },
    onActivityChange() {
      return () => undefined;
    },
    push(msg: unknown, mailboxId = 'mb1') {
      const h = handlersByMailbox.get(mailboxId);
      if (h) h(msg);
    },
    async fireOwnership(event) {
      for (const l of ownershipListeners) {
        await l(event);
      }
    },
  } as FakeIngest;
}

describe('createDefaultEmailIngestAdapter', () => {
  it('returns mailbox + attachments + shutdown', () => {
    const ingest = makeIngest();
    const a = createDefaultEmailIngestAdapter({
      emailIngest: ingest,
      appId: 'bank-reconcile',
    });
    expect(typeof a.mailbox.list).toBe('function');
    expect(typeof a.attachments.fetchAttachment).toBe('function');
    expect(typeof a.shutdown).toBe('function');
  });

  it('bootstraps from listMyMailboxes — production path', async () => {
    const ingest = makeIngest({
      myMailboxes: [{ id: 'mb1', email_address: 'ops@example.com' }],
    });
    const a = createDefaultEmailIngestAdapter({
      emailIngest: ingest,
      appId: 'bank-reconcile',
    });
    // Wait for the async listMyMailboxes() to settle
    await new Promise((r) => setTimeout(r, 5));
    ingest.push(
      {
        id: 'g1',
        subject: 'Bank statement',
        receivedDateTime: '2026-04-15T09:00:00Z',
        attachments: [{ id: 'att-a', name: 'stmt.pdf', size: 1234 }],
      },
      'mb1',
    );
    const r = await a.mailbox.list({
      fromDate: new Date('2026-01-01'),
      pageSize: 10,
    });
    expect(r.emails.length).toBe(1);
    expect(r.emails[0]?.subject).toBe('Bank statement');
    await a.shutdown();
  });

  it('attaches when SAM Admin assigns a mailbox (onOwnershipChange)', async () => {
    const ingest = makeIngest();
    const a = createDefaultEmailIngestAdapter({
      emailIngest: ingest,
      appId: 'bank-reconcile',
    });
    await new Promise((r) => setTimeout(r, 5));
    // Simulate SAM admin assigning the mailbox
    await ingest.fireOwnership({
      mailboxId: 'mb-new',
      previousOwnerAppId: null,
      newOwnerAppId: 'bank-reconcile',
    });
    ingest.push({ id: 'g1', subject: 'After assign', receivedDateTime: '2026-04-15' }, 'mb-new');
    const r = await a.mailbox.list({
      fromDate: new Date('2026-01-01'),
      pageSize: 10,
    });
    expect(r.emails.length).toBe(1);
    expect(r.emails[0]?.subject).toBe('After assign');
  });

  it('detaches when ownership is taken away', async () => {
    const ingest = makeIngest({
      myMailboxes: [{ id: 'mb1', email_address: 'ops@example.com' }],
    });
    const a = createDefaultEmailIngestAdapter({
      emailIngest: ingest,
      appId: 'bank-reconcile',
    });
    await new Promise((r) => setTimeout(r, 5));
    await ingest.fireOwnership({
      mailboxId: 'mb1',
      previousOwnerAppId: 'bank-reconcile',
      newOwnerAppId: 'gocardless',
    });
    // After detach, push should not reach our cache
    ingest.push({ id: 'g1', subject: 'orphan', receivedDateTime: '2026-04-15' }, 'mb1');
    const r = await a.mailbox.list({
      fromDate: new Date('2026-01-01'),
      pageSize: 10,
    });
    expect(r.emails.length).toBe(0);
  });

  it('test-path initialMailboxes bypasses listMyMailboxes', async () => {
    const ingest = makeIngest();
    const listSpy = vi.spyOn(ingest, 'listMyMailboxes');
    const a = createDefaultEmailIngestAdapter({
      emailIngest: ingest,
      appId: 'bank-reconcile',
      initialMailboxes: [{ id: 'mb-test', email_address: 'test@x' }],
    });
    expect(listSpy).not.toHaveBeenCalled();
    ingest.push({ id: 'g1', subject: 'X', receivedDateTime: '2026-04-15' }, 'mb-test');
    const r = await a.mailbox.list({ fromDate: new Date('2026-01-01'), pageSize: 5 });
    expect(r.emails.length).toBe(1);
  });

  it('fetchAttachment returns null for unknown emailId', async () => {
    const ingest = makeIngest();
    const a = createDefaultEmailIngestAdapter({
      emailIngest: ingest,
      appId: 'bank-reconcile',
    });
    expect(await a.attachments.fetchAttachment({ emailId: 999, attachmentId: 'x' })).toBeNull();
  });

  it('fetchAttachment proxies through ctx.emailIngest', async () => {
    const ingest = makeIngest({
      myMailboxes: [{ id: 'mb1', email_address: 'ops@example.com' }],
    });
    const a = createDefaultEmailIngestAdapter({
      emailIngest: ingest,
      appId: 'bank-reconcile',
    });
    await new Promise((r) => setTimeout(r, 5));
    ingest.push(
      {
        id: 'g1',
        subject: 'X',
        receivedDateTime: '2026-04-15T09:00:00Z',
        attachments: [{ id: 'att-1', name: 'a.pdf' }],
      },
      'mb1',
    );
    const list = await a.mailbox.list({ fromDate: new Date('2026-01-01'), pageSize: 5 });
    const id = list.emails[0]!.id;
    const r = await a.attachments.fetchAttachment({ emailId: id, attachmentId: 'att-1' });
    expect(r?.filename).toBe('att-att-1.pdf');
    expect(Buffer.from(r!.bytes).toString('utf8')).toBe('bytes-for-att-1');
  });

  it('dedupes by graph message id', async () => {
    const ingest = makeIngest({
      myMailboxes: [{ id: 'mb1', email_address: 'ops@example.com' }],
    });
    const a = createDefaultEmailIngestAdapter({
      emailIngest: ingest,
      appId: 'bank-reconcile',
    });
    await new Promise((r) => setTimeout(r, 5));
    ingest.push({ id: 'g1', subject: 'A', receivedDateTime: '2026-04-15' }, 'mb1');
    ingest.push({ id: 'g1', subject: 'A', receivedDateTime: '2026-04-15' }, 'mb1');
    const list = await a.mailbox.list({ fromDate: new Date('2026-01-01'), pageSize: 10 });
    expect(list.emails.length).toBe(1);
  });

  it('evicts old messages above cacheSize', async () => {
    const ingest = makeIngest({
      myMailboxes: [{ id: 'mb1', email_address: 'ops@example.com' }],
    });
    const a = createDefaultEmailIngestAdapter({
      emailIngest: ingest,
      appId: 'bank-reconcile',
      cacheSize: 2,
    });
    await new Promise((r) => setTimeout(r, 5));
    ingest.push({ id: 'g1', subject: '1', receivedDateTime: '2026-04-01' }, 'mb1');
    ingest.push({ id: 'g2', subject: '2', receivedDateTime: '2026-04-02' }, 'mb1');
    ingest.push({ id: 'g3', subject: '3', receivedDateTime: '2026-04-03' }, 'mb1');
    const list = await a.mailbox.list({ fromDate: new Date('2026-01-01'), pageSize: 10 });
    expect(list.emails.length).toBe(2);
    expect(list.emails.map((e) => e.subject).sort()).toEqual(['2', '3']);
  });
});

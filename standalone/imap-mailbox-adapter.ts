/**
 * IMAP-backed mailbox adapter for the standalone host.
 *
 * Plugs `BankMailboxAdapter` (used by `/scan-emails`) and
 * `EmailAttachmentProvider` (used by `/preview-from-email` and
 * `/import-from-email`) directly into the per-company `AppContext`.
 *
 * Design notes:
 *   - Config (IMAP server, port, credentials, SSL flag) is read from
 *     the per-company `settings` table under key=`email_provider` on
 *     every call. That means the operator can edit credentials on
 *     `/settings.html` and the next scan picks them up without
 *     restarting the standalone host.
 *   - Connections are NOT pooled. Each call opens, does its work,
 *     and closes. IMAP servers are tolerant of this; the overhead is
 *     a couple of seconds per scan, which is acceptable for an
 *     interactive bank-reconciliation workflow.
 *   - `emailId` in the plugin's contract is a number. We use the
 *     IMAP UID (uint32) directly — stable per (mailbox, message)
 *     across re-fetches, which is what the plugin needs to
 *     `getById()` after listing.
 *   - `attachmentId` is the MIME part identifier from the BODYSTRUCTURE
 *     response (e.g., `"2"`, `"2.1"`). imapflow exposes these as
 *     `part` strings — pass them through unchanged.
 *   - Folder is hard-coded to `INBOX` for v1. Multi-folder support
 *     is reserved for a future iteration (mirrors the legacy
 *     `email_folders.monitored` flag).
 */
import { ImapFlow, type FetchMessageObject } from 'imapflow';
import type { Knex } from 'knex';
import type {
  BankMailboxAdapter,
  MailboxAttachment,
  MailboxEmail,
} from '../src/services/scan-emails.js';
import type { EmailAttachmentProvider } from '../src/services/preview-from-email.js';
import type { AppLogger } from '../src/app-context.js';

/** Stored in settings.value as JSON. */
export interface StoredEmailProvider {
  name?: string;
  provider_type?: 'imap' | 'microsoft' | 'gmail';
  server?: string;
  port?: number;
  username?: string;
  password?: string;
  use_ssl?: boolean;
  from_email?: string;
  /**
   * Skip TLS hostname/CA verification. Needed for LAN IMAP servers
   * whose certs are self-signed or IP-issued (cert SAN doesn't list
   * the literal IP, so strict validation fails). Mirrors the
   * `OPERA_SQL_TRUST_CERT` env var used by the MSSQL adapter.
   * Default: true (matches legacy Python imaplib behaviour).
   */
  allow_invalid_cert?: boolean;
}

export interface ImapAdapterBundle {
  mailbox: BankMailboxAdapter;
  attachments: EmailAttachmentProvider;
}

const FOLDER = 'INBOX';

/**
 * Build the mailbox + attachment-provider pair for a single company.
 * The returned adapters re-read the config on every call so post-
 * boot edits via `/auth/email-config` take effect immediately.
 */
export function buildImapAdapter(opts: {
  code: string;
  appDb: Knex;
  logger: AppLogger;
}): ImapAdapterBundle {
  const { code, appDb, logger } = opts;

  async function loadConfig(): Promise<StoredEmailProvider | null> {
    const row = (await appDb('settings')
      .where({ key: 'email_provider' })
      .first()) as { value?: string } | undefined;
    if (!row?.value) return null;
    try {
      const parsed = JSON.parse(row.value) as StoredEmailProvider;
      if (parsed.provider_type && parsed.provider_type !== 'imap') {
        logger.warn(
          `[${code}] email_provider type="${parsed.provider_type}" — only IMAP is wired in standalone today; scan-emails will fail`,
        );
        return null;
      }
      return parsed;
    } catch (err) {
      logger.warn(`[${code}] email_provider JSON unreadable: ${(err as Error).message}`);
      return null;
    }
  }

  async function connect(): Promise<ImapFlow> {
    const cfg = await loadConfig();
    if (!cfg) {
      throw new Error(
        `Email account not configured for company "${code}". Open /settings.html and add IMAP credentials.`,
      );
    }
    if (!cfg.server || !cfg.username || !cfg.password) {
      throw new Error(
        `Email config for "${code}" is missing required fields (server/username/password). Open /settings.html to complete.`,
      );
    }
    // Default allow_invalid_cert to true — matches legacy Python
    // imaplib behaviour and unbreaks LAN IMAP servers with self-
    // signed certs. The Settings UI exposes this as a checkbox so
    // operators on public IMAP (Gmail, Microsoft, AWS WorkMail) can
    // tighten it.
    const allowInvalidCert = cfg.allow_invalid_cert !== false;
    const client = new ImapFlow({
      host: cfg.server,
      port: cfg.port ?? (cfg.use_ssl === false ? 143 : 993),
      secure: cfg.use_ssl !== false,
      auth: { user: cfg.username, pass: cfg.password },
      tls: { rejectUnauthorized: !allowInvalidCert },
      logger: false,
    });
    await client.connect();
    return client;
  }

  /**
   * Run `fn` against an open IMAP client locked on INBOX. Always
   * releases the lock and closes the connection — even on error.
   */
  async function withInbox<T>(
    fn: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    const client = await connect();
    let lock: { release: () => void } | null = null;
    try {
      lock = await client.getMailboxLock(FOLDER);
      return await fn(client);
    } finally {
      if (lock) lock.release();
      try {
        await client.logout();
      } catch {
        // best-effort close — server may have already dropped the connection
      }
    }
  }

  const mailbox: BankMailboxAdapter = {
    async sync() {
      // No-op in live-fetch mode; we touch the server on every list().
    },

    async list({ fromDate, pageSize }) {
      const since = fromDate instanceof Date ? fromDate : new Date(fromDate);
      try {
        return await withInbox(async (client) => {
          // CRITICAL: search() returns SEQUENCE NUMBERS by default;
          // we MUST pass { uid: true } to get UIDs, otherwise the
          // subsequent fetch(..., { uid: true }) treats sequence
          // numbers as UIDs and silently returns only the
          // overlapping few. This server has sequence 1-130 but
          // UIDs going up to 810.
          const uids = await client.search({ since }, { uid: true });
          if (!uids || uids.length === 0) return { emails: [] };
          // Newest first; cap at pageSize.
          const tail = uids.slice(-pageSize).reverse();
          const emails: MailboxEmail[] = [];
          for await (const msg of client.fetch(
            tail,
            { envelope: true, bodyStructure: true, internalDate: true },
            { uid: true },
          )) {
            emails.push(toMailboxEmail(msg));
          }
          return { emails };
        });
      } catch (err) {
        logger.warn(`[${code}] IMAP list failed: ${(err as Error).message}`);
        throw err;
      }
    },

    async getById(emailId) {
      if (!Number.isFinite(emailId) || emailId <= 0) return null;
      try {
        return await withInbox(async (client) => {
          const msg = await client.fetchOne(
            String(emailId),
            { envelope: true, bodyStructure: true, internalDate: true },
            { uid: true },
          );
          if (!msg) return null;
          return toMailboxEmail(msg);
        });
      } catch (err) {
        logger.warn(`[${code}] IMAP getById(${emailId}) failed: ${(err as Error).message}`);
        return null;
      }
    },
  };

  const attachments: EmailAttachmentProvider = {
    async fetchAttachment({ emailId, attachmentId }) {
      if (!Number.isFinite(emailId) || emailId <= 0) return null;
      if (!attachmentId) return null;
      try {
        return await withInbox(async (client) => {
          // download() streams a single MIME part by its bodyStructure
          // part identifier (e.g., "2", "2.1"). Returns a stream + meta.
          const out = await client.download(String(emailId), attachmentId, {
            uid: true,
          });
          if (!out || !out.content) return null;
          const chunks: Buffer[] = [];
          for await (const chunk of out.content) {
            chunks.push(chunk as Buffer);
          }
          const bytes = Buffer.concat(chunks);
          return {
            bytes: new Uint8Array(bytes),
            filename: out.meta?.filename ?? 'attachment',
            contentType: out.meta?.contentType ?? 'application/octet-stream',
          };
        });
      } catch (err) {
        logger.warn(
          `[${code}] IMAP fetchAttachment(${emailId}, ${attachmentId}) failed: ${(err as Error).message}`,
        );
        return null;
      }
    },
  };

  return { mailbox, attachments };
}

/**
 * Walk a bodyStructure tree and emit attachment-like parts.
 * imapflow exposes the parsed structure as nested `childNodes`; we
 * flatten it and surface anything with a filename or a disposition of
 * "attachment".
 */
function collectAttachments(
  node: unknown,
  out: MailboxAttachment[] = [],
): MailboxAttachment[] {
  if (!node || typeof node !== 'object') return out;
  const n = node as Record<string, unknown>;

  const disposition = (n.disposition as string | undefined)?.toLowerCase();
  const params = (n.dispositionParameters ?? n.parameters) as
    | Record<string, unknown>
    | undefined;
  const filename =
    (params?.filename as string | undefined) ??
    (params?.name as string | undefined) ??
    (n.filename as string | undefined);

  const looksLikeAttachment = disposition === 'attachment' || Boolean(filename);
  if (looksLikeAttachment && typeof n.part === 'string') {
    out.push({
      attachment_id: n.part,
      filename: filename ?? 'attachment',
      size_bytes:
        typeof n.size === 'number'
          ? n.size
          : typeof n.size === 'string'
            ? Number(n.size) || undefined
            : undefined,
      content_type:
        typeof n.type === 'string' && typeof n.subtype === 'string'
          ? `${n.type}/${n.subtype}`
          : null,
    });
  }

  const children = (n.childNodes ?? n.children) as unknown[] | undefined;
  if (Array.isArray(children)) {
    for (const child of children) collectAttachments(child, out);
  }
  return out;
}

function toMailboxEmail(msg: FetchMessageObject): MailboxEmail {
  const envelope = msg.envelope ?? null;
  const from = envelope?.from?.[0];
  const fromAddress = from
    ? from.address ?? (from.name ? from.name : null)
    : null;
  const attachments = collectAttachments(msg.bodyStructure);
  return {
    id: typeof msg.uid === 'number' ? msg.uid : Number(msg.uid),
    subject: envelope?.subject ?? null,
    from_address: fromAddress,
    received_at:
      msg.internalDate instanceof Date
        ? msg.internalDate.toISOString()
        : envelope?.date instanceof Date
          ? envelope.date.toISOString()
          : null,
    has_attachments: attachments.length > 0,
    attachments,
  };
}

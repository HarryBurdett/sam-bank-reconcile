/**
 * Default email-ingest adapter.
 *
 * Bridges SAM's `ctx.emailIngest` service onto the `BankMailboxAdapter`
 * + `EmailAttachmentProvider` shapes the bank-reconcile services
 * expect. Two pieces:
 *
 *  1. Subscribe to mailbox messages via `registerHandler` and keep a
 *     bounded in-memory cache keyed by a sequential numeric ID. The ID
 *     space is the only stable handle the bank-reconcile UI has —
 *     Microsoft Graph message IDs are opaque strings the React table
 *     can't use as React keys reliably.
 *
 *  2. Provide `list/getById/fetchAttachment` against that cache.
 *
 * The cache is per-process and capped (default 1,000 messages). It's
 * not persistent — restarts wipe it. Production deployments should
 * either persist it via SAM's per-app DB (left to the SAM team) or
 * accept the warm-up cost on restart, which is fine because the
 * email-ingest service replays recent messages to handlers on
 * (re)claim.
 */
import type { Knex } from 'knex';
import type { BankMailboxAdapter } from './scan-emails.js';
import type { EmailAttachmentProvider } from './preview-from-email.js';
import type { SamEmailIngestService } from '../app-context.js';
interface IngestOptions {
    emailIngest: SamEmailIngestService;
    /**
     * App ID. Used only to filter `onOwnershipChange` events — the
     * subscription delivers events for any app, but we only care
     * about ones where this plugin gains or loses ownership.
     */
    appId: string;
    /**
     * Optional starter mailbox list. When omitted (the production
     * path), the adapter calls `listMyMailboxes()` itself. Tests
     * supply this to bypass the SAM lookup and inject pre-claimed
     * mailboxes directly.
     */
    initialMailboxes?: Array<{
        id: string;
        email_address?: string | null;
    }>;
    /** Maximum cached messages (FIFO). Default 1,000. */
    cacheSize?: number;
    /**
     * Optional Knex pool — if supplied, the adapter persists incoming
     * messages so they survive restarts.
     */
    appDb?: Knex | null;
    /** Logger (defaults to console). */
    logger?: {
        info: (m: string, ...a: unknown[]) => void;
        warn: (m: string, ...a: unknown[]) => void;
        error: (m: string, ...a: unknown[]) => void;
    };
}
export interface DefaultEmailIngestAdapter {
    mailbox: BankMailboxAdapter;
    attachments: EmailAttachmentProvider;
    /** Detach all listeners and release claimed mailboxes. */
    shutdown: () => Promise<void>;
}
export declare function createDefaultEmailIngestAdapter(options: IngestOptions): DefaultEmailIngestAdapter;
export {};
//# sourceMappingURL=default-email-ingest.d.ts.map
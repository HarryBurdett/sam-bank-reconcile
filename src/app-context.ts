/**
 * Plugin context shape — aligned with SAM's runtime contract.
 *
 * Source of truth is the actual context object SAM's plugin loader
 * builds and passes to a factory:
 *   ~/opera-knowledge-ref/packages/backend/src/plugins/loader.ts
 *   (lines 338-398, function buildPluginRouter)
 *
 * SAM's published interface in
 *   ~/opera-knowledge-ref/packages/backend/src/plugins/context.ts
 * is leaner than what the loader actually injects (it omits `db.app`,
 * `email`, `llm`, `emailIngest`, `graph`, `setSyncTrigger`,
 * `createAIService`). We mirror the runtime shape so plugins can
 * actually use the services SAM provides — and per
 * `docs/plugin-authoring.md §2`: "Treat unknown keys as optional."
 *
 * If SAM later removes a field, that's a breaking change SAM announces;
 * if SAM adds new fields, they're additive — our plugins simply ignore
 * them. The structural typing means SAM doesn't care that we declare
 * the shape locally rather than importing from `@ai-sam/backend`.
 */
import type { Knex } from 'knex';

export type OperaType = 'opera-se' | 'opera-3';

export interface AppLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

/**
 * Email service injected by SAM (via `services/graphEmailService.ts`).
 * `bodyHtml` is the canonical field; `bodyText` is optional fallback.
 * `senderEmail` is a per-call override of the appId-based sender lookup.
 */
export interface SamEmailService {
  send(opts: {
    to: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    subject: string;
    bodyHtml: string;
    bodyText?: string;
    senderEmail?: string | null;
  }): Promise<{ success: boolean; error?: string }>;
  isConfigured(): Promise<boolean>;
}

/**
 * LLM service injected by SAM (via `services/llm/index.ts`).
 * Plugins consume this when `manifest.consumes.llm = true`.
 */
export interface SamLlmService {
  chat(req: {
    messages: Array<{ role: string; content: string }>;
    tools?: unknown[];
    model?: string;
    maxTokens?: number;
    temperature?: number;
    context?: string;
  }): AsyncIterable<unknown>;
  stream(req: {
    messages: Array<{ role: string; content: string }>;
    tools?: unknown[];
    model?: string;
    maxTokens?: number;
    temperature?: number;
    context?: string;
  }): AsyncIterable<unknown>;
}

/**
 * Email-ingest service injected by SAM (via `services/emailIngest/index.ts`).
 * Plugins consume this when `manifest.consumes['email-ingest'] = true`.
 * Typed loosely here — apps that consume it cast to the full type
 * imported from `@ai-sam/backend` at use-site.
 */
export interface SamEmailIngestService {
  claimMailbox(opts: { mailboxEmail: string }): Promise<unknown>;
  releaseMailbox(opts: { mailboxEmail: string }): Promise<void>;
  listMyMailboxes(): Promise<unknown[]>;
  registerHandler(mailboxId: string, handler: (...args: unknown[]) => unknown): () => void;
  fetchAttachment(
    msg: unknown,
    attachmentId: string,
  ): Promise<{ bytes: Buffer; name: string; contentType: string }>;
  getAttachmentText(
    msg: unknown,
    attachmentId: string,
    opts?: { maxBytes?: number },
  ): Promise<{ name: string; contentType: string; text: string; truncated: boolean }>;
  onOwnershipChange(fn: (event: unknown) => Promise<void>): () => void;
  onActivityChange(fn: (event: unknown) => Promise<void>): () => void;
}

/**
 * Microsoft Graph helper injected by SAM. Used for direct Graph calls
 * the email-ingest service doesn't cover (e.g. fetching profile data).
 */
export interface SamGraphService {
  getToken(): Promise<string>;
}

/**
 * Runtime shape of the context SAM's plugin loader builds.
 */
export interface AppContext {
  appId: string;
  tenantId: string;
  config: Record<string, unknown>;
  /** Opera DB type for this tenant: 'opera-se' (SQL) or 'opera-3' (FoxPro) */
  operaType: OperaType | null;
  db: {
    /** SAM's own database */
    sam: Knex;
    /** Per-app DB (provisioned when manifest.backend.separateDatabase=true) */
    app: Knex | null;
    /** Opera3SESystem (or null when no active connection) */
    operaSystem: Knex | null;
    /** Per-Opera-company database resolver */
    getCompanyDb: (code: string) => Knex | null;
  };
  logger: AppLogger;

  /** Optional services SAM also injects — see loader.ts:338-398. */
  createAIService?: () => unknown;
  email?: SamEmailService;
  llm?: SamLlmService;
  emailIngest?: SamEmailIngestService;
  graph?: SamGraphService;
  setSyncTrigger?: (handler: () => Promise<void>) => void;
}

/**
 * SAM's middleware (`packages/backend/src/middleware/company.ts`)
 * extracts the `X-Opera-Company` header and attaches the company code
 * to the request before the plugin router runs. We declare the
 * augmentation here so TypeScript knows the field exists.
 *
 * `req.user` is populated by SAM's `authenticate` middleware when a
 * valid `sam_session` cookie is present (see plugin-authoring.md §3).
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      operaCompany?: string;
      user?: {
        userId: string;
        email: string;
        role: 'admin' | 'user' | 'sam-admin';
        userType: 'sam-admin' | 'tenant-admin' | 'app-user';
        tenantId: string;
        appRole?: string | null;
        permissions: string[];
        tokenType?: string;
      };
    }
  }
}

export type AppBackendFactory = (
  context: AppContext,
) => import('express').Router | Promise<import('express').Router>;

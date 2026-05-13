/**
 * Standalone host entry point.
 *
 * Multi-company:
 *   - For each subdirectory of DATA_ROOT (auto-discovered, optionally
 *     bootstrapped from LEGACY_DATA_ROOT), boot a dedicated plugin
 *     instance from dist/index.js, backed by its own SQLite at
 *     <DATA_ROOT>/<companyCode>/bank-reconcile.sqlite.
 *   - A dispatcher router at /api/apps/bank-reconcile inspects the
 *     session cookie to forward each request to the right per-company
 *     router.
 *   - Login form picks the company (alongside the shared password) and
 *     bakes companyCode into the signed session cookie.
 *
 * SAM contract is untouched — `standalone/` is sibling to the SAM
 * plugin contract; SAM-plugged mode runs dist/index.js with SAM's own
 * AppContext and never imports this module.
 */
import express, { type Express, type Router, type Request, type Response, type NextFunction } from 'express';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { loadConfig, type StandaloneConfig } from './config.js';
import { loginRouter, requireAuth } from './auth.js';
import { selectAdapter, type OperaAdapter } from './opera-adapter.js';
import {
  discoverCompanies,
  loadCompany,
  loadOperaConfig,
  type CompanyInstance,
} from './company-registry.js';
import type {
  AppBackendFactory,
  AppLogger,
} from '../src/app-context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const DIST_ENTRY = resolve(repoRoot, 'dist', 'index.js');
const FRONTEND_DIST = resolve(repoRoot, 'frontend', 'dist');
const PUBLIC_DIR = resolve(__dirname, 'public');
const APP_ROUTE = '/api/apps/bank-reconcile';

const consoleLogger: AppLogger = {
  info: (msg, ...args) => console.log(`[info] ${msg}`, ...args),
  warn: (msg, ...args) => console.warn(`[warn] ${msg}`, ...args),
  error: (msg, ...args) => console.error(`[error] ${msg}`, ...args),
  debug: (msg, ...args) => console.log(`[debug] ${msg}`, ...args),
};

export interface BuildAppOptions {
  dataDir?: string;
}

export interface BuiltApp {
  app: Express;
  config: StandaloneConfig;
  companies: Map<string, CompanyInstance>;
  operaAdapter: OperaAdapter;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<BuiltApp> {
  if (!existsSync(DIST_ENTRY)) {
    throw new Error(
      `${DIST_ENTRY} not found — run \`npm run build\` first.`,
    );
  }

  const config = loadConfig({ dataDir: opts.dataDir });
  const pluginMod = (await import(DIST_ENTRY)) as { default: AppBackendFactory };

  const codes = discoverCompanies(config.dataRoot, config.legacyDataRoot);
  if (codes.length === 0) {
    throw new Error(
      `No companies found under ${config.dataRoot}. Create a subdirectory ` +
        `per company (e.g., ${config.dataRoot}/intsys/) or set LEGACY_DATA_ROOT ` +
        `to bootstrap from an existing data tree.`,
    );
  }

  // Build the standalone-company → { database, operaVersion } map by
  // reading each company's opera.json (seeding from legacy on first
  // run if available).
  const operaCompanies = new Map<
    string,
    { database: string; operaVersion?: string }
  >();
  for (const code of codes) {
    const cfg = loadOperaConfig(
      config.dataRoot,
      config.legacyCompaniesDir,
      code,
      consoleLogger,
    );
    if (cfg) {
      operaCompanies.set(code, {
        database: cfg.database,
        operaVersion: cfg.operaVersion,
      });
    }
  }

  const operaAdapter = await selectAdapter({
    name: config.operaAdapter,
    logger: consoleLogger,
    mssql: config.mssql
      ? { ...config.mssql, companies: operaCompanies }
      : undefined,
    opera3: config.opera3
      ? { ...config.opera3, companies: operaCompanies }
      : undefined,
  });

  const companies = new Map<string, CompanyInstance>();
  try {
    for (const code of codes) {
      consoleLogger.info(`loading company "${code}"`);
      const instance = await loadCompany(code, {
        dataRoot: config.dataRoot,
        legacyDataRoot: config.legacyDataRoot,
        operaAdapter,
        logger: consoleLogger,
        factory: pluginMod.default,
      });
      companies.set(code, instance);
    }
  } catch (err) {
    for (const c of companies.values()) {
      await c.samDb.destroy().catch(() => {});
      await c.appDb.destroy().catch(() => {});
    }
    if (operaAdapter.destroy) await operaAdapter.destroy().catch(() => {});
    throw err;
  }

  const app = express();
  // Trust upstream proxies so req.protocol honors X-Forwarded-Proto
  // when behind TLS termination. Required for the auth middleware
  // to set Secure on cookies. Operators behind a public-IP proxy
  // must widen this via TRUST_PROXY (see README) — the loopback
  // default does not match public IPs.
  app.set('trust proxy', config.trustProxy);

  app.use(express.json({ limit: '10mb' }));

  // /healthz — liveness/readiness probe. Cheap, no auth, no DB hit.
  // Reverse proxies / orchestrators can use this without holding a
  // session.
  app.get('/healthz', (_req, res) => {
    res.json({
      ok: true,
      companies: Array.from(companies.keys()),
      adapter: config.operaAdapter,
    });
  });

  // /login.html — explicit, before auth.
  app.get('/login.html', (_req, res) => {
    res.sendFile(resolve(PUBLIC_DIR, 'login.html'));
  });

  // /auth/* — login + logout + companies (no auth).
  app.use('/auth', loginRouter(config, () => Array.from(companies.keys())));

  // Everything below requires auth.
  app.use(requireAuth(config));

  // Authenticated /auth/me — caller can read which company the session selected.
  app.get('/auth/me', (req: Request, res: Response) => {
    res.json({
      user: req.user,
      company: req.standaloneCompany ?? null,
    });
  });

  // Read-only system info for the Settings page — surfaces the
  // Opera connection params and per-company database mapping so the
  // operator can see what backend this host is wired up to without
  // SSHing in to read env vars. Secrets are never returned; the
  // password is reported only as a `configured` boolean.
  app.get('/auth/system-info', (req: Request, res: Response) => {
    const code = req.standaloneCompany;
    const company = code ? companies.get(code) : undefined;
    let operaDatabase: string | null = null;
    let operaVersion: string | null = null;
    if (code) {
      const operaFile = join(config.dataRoot, code, 'opera.json');
      if (existsSync(operaFile)) {
        try {
          const parsed = JSON.parse(readFileSync(operaFile, 'utf8')) as {
            database?: string;
            operaVersion?: string;
          };
          operaDatabase = parsed.database ?? null;
          operaVersion = parsed.operaVersion ?? null;
        } catch {
          // surface as null
        }
      }
    }
    res.json({
      active_company: {
        code,
        opera_database: operaDatabase,
        opera_version: operaVersion,
      },
      adapter: config.operaAdapter,
      opera_sql: config.mssql
        ? {
            host: config.mssql.host,
            port: config.mssql.port,
            username: config.mssql.user,
            password_configured: Boolean(config.mssql.password),
            encrypt: config.mssql.encrypt,
            trust_server_certificate: config.mssql.trustServerCertificate,
          }
        : null,
      opera3: config.opera3
        ? {
            agent_url: config.opera3.agentUrl,
            agent_key_configured: Boolean(config.opera3.agentKey),
            data_path: config.opera3.dataPath,
          }
        : null,
      data_root: config.dataRoot,
      legacy_data_root: config.legacyDataRoot,
      // Has the Opera adapter ever opened a pool for this company?
      // (lazy — pool is created on first getCompanyDb call)
      company_loaded: Boolean(company),
    });
  });

  // Live customer search against Opera's sname table for the
  // session-selected company. UI dropdowns can call this. Lives at
  // the host layer (not the plugin router) so the SAM contract stays
  // zero-diff.
  app.get('/auth/customers-search', async (req: Request, res: Response) => {
    const code = req.standaloneCompany;
    if (!code) {
      res.status(400).json({ error: 'no company in session', customers: [] });
      return;
    }
    const q = typeof req.query.q === 'string' ? req.query.q : (typeof req.query.search === 'string' ? req.query.search : '');
    const limitRaw = Number.parseInt(String(req.query.limit ?? '20'), 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 20;

    const operaDb = operaAdapter.getCompanyDb(code);
    if (!operaDb) {
      res.json({ customers: [], note: 'Opera connection not available for this company.' });
      return;
    }
    try {
      const pattern = `%${(q ?? '').trim().toUpperCase()}%`;
      // Opera's sn_name column commonly uses a case-sensitive
      // collation, so we upper-case both sides to make the search
      // robust to whatever the operator types.
      const rows = (await operaDb.raw(
        `SELECT TOP (?)
            RTRIM(sn_account) AS account,
            RTRIM(sn_name)    AS name
         FROM sname WITH (NOLOCK)
         WHERE UPPER(sn_account) LIKE ? OR UPPER(sn_name) LIKE ?
         ORDER BY sn_name`,
        [limit, pattern, pattern],
      )) as Array<{ account: string; name: string }> | { recordset?: Array<{ account: string; name: string }> };
      const list = Array.isArray(rows)
        ? rows
        : Array.isArray(rows.recordset)
          ? rows.recordset
          : [];
      res.json({ customers: list });
    } catch (err) {
      consoleLogger.warn(`[${code}] customer-search failed: ${(err as Error).message}`);
      res.status(500).json({ error: (err as Error).message, customers: [] });
    }
  });

  // Update the per-company opera.json (database + operaVersion).
  // The Opera SQL connection details (host/user/password/etc.) are
  // bootstrap-time env vars and are not editable here — they're
  // host-wide and changing them requires restarting the process.
  app.put('/auth/system-info', async (req: Request, res: Response) => {
    const code = req.standaloneCompany;
    if (!code) {
      res.status(400).json({ error: 'no company in session' });
      return;
    }
    const body = (req.body ?? {}) as {
      opera_database?: unknown;
      opera_version?: unknown;
    };
    const database =
      typeof body.opera_database === 'string' ? body.opera_database.trim() : '';
    const operaVersion =
      typeof body.opera_version === 'string' ? body.opera_version.trim() : '';
    if (database.length === 0) {
      res.status(400).json({ error: 'opera_database is required' });
      return;
    }
    if (operaVersion.length > 0 && !['SE', '3'].includes(operaVersion)) {
      res.status(400).json({ error: 'opera_version must be "SE" or "3"' });
      return;
    }

    const dir = join(config.dataRoot, code);
    mkdirSync(dir, { recursive: true });
    const operaFile = join(dir, 'opera.json');
    const payload: { database: string; operaVersion?: string } = { database };
    if (operaVersion.length > 0) payload.operaVersion = operaVersion;
    writeFileSync(operaFile, JSON.stringify(payload, null, 2) + '\n');

    // Tell the adapter to drop any cached pool for this company so
    // the next getCompanyDb() call rebuilds it against the new
    // database / version.
    if (operaAdapter.invalidateCompany) {
      await operaAdapter.invalidateCompany(code, payload);
    }
    consoleLogger.info(
      `[${code}] opera.json updated: database=${payload.database} operaVersion=${payload.operaVersion ?? '(default SE)'}`,
    );
    res.json({ ok: true, opera_database: payload.database, opera_version: payload.operaVersion ?? null });
  });

  // -------- Email provider config (per-company) --------
  // Stored as a single row in the per-company `settings` table under
  // key='email_provider'. The plugin's scan-emails / mailbox flow
  // currently still requires a wired ctx.emailIngest — this endpoint
  // just persists the operator's IMAP/Graph/Gmail credentials so they
  // survive process restarts and so a future email adapter can pick
  // them up without operator re-entry.
  app.get('/auth/email-config', async (req: Request, res: Response) => {
    const code = req.standaloneCompany;
    if (!code) {
      res.status(400).json({ error: 'no company in session' });
      return;
    }
    const company = companies.get(code);
    if (!company) {
      res.status(404).json({ error: `unknown company: ${code}` });
      return;
    }
    const row = (await company.appDb('settings')
      .where({ key: 'email_provider' })
      .first()) as { value?: string } | undefined;
    if (!row?.value) {
      res.json({ configured: false, email_provider: null });
      return;
    }
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(row.value);
    } catch {
      res.json({
        configured: false,
        email_provider: null,
        error: 'stored email_provider is not valid JSON',
      });
      return;
    }
    // Redact the password — surface a `password_configured` boolean
    // so the UI can show "(unchanged)" without leaking the secret.
    const passwordConfigured =
      typeof parsed.password === 'string' && parsed.password.length > 0;
    const safe = { ...parsed };
    delete safe.password;
    res.json({
      configured: true,
      email_provider: { ...safe, password_configured: passwordConfigured },
    });
  });

  app.put('/auth/email-config', async (req: Request, res: Response) => {
    const code = req.standaloneCompany;
    if (!code) {
      res.status(400).json({ error: 'no company in session' });
      return;
    }
    const company = companies.get(code);
    if (!company) {
      res.status(404).json({ error: `unknown company: ${code}` });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;

    const providerType = typeof body.provider_type === 'string' ? body.provider_type : 'imap';
    if (!['imap', 'microsoft', 'gmail'].includes(providerType)) {
      res.status(400).json({ error: 'provider_type must be imap, microsoft, or gmail' });
      return;
    }

    // For IMAP the operator-editable fields are: server, port, username,
    // password, use_ssl, from_email. We validate the minimal set
    // required to actually connect to a server later.
    if (providerType === 'imap') {
      if (typeof body.server !== 'string' || body.server.trim().length === 0) {
        res.status(400).json({ error: 'server is required for IMAP' });
        return;
      }
      if (typeof body.username !== 'string' || body.username.trim().length === 0) {
        res.status(400).json({ error: 'username is required for IMAP' });
        return;
      }
    }

    // Preserve the existing password when the UI sends an empty string
    // (the "(unchanged)" case — operator left the password field blank).
    const existing = (await company.appDb('settings')
      .where({ key: 'email_provider' })
      .first()) as { value?: string } | undefined;
    let existingPassword: string | null = null;
    if (existing?.value) {
      try {
        const parsed = JSON.parse(existing.value) as Record<string, unknown>;
        if (typeof parsed.password === 'string') existingPassword = parsed.password;
      } catch {
        // Treat unreadable existing config as empty.
      }
    }

    const incomingPassword =
      typeof body.password === 'string' && body.password.length > 0
        ? body.password
        : existingPassword;

    const merged: Record<string, unknown> = {
      name: typeof body.name === 'string' ? body.name : '',
      provider_type: providerType,
    };
    for (const k of [
      'server',
      'port',
      'username',
      'use_ssl',
      'from_email',
      'allow_invalid_cert',
    ]) {
      if (body[k] !== undefined) merged[k] = body[k];
    }
    if (incomingPassword !== null) merged[`password`] = incomingPassword;

    const value = JSON.stringify(merged);
    if (existing) {
      await company.appDb('settings')
        .where({ key: 'email_provider' })
        .update({ value, updated_at: company.appDb.fn.now() });
    } else {
      await company.appDb('settings').insert({ key: 'email_provider', value });
    }
    consoleLogger.info(
      `[${code}] email_provider updated (type=${providerType}, name=${merged.name})`,
    );

    const safe = { ...merged };
    delete safe.password;
    res.json({
      ok: true,
      email_provider: {
        ...safe,
        password_configured:
          typeof incomingPassword === 'string' && incomingPassword.length > 0,
      },
    });
  });

  // Frontend static bundle.
  app.use(`${APP_ROUTE}/static`, express.static(FRONTEND_DIST));

  // Dispatcher: forward /api/apps/bank-reconcile/* to the per-company router.
  app.use(APP_ROUTE, makeDispatcher(companies));

  // App shell + any other authenticated static assets.
  app.use(express.static(PUBLIC_DIR));

  // Catch-all error handler.
  app.use(
    (
      err: Error,
      _req: Request,
      res: Response,
      _next: NextFunction,
    ) => {
      consoleLogger.error('unhandled:', err);
      res.status(500).json({ error: err.message });
    },
  );

  return { app, config, companies, operaAdapter };
}

function makeDispatcher(companies: Map<string, CompanyInstance>): Router {
  const dispatch = express.Router();
  dispatch.use((req: Request, res: Response, next: NextFunction) => {
    const code = req.standaloneCompany;
    if (!code) {
      res.status(400).json({ error: 'no company in session' });
      return;
    }
    const instance = companies.get(code);
    if (!instance) {
      res.status(404).json({ error: `unknown company: ${code}` });
      return;
    }
    instance.router(req, res, next);
  });
  return dispatch;
}

async function main(): Promise<void> {
  const { app, config, companies, operaAdapter } = await buildApp();
  const server = app.listen(config.port, () => {
    console.log(`\n[standalone] listening on http://localhost:${config.port}`);
    console.log(`[standalone] data root:  ${config.dataRoot}`);
    if (config.legacyDataRoot) {
      console.log(`[standalone] legacy root: ${config.legacyDataRoot}`);
    }
    if (config.legacyCompaniesDir) {
      console.log(`[standalone] legacy companies: ${config.legacyCompaniesDir}`);
    }
    console.log(`[standalone] companies:  ${Array.from(companies.keys()).join(', ')}`);
    console.log(`[standalone] adapter:    ${config.operaAdapter}`);
    if (config.mssql) {
      console.log(`[standalone] mssql:      ${config.mssql.user}@${config.mssql.host}:${config.mssql.port}`);
    }
  });

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[standalone] ${signal} received — shutting down`);
    server.close((err) => {
      if (err) console.error('[standalone] http close error:', err);
    });
    // Drain Knex pools.
    for (const c of companies.values()) {
      await c.samDb.destroy().catch(() => {});
      await c.appDb.destroy().catch(() => {});
    }
    if (operaAdapter.destroy) {
      await operaAdapter.destroy().catch(() => {});
    }
    process.exit(0);
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// Run only when invoked as the entry point, not when imported by tests.
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[standalone] failed to start:', err);
    process.exit(1);
  });
}

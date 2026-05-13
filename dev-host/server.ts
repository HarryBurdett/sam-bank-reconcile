/**
 * Local dev host that loads the Bank Reconciliation SAM plugin standalone.
 *
 * NOT a SAM-compatible host — only enough scaffolding to render the
 * frontend and answer endpoints that don't depend on a real Opera DB.
 * `db.getCompanyDb()` returns null, so any route that touches Opera
 * will surface a 500/null error.
 */
import express from 'express';
import knex, { type Knex } from 'knex';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import type { AppContext, AppBackendFactory } from '../src/app-context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const APP_ROUTE = '/api/apps/bank-reconcile';

function makeInMemoryKnex(): Knex {
  return knex({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 },
  });
}

async function runMigrations(db: Knex): Promise<void> {
  const dir = resolve(repoRoot, 'db/migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.ts')).sort();
  for (const file of files) {
    const mod = (await import(resolve(dir, file))) as {
      up: (k: Knex) => Promise<void>;
    };
    await mod.up(db);
    console.log(`  migrated ${file}`);
  }
}

function makeLogger() {
  return {
    info: (msg: string, ...args: unknown[]) => console.log(`[info] ${msg}`, ...args),
    warn: (msg: string, ...args: unknown[]) => console.warn(`[warn] ${msg}`, ...args),
    error: (msg: string, ...args: unknown[]) => console.error(`[error] ${msg}`, ...args),
    debug: (msg: string, ...args: unknown[]) => console.log(`[debug] ${msg}`, ...args),
  };
}

async function main() {
  console.log('[dev-host] booting in-memory SQLite for db.app');
  const appDb = makeInMemoryKnex();
  console.log('[dev-host] running plugin migrations');
  await runMigrations(appDb);

  const samDb = makeInMemoryKnex();

  const ctx: AppContext = {
    appId: 'bank-reconcile',
    tenantId: 'dev-tenant',
    config: {},
    operaType: 'opera-se',
    db: {
      sam: samDb,
      app: appDb,
      operaSystem: null,
      getCompanyDb: () => null,
    },
    logger: makeLogger(),
  };

  console.log('[dev-host] loading plugin factory from dist/index.js');
  const pluginMod = (await import(resolve(repoRoot, 'dist/index.js'))) as {
    default: AppBackendFactory;
  };
  const pluginRouter = await pluginMod.default(ctx);

  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Inject a stub user + company on every plugin request — the router
  // expects `req.user` from SAM's auth middleware.
  app.use(APP_ROUTE, (req, _res, next) => {
    req.user = {
      userId: 'dev-user',
      email: 'dev@example.com',
      role: 'admin',
      userType: 'tenant-admin',
      tenantId: 'dev-tenant',
      permissions: ['opera:read', 'opera:write', 'sam:config:read'],
    };
    const company = req.header('X-Opera-Company');
    if (company) req.operaCompany = company;
    next();
  });

  app.use(APP_ROUTE, pluginRouter);

  // Serve the frontend bundle at the static path the manifest implies.
  app.use(`${APP_ROUTE}/static`, express.static(resolve(repoRoot, 'frontend/dist')));

  // HTML shell.
  app.use(express.static(resolve(__dirname, 'public')));

  // Catch-all errors so they don't kill the process.
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error('[dev-host] unhandled:', err);
      res.status(500).json({ error: err.message });
    },
  );

  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => {
    console.log(`\n[dev-host] http://localhost:${port}`);
    console.log(`[dev-host] plugin API:  ${APP_ROUTE}/*`);
    console.log(`[dev-host] frontend:    ${APP_ROUTE}/static/index.js`);
  });
}

main().catch((err) => {
  console.error('[dev-host] failed to start:', err);
  process.exit(1);
});

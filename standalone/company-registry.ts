/**
 * Multi-company plugin loader for the standalone host.
 *
 * Each "company" is a top-level subdirectory under DATA_ROOT
 * (e.g., ./data/intsys, ./data/cloudsis). Each gets:
 *   - its own SQLite file at <root>/<code>/bank-reconcile.sqlite
 *   - its own Knex pool
 *   - its own AppContext + plugin Router instance
 *
 * This mirrors the legacy Python layout (data/<company>/bank_reconcile/…)
 * while keeping the SAM plugin contract untouched: SAM-plugged mode
 * still boots one plugin instance per SAM tenant, just like before;
 * `company-registry.ts` is standalone-only code.
 */
import knex, { type Knex } from 'knex';
import { buildOperaAwareImportLock } from './import-lock-mssql.js';
import { buildImapAdapter } from './imap-mailbox-adapter.js';
import { buildGeminiPdfExtractor } from './gemini-pdf-extractor.js';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { Router } from 'express';
import { runMigrations } from './migrate.js';
import type { OperaAdapter } from './opera-adapter.js';
import type {
  AppContext,
  AppBackendFactory,
  AppLogger,
} from '../src/app-context.js';

export interface OperaCompanyConfig {
  /** Opera database name, e.g. "Opera3SECompany00I". */
  database: string;
  /** "SE" or "3" — from legacy companies/<code>.json. */
  operaVersion?: string;
}

export interface CompanyInstance {
  code: string;
  ctx: AppContext;
  router: Router;
  appDb: Knex;
  samDb: Knex;
}

export interface LoadOptions {
  dataRoot: string;
  legacyDataRoot: string | null;
  operaAdapter: OperaAdapter;
  logger: AppLogger;
  factory: AppBackendFactory;
  /** Gemini API key, if configured — wires the PDF extractor. */
  geminiApiKey?: string | null;
  geminiModel?: string;
}

/** Legacy data lives at <legacyDataRoot>/<code>/<LEGACY_APP_SUBDIR>/ */
const LEGACY_APP_SUBDIR = 'bank_reconcile';
/** Per-company SQLite filename inside <dataRoot>/<code>/. */
const APP_DB_FILENAME = 'bank-reconcile.sqlite';

/**
 * Return the sorted list of company codes discovered under dataRoot
 * (plus any new ones bootstrapped from legacyDataRoot). Skips hidden
 * dirs and non-directory entries.
 */
export function discoverCompanies(
  dataRoot: string,
  legacyDataRoot: string | null,
): string[] {
  mkdirSync(dataRoot, { recursive: true });

  if (legacyDataRoot && existsSync(legacyDataRoot)) {
    for (const entry of readdirSync(legacyDataRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const legacyApp = join(legacyDataRoot, entry.name, LEGACY_APP_SUBDIR);
      if (!existsSync(legacyApp)) continue;
      const newDir = join(dataRoot, entry.name);
      if (!existsSync(newDir)) mkdirSync(newDir, { recursive: true });
    }
  }

  return readdirSync(dataRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();
}

/**
 * Load `<dataRoot>/<code>/opera.json` if it exists, optionally seeding
 * it from `<legacyCompaniesDir>/<code>.json` on first run. Returns null
 * when no Opera config is available for the company — the MSSQL adapter
 * skips that company; the noop adapter is unaffected.
 */
export function loadOperaConfig(
  dataRoot: string,
  legacyCompaniesDir: string | null,
  code: string,
  logger: AppLogger,
): OperaCompanyConfig | null {
  const newFile = join(dataRoot, code, 'opera.json');
  if (!existsSync(newFile)) {
    if (legacyCompaniesDir) {
      const seeded = trySeedFromLegacyCompanyJson(
        legacyCompaniesDir,
        code,
        newFile,
        logger,
      );
      if (!seeded) return null;
    } else {
      return null;
    }
  }

  try {
    const parsed = JSON.parse(readFileSync(newFile, 'utf8')) as Partial<OperaCompanyConfig>;
    if (typeof parsed.database !== 'string' || parsed.database.length === 0) {
      logger.warn(`[${code}] opera.json missing "database" field`);
      return null;
    }
    return {
      database: parsed.database,
      operaVersion: parsed.operaVersion,
    };
  } catch (err) {
    logger.warn(`[${code}] opera.json unreadable: ${(err as Error).message}`);
    return null;
  }
}

function trySeedFromLegacyCompanyJson(
  legacyCompaniesDir: string,
  code: string,
  newFile: string,
  logger: AppLogger,
): boolean {
  const legacyFile = join(legacyCompaniesDir, `${code}.json`);
  if (!existsSync(legacyFile)) return false;
  try {
    const parsed = JSON.parse(readFileSync(legacyFile, 'utf8')) as {
      database?: string;
      opera_version?: string;
    };
    if (!parsed.database) return false;
    const out: OperaCompanyConfig = { database: parsed.database };
    if (parsed.opera_version) out.operaVersion = parsed.opera_version;
    mkdirSync(join(newFile, '..'), { recursive: true });
    writeFileSync(newFile, JSON.stringify(out, null, 2) + '\n');
    logger.info(`[${code}] seeded opera.json from legacy company file (db=${out.database})`);
    return true;
  } catch (err) {
    logger.warn(
      `[${code}] could not seed opera.json from ${legacyFile}: ${(err as Error).message}`,
    );
    return false;
  }
}

/**
 * Build per-company AppContext + plugin Router. Runs migrations on the
 * per-company SQLite. On first boot, seeds the settings table from the
 * legacy `core/company_settings.json` and copies rows from the legacy
 * SQLite files (bank_aliases.db, bank_patterns.db, deferred_transactions.db)
 * into the new per-company DB.
 */
export async function loadCompany(
  code: string,
  opts: LoadOptions,
): Promise<CompanyInstance> {
  const companyDir = join(opts.dataRoot, code);
  mkdirSync(companyDir, { recursive: true });
  const dbPath = join(companyDir, APP_DB_FILENAME);

  let appDb: Knex | undefined;
  let samDb: Knex | undefined;
  try {
    appDb = knex({
      client: 'sqlite3',
      connection: { filename: dbPath },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 },
    });
    await runMigrations(appDb);
    await seedSettingsFromLegacy(appDb, opts.legacyDataRoot, code, opts.logger);
    await seedEmailProviderFromLegacy(appDb, opts.legacyDataRoot, code, opts.logger);
    await seedTablesFromLegacyDbs(appDb, opts.legacyDataRoot, code, opts.logger);

    samDb = knex({
      client: 'sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 },
    });

    const ctx: AppContext = {
      appId: 'bank-reconcile',
      tenantId: `standalone:${code}`,
      config: {},
      operaType: opts.operaAdapter.operaType,
      db: {
        sam: samDb,
        app: appDb,
        operaSystem: null,
        getCompanyDb: (c) => opts.operaAdapter.getCompanyDb(c),
      },
      logger: opts.logger,
    };

    // Inject the SQL Server applock-backed import lock. Picks MSSQL
    // when an Opera Knex pool is available for this company (opera-se);
    // falls back to in-memory when not (opera-3 / noop). The adapter
    // hook the plugin reads is `ctx.bankImportLock`.
    (ctx as Record<string, unknown>).bankImportLock =
      buildOperaAwareImportLock(
        code,
        () => opts.operaAdapter.getCompanyDb(code),
        opts.logger,
      );

    // Inject the IMAP mailbox adapter so /scan-emails and friends
    // can reach the operator's mailbox. The adapter re-reads
    // `settings.email_provider` on every call, so the Settings UI's
    // saves take effect without restarting. When the settings row
    // is missing or the provider is non-IMAP, the adapter throws a
    // clean error and the plugin's route returns a user-friendly
    // 400/503.
    const imap = buildImapAdapter({ code, appDb, logger: opts.logger });
    (ctx as Record<string, unknown>).bankMailboxAdapter = imap.mailbox;
    (ctx as Record<string, unknown>).bankEmailAttachments = imap.attachments;

    // Gemini-backed PDF extractor. The plugin uses `ctx.bankPdfExtractor`
    // for both /api/bank-import/preview-from-pdf (Analyse) and
    // /api/bank-import/import-from-pdf (full import). When unset, the
    // plugin falls back to ctx.llm (Claude); legacy parity requires
    // Gemini per sql_rag/statement_reconcile.py:84.
    if (opts.geminiApiKey) {
      (ctx as Record<string, unknown>).bankPdfExtractor =
        buildGeminiPdfExtractor({
          apiKey: opts.geminiApiKey,
          model: opts.geminiModel ?? 'gemini-2.5-flash',
          logger: opts.logger,
        });
      opts.logger.info(
        `[${code}] Gemini PDF extractor wired (model=${opts.geminiModel ?? 'gemini-2.5-flash'})`,
      );
    }

    // Reconciled-key store: the plugin's /scan-emails route uses this
    // to mark already-processed candidates so the operator doesn't
    // re-import them. v1 returns empty sets — every candidate shows
    // up. A future iteration can query bank_statement_imports for
    // (email_id, attachment_id) tuples already posted to Opera.
    (ctx as Record<string, unknown>).bankReconciledKeyStore = {
      getReconciledKeys: async (_bankCode: string) => new Set<string>(),
      getReconciledFilenames: async (_bankCode: string) => new Set<string>(),
    };

    const router = await opts.factory(ctx);
    return { code, ctx, router, appDb, samDb };
  } catch (err) {
    if (samDb) await samDb.destroy().catch(() => {});
    if (appDb) await appDb.destroy().catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Legacy seeding
// ---------------------------------------------------------------------------

/**
 * Seed the settings table from the legacy
 * `<legacy>/<code>/core/company_settings.json` file. Two settings
 * keys come out of this file:
 *
 *   - `folder_settings` (JSON `{ base_folder, archive_folder }`)
 *     ← `bank_statements_base_folder` + `bank_statements_archive_folder`
 *   - `recurring_entries_mode` (JSON-encoded `"process"` or `"warn"`)
 *     ← `recurring_entries_mode`
 *
 * Each setting is seeded independently and only when the destination
 * row does not already exist — so re-running against a partially-
 * populated database is safe.
 */
async function seedSettingsFromLegacy(
  appDb: Knex,
  legacyDataRoot: string | null,
  code: string,
  logger: AppLogger,
): Promise<void> {
  if (!legacyDataRoot) return;
  const legacyFile = resolve(legacyDataRoot, code, 'core', 'company_settings.json');
  if (!existsSync(legacyFile)) return;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(legacyFile, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    logger.warn(`[${code}] legacy company_settings.json unreadable: ${(err as Error).message}`);
    return;
  }

  const base =
    typeof parsed.bank_statements_base_folder === 'string'
      ? parsed.bank_statements_base_folder
      : '';
  const archive =
    typeof parsed.bank_statements_archive_folder === 'string'
      ? parsed.bank_statements_archive_folder
      : '';
  if (base.length > 0 || archive.length > 0) {
    const existing = await appDb('settings').where({ key: 'folder_settings' }).first();
    if (!existing) {
      await appDb('settings').insert({
        key: 'folder_settings',
        value: JSON.stringify({ base_folder: base, archive_folder: archive }),
      });
      logger.info(`[${code}] seeded folder_settings from legacy company_settings.json`);
    }
  }

  const mode = parsed.recurring_entries_mode;
  if (mode === 'process' || mode === 'warn') {
    const existing = await appDb('settings').where({ key: 'recurring_entries_mode' }).first();
    if (!existing) {
      await appDb('settings').insert({
        key: 'recurring_entries_mode',
        value: JSON.stringify(mode),
      });
      logger.info(`[${code}] seeded recurring_entries_mode=${mode} from legacy company_settings.json`);
    }
  }
}

/** Convert a legacy row into the new schema's column shape. */
type RowTransform = (row: Record<string, unknown>) => Record<string, unknown>;

/**
 * Per-table copy spec. `transform` overrides the default
 * column-intersection projection. Tables whose new-schema columns
 * match the legacy column names (e.g. `deferred_transactions`)
 * leave `transform` unset and use the default.
 */
interface LegacyTableSpec {
  name: string;
  transform?: RowTransform;
}

/**
 * Seed the IMAP / email-provider config from the legacy
 * `<legacy>/<code>/core/email_data.db.email_providers` table. The
 * legacy schema supports `microsoft` / `gmail` / `imap`; in practice
 * existing customers only have one enabled IMAP row. We collapse it
 * into a single `settings` row keyed `email_provider` with JSON
 * value `{ name, provider_type, ...legacy config_json }`.
 *
 * Idempotent: skipped when the settings row already exists.
 */
async function seedEmailProviderFromLegacy(
  appDb: Knex,
  legacyDataRoot: string | null,
  code: string,
  logger: AppLogger,
): Promise<void> {
  if (!legacyDataRoot) return;
  const legacyFile = resolve(legacyDataRoot, code, 'core', 'email_data.db');
  if (!existsSync(legacyFile)) return;

  const existing = await appDb('settings').where({ key: 'email_provider' }).first();
  if (existing) return;

  const legacyDb = knex({
    client: 'sqlite3',
    connection: { filename: legacyFile },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 },
  });
  try {
    if (!(await legacyDb.schema.hasTable('email_providers'))) return;
    const row = (await legacyDb('email_providers')
      .where({ enabled: 1 })
      .orderBy('id', 'asc')
      .first()) as
      | { name?: string; provider_type?: string; config_json?: string | null }
      | undefined;
    if (!row || !row.config_json) return;
    let cfg: Record<string, unknown>;
    try {
      cfg = JSON.parse(row.config_json) as Record<string, unknown>;
    } catch (err) {
      logger.warn(
        `[${code}] legacy email_providers.config_json unparseable: ${(err as Error).message}`,
      );
      return;
    }
    const merged: Record<string, unknown> = {
      name: row.name ?? '',
      provider_type: row.provider_type ?? 'imap',
      ...cfg,
    };
    await appDb('settings').insert({
      key: 'email_provider',
      value: JSON.stringify(merged),
    });
    logger.info(`[${code}] seeded email_provider from legacy email_data.db (name=${row.name ?? '<unnamed>'})`);
  } finally {
    await legacyDb.destroy();
  }
}

/**
 * Mapping from per-table legacy SQLite filename → tables to copy.
 * Each table is copied independently; copy is a no-op when the
 * destination already has rows (idempotent re-runs are safe).
 *
 * Deliberately skipped:
 *   - pdf_extraction_cache.db — rebuilds from PDF re-reads.
 *   - import_locks.db — runtime state; stale locks should not survive
 *     a migration.
 *   - bank_import_keywords (inside bank_patterns.db) — no destination
 *     table in the current SAM schema; legacy customers have 0 rows
 *     anyway.
 *
 * Two tables (`bank_import_aliases`, `bank_import_patterns`) have
 * substantially different column names in the new schema and need
 * explicit transformers; everything else is either schema-aligned
 * (deferred_transactions) or empty in real-world legacy customers
 * (repeat_entry_aliases, match_config, duplicate_overrides,
 * ai_suggestions).
 */
/**
 * Plan entries are addressed relative to a *sub-root* under the
 * per-company legacy directory:
 *   - `bank_reconcile/` holds aliases / patterns / deferred (split DBs)
 *   - `core/` holds email_data.db, which doubles as the bank import
 *     history store (`bank_statement_imports`, `bank_statement_transactions`,
 *     `bank_import_drafts`, `ignored_bank_transactions`).
 *
 * Both sub-roots get walked; per-file probes are no-ops when the file
 * is missing, so this works for partial deployments too.
 */
const LEGACY_TABLE_PLAN: ReadonlyArray<{
  subdir: string;
  file: string;
  tables: LegacyTableSpec[];
}> = [
  {
    subdir: LEGACY_APP_SUBDIR, // 'bank_reconcile'
    file: 'bank_aliases.db',
    tables: [
      { name: 'bank_import_aliases', transform: transformBankImportAlias },
      { name: 'repeat_entry_aliases', transform: transformRepeatEntryAlias },
      { name: 'match_config' },
      { name: 'duplicate_overrides' },
      { name: 'ai_suggestions' },
    ],
  },
  {
    subdir: LEGACY_APP_SUBDIR,
    file: 'bank_patterns.db',
    tables: [{ name: 'bank_import_patterns', transform: transformBankImportPattern }],
  },
  {
    subdir: LEGACY_APP_SUBDIR,
    file: 'deferred_transactions.db',
    tables: [{ name: 'deferred_transactions' }],
  },
  {
    // Bank import history lives in core/email_data.db (the legacy
    // shared email + import-history database). Without these tables
    // the Hub's "Imported statements awaiting reconciliation" view
    // is empty for any previously-imported statement.
    subdir: 'core',
    file: 'email_data.db',
    tables: [
      { name: 'bank_statement_imports', transform: transformBankStatementImport },
      { name: 'bank_statement_transactions', transform: transformBankStatementTransaction },
      { name: 'bank_import_drafts' },
      { name: 'ignored_bank_transactions', transform: transformIgnoredBankTransaction },
    ],
  },
];

/**
 * Legacy `bank_import_aliases` → new schema.
 * Legacy columns: bank_name, ledger_type, account_code, account_name,
 *   match_score, created_date, created_by, last_used, use_count,
 *   active, bank_code.
 * New columns:    bank_code, payee_pattern, match_type, opera_account,
 *   confidence, direction, match_count, created_at, updated_at.
 *
 * `match_type`, `active`, `account_name`, `created_by` have no
 * destination and are dropped. `ledger_type` (S/P/N) is mapped to
 * `direction` ("sales"/"purchase"/"nominal"). `match_score` is
 * preserved as-is; the new plugin can rescale if needed.
 */
function transformBankImportAlias(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const ledger = typeof row.ledger_type === 'string' ? row.ledger_type.toUpperCase() : '';
  const direction =
    ledger === 'S' ? 'sales' : ledger === 'P' ? 'purchase' : ledger === 'N' ? 'nominal' : null;
  return {
    bank_code: row.bank_code ?? '',
    payee_pattern: row.bank_name,
    match_type: null,
    opera_account: row.account_code,
    confidence: row.match_score,
    direction,
    match_count: row.use_count,
    created_at: row.created_date,
    updated_at: row.last_used ?? row.created_date,
  };
}

/**
 * Legacy `bank_import_patterns` → new schema.
 * Legacy columns: company_code, description_raw, description_normalized,
 *   transaction_type, account_code, account_name, ledger_type, vat_code,
 *   nominal_code, net_amount_typical, times_used, first_used, last_used.
 * New columns:    pattern, opera_account, confidence, match_count,
 *   updated_at.
 *
 * The new schema is much leaner — the legacy company-scoping,
 * VAT/nominal hints, and split raw/normalized text are discarded.
 * `confidence` has no legacy source.
 */
function transformBankImportPattern(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return {
    pattern: row.description_normalized,
    opera_account: row.account_code,
    confidence: null,
    match_count: row.times_used,
    updated_at: row.last_used,
  };
}

/**
 * Legacy `repeat_entry_aliases` → new schema.
 * Legacy: bank_name, bank_code, entry_ref, entry_desc, created_at,
 *   last_used, use_count, active.
 * New:    bank_code, memo_pattern, opera_repeat_ref, created_at.
 *
 * Real legacy customers have 0 rows, but the transformer is here for
 * completeness so deploys with data don't silently drop it.
 */
function transformRepeatEntryAlias(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return {
    bank_code: row.bank_code,
    memo_pattern: row.bank_name,
    opera_repeat_ref: row.entry_ref,
    created_at: row.created_at,
  };
}

/**
 * Legacy `bank_statement_imports` (email_data.db) → new schema.
 *
 * Legacy: id, email_id, attachment_id, source, bank_code, filename,
 *   total_receipts, total_payments, transactions_imported,
 *   target_system, import_date, imported_by, is_reconciled,
 *   reconciled_date, reconciled_count, pdf_hash, opening_balance,
 *   closing_balance, statement_date, account_number, sort_code,
 *   period_start, period_end, file_path, statement_number.
 *
 * New: bank_code, statement_date, opening_balance, closing_balance,
 *   source, source_ref, imported_by, imported_at, is_reconciled,
 *   reconciled_count, target_system, reconciled_at, filename,
 *   transactions_imported, total_receipts, total_payments,
 *   account_number, sort_code, period_start, period_end,
 *   reconciled_by, archived_at, archived_by, records_imported.
 *
 * The legacy split of `email_id`+`attachment_id`+`file_path` collapses
 * into a single `source_ref` in the new schema:
 *   source='email' → source_ref = "<email_id>:<attachment_id>"
 *   source='file'  → source_ref = file_path
 * `pdf_hash` and `statement_number` are dropped (no destination).
 */
function transformBankStatementImport(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const source = typeof row.source === 'string' ? row.source : 'file';
  let sourceRef: string | null = null;
  if (source === 'email') {
    const eid = row.email_id == null ? '' : String(row.email_id);
    const aid = row.attachment_id == null ? '' : String(row.attachment_id);
    sourceRef = `${eid}:${aid}`;
  } else if (typeof row.file_path === 'string' && row.file_path.length > 0) {
    sourceRef = row.file_path;
  } else if (typeof row.filename === 'string') {
    sourceRef = row.filename;
  }
  return {
    bank_code: row.bank_code,
    statement_date: row.statement_date ?? null,
    opening_balance: row.opening_balance ?? null,
    closing_balance: row.closing_balance ?? null,
    source,
    source_ref: sourceRef,
    imported_by: row.imported_by ?? null,
    imported_at: row.import_date ?? null,
    is_reconciled: row.is_reconciled ?? 0,
    reconciled_count: row.reconciled_count ?? 0,
    target_system: row.target_system ?? 'opera_se',
    reconciled_at: row.reconciled_date ?? null,
    filename: row.filename ?? null,
    transactions_imported: row.transactions_imported ?? 0,
    total_receipts: row.total_receipts ?? 0,
    total_payments: row.total_payments ?? 0,
    account_number: row.account_number ?? null,
    sort_code: row.sort_code ?? null,
    period_start: row.period_start ?? null,
    period_end: row.period_end ?? null,
  };
}

/**
 * Legacy `bank_statement_transactions` → new schema.
 * Only difference: legacy `date` → new `post_date`. Pass through
 * everything else.
 */
function transformBankStatementTransaction(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return {
    import_id: row.import_id,
    line_number: row.line_number,
    post_date: row.date,
    description: row.description ?? null,
    amount: row.amount,
    balance: row.balance ?? null,
    transaction_type: row.transaction_type ?? null,
    reference: row.reference ?? null,
    matched_entry: row.matched_entry ?? null,
    match_confidence: row.match_confidence ?? null,
    match_type: row.match_type ?? null,
    is_reconciled: row.is_reconciled ?? 0,
    posted_entry_number: row.posted_entry_number ?? null,
    posted_at: row.posted_at ?? null,
  };
}

/**
 * Legacy `ignored_bank_transactions` → new schema.
 * Only difference: legacy `bank_account` → new `bank_code`. Pass
 * through everything else.
 */
function transformIgnoredBankTransaction(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return {
    bank_code: row.bank_account,
    transaction_date: row.transaction_date,
    amount: row.amount,
    description: row.description ?? null,
    reference: row.reference ?? null,
    reason: row.reason ?? null,
    ignored_at: row.ignored_at ?? null,
    ignored_by: row.ignored_by ?? null,
  };
}

async function seedTablesFromLegacyDbs(
  appDb: Knex,
  legacyDataRoot: string | null,
  code: string,
  logger: AppLogger,
): Promise<void> {
  if (!legacyDataRoot) return;

  for (const entry of LEGACY_TABLE_PLAN) {
    const legacyFile = resolve(legacyDataRoot, code, entry.subdir, entry.file);
    if (!existsSync(legacyFile)) continue;

    const legacyDb = knex({
      client: 'sqlite3',
      connection: { filename: legacyFile },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 },
    });
    try {
      for (const spec of entry.tables) {
        await copyTable(legacyDb, appDb, spec, code, logger);
      }
    } finally {
      await legacyDb.destroy();
    }
  }
}

async function copyTable(
  legacy: Knex,
  app: Knex,
  spec: LegacyTableSpec,
  code: string,
  logger: AppLogger,
): Promise<void> {
  const table = spec.name;
  if (!(await legacy.schema.hasTable(table))) return;
  if (!(await app.schema.hasTable(table))) return;

  // Idempotency: skip if destination already has rows for this table.
  const existing = await app(table).count<{ c: number }[]>('* as c');
  if (Number(existing[0]?.c ?? 0) > 0) return;

  const rows = (await legacy(table).select()) as Array<Record<string, unknown>>;
  if (rows.length === 0) return;

  const destColumns = new Set(
    (
      (await app.raw(`PRAGMA table_info(${table})`)) as Array<{ name: string }>
    ).map((c) => c.name),
  );

  const mapped = rows.map((row) => {
    const transformed = spec.transform ? spec.transform(row) : row;
    return projectRow(transformed, destColumns);
  });

  // Fast path: bulk insert inside a transaction. Falls back to row-by-row
  // when a unique-constraint or similar conflict aborts the bulk path.
  try {
    await app.transaction(async (trx) => {
      const BATCH = 200;
      for (let i = 0; i < mapped.length; i += BATCH) {
        await trx(table).insert(mapped.slice(i, i + BATCH));
      }
    });
    logger.info(`[${code}] migrated ${rows.length} rows from ${table}`);
    return;
  } catch (err) {
    // Suppress the full SQL knex dumps; the row-by-row pass below will
    // log a clean summary of inserted vs skipped.
    logger.debug(
      `[${code}] bulk insert into ${table} hit a conflict; retrying row-by-row`,
    );
    void err;
  }

  let inserted = 0;
  let skipped = 0;
  for (const row of mapped) {
    try {
      await app(table).insert(row);
      inserted++;
    } catch {
      skipped++;
    }
  }
  logger.info(
    `[${code}] migrated ${inserted}/${rows.length} rows from ${table}` +
      (skipped > 0 ? ` (${skipped} skipped due to conflicts)` : ''),
  );
}

function projectRow(
  row: Record<string, unknown>,
  destColumns: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'id') continue; // autoincrement: regenerated
    if (!destColumns.has(k)) continue;
    out[k] = v;
  }
  return out;
}

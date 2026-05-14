/**
 * Express router for the bank-reconcile plugin.
 *
 * Foundation endpoints + first batch of read-only ports. Many more
 * endpoints to come — bank-reconcile is the largest app at 127 routes.
 */
import { Router, type Request, type Response } from 'express';
import type { AppContext } from './app-context.js';
import { listBanks } from './services/banks.js';
import { runHealthCheck } from './services/health-check.js';
import {
  listOrphanTmpstat,
  clearOrphanTmpstat,
} from './services/orphan-tmpstat.js';
import {
  getUnreconciledEntries,
  getReconciliationStatus,
  recoverFromOperaDivergence,
} from './services/reconciliation-status.js';
import {
  checkOrphanedTransactions,
  recoverOrphanedTransactions,
} from './services/transaction-orphan-check.js';
import { checkRestoreAcrossAllBanks } from './services/restore-check-all.js';
import {
  ignoreTransaction,
  listIgnoredTransactions,
  unignoreTransactionById,
  unignoreTransactionByMatch,
} from './services/ignored-transactions.js';
import {
  markStatementReconciled,
  listImportedStatements,
} from './services/statement-files.js';
import {
  getRecurringEntriesMode,
  setRecurringEntriesMode,
} from './services/settings.js';
import { listCashbookTypes } from './services/cashbook-types.js';
import {
  getMatchConfig,
  updateMatchConfig,
} from './services/match-config.js';
import {
  detectFormat,
  supportedFormats,
} from './services/format-detect.js';
import { detectBankFromContent } from './services/detect-bank.js';
import { recordDuplicateOverride } from './services/duplicate-override.js';
import {
  saveImportDraft,
  loadImportDraft,
  deleteImportDraft,
} from './services/bank-import-drafts.js';
import {
  getCustomersForDropdown,
  getSuppliersForDropdown,
} from './services/account-dropdowns.js';
import { unreconcileEntries } from './services/unreconcile.js';
import {
  listImportHistory,
  deleteImportRecord,
  clearImportHistory,
} from './services/import-history.js';
import {
  getFolderSettings,
  saveFolderSettings,
} from './services/folder-settings.js';
import { validateStatementForReconciliation } from './services/validate-statement.js';
import {
  matchStatementToCashbook,
  type StatementTransaction,
} from './services/match-statement.js';
import { reconcileBank } from './services/reconcile-bank.js';
import { completeReconciliation } from './services/complete-reconciliation.js';
import {
  markEntriesReconciled,
  type ReconcileEntryInput,
} from './services/mark-reconciled.js';
import {
  recordCorrection,
  listCorrections,
} from './services/alias-corrections.js';
import { completeBatch } from './services/complete-batch.js';
import { persistImportDecisions } from './services/persist-decisions.js';
import {
  confirmStatementMatches,
  type ConfirmMatchInput,
} from './services/confirm-matches.js';
import {
  updateRepeatEntryDate,
  listRepeatEntries,
} from './services/repeat-entries.js';
import {
  scanEmailsForBankStatements,
  type BankMailboxAdapter,
  type ReconciledKeyStore,
} from './services/scan-emails.js';
import {
  importBankStatementFromPdf,
  type PdfExtractor,
  type ImportPostingExecutor,
  type ImportLockAdapter,
  type PeriodOverlapChecker,
} from './services/import-from-pdf.js';
import {
  checkBatch as checkDuplicateBatch,
  type CheckTransactionInput,
} from './services/duplicate-detection.js';
import {
  refreshMatches,
  type RefreshTransactionInput,
} from './services/refresh-matches.js';
import {
  suggestAccountForTransaction,
  type TransactionType,
} from './services/suggest-account.js';
import { bankImportPostingExecutor } from './services/import-posting-executor.js';
import {
  inMemoryImportLock,
  makeBankStatementOverlapChecker,
} from './services/import-defaults.js';
import {
  previewBankImportFromPdf,
  type LlmService,
} from './services/preview-from-pdf.js';
import {
  previewBankImportFromEmail,
  type EmailAttachmentProvider,
} from './services/preview-from-email.js';
import { reconcileBankDashboard } from './services/reconcile-dashboard.js';
import {
  archiveFile,
  getArchiveHistory,
  restoreArchivedFile,
  getPendingFiles,
  type FileStorageAdapter,
  type ImportType,
} from './services/archive.js';
import { processStatement } from './services/process-statement.js';
import {
  getBankReconciliationStatus,
  getUnreconciledEntriesForBank,
  getStatementTransactionsForImport,
} from './services/bank-reconciliation-status.js';
import {
  recordDeferredTransaction,
  listDeferredItems,
  deleteDeferredItems,
  deleteIgnoredTransactionByRecordId,
} from './services/deferred-items.js';
import {
  listCashbookBankAccounts,
  createCashbookEntry,
  createBankTransfer,
  autoMatchStatementLines,
} from './services/cashbook-create.js';
import {
  archiveStatement,
  listArchivedStatements,
  restoreStatement,
  getArchivedStatementPdf,
  deleteArchivedStatement,
  manageStatements,
} from './services/statement-archive.js';
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
} from './services/misc-endpoints.js';
import {
  importBankStatementFromEmail,
  type BankImportFromEmailInput,
} from './services/bank-import-from-email.js';
import { defaultMultiformatParser } from './services/default-multiformat-parser.js';
import { createDefaultBankPdfExtractor } from './services/default-bank-pdf-extractor.js';
import { createDefaultEmailIngestAdapter } from './services/default-email-ingest.js';
import {
  createFolderBackedFileStorage,
  createFolderBackedPdfContentReader,
} from './services/folder-backed-storage.js';

export function createRouter(ctx: AppContext): Router {
  const router = Router();

  // Built-in fallback adapters — used when SAM hasn't wired custom
  // implementations onto ctx.
  //
  // The filesystem adapters resolve their rootDir lazily from the
  // per-app `folder_settings.base_folder` row (managed by the plugin's
  // own Settings UI). The PDF extractor activates whenever `ctx.llm`
  // is available — no per-tenant config needed.
  const builtinFileStorage: FileStorageAdapter = createFolderBackedFileStorage(
    () => ctx.db.app,
  );
  const builtinPdfReader: PdfContentReader = createFolderBackedPdfContentReader(
    () => ctx.db.app,
  );
  const builtinPdfExtractor: PdfExtractor | null = ctx.llm
    ? createDefaultBankPdfExtractor({ llm: ctx.llm })
    : null;

  // Default email-ingest adapter — instantiated once per plugin
  // lifecycle. Activates whenever ctx.emailIngest is wired; bootstraps
  // by calling ctx.emailIngest.listMyMailboxes() and reacts to
  // ownership changes pushed from SAM Admin.
  const builtinEmailIngest = ctx.emailIngest
    ? createDefaultEmailIngestAdapter({
        emailIngest: ctx.emailIngest,
        appId: ctx.appId,
        logger: ctx.logger,
      })
    : null;

  // Opera-3 mirror routes: every Python endpoint under /api/opera3/*
  // exists in this router under its canonical (non-prefixed) path.
  // The frontend selects the prefix based on the tenant's Opera type
  // (`opera_type === 'opera-3'` → use /api/opera3/...). Both prefixes
  // resolve to the same handler because ctx.db.getCompanyDb() returns
  // an Opera-3 (FoxPro/Knex) connection for opera-3 tenants, so the
  // queries Just Work. We strip the prefix here and let Express route.
  router.use((req, _res, next) => {
    if (req.url.startsWith('/api/opera3/')) {
      req.url = '/api/' + req.url.slice('/api/opera3/'.length);
      (req as unknown as { operaMirror?: boolean }).operaMirror = true;
    }
    next();
  });

  function getAppDb(req: Request, res: Response): import('knex').Knex | null {
    if (!ctx.db.app) {
      res.status(503).json({
        success: false,
        error: 'bank-reconcile per-app database not provisioned for this tenant.',
      });
      return null;
    }
    return ctx.db.app;
  }

  function getOperaDb(req: Request, res: Response): import('knex').Knex | null {
    const company = req.operaCompany;
    if (!company) {
      res.status(400).json({
        success: false,
        error: 'No Opera company in context. SAM should set X-Opera-Company.',
      });
      return null;
    }
    const db = ctx.db.getCompanyDb(company);
    if (!db) {
      res.status(503).json({
        success: false,
        error: `Opera SQL connection not available for company ${company}.`,
      });
      return null;
    }
    return db;
  }

  /**
   * GET /api/bank-reconcile/status — plugin liveness.
   */
  router.get('/api/bank-reconcile/status', (_req, res) => {
    res.json({
      success: true,
      app: 'bank-reconcile',
      tenant_id: ctx.tenantId,
      opera_type: ctx.operaType,
      message: 'Foundation in place. Endpoint port in progress.',
    });
  });

  /**
   * GET /api/reconcile/banks — list of bank accounts.
   *
   * Faithful port of `get_bank_accounts` (line 280).
   */
  router.get('/api/reconcile/banks', async (req, res) => {
    const operaDb = getOperaDb(req, res);
    if (!operaDb) return;
    try {
      const result = await listBanks(operaDb);
      res.json(result);
    } catch (err: any) {
      ctx.logger.error('List banks failed', err);
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  });

  /**
   * GET /api/bank-import/health-check — data-integrity health check.
   *
   * Faithful port of `bank_import_health_check`.
   */
  router.get('/api/bank-import/health-check', async (req, res) => {
    const operaDb = getOperaDb(req, res);
    if (!operaDb) return;
    try {
      const result = await runHealthCheck({ operaDb, appDb: ctx.db.app });
      res.json(result);
    } catch (err: any) {
      ctx.logger.error('Health check failed', err);
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  });

  /**
   * GET /api/reconcile/bank/:bank_code/orphan-tmpstat — list orphaned
   * partial reconcile reservations on a bank. Read-only.
   */
  router.get('/api/reconcile/bank/:bank_code/orphan-tmpstat', async (req, res) => {
    const operaDb = getOperaDb(req, res);
    if (!operaDb) return;
    try {
      const bankCode = String(req.params.bank_code ?? '').trim();
      if (!bankCode) {
        res.status(400).json({ success: false, error: 'Missing bank_code' });
        return;
      }
      const result = await listOrphanTmpstat(operaDb, bankCode);
      res.json(result);
    } catch (err: any) {
      ctx.logger.error('List orphan tmpstat failed', err);
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  });

  /**
   * POST /api/reconcile/bank/:bank_code/clear-orphan-tmpstat —
   * clear orphan tmpstat reservations. Optional body
   * `{ entry_numbers: [...] }` restricts to specific entries.
   *
   * Faithful port of `clear_orphan_tmpstat`. Uses ROWLOCK on a narrow
   * UPDATE per CLAUDE.md locking rules.
   */
  router.post('/api/reconcile/bank/:bank_code/clear-orphan-tmpstat', async (req, res) => {
    const operaDb = getOperaDb(req, res);
    if (!operaDb) return;
    try {
      const bankCode = String(req.params.bank_code ?? '').trim();
      if (!bankCode) {
        res.status(400).json({ success: false, error: 'Missing bank_code' });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const entryNumbers = Array.isArray(body.entry_numbers)
        ? (body.entry_numbers as string[])
        : undefined;
      const result = await clearOrphanTmpstat(operaDb, bankCode, entryNumbers);
      res.json(result);
    } catch (err: any) {
      ctx.logger.error('Clear orphan tmpstat failed', err);
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  });

  /**
   * GET /api/reconcile/bank/:bank_code — three-way reconciliation
   * dashboard for a single bank account. Returns cashbook /
   * bank-master / nominal-ledger totals plus the variance summary.
   * Faithful port of `reconcile_bank` (routes.py:320-720).
   */
  router.get(
    '/api/reconcile/bank/:bank_code',
    async (req: Request, res: Response) => {
      const operaDb = getOperaDb(req, res);
      if (!operaDb) return;
      try {
        const bankCode = String(req.params.bank_code ?? '').trim();
        const result = await reconcileBankDashboard(operaDb, bankCode);
        if (!result.success) {
          res.status(404).json(result);
          return;
        }
        res.json(result);
      } catch (err: any) {
        ctx.logger.error('reconcile dashboard failed', err);
        res.status(500).json({
          success: false,
          error: err?.message ?? String(err),
        });
      }
    },
  );

  /**
   * GET /api/reconcile/bank/:bank_code/unreconciled — list unreconciled
   * cashbook entries for a bank account. Faithful port of
   * `get_unreconciled_entries` (line 818).
   *
   * Query: ?include_incomplete=true to include batches with ae_complet=0
   * (not yet posted to NL).
   */
  router.get('/api/reconcile/bank/:bank_code/unreconciled', async (req, res) => {
    const operaDb = getOperaDb(req, res);
    if (!operaDb) return;
    try {
      const bankCode = String(req.params.bank_code ?? '').trim();
      if (!bankCode) {
        res.status(400).json({ success: false, error: 'Missing bank_code' });
        return;
      }
      const includeIncomplete = req.query.include_incomplete === 'true';
      const result = await getUnreconciledEntries(operaDb, bankCode, includeIncomplete);
      res.json(result);
    } catch (err: any) {
      ctx.logger.error('Get unreconciled entries failed', err);
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  });

  /**
   * GET /api/reconcile/bank/:bank_code/status — current reconciliation
   * status (balances + last reconcile info). Faithful port of
   * `get_reconciliation_status` (the OperaSQLImport method, not the
   * full route handler with sequential-gating logic).
   */
  router.get('/api/reconcile/bank/:bank_code/status', async (req, res) => {
    const operaDb = getOperaDb(req, res);
    if (!operaDb) return;
    try {
      const bankCode = String(req.params.bank_code ?? '').trim();
      if (!bankCode) {
        res.status(400).json({ success: false, error: 'Missing bank_code' });
        return;
      }
      const currentFilename =
        typeof req.query.current_filename === 'string'
          ? req.query.current_filename
          : null;
      const result = await getReconciliationStatus(
        operaDb,
        bankCode,
        ctx.db.app,
        currentFilename,
      );
      // Per-line orphan check — wider net than the statement-level
      // divergence check above. Catches the case where lines were
      // posted to Opera but the underlying entries are gone (e.g.
      // Opera restored before the statement was marked reconciled).
      if (ctx.db.app) {
        try {
          const orphans = await checkOrphanedTransactions(
            operaDb,
            ctx.db.app,
            bankCode,
          );
          if (orphans.success && orphans.orphan_line_count > 0) {
            (result as unknown as Record<string, unknown>).orphan_transactions = {
              detected: true,
              line_count: orphans.orphan_line_count,
              statement_count: orphans.statement_count,
              statements: orphans.orphan_statements,
              message:
                `${orphans.orphan_line_count} statement line(s) across ` +
                `${orphans.statement_count} statement(s) reference Opera ` +
                `entries that no longer exist (Opera restore likely). ` +
                `Use the recovery endpoint to clear so they can be re-posted.`,
            };
          } else {
            (result as unknown as Record<string, unknown>).orphan_transactions = {
              detected: false,
              line_count: 0,
              statement_count: 0,
              statements: [],
            };
          }
        } catch {
          // best-effort — never block the status response
        }
      }
      res.json(result);
    } catch (err: any) {
      ctx.logger.error('Get reconciliation status failed', err);
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  });

  /**
   * GET /api/reconcile/bank/:bank_code/orphan-transactions
   *
   * Read-only per-line orphan check — surfaces every
   * `bank_statement_transactions` row whose `posted_entry_number`
   * doesn't match an Opera `aentry` for this bank. Triggers: Opera
   * was restored from backup, or the Cashbook entry was deleted
   * directly in Opera. The recovery endpoint clears the stale
   * tracking only after explicit user confirmation.
   */
  router.get('/api/reconcile/bank/:bank_code/orphan-transactions', async (req, res) => {
    const operaDb = getOperaDb(req, res);
    if (!operaDb) return;
    const appDb = getAppDb(req, res);
    if (!appDb) return;
    try {
      const bankCode = String(req.params.bank_code ?? '').trim();
      if (!bankCode) {
        res.status(400).json({ success: false, error: 'Missing bank_code' });
        return;
      }
      const result = await checkOrphanedTransactions(operaDb, appDb, bankCode);
      res.json(result);
    } catch (err: any) {
      ctx.logger.error('Orphan transactions check failed', err);
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  });

  /**
   * POST /api/reconcile/bank/:bank_code/recover-orphan-transactions
   *
   * Clear `posted_entry_number` + `posted_at` on every line whose
   * Opera entry is gone, plus reset the parent statement's
   * `is_reconciled` flag. Subsequent re-import of the statement will
   * re-post the cleared lines. Requires explicit confirmation —
   * never auto-runs.
   */
  router.post('/api/reconcile/bank/:bank_code/recover-orphan-transactions', async (req, res) => {
    const operaDb = getOperaDb(req, res);
    if (!operaDb) return;
    const appDb = getAppDb(req, res);
    if (!appDb) return;
    try {
      const bankCode = String(req.params.bank_code ?? '').trim();
      if (!bankCode) {
        res.status(400).json({ success: false, error: 'Missing bank_code' });
        return;
      }
      const result = await recoverOrphanedTransactions(operaDb, appDb, bankCode);
      res.json(result);
    } catch (err: any) {
      ctx.logger.error('Orphan transactions recovery failed', err);
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  });

  /**
   * POST /api/reconcile/bank/:bank_code/recover-from-restore
   *
   * SAM enhancement — if Opera SQL is restored to an earlier backup
   * (or someone unreconciles directly in Opera Cashbook), SAM's
   * `bank_statement_imports` history may show statements as
   * reconciled that Opera no longer reflects. This endpoint detects
   * the divergence (any SAM row whose closing balance > Opera's
   * `nk_recbal`) and marks those rows un-reconciled so they can be
   * re-processed via the normal import flow.
   *
   * Body: none. Returns the cleared imports so the UI can list them.
   */
  router.post('/api/reconcile/bank/:bank_code/recover-from-restore', async (req, res) => {
    const operaDb = getOperaDb(req, res);
    if (!operaDb) return;
    const appDb = getAppDb(req, res);
    if (!appDb) return;
    try {
      const bankCode = String(req.params.bank_code ?? '').trim();
      if (!bankCode) {
        res.status(400).json({ success: false, error: 'Missing bank_code' });
        return;
      }
      const result = await recoverFromOperaDivergence(operaDb, appDb, bankCode);
      if (!result.success) {
        res.status(500).json(result);
        return;
      }
      res.json(result);
    } catch (err: any) {
      ctx.logger.error('Recover from restore failed', err);
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  });

  /**
   * POST /api/reconcile/bank/:bank_code/ignore-transaction
   *
   * Mark a bank statement line as "already in Opera, ignore for reconcile".
   * Faithful port of `ignore_bank_transaction`.
   */
  router.post('/api/reconcile/bank/:bank_code/ignore-transaction', async (req, res) => {
    const appDb = getAppDb(req, res);
    if (!appDb) return;
    try {
      const bankCode = String(req.params.bank_code ?? '').trim();
      const q = req.query;
      const tx = String(q.transaction_date ?? '').trim();
      const amt = q.amount !== undefined ? Number(q.amount) : NaN;
      if (!bankCode || !tx || Number.isNaN(amt)) {
        res.status(400).json({
          success: false,
          error: 'bank_code, transaction_date, and amount are required',
        });
        return;
      }
      const result = await ignoreTransaction(appDb, {
        bankCode,
        transactionDate: tx,
        amount: amt,
        description: typeof q.description === 'string' ? q.description : null,
        reference: typeof q.reference === 'string' ? q.reference : null,
        reason: typeof q.reason === 'string' ? q.reason : null,
        ignoredBy: 'API',
      });
      res.json(result);
    } catch (err: any) {
      ctx.logger.error('Ignore transaction failed', err);
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  });

  /**
   * GET /api/reconcile/bank/:bank_code/ignored-transactions
   *
   * List the ignored transactions for a bank account. Faithful port of
   * `get_ignored_transactions`.
   */
  router.get('/api/reconcile/bank/:bank_code/ignored-transactions', async (req, res) => {
    const appDb = getAppDb(req, res);
    if (!appDb) return;
    try {
      const bankCode = String(req.params.bank_code ?? '').trim();
      const limit = req.query.limit ? Number(req.query.limit) : 100;
      const result = await listIgnoredTransactions(appDb, bankCode, limit);
      res.json(result);
    } catch (err: any) {
      ctx.logger.error('List ignored transactions failed', err);
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  });

  /**
   * DELETE /api/reconcile/bank/ignored-transaction/:record_id
   *
   * Remove an ignored-transaction record by id. Faithful port of
   * `unignore_transaction`.
   */
  router.delete('/api/reconcile/bank/ignored-transaction/:record_id', async (req, res) => {
    const appDb = getAppDb(req, res);
    if (!appDb) return;
    try {
      const recordId = Number(req.params.record_id);
      if (!Number.isFinite(recordId)) {
        res.status(400).json({ success: false, error: 'Invalid record_id' });
        return;
      }
      const result = await unignoreTransactionById(appDb, recordId);
      if (!result.success && result.error === 'Record not found') {
        res.status(404).json(result);
        return;
      }
      res.json(result);
    } catch (err: any) {
      ctx.logger.error('Unignore transaction failed', err);
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  });

  /**
   * DELETE /api/reconcile/bank/:bank_code/unignore-transaction
   *
   * Remove an ignored transaction by matching bank+date+amount.
   * Faithful port of `unignore_transaction_by_match`.
   */
  router.delete('/api/reconcile/bank/:bank_code/unignore-transaction', async (req, res) => {
    const appDb = getAppDb(req, res);
    if (!appDb) return;
    try {
      const bankCode = String(req.params.bank_code ?? '').trim();
      const tx = String(req.query.transaction_date ?? '').trim();
      const amt = req.query.amount !== undefined ? Number(req.query.amount) : NaN;
      if (!bankCode || !tx || Number.isNaN(amt)) {
        res.status(400).json({
          success: false,
          error: 'bank_code, transaction_date, and amount are required',
        });
        return;
      }
      const result = await unignoreTransactionByMatch(appDb, bankCode, tx, amt);
      res.json(result);
    } catch (err: any) {
      ctx.logger.error('Unignore (by match) failed', err);
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  });

  /**
   * POST /api/statement-files/mark-reconciled
   *
   * Mark a statement file as reconciled. Faithful port of
   * `mark_statement_reconciled`.
   */
  router.post('/api/statement-files/mark-reconciled', async (req, res) => {
    const appDb = getAppDb(req, res);
    if (!appDb) return;
    try {
      const filename = String(req.query.filename ?? '').trim();
      const bankCode = typeof req.query.bank_code === 'string' ? req.query.bank_code : null;
      const reconciledCount = req.query.reconciled_count
        ? Number(req.query.reconciled_count)
        : 0;
      if (!filename) {
        res.status(400).json({ success: false, error: 'filename is required' });
        return;
      }
      const result = await markStatementReconciled(appDb, {
        filename,
        bankCode,
        reconciledCount,
      });
      res.json(result);
    } catch (err: any) {
      ctx.logger.error('Mark statement reconciled failed', err);
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  });

  /**
   * GET /api/statement-files/imported-for-reconciliation
   *
   * List imported bank statements pending reconciliation.
   * Faithful port (without the Opera-side cross-check yet — queued for
   * a future session per progress.md).
   */
  router.get('/api/statement-files/imported-for-reconciliation', async (req, res) => {
    const appDb = getAppDb(req, res);
    if (!appDb) return;
    try {
      const bankCode = typeof req.query.bank_code === 'string' ? req.query.bank_code : null;
      const limit = req.query.limit ? Number(req.query.limit) : 200;
      const includeReconciled = req.query.include_reconciled === 'true';
      const result = await listImportedStatements(appDb, {
        bankCode,
        limit,
        includeReconciled,
      });
      res.json(result);
    } catch (err: any) {
      ctx.logger.error('List imported statements failed', err);
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  });

  /**
   * GET /api/recurring-entries/config
   *
   * Read recurring-entries processing mode ('process' or 'warn').
   * Faithful port of `get_recurring_entries_config` (api/main.py:10290).
   */
  router.get('/api/recurring-entries/config', async (req, res) => {
    const appDb = getAppDb(req, res);
    if (!appDb) return;
    try {
      const result = await getRecurringEntriesMode(appDb);
      res.json(result);
    } catch (err: any) {
      ctx.logger.error('Get recurring-entries mode failed', err);
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  });

  /**
   * PUT /api/recurring-entries/config?mode=process|warn
   *
   * Update recurring-entries processing mode. Faithful port of
   * `update_recurring_entries_config`.
   */
  router.put('/api/recurring-entries/config', async (req, res) => {
    const appDb = getAppDb(req, res);
    if (!appDb) return;
    try {
      const mode = String(req.query.mode ?? '').trim();
      const result = await setRecurringEntriesMode(appDb, mode);
      if (!result.success) {
        res.status(400).json(result);
        return;
      }
      res.json(result);
    } catch (err: any) {
      ctx.logger.error('Set recurring-entries mode failed', err);
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  });

  /**
   * GET /api/bank-import/cashbook-types?category=R|P|T
   *
   * Returns the configured Opera cashbook entry types from `atype`,
   * optionally filtered by category. Faithful port of
   * `get_cashbook_types` (apps/bank_reconcile/api/routes.py:3009-3040).
   */
  router.get('/api/bank-import/cashbook-types', async (req: Request, res: Response) => {
    const operaDb = getOperaDb(req, res);
    if (!operaDb) return;
    try {
      const category =
        typeof req.query.category === 'string' && req.query.category.trim()
          ? req.query.category.trim()
          : null;
      const result = await listCashbookTypes(operaDb, category);
      res.json(result);
    } catch (err: any) {
      ctx.logger.error('Cashbook types fetch failed', err);
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  });

  /**
   * GET /api/bank-import/config
   *
   * Returns the bank-import matching thresholds (min_match_score,
   * learn_threshold, ambiguity_threshold, use_phonetic, use_levenshtein,
   * use_ngram). If no row exists, returns hard-coded defaults — same
   * fallback as `get_match_config` in routes.py:3046-3088.
   */
  router.get('/api/bank-import/config', async (req: Request, res: Response) => {
    const appDb = getAppDb(req, res);
    if (!appDb) return;
    try {
      const result = await getMatchConfig(appDb);
      res.json(result);
    } catch (err: any) {
      ctx.logger.error('Match config fetch failed', err);
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  });

  /**
   * PUT /api/bank-import/config?min_match_score=...&learn_threshold=...
   *
   * Update the bank-import matching thresholds. Faithful port of
   * `update_match_config` (routes.py:3094-3134). All numeric thresholds
   * are clamped to [0,1] (matches the FastAPI `ge=0.0, le=1.0` validator).
   */
  router.put('/api/bank-import/config', async (req: Request, res: Response) => {
    const appDb = getAppDb(req, res);
    if (!appDb) return;
    try {
      const q = req.query;
      const result = await updateMatchConfig(appDb, {
        min_match_score:
          q.min_match_score !== undefined ? Number(q.min_match_score) : 0.6,
        learn_threshold:
          q.learn_threshold !== undefined ? Number(q.learn_threshold) : 0.8,
        ambiguity_threshold:
          q.ambiguity_threshold !== undefined ? Number(q.ambiguity_threshold) : 0.15,
        use_phonetic: q.use_phonetic !== undefined ? q.use_phonetic === 'true' : true,
        use_levenshtein:
          q.use_levenshtein !== undefined ? q.use_levenshtein === 'true' : true,
        use_ngram: q.use_ngram !== undefined ? q.use_ngram === 'true' : true,
      });
      res.json(result);
    } catch (err: any) {
      ctx.logger.error('Match config update failed', err);
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  });

  /**
   * POST /api/bank-import/detect-format
   *
   * Detect the format of a bank-statement file. Faithful port of
   * `detect_file_format` (apps/bank_reconcile/api/routes.py:2337-2363).
   *
   * SAM port note: the Python endpoint took a server-side `filepath`
   * and read the file from disk. Under SAM the plugin doesn't see
   * the user's file system — the frontend uploads the file content
   * (or the email-ingest service produces it). Accept the content in
   * the JSON body instead. This is the only difference; the parser
   * sniffing logic is unchanged.
   *
   * Body: { content: string, filename?: string }
   * Returns: { success, format: 'CSV'|'OFX'|'QIF'|'MT940'|null,
   *            supported_formats: string[] }
   */
  router.post('/api/bank-import/detect-format', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as { content?: string; filename?: string };
      const content = String(body.content ?? '');
      const filename = String(body.filename ?? '');
      if (!content) {
        res.status(400).json({ success: false, error: 'content is required' });
        return;
      }
      const format = detectFormat(content, filename);
      res.json({
        success: true,
        format,
        supported_formats: supportedFormats,
      });
    } catch (err: any) {
      ctx.logger.error('Detect format failed', err);
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  });

  /**
   * POST /api/bank-import/detect-bank
   *
   * Detect which Opera bank account a bank-statement file belongs to.
   * Faithful port of `detect_bank_from_file`
   * (apps/bank_reconcile/api/routes.py:2369-2490).
   *
   * Two extraction strategies on the first 30 lines:
   *   1. regex: sort code (XX-XX-XX) + 8-digit account number
   *   2. CSV header scan + 'Account' field "20-96-89 90764205"
   *
   * Once extracted, both sides are normalised (whitespace + dashes
   * stripped) before comparing against Opera nbank.
   *
   * Body: { content: string }
   * Returns:
   *   - detected=true:  bank_code + bank_description + sort_code + account_number
   *   - detected=false: available_banks for manual selection
   */
  router.post('/api/bank-import/detect-bank', async (req: Request, res: Response) => {
    const operaDb = getOperaDb(req, res);
    if (!operaDb) return;
    try {
      const body = (req.body ?? {}) as { content?: string };
      const content = String(body.content ?? '');
      if (!content) {
        res.status(400).json({ success: false, error: 'content is required' });
        return;
      }
      const detected = await detectBankFromContent(operaDb, content);
      if (detected.bank_code) {
        const banks = await listBanks(operaDb);
        const info = banks.banks?.find((b) => b.account_code === detected.bank_code);
        res.json({
          success: true,
          detected: true,
          bank_code: detected.bank_code,
          bank_description: info?.description ?? detected.bank_code,
          sort_code: info?.sort_code ?? detected.sort_code ?? '',
          account_number: info?.account_number ?? detected.account_number ?? '',
          message: `Detected bank account: ${detected.bank_code}`,
        });
      } else {
        const banks = await listBanks(operaDb);
        const found =
          detected.sort_code && detected.account_number
            ? ` Found: ${detected.sort_code} ${detected.account_number}`
            : '';
        res.json({
          success: true,
          detected: false,
          bank_code: null,
          message: `Could not detect bank account from file.${found} Please select manually.`,
          available_banks: banks.banks ?? [],
        });
      }
    } catch (err: any) {
      ctx.logger.error('Detect bank failed', err);
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  });

  /**
   * POST /api/bank-import/duplicate-override
   *
   * Record a user's decision to import a transaction despite it being
   * flagged as a possible duplicate. Faithful port of
   * `override_duplicate` (apps/bank_reconcile/api/routes.py:2961-3003).
   *
   * Query params:
   *   - transaction_hash: hash of the transaction
   *   - reason: free-text explanation
   *   - user_code: (optional) operator code from req.user.appRole etc.
   *
   * Upsert semantics — re-overriding the same hash updates the reason
   * and timestamp.
   */
  router.post(
    '/api/bank-import/duplicate-override',
    async (req: Request, res: Response) => {
      const appDb = getAppDb(req, res);
      if (!appDb) return;
      try {
        const transactionHash = String(req.query.transaction_hash ?? '').trim();
        const reason = String(req.query.reason ?? '').trim();
        const userCode = req.user?.userId ?? null;
        if (!transactionHash) {
          res.status(400).json({
            success: false,
            error: 'transaction_hash is required',
          });
          return;
        }
        if (!reason) {
          res.status(400).json({ success: false, error: 'reason is required' });
          return;
        }
        const result = await recordDuplicateOverride(appDb, {
          transactionHash,
          reason,
          userCode,
        });
        res.json(result);
      } catch (err: any) {
        ctx.logger.error('Duplicate override failed', err);
        res.status(500).json({ success: false, error: err?.message ?? String(err) });
      }
    },
  );

  /**
   * POST /api/bank-import/draft
   *
   * Save (upsert) a work-in-progress bank statement import. Faithful
   * port of `save_bank_import_draft` (routes.py:3297-3327).
   *
   * Body: { bank_code, source, filename, preview_data, user_edits,
   *         email_id?, attachment_id?, pdf_hash?, target_system? }
   */
  router.post('/api/bank-import/draft', async (req: Request, res: Response) => {
    const appDb = getAppDb(req, res);
    if (!appDb) return;
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await saveImportDraft(appDb, {
        bankCode: String(body.bank_code ?? ''),
        source: String(body.source ?? ''),
        filename: String(body.filename ?? ''),
        previewData: body.preview_data ?? {},
        userEdits: body.user_edits ?? {},
        emailId: body.email_id as number | string | null | undefined,
        attachmentId: (body.attachment_id as string | null | undefined) ?? null,
        pdfHash: (body.pdf_hash as string | null | undefined) ?? null,
        targetSystem: (body.target_system as string | undefined) ?? 'opera_se',
      });
      res.json(result);
    } catch (err: any) {
      ctx.logger.error('Save bank import draft failed', err);
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  });

  /**
   * GET /api/bank-import/draft
   *
   * Load a previously-saved draft. Faithful port of
   * `load_bank_import_draft` (routes.py:3333-3371). Optional filters
   * are applied only when explicitly provided (`null` means "no filter
   * on this column" — same as Python's `if x is not None` guards).
   */
  router.get('/api/bank-import/draft', async (req: Request, res: Response) => {
    const appDb = getAppDb(req, res);
    if (!appDb) return;
    try {
      const q = req.query;
      const bankCode = String(q.bank_code ?? '').trim();
      const source = String(q.source ?? '').trim();
      if (!bankCode || !source) {
        res.status(400).json({
          success: false,
          error: 'bank_code and source are required',
        });
        return;
      }
      const result = await loadImportDraft(appDb, {
        bankCode,
        source,
        emailId:
          q.email_id !== undefined && q.email_id !== ''
            ? String(q.email_id)
            : undefined,
        attachmentId:
          q.attachment_id !== undefined ? String(q.attachment_id) : undefined,
        pdfHash:
          q.pdf_hash !== undefined ? String(q.pdf_hash) : undefined,
        filename:
          q.filename !== undefined ? String(q.filename) : undefined,
      });
      res.json(result);
    } catch (err: any) {
      ctx.logger.error('Load bank import draft failed', err);
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  });

  /**
   * DELETE /api/bank-import/draft
   *
   * Delete a saved draft (after import completion or manual clear).
   * Same identifying-key shape as load.
   */
  router.delete(
    '/api/bank-import/draft',
    async (req: Request, res: Response) => {
      const appDb = getAppDb(req, res);
      if (!appDb) return;
      try {
        const q = req.query;
        const bankCode = String(q.bank_code ?? '').trim();
        const source = String(q.source ?? '').trim();
        if (!bankCode || !source) {
          res.status(400).json({
            success: false,
            error: 'bank_code and source are required',
          });
          return;
        }
        const result = await deleteImportDraft(appDb, {
          bankCode,
          source,
          emailId:
            q.email_id !== undefined && q.email_id !== ''
              ? String(q.email_id)
              : undefined,
          attachmentId:
            q.attachment_id !== undefined ? String(q.attachment_id) : undefined,
          pdfHash:
            q.pdf_hash !== undefined ? String(q.pdf_hash) : undefined,
          filename: q.filename !== undefined ? String(q.filename) : undefined,
        });
        res.json(result);
      } catch (err: any) {
        ctx.logger.error('Delete bank import draft failed', err);
        res.status(500).json({ success: false, error: err?.message ?? String(err) });
      }
    },
  );

  /**
   * GET /api/bank-import/accounts/customers
   *
   * Customer accounts for the import-UI manual override dropdown.
   * Faithful port of get_customers_for_dropdown
   * (apps/bank_reconcile/api/routes.py:4767-4805).
   *
   * Adds the dormant + stopped filters per CLAUDE.md "cannot post to
   * dormant accounts" — the original Python missed these on the
   * dropdown but enforces them on actual posting; this prevents the
   * operator from picking an account they couldn't post to anyway.
   */
  router.get(
    '/api/bank-import/accounts/customers',
    async (req: Request, res: Response) => {
      const operaDb = getOperaDb(req, res);
      if (!operaDb) return;
      try {
        const result = await getCustomersForDropdown(operaDb);
        res.json(result);
      } catch (err: any) {
        ctx.logger.error('Customers dropdown failed', err);
        res.status(500).json({ success: false, error: err?.message ?? String(err) });
      }
    },
  );

  /**
   * GET /api/bank-import/accounts/suppliers
   *
   * Supplier accounts for the import-UI manual override dropdown.
   * Faithful port of get_suppliers_for_dropdown
   * (apps/bank_reconcile/api/routes.py:4811-4849).
   *
   * Same dormant+stopped filtering as the customer dropdown.
   */
  router.get(
    '/api/bank-import/accounts/suppliers',
    async (req: Request, res: Response) => {
      const operaDb = getOperaDb(req, res);
      if (!operaDb) return;
      try {
        const result = await getSuppliersForDropdown(operaDb);
        res.json(result);
      } catch (err: any) {
        ctx.logger.error('Suppliers dropdown failed', err);
        res.status(500).json({ success: false, error: err?.message ?? String(err) });
      }
    },
  );

  /**
   * GET /api/gocardless/nominal-accounts
   *
   * Nominal accounts for the import UI's "Nominal Receipt/Payment"
   * dropdown. Faithful port of get_nominal_accounts
   * (apps/gocardless/api/routes.py:1744-1779). Reads Opera's nacnt
   * table, filters out Z-prefixed system accounts, returns
   * code + description + project/department flags so the UI knows
   * whether to surface project/department selectors per row.
   *
   * Path is `/gocardless/nominal-accounts` because the vendored FE
   * still uses the legacy gocardless plugin URL. The endpoint is
   * implemented inside the bank-reconcile router so it works in
   * standalone mode without depending on the gocardless plugin
   * being loaded.
   */
  router.get(
    '/api/gocardless/nominal-accounts',
    async (req: Request, res: Response) => {
      const operaDb = getOperaDb(req, res);
      if (!operaDb) return;
      try {
        const rows = (await operaDb.raw(
          `SELECT na_acnt, na_desc,
                  ISNULL(na_allwprj, 0) AS na_allwprj,
                  ISNULL(na_allwjob, 0) AS na_allwjob,
                  RTRIM(ISNULL(na_project, '')) AS na_project,
                  RTRIM(ISNULL(na_job, '')) AS na_job
           FROM nacnt WITH (NOLOCK)
           WHERE na_acnt NOT LIKE 'Z%'
           ORDER BY na_acnt`,
        )) as unknown as Array<{
          na_acnt: string;
          na_desc: string | null;
          na_allwprj: number | null;
          na_allwjob: number | null;
          na_project: string | null;
          na_job: string | null;
        }>;
        const accounts = (Array.isArray(rows) ? rows : []).map((r) => ({
          code: (r.na_acnt ?? '').trim(),
          description: (r.na_desc ?? '').trim(),
          allow_project: Number(r.na_allwprj ?? 0),
          allow_department: Number(r.na_allwjob ?? 0),
          default_project: (r.na_project ?? '').trim(),
          default_department: (r.na_job ?? '').trim(),
        }));
        res.json({ success: true, accounts });
      } catch (err: any) {
        ctx.logger.error('nominal-accounts failed', err);
        res.json({ success: false, accounts: [], error: err?.message ?? String(err) });
      }
    },
  );

  /**
   * GET /api/nominal/advanced-config
   *
   * Company-level Advanced Nominal toggle (project/department
   * enabled flags + custom field labels). Faithful port of
   * get_advanced_nominal_config (sql_rag/opera_config.py:455). The
   * FE uses this to decide whether to show project/department
   * dropdowns on nominal posting rows.
   */
  router.get(
    '/api/nominal/advanced-config',
    async (req: Request, res: Response) => {
      const operaDb = getOperaDb(req, res);
      if (!operaDb) {
        res.json({ success: true, project_enabled: false, department_enabled: false });
        return;
      }
      const result = {
        project_enabled: false,
        department_enabled: false,
        project_label: 'Project',
        department_label: 'Department',
      };
      try {
        const rows = (await operaDb.raw(
          `SELECT co_advproj, co_advjob
           FROM Opera3SESystem.dbo.seqco WITH (NOLOCK)
           WHERE co_code = RIGHT(DB_NAME(), 1)`,
        )) as unknown as Array<{
          co_advproj?: number | boolean | null;
          co_advjob?: number | boolean | null;
        }>;
        if (Array.isArray(rows) && rows.length > 0 && rows[0]) {
          result.project_enabled = !!rows[0].co_advproj;
          result.department_enabled = !!rows[0].co_advjob;
        }
      } catch {
        // Try local seqco fallback (opera_config.py:487-496)
        try {
          const rows = (await operaDb.raw(
            `SELECT TOP 1 co_advproj, co_advjob FROM seqco WITH (NOLOCK)`,
          )) as unknown as Array<{
            co_advproj?: number | boolean | null;
            co_advjob?: number | boolean | null;
          }>;
          if (Array.isArray(rows) && rows.length > 0 && rows[0]) {
            result.project_enabled = !!rows[0].co_advproj;
            result.department_enabled = !!rows[0].co_advjob;
          }
        } catch {
          /* tolerated */
        }
      }
      try {
        const rows = (await operaDb.raw(
          `SELECT RTRIM(ISNULL(sy_nlproj, '')) AS sy_nlproj,
                  RTRIM(ISNULL(sy_nljob, '')) AS sy_nljob
           FROM Opera3SESystem.dbo.seqsys WITH (NOLOCK)`,
        )) as unknown as Array<{
          sy_nlproj?: string | null;
          sy_nljob?: string | null;
        }>;
        if (Array.isArray(rows) && rows.length > 0 && rows[0]) {
          const p = (rows[0].sy_nlproj ?? '').trim();
          const d = (rows[0].sy_nljob ?? '').trim();
          if (p) result.project_label = p;
          if (d) result.department_label = d;
        }
      } catch {
        /* tolerated */
      }
      res.json({ success: true, ...result });
    },
  );

  /**
   * GET /api/nominal/projects
   *
   * Project codes for nominal posting rows. Faithful port of
   * get_project_codes (api/main.py:11034). Reads nproj; tolerates
   * missing table (older Opera installs).
   */
  router.get(
    '/api/nominal/projects',
    async (req: Request, res: Response) => {
      const operaDb = getOperaDb(req, res);
      if (!operaDb) {
        res.json({ success: true, projects: [] });
        return;
      }
      try {
        const rows = (await operaDb.raw(
          `SELECT RTRIM(nr_project) AS nr_project,
                  RTRIM(ISNULL(nr_desc, '')) AS nr_desc
           FROM nproj WITH (NOLOCK)
           ORDER BY nr_project`,
        )) as unknown as Array<{ nr_project: string; nr_desc: string | null }>;
        const projects = (Array.isArray(rows) ? rows : []).map((r) => ({
          code: (r.nr_project ?? '').trim(),
          description: (r.nr_desc ?? '').trim(),
        }));
        res.json({ success: true, projects });
      } catch {
        // Table may not exist on older installs — return empty,
        // matches legacy fallback (api/main.py:11056).
        res.json({ success: true, projects: [] });
      }
    },
  );

  /**
   * GET /api/nominal/departments
   *
   * Department codes for nominal posting rows. Faithful port of
   * get_department_codes (api/main.py:11059). Reads njob; tolerates
   * missing table.
   */
  router.get(
    '/api/nominal/departments',
    async (req: Request, res: Response) => {
      const operaDb = getOperaDb(req, res);
      if (!operaDb) {
        res.json({ success: true, departments: [] });
        return;
      }
      try {
        const rows = (await operaDb.raw(
          `SELECT RTRIM(no_job) AS no_job,
                  RTRIM(ISNULL(no_desc, '')) AS no_desc
           FROM njob WITH (NOLOCK)
           ORDER BY no_job`,
        )) as unknown as Array<{ no_job: string; no_desc: string | null }>;
        const departments = (Array.isArray(rows) ? rows : []).map((r) => ({
          code: (r.no_job ?? '').trim(),
          description: (r.no_desc ?? '').trim(),
        }));
        res.json({ success: true, departments });
      } catch {
        res.json({ success: true, departments: [] });
      }
    },
  );

  /**
   * POST /api/reconcile/bank/:bank_code/unreconcile
   *
   * Reverse a previously-reconciled batch. Faithful port of
   * `unreconcile_entries` (apps/bank_reconcile/api/routes.py:981-1143).
   *
   * Body: array of entry numbers to unreconcile.
   *
   * Resets every per-aentry rec field, recalculates nbank.nk_recbal,
   * and walks back to the prior batch state to update nbank's last-rec
   * fields. Bank-level lock + ROWLOCK on writes per CLAUDE.md.
   *
   * SQL injection guards: bank_code + every entry number validated at
   * the boundary via @sqlrag/sam-shared validators.
   */
  router.post(
    '/api/reconcile/bank/:bank_code/unreconcile',
    async (req: Request, res: Response) => {
      const operaDb = getOperaDb(req, res);
      if (!operaDb) return;
      const appDb = getAppDb(req, res);
      if (!appDb) return;
      try {
        const bankCode = String(req.params.bank_code ?? '');
        const body = req.body as
          | string[]
          | { entry_numbers?: string[] }
          | null;
        const entryNumbers = Array.isArray(body)
          ? body
          : Array.isArray(body?.entry_numbers)
            ? body.entry_numbers
            : null;
        if (!entryNumbers) {
          res.status(400).json({
            success: false,
            error: 'Body must be an array of entry numbers',
          });
          return;
        }
        const result = await unreconcileEntries(appDb, operaDb, {
          bankCode,
          entryNumbers,
        });
        if (!result.success) {
          res.status(400).json(result);
          return;
        }
        res.json(result);
      } catch (err: any) {
        ctx.logger.error('Unreconcile failed', err);
        res.status(500).json({ success: false, error: err?.message ?? String(err) });
      }
    },
  );

  /**
   * POST /api/reconcile/bank/:bank_code/mark-reconciled
   *
   * Mark cashbook entries as reconciled (full or partial).
   * Faithful port of mark_entries_reconciled (apps/bank_reconcile/api/
   * routes.py:897-975) + the underlying OperaSQLImport method.
   *
   * Body:
   *   {
   *     entries: [{entry_number, statement_line}, ...],
   *     statement_number: number,
   *     statement_date?:    'YYYY-MM-DD',
   *     reconciliation_date?: 'YYYY-MM-DD',
   *     partial?: boolean,
   *     closing_balance?: number  // pounds, used for nk_reccfwd in partial mode
   *   }
   *
   * Bank-level lock + UPDLOCK on nbank/aentry reads, ROWLOCK on
   * writes, single transaction.
   */
  router.post(
    '/api/reconcile/bank/:bank_code/mark-reconciled',
    async (req: Request, res: Response) => {
      const operaDb = getOperaDb(req, res);
      if (!operaDb) return;
      const appDb = getAppDb(req, res);
      if (!appDb) return;
      try {
        const bankCode = String(req.params.bank_code ?? '');
        const body = (req.body ?? {}) as {
          entries?: ReconcileEntryInput[];
          statement_number?: number;
          statement_date?: string;
          reconciliation_date?: string;
          partial?: boolean;
          closing_balance?: number;
        };
        const result = await markEntriesReconciled(appDb, operaDb, {
          bankCode,
          entries: Array.isArray(body.entries) ? body.entries : [],
          statementNumber: Number(body.statement_number ?? 0),
          statementDate: body.statement_date ?? null,
          reconciliationDate: body.reconciliation_date ?? null,
          partial: !!body.partial,
          closingBalance:
            body.closing_balance !== undefined ? Number(body.closing_balance) : null,
        });
        if (!result.success) {
          res.status(400).json(result);
          return;
        }
        res.json(result);
      } catch (err: any) {
        ctx.logger.error('Mark reconciled failed', err);
        res.status(500).json({ success: false, error: err?.message ?? String(err) });
      }
    },
  );

  /**
   * POST /api/bank-import/correction
   *
   * Record an operator correction to the bank-name → Opera-account
   * matching. Faithful port of record_correction (routes.py:2845-2895)
   * + BankAliasManager.record_correction (bank_aliases.py:728-790).
   *
   * Three side-effects in one transaction:
   *   1. Audit row in alias_corrections
   *   2. Upsert positive alias in bank_import_aliases (confidence=1.0)
   *   3. INSERT-OR-IGNORE negative example in negative_aliases so
   *      future matches avoid the bad mapping
   *
   * Query params:
   *   - bank_name        (required)
   *   - wrong_account    (required)
   *   - correct_account  (required)
   *   - ledger_type      (required: 'S' supplier | 'C' customer)
   *   - account_name     (optional — currently informational)
   */
  router.post(
    '/api/bank-import/correction',
    async (req: Request, res: Response) => {
      const appDb = getAppDb(req, res);
      if (!appDb) return;
      try {
        const q = req.query;
        const result = await recordCorrection(appDb, {
          bank_name: String(q.bank_name ?? ''),
          wrong_account: String(q.wrong_account ?? ''),
          correct_account: String(q.correct_account ?? ''),
          ledger_type: String(q.ledger_type ?? ''),
          account_name: typeof q.account_name === 'string' ? q.account_name : null,
          corrected_by: req.user?.userId ?? 'USER',
        });
        if (!result.success) {
          res.status(400).json(result);
          return;
        }
        res.json(result);
      } catch (err: any) {
        ctx.logger.error('Record correction failed', err);
        res.status(500).json({ success: false, error: err?.message ?? String(err) });
      }
    },
  );

  /**
   * GET /api/bank-import/corrections
   *
   * List recorded alias corrections (audit trail UI).
   */
  router.get(
    '/api/bank-import/corrections',
    async (req: Request, res: Response) => {
      const appDb = getAppDb(req, res);
      if (!appDb) return;
      try {
        const result = await listCorrections(appDb, {
          bankName:
            typeof req.query.bank_name === 'string' ? req.query.bank_name : null,
          correctAccount:
            typeof req.query.correct_account === 'string'
              ? req.query.correct_account
              : null,
          limit: req.query.limit ? Number(req.query.limit) : undefined,
        });
        if (!result.success) {
          res.status(400).json(result);
          return;
        }
        res.json(result);
      } catch (err: any) {
        ctx.logger.error('List corrections failed', err);
        res.status(500).json({ success: false, error: err?.message ?? String(err) });
      }
    },
  );

  /**
   * POST /api/reconcile/bank/:bank_code/complete-batch/:entry_number
   *
   * Complete an incomplete cashbook batch by posting to the nominal
   * ledger. Faithful port of complete_batch (routes.py:849-891) +
   * OperaSQLImport.complete_batch_posting (opera_sql_import.py
   * :8809-9019).
   *
   * Reads unposted anoml records (ax_done='N') for the entry,
   * creates the corresponding ntran rows + updates nacnt/nhist/
   * nbank, marks anoml ax_done='Y', and sets ae_complet=1. All in
   * a single transaction with bank-level lock.
   *
   * SQL injection guards: bank_code + entry_number validated at
   * the route boundary.
   */
  router.post(
    '/api/reconcile/bank/:bank_code/complete-batch/:entry_number',
    async (req: Request, res: Response) => {
      const operaDb = getOperaDb(req, res);
      if (!operaDb) return;
      const appDb = getAppDb(req, res);
      if (!appDb) return;
      try {
        const result = await completeBatch(appDb, operaDb, {
          bankCode: String(req.params.bank_code ?? ''),
          entryNumber: String(req.params.entry_number ?? ''),
        });
        if (!result.success) {
          res.status(400).json(result);
          return;
        }
        res.json(result);
      } catch (err: any) {
        ctx.logger.error('Complete batch failed', err);
        res.status(500).json({ success: false, error: err?.message ?? String(err) });
      }
    },
  );

  /**
   * POST /api/bank-import/persist-decisions
   *
   * Persist defer / partial-rec decisions for a bank statement WITHOUT
   * requiring the user to click the green Import button. Faithful
   * port of persist_bank_import_decisions (routes.py:3406-3565).
   *
   * Body:
   *   {
   *     bank_code, filename,
   *     source: 'pdf'|'email',
   *     statement_info: { opening_balance?, closing_balance?,
   *                        statement_date?, period_start?, period_end?,
   *                        account_number?, sort_code? },
   *     deferred_transactions: [{date, amount, description}],
   *     imported_by?: string
   *   }
   *
   * Behaviour:
   *   - Idempotent UPSERT of bank_statement_imports row
   *   - Replaces the bank+period defer set in deferred_transactions
   *     (period bounds optional — full-bank clear if omitted)
   */
  router.post(
    '/api/bank-import/persist-decisions',
    async (req: Request, res: Response) => {
      const appDb = getAppDb(req, res);
      if (!appDb) return;
      try {
        const body = (req.body ?? {}) as {
          bank_code?: string;
          filename?: string;
          source?: string;
          statement_info?: any;
          deferred_transactions?: any[];
          imported_by?: string;
        };
        const result = await persistImportDecisions(appDb, {
          bankCode: String(body.bank_code ?? ''),
          filename: String(body.filename ?? ''),
          source: String(body.source ?? 'pdf'),
          statementInfo: body.statement_info ?? null,
          deferredTransactions: Array.isArray(body.deferred_transactions)
            ? body.deferred_transactions
            : [],
          importedBy: body.imported_by ?? req.user?.userId ?? 'admin',
        });
        if (!result.success) {
          res.status(400).json(result);
          return;
        }
        res.json(result);
      } catch (err: any) {
        ctx.logger.error('Persist decisions failed', err);
        res.status(500).json({ success: false, error: err?.message ?? String(err) });
      }
    },
  );

  /**
   * POST /api/reconcile/bank/:bank_code/confirm-matches
   *
   * Confirm matched transactions and reconcile them. Faithful port of
   * confirm_statement_matches (routes.py:1935-2035). Thin wrapper
   * around mark-reconciled that:
   *   - reads the next statement_number from nbank.nk_lststno + 1
   *     (per CLAUDE.md never use MAX+1 — comes from Opera's stored
   *     counter)
   *   - assigns statement_line numbers in 10s (Opera convention)
   *   - delegates the actual write to markEntriesReconciled (which
   *     has the bank lock + UPDLOCK + ROWLOCK + transaction)
   *
   * Body:
   *   {
   *     matches: [{ ae_entry } | { opera_entry: { ae_entry }}, ...],
   *     statement_balance: number  (pounds — flows to nk_reccfwd),
   *     statement_date: 'YYYY-MM-DD'
   *   }
   */
  router.post(
    '/api/reconcile/bank/:bank_code/confirm-matches',
    async (req: Request, res: Response) => {
      const operaDb = getOperaDb(req, res);
      if (!operaDb) return;
      const appDb = getAppDb(req, res);
      if (!appDb) return;
      try {
        const body = (req.body ?? {}) as {
          matches?: ConfirmMatchInput[];
          statement_balance?: number;
          statement_date?: string;
        };
        const result = await confirmStatementMatches(appDb, operaDb, {
          bankCode: String(req.params.bank_code ?? ''),
          matches: Array.isArray(body.matches) ? body.matches : [],
          statementBalance: Number(body.statement_balance ?? 0),
          statementDate: String(body.statement_date ?? ''),
        });
        if (!result.success) {
          res.status(400).json(result);
          return;
        }
        res.json(result);
      } catch (err: any) {
        ctx.logger.error('Confirm matches failed', err);
        res.status(500).json({ success: false, error: err?.message ?? String(err) });
      }
    },
  );

  /**
   * GET /api/reconcile/bank/:bank_code/scan-emails (legacy/deprecated)
   *
   * Returns the deprecated-redirect payload pointing callers at the
   * real /api/bank-import/scan-emails endpoint. Faithful port of
   * scan_emails_for_statements_legacy (routes.py:2041-2062). Older
   * frontend builds still bind to this URL — we preserve the URL
   * shape but make it explicit that the data is empty.
   */
  router.get(
    '/api/reconcile/bank/:bank_code/scan-emails',
    (_req: Request, res: Response) => {
      res.json({
        success: false,
        deprecated: true,
        redirect_to: '/api/bank-import/scan-emails',
        message:
          "This endpoint is deprecated — use /api/bank-import/scan-emails " +
          "instead. The legacy URL preserved an empty placeholder; that's " +
          'been removed to stop callers silently receiving zero results.',
        statements_found: [],
      });
    },
  );

  /**
   * GET /api/bank-import/repeat-entries?bank_code=...
   *
   * List active repeat entries for a bank — debug + UI listing.
   * Faithful port of list_repeat_entries (routes.py:5425-5495).
   * Joins arhead + arline so each entry includes its first line's
   * amount/account/cbtype/comment for display purposes.
   */
  router.get(
    '/api/bank-import/repeat-entries',
    async (req: Request, res: Response) => {
      const operaDb = getOperaDb(req, res);
      if (!operaDb) return;
      try {
        const result = await listRepeatEntries(
          operaDb,
          String(req.query.bank_code ?? ''),
        );
        if (!result.success) {
          res.status(400).json(result);
          return;
        }
        res.json(result);
      } catch (err: any) {
        ctx.logger.error('List repeat entries failed', err);
        res.status(500).json({ success: false, error: err?.message ?? String(err) });
      }
    },
  );

  /**
   * POST /api/bank-import/update-repeat-entry-date
   *
   * Update ae_nxtpost on an arhead row so the operator can sync a
   * repeat entry's next posting date with the actual bank
   * transaction date. Faithful port of update_repeat_entry_date
   * (routes.py:5320-5419).
   *
   * Bank-level lock + ROWLOCK on the UPDATE per CLAUDE.md.
   *
   * Optional alias save: when statement_name is supplied, upsert a
   * row in repeat_entry_aliases (per-app DB) so future imports
   * auto-match this bank statement description to this repeat entry.
   *
   * Query params:
   *   - bank_code, entry_ref, new_date (YYYY-MM-DD)
   *   - statement_name (optional)
   */
  router.post(
    '/api/bank-import/update-repeat-entry-date',
    async (req: Request, res: Response) => {
      const operaDb = getOperaDb(req, res);
      if (!operaDb) return;
      const appDb = getAppDb(req, res);
      if (!appDb) return;
      try {
        const q = req.query;
        const result = await updateRepeatEntryDate(appDb, operaDb, {
          bankCode: String(q.bank_code ?? ''),
          entryRef: String(q.entry_ref ?? ''),
          newDate: String(q.new_date ?? ''),
          statementName:
            typeof q.statement_name === 'string' ? q.statement_name : null,
        });
        if (!result.success) {
          res.status(400).json(result);
          return;
        }
        res.json(result);
      } catch (err: any) {
        ctx.logger.error('Update repeat entry date failed', err);
        res.status(500).json({ success: false, error: err?.message ?? String(err) });
      }
    },
  );

  /**
   * GET /api/bank-import/import-history
   *
   * List bank statement import audit rows. Faithful port of
   * get_bank_statement_import_history (apps/bank_reconcile/api/
   * routes.py:9967-9997).
   *
   * Query params:
   *   - bank_code (optional)
   *   - from_date / to_date (statement_date range, optional)
   *   - limit (default 50)
   * Filters target_system='opera_se' to match the Python wrapper —
   * the legacy variant on /api/bank-import/email-import-history below
   * mirrors that without the filter for backwards compatibility.
   */
  router.get(
    '/api/bank-import/import-history',
    async (req: Request, res: Response) => {
      const appDb = ctx.db.app;
      if (!appDb) {
        res.status(503).json({
          success: false,
          error: 'bank-reconcile per-app database not provisioned for this tenant.',
        });
        return;
      }
      try {
        const result = await listImportHistory(appDb, {
          bankCode:
            typeof req.query.bank_code === 'string'
              ? req.query.bank_code
              : null,
          fromDate:
            typeof req.query.from_date === 'string'
              ? req.query.from_date
              : null,
          toDate:
            typeof req.query.to_date === 'string'
              ? req.query.to_date
              : null,
          limit: req.query.limit ? Number(req.query.limit) : 50,
        });
        res.json(result);
      } catch (err: any) {
        ctx.logger.error('List import history failed', err);
        res.status(500).json({ success: false, error: err?.message ?? String(err) });
      }
    },
  );

  /**
   * GET /api/bank-import/email-import-history
   *
   * Legacy alias for /api/bank-import/import-history. Same shape but
   * the response key is `history` (Python wrapper kept that name for
   * backwards compatibility — see routes.py:10171-10192). Filters
   * default-target_system NOT applied; matches Python's exact
   * behaviour.
   */
  router.get(
    '/api/bank-import/email-import-history',
    async (req: Request, res: Response) => {
      const appDb = ctx.db.app;
      if (!appDb) {
        res.status(503).json({
          success: false,
          error: 'bank-reconcile per-app database not provisioned for this tenant.',
        });
        return;
      }
      try {
        const result = await listImportHistory(appDb, {
          bankCode:
            typeof req.query.bank_code === 'string'
              ? req.query.bank_code
              : null,
          limit: req.query.limit ? Number(req.query.limit) : 50,
          targetSystem: null, // legacy: no target_system filter
        });
        if (!result.success) {
          res.status(500).json(result);
          return;
        }
        res.json({
          success: true,
          history: result.imports,
          count: result.count,
        });
      } catch (err: any) {
        ctx.logger.error('List email import history failed', err);
        res.status(500).json({ success: false, error: err?.message ?? String(err) });
      }
    },
  );

  /**
   * DELETE /api/bank-import/import-history/:record_id
   *
   * Delete a single import audit row so the statement can be
   * re-imported. Faithful port of delete_bank_statement_import_record
   * (apps/bank_reconcile/api/routes.py:10104-10131). Does NOT touch
   * Opera — only the local audit row.
   */
  router.delete(
    '/api/bank-import/import-history/:record_id',
    async (req: Request, res: Response) => {
      const appDb = ctx.db.app;
      if (!appDb) {
        res.status(503).json({
          success: false,
          error: 'bank-reconcile per-app database not provisioned for this tenant.',
        });
        return;
      }
      try {
        const id = Number(req.params.record_id);
        const result = await deleteImportRecord(appDb, id);
        if (!result.success) {
          res
            .status(/not found/i.test(result.error ?? '') ? 404 : 400)
            .json(result);
          return;
        }
        res.json(result);
      } catch (err: any) {
        ctx.logger.error('Delete import record failed', err);
        res.status(500).json({ success: false, error: err?.message ?? String(err) });
      }
    },
  );

  /**
   * DELETE /api/bank-import/import-history
   *
   * Bulk-clear import audit rows by optional bank_code + date range.
   * Faithful port of clear_bank_statement_import_history
   * (apps/bank_reconcile/api/routes.py:10137-10165). Returns the
   * deleted count.
   */
  router.delete(
    '/api/bank-import/import-history',
    async (req: Request, res: Response) => {
      const appDb = ctx.db.app;
      if (!appDb) {
        res.status(503).json({
          success: false,
          error: 'bank-reconcile per-app database not provisioned for this tenant.',
        });
        return;
      }
      try {
        const result = await clearImportHistory(appDb, {
          bankCode:
            typeof req.query.bank_code === 'string'
              ? req.query.bank_code
              : null,
          fromDate:
            typeof req.query.from_date === 'string'
              ? req.query.from_date
              : null,
          toDate:
            typeof req.query.to_date === 'string'
              ? req.query.to_date
              : null,
        });
        res.json(result);
      } catch (err: any) {
        ctx.logger.error('Clear import history failed', err);
        res.status(500).json({ success: false, error: err?.message ?? String(err) });
      }
    },
  );

  /**
   * GET /api/bank-import/folder-settings
   *
   * Read the per-tenant bank-statement folder paths used by both the
   * file-system scanner and the email-archiver. Faithful port of
   * get_bank_import_folder_settings (apps/bank_reconcile/api/
   * routes.py:5501-5516). Always returns success=true so the UI
   * loads even when the row is missing.
   */
  router.get(
    '/api/bank-import/folder-settings',
    async (_req: Request, res: Response) => {
      const appDb = ctx.db.app;
      if (!appDb) {
        res.status(503).json({
          success: false,
          error: 'bank-reconcile per-app database not provisioned for this tenant.',
        });
        return;
      }
      try {
        const result = await getFolderSettings(appDb);
        res.json(result);
      } catch (err: any) {
        ctx.logger.error('Get folder settings failed', err);
        res.status(500).json({ success: false, error: err?.message ?? String(err) });
      }
    },
  );

  /**
   * POST /api/bank-import/folder-settings
   *
   * Update the bank-statement folder paths. Faithful port of
   * save_bank_import_folder_settings (apps/bank_reconcile/api/
   * routes.py:5522-5535). Empty strings are valid (clears the
   * setting).
   */
  router.post(
    '/api/bank-import/folder-settings',
    async (req: Request, res: Response) => {
      const appDb = ctx.db.app;
      if (!appDb) {
        res.status(503).json({
          success: false,
          error: 'bank-reconcile per-app database not provisioned for this tenant.',
        });
        return;
      }
      try {
        const body = (req.body ?? {}) as {
          base_folder?: string | null;
          archive_folder?: string | null;
        };
        const result = await saveFolderSettings(appDb, {
          base_folder: body.base_folder ?? '',
          archive_folder: body.archive_folder ?? '',
        });
        if (!result.success) {
          res.status(500).json(result);
          return;
        }
        res.json(result);
      } catch (err: any) {
        ctx.logger.error('Save folder settings failed', err);
        res.status(500).json({ success: false, error: err?.message ?? String(err) });
      }
    },
  );

  /**
   * GET /api/reconcile/bank/:bank_code
   *
   * Three-way bank-balance reconciliation: cashbook (atran) vs
   * bank master (nbank.nk_curbal) vs nominal ledger (ntran). Faithful
   * port of `reconcile_bank` (apps/bank_reconcile/api/routes.py
   * :320-704).
   *
   * Returns full diagnostic payload: bank info, cashbook section
   * (current year movements + B/F + transfer-file pending),
   * bank-master balance, NL section, three pairwise variances,
   * summary + RECONCILED / UNRECONCILED status with a human-readable
   * message describing each mismatch.
   *
   * NB: route is GET /api/reconcile/bank/:bank_code, NOT under
   * /api/bank-reconciliation. Matches the legacy URL the frontend
   * already calls.
   */
  router.get(
    '/api/reconcile/bank/:bank_code',
    async (req: Request, res: Response) => {
      const operaDb = getOperaDb(req, res);
      if (!operaDb) return;
      try {
        const bankCode = String(req.params.bank_code ?? '').trim();
        const result = await reconcileBank(operaDb, bankCode);
        if (!result.success) {
          res
            .status(/not found/i.test(result.error ?? '') ? 404 : 400)
            .json(result);
          return;
        }
        res.json(result);
      } catch (err: any) {
        ctx.logger.error('Reconcile bank failed', err);
        res.status(500).json({ success: false, error: err?.message ?? String(err) });
      }
    },
  );

  /**
   * POST /api/bank-reconciliation/complete
   *
   * Final closer for the bank-reconciliation flow. Faithful port of
   * complete_reconciliation (apps/bank_reconcile/api/routes.py
   * :10416-10794) + OperaSQLImport.complete_reconciliation
   * (sql_rag/opera_sql_import.py:9021-9145).
   *
   * Pipeline:
   *   1. Validate inputs (bank_code, statement metadata, matched
   *      entries non-empty)
   *   2. Service computes calculated closing, auto-detects partial
   *      mode if mismatch within 1p tolerance, generates gap-aware
   *      ae_statln line numbers, delegates to markEntriesReconciled
   *   3. On success, update bank_statement_imports tracking row
   *      (is_reconciled / reconciled_count / statement_number)
   *      when import_id supplied
   *
   * Query params:
   *   - bank_code (required)
   *   - statement_number (required, integer)
   *   - statement_date (required, YYYY-MM-DD)
   *   - closing_balance (required, pounds)
   *   - partial (optional, defaults false)
   *   - import_id (optional, for app-DB tracking update)
   *
   * Body:
   *   - matched_entries[] (required): { entry_number, statement_line }
   *   - statement_transactions[] (optional): drives gap calculation
   *   - period_start, period_end (optional, YYYY-MM-DD)
   */
  router.post(
    '/api/bank-reconciliation/complete',
    async (req: Request, res: Response) => {
      const operaDb = getOperaDb(req, res);
      if (!operaDb) return;
      const appDb = ctx.db.app;
      if (!appDb) {
        res.status(503).json({
          success: false,
          error:
            'bank-reconcile per-app database not provisioned for this tenant.',
        });
        return;
      }
      try {
        const bankCode = String(req.query.bank_code ?? '').trim();
        const statementNumber = Number(req.query.statement_number);
        const statementDate = String(req.query.statement_date ?? '').trim();
        const closingBalance = Number(req.query.closing_balance);
        const partial =
          req.query.partial === 'true' || req.query.partial === '1';
        const importId = req.query.import_id
          ? Number(req.query.import_id)
          : null;
        if (
          !bankCode ||
          !Number.isFinite(statementNumber) ||
          !statementDate ||
          !Number.isFinite(closingBalance)
        ) {
          res.status(400).json({
            success: false,
            error:
              'bank_code, statement_number, statement_date, closing_balance are required',
          });
          return;
        }
        const body = (req.body ?? {}) as {
          matched_entries?: Array<{ entry_number: string; statement_line: number }>;
          statement_transactions?: unknown[];
        };
        const matchedEntries = Array.isArray(body.matched_entries)
          ? body.matched_entries
          : [];
        if (matchedEntries.length === 0) {
          res.status(400).json({
            success: false,
            error: 'No matched entries provided',
          });
          return;
        }
        const result = await completeReconciliation(operaDb, appDb, {
          bankCode,
          statementNumber,
          statementDate,
          closingBalance,
          matchedEntries,
          statementTransactions: Array.isArray(body.statement_transactions)
            ? body.statement_transactions
            : [],
          partial,
        });

        // App-DB tracking update on success
        if (result.success && importId !== null && Number.isFinite(importId)) {
          try {
            const newRecBal = result.new_reconciled_balance ?? null;
            const statementActuallyComplete =
              !result.partial ||
              (newRecBal !== null &&
                Math.abs(newRecBal - closingBalance) < 0.01);
            const isReconciled = statementActuallyComplete ? 1 : 0;
            await appDb('bank_statement_imports')
              .where({ id: importId })
              .update({
                is_reconciled: isReconciled,
                reconciled_count: result.records_reconciled ?? 0,
                reconciled_at: appDb.fn.now(),
              });
          } catch (dbErr: any) {
            ctx.logger.warn?.(
              'Could not update bank_statement_imports tracking row',
              dbErr,
            );
          }
        }
        res.json(result);
      } catch (err: any) {
        ctx.logger.error('Complete reconciliation failed', err);
        res.status(500).json({
          success: false,
          error: err?.message ?? String(err),
        });
      }
    },
  );

  /**
   * POST /api/bank-reconciliation/validate-statement
   *
   * Validate that a bank statement is ready for reconciliation by
   * comparing its opening balance to Opera's `nbank.nk_recbal`.
   * Faithful port of validate_statement_for_reconciliation
   * (apps/bank_reconcile/api/routes.py:10198-10238).
   *
   * Query params:
   *   - bank_code (required)
   *   - opening_balance (required, pounds)
   *   - closing_balance (required, pounds)
   *   - statement_number (optional)
   *   - statement_date (required, YYYY-MM-DD)
   */
  router.post(
    '/api/bank-reconciliation/validate-statement',
    async (req: Request, res: Response) => {
      const operaDb = getOperaDb(req, res);
      if (!operaDb) return;
      try {
        const bankCode = String(req.query.bank_code ?? '').trim();
        const openingBalance = Number(req.query.opening_balance);
        const closingBalance = Number(req.query.closing_balance);
        const statementNumber =
          req.query.statement_number !== undefined &&
          req.query.statement_number !== ''
            ? Number(req.query.statement_number)
            : null;
        const statementDate =
          typeof req.query.statement_date === 'string'
            ? req.query.statement_date
            : null;
        const result = await validateStatementForReconciliation(operaDb, {
          bankAccount: bankCode,
          openingBalance,
          closingBalance,
          statementNumber,
          statementDate,
        });
        res.json(result);
      } catch (err: any) {
        ctx.logger.error('Validate statement failed', err);
        res.status(500).json({ valid: false, error_message: err?.message ?? String(err) });
      }
    },
  );

  /**
   * POST /api/bank-reconciliation/match-statement
   *
   * Match statement lines to unreconciled Opera cashbook entries.
   * Faithful port of match_statement_to_cashbook
   * (apps/bank_reconcile/api/routes.py:10244-10410 +
   *  sql_rag/opera_sql_import.py:8367-8760).
   *
   * Tiered matching:
   *   1. Exact reference + amount    → 100% (auto)
   *   2. Amount + closest date       → 55..100% (auto if ≥95)
   *   3. Already-reconciled second pass moves ✓-eligible lines
   *      out of unmatched_statement
   *
   * Query params:
   *   - bank_code (required)
   *   - date_tolerance_days (default 45)
   *
   * Body:
   *   - statement_transactions[] (required)
   *   - period_start / period_end (optional but recommended)
   */
  router.post(
    '/api/bank-reconciliation/match-statement',
    async (req: Request, res: Response) => {
      const operaDb = getOperaDb(req, res);
      if (!operaDb) return;
      try {
        const bankCode = String(req.query.bank_code ?? '').trim();
        if (!bankCode) {
          res.status(400).json({
            success: false,
            error: 'bank_code is required',
          });
          return;
        }
        const dateToleranceDays = req.query.date_tolerance_days
          ? Number(req.query.date_tolerance_days)
          : 45;
        const body = (req.body ?? {}) as {
          statement_transactions?: StatementTransaction[];
          period_start?: string | null;
          period_end?: string | null;
        };
        const txns = Array.isArray(body.statement_transactions)
          ? body.statement_transactions
          : [];
        if (txns.length === 0) {
          res.status(400).json({
            success: false,
            error: 'Request body must include statement_transactions',
          });
          return;
        }
        const result = await matchStatementToCashbook(operaDb, {
          bankAccount: bankCode,
          statementTransactions: txns,
          dateToleranceDays,
          periodStart: body.period_start ?? null,
          periodEnd: body.period_end ?? null,
          onWarn: (msg) => ctx.logger.warn?.(msg),
        });
        res.json(result);
      } catch (err: any) {
        ctx.logger.error('Match statement failed', err);
        res.status(500).json({ success: false, error: err?.message ?? String(err) });
      }
    },
  );

  /**
   * GET /api/bank-import/scan-emails
   *
   * Scan the connected mailbox for bank statement attachments.
   * Faithful port of `scan_emails_for_bank_statements`
   * (apps/bank_reconcile/api/routes.py:6043-6800), deterministic
   * core only. PDF balance validation is deferred — statements are
   * returned with `validation_status: 'pending'` until a separate
   * validate-from-pdf pass runs.
   *
   * Requires the SAM team to attach a `bankMailboxAdapter` and a
   * `bankReconciledKeyStore` to the runtime context (returns 503
   * until then). The adapters wrap whatever email-ingest +
   * reconciled-state strategy SAM settles on; everything else here
   * is engine-agnostic and exercised by scan-emails.test.ts.
   *
   * Query params:
   *   - bank_code        (required)
   *   - days_back        (default 30)
   *   - include_processed ('1'/'true' to include already-reconciled)
   *   - validate_balances ('false' to skip pending-validation flag)
   */
  router.get(
    '/api/bank-import/scan-emails',
    async (req: Request, res: Response) => {
      const operaDb = getOperaDb(req, res);
      if (!operaDb) return;
      const appDb = getAppDb(req, res);
      if (!appDb) return;
      const adapter = (ctx as unknown as {
        bankMailboxAdapter?: BankMailboxAdapter;
        bankReconciledKeyStore?: ReconciledKeyStore;
      });
      const mailbox =
        adapter.bankMailboxAdapter ?? builtinEmailIngest?.mailbox;
      if (!mailbox || !adapter.bankReconciledKeyStore) {
        res.status(503).json({
          success: false,
          error:
            'Mailbox adapter or reconciled-key store not configured. SAM email-ingest wiring required.',
        });
        return;
      }
      try {
        const bankCode = String(req.query.bank_code ?? '').trim();
        if (!bankCode) {
          res
            .status(400)
            .json({ success: false, error: 'bank_code is required' });
          return;
        }
        const daysBack = req.query.days_back
          ? Number(req.query.days_back)
          : 30;
        const includeProcessed =
          req.query.include_processed === '1' ||
          req.query.include_processed === 'true';
        const validateBalances = !(
          req.query.validate_balances === 'false' ||
          req.query.validate_balances === '0'
        );
        const result = await scanEmailsForBankStatements(
          operaDb,
          appDb,
          mailbox,
          adapter.bankReconciledKeyStore,
          {
            bankCode,
            daysBack,
            includeProcessed,
            validateBalances,
          },
        );
        if (!result.success) {
          res.status(400).json(result);
          return;
        }
        res.json(result);
      } catch (err: any) {
        ctx.logger.error('scan-emails failed', err);
        res.status(500).json({
          success: false,
          error: err?.message ?? String(err),
        });
      }
    },
  );

  /**
   * POST /api/bank-import/import-from-pdf
   *
   * Import a bank statement from a PDF and post the transactions to
   * Opera. Faithful port of the route-level orchestration in
   * `import_bank_statement_from_pdf` (routes.py:4031-4787).
   *
   * The actual PDF→transactions extraction (ctx.llm) and the posting
   * body (~750 LOC) are delegated to executor adapters the SAM team
   * attaches at construction time. The validation, overlap check,
   * lock acquisition, and audit-row write are deterministic and
   * exercised by import-from-pdf.test.ts.
   *
   * Body / query:
   *   - file_path (required)
   *   - bank_code (required)
   *   - auto_allocate ('1'/'true' to auto-allocate to invoices)
   *   - auto_reconcile ('1'/'true' to auto-reconcile after import)
   *   - resume_import_id (optional resume key)
   *   - body: { overrides, selected_rows, date_overrides,
   *            rejected_refund_rows, skip_overlap_check }
   */
  router.post(
    '/api/bank-import/import-from-pdf',
    async (req: Request, res: Response) => {
      const operaDb = getOperaDb(req, res);
      if (!operaDb) return;
      const appDb = getAppDb(req, res);
      if (!appDb) return;
      const adapter = ctx as unknown as {
        bankPdfExtractor?: PdfExtractor;
        bankImportExecutor?: ImportPostingExecutor;
        bankImportLock?: ImportLockAdapter;
        bankPeriodOverlapChecker?: PeriodOverlapChecker;
        bankPaymentRequestLookup?: (
          gcPaymentId: string,
        ) => Promise<string[] | null>;
      };
      const extractor = adapter.bankPdfExtractor ?? builtinPdfExtractor;
      if (!extractor) {
        res.status(503).json({
          success: false,
          error:
            'PDF extractor not configured. SAM team must provide ctx.bankPdfExtractor or enable ctx.llm.',
        });
        return;
      }
      const executor = adapter.bankImportExecutor ?? bankImportPostingExecutor;
      const lock = adapter.bankImportLock ?? inMemoryImportLock;
      const overlapChecker =
        adapter.bankPeriodOverlapChecker ??
        makeBankStatementOverlapChecker(appDb);
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const result = await importBankStatementFromPdf(
          operaDb,
          appDb,
          {
            filePath: String(req.query.file_path ?? body.file_path ?? ''),
            bankCode: String(req.query.bank_code ?? body.bank_code ?? ''),
            filename: (body.filename as string) ?? undefined,
            autoAllocate:
              req.query.auto_allocate === '1' ||
              req.query.auto_allocate === 'true',
            autoReconcile:
              req.query.auto_reconcile === '1' ||
              req.query.auto_reconcile === 'true',
            resumeImportId: req.query.resume_import_id
              ? Number(req.query.resume_import_id)
              : null,
            overrides: Array.isArray(body.overrides) ? body.overrides : [],
            selectedRows: Array.isArray(body.selected_rows)
              ? (body.selected_rows as number[])
              : null,
            dateOverrides: Array.isArray(body.date_overrides)
              ? body.date_overrides
              : [],
            rejectedRefundRows: Array.isArray(body.rejected_refund_rows)
              ? (body.rejected_refund_rows as number[])
              : [],
            skipOverlapCheck: body.skip_overlap_check === true,
            importedBy: req.user?.userId ?? null,
            // Tenant id (`standalone:<co>` in standalone mode, `<co>`
            // in plain SAM) is what the legacy learner key expects.
            // Stripping the namespace prefix keeps row reuse clean
            // across mode switches.
            companyCode: (ctx.tenantId ?? '').replace(/^standalone:/, '') || null,
            paymentRequestLookup: adapter.bankPaymentRequestLookup ?? null,
          },
          extractor,
          executor,
          lock,
          overlapChecker,
        );
        // Legacy returns 200 with `success: false` on overlap /
        // validation errors; only true server faults are non-200
        // (caught below). Anything keyed off HTTP status will break
        // otherwise — matches routes.py:4109 (return overlap_err) and
        // 4438 ("success": …) where neither call sets a non-200 code.
        res.json(result);
      } catch (err: any) {
        ctx.logger.error('import-from-pdf failed', err);
        res.status(500).json({
          success: false,
          error: err?.message ?? String(err),
        });
      }
    },
  );

  /**
   * POST /api/bank-import/check-duplicates
   *
   * Check a batch of bank transactions against Opera (atran/stran/ptran)
   * for already-imported duplicates. Faithful port of `check_duplicates`
   * (apps/bank_reconcile/api/routes.py:2901-2955).
   *
   * Covers all seven legacy strategies via findDuplicates:
   *   - fingerprint  (BKIMP:* in at_refer/st_trref/pt_trref) — definitive
   *   - fit_id       (OFX bank-issued unique txn id)         — definitive
   *   - exact        (date + amount + account)               — 0.90
   *   - fuzzy_amount (date + ±5% amount + account)           — 0.80
   *   - reference    (partial reference + account)           — 0.75
   *   - cross_period (±7 days + amount + account)            — 0.70
   *   - bank_amount  (±14 days + signed amount on bank,      — 0.65
   *                   only when account-level found nothing)
   *
   * Body shape:
   *   { transactions: [{ name, amount, date, account?, fit_id?, reference? }] }
   */
  router.post(
    '/api/bank-import/check-duplicates',
    async (req: Request, res: Response) => {
      const operaDb = getOperaDb(req, res);
      if (!operaDb) return;
      try {
        const body = (req.body ?? {}) as {
          transactions?: CheckTransactionInput[];
        };
        const txns = Array.isArray(body.transactions) ? body.transactions : [];
        if (txns.length === 0) {
          res.status(400).json({
            success: false,
            error: 'transactions array is required',
          });
          return;
        }
        const bankCode = (req.query.bank_code as string) ?? null;
        const result = await checkDuplicateBatch(operaDb, txns, bankCode);
        res.json(result);
      } catch (err: any) {
        ctx.logger.error('check-duplicates failed', err);
        res.status(500).json({
          success: false,
          error: err?.message ?? String(err),
        });
      }
    },
  );

  /**
   * POST /api/reconcile/refresh-matches
   *
   * Re-check a list of transactions against Opera. Used after the
   * operator enters / posts something in Opera and wants the import
   * preview to update without a full re-extract. Faithful port of
   * `refresh_statement_matches` (routes.py:1647-1716).
   *
   * Reuses the all-six-strategy `findDuplicates` from duplicate-
   * detection. A candidate at confidence ≥ 0.85 is treated as
   * already-posted; the row's `action` is set to `skip` and
   * `skip_reason` is populated with the matching table+id+strategy.
   *
   * LEDGER_ALLOCATION_TARGET (refund advisory) is surfaced from the
   * import-time pre-posting check, not here. refresh-matches uses
   * findDuplicates with a confidence threshold, which is the same
   * behaviour the legacy refresh path used.
   */
  router.post(
    '/api/reconcile/refresh-matches',
    async (req: Request, res: Response) => {
      const operaDb = getOperaDb(req, res);
      if (!operaDb) return;
      try {
        const bankCode = String(req.query.bank_code ?? '');
        if (!bankCode) {
          res
            .status(400)
            .json({ success: false, error: 'bank_code is required' });
          return;
        }
        const body = (req.body ?? {}) as {
          transactions?: RefreshTransactionInput[];
          posted_threshold?: number;
        };
        const txns = Array.isArray(body.transactions) ? body.transactions : [];
        const result = await refreshMatches(operaDb, bankCode, txns, {
          posted_threshold: body.posted_threshold,
        });
        res.json(result);
      } catch (err: any) {
        ctx.logger.error('refresh-matches failed', err);
        res.status(500).json({
          success: false,
          error: err?.message ?? String(err),
        });
      }
    },
  );

  /**
   * GET /api/bank-import/suggest-account
   *
   * Suggest a customer or supplier account for a bank-statement
   * line based on the transaction name and direction. Faithful port
   * of `suggest_account_for_transaction` (routes.py:11225-11334).
   *
   * Three-tier matcher: substring (95) → word match (≥70) → fuzzy
   * Ratcliff/Obershelp ratio (≥60). sales_receipt/sales_refund
   * search sname; purchase_payment/purchase_refund search pname.
   * Dormant accounts (sn_stop='Y' / pn_stop='Y') excluded.
   */
  router.get(
    '/api/bank-import/suggest-account',
    async (req: Request, res: Response) => {
      const operaDb = getOperaDb(req, res);
      if (!operaDb) return;
      try {
        const name = String(req.query.name ?? '');
        const transactionType = String(
          req.query.transaction_type ?? '',
        ) as TransactionType;
        const limit = req.query.limit ? Number(req.query.limit) : 5;
        if (!name || !transactionType) {
          res.status(400).json({
            success: false,
            error: 'name and transaction_type are required',
          });
          return;
        }
        const result = await suggestAccountForTransaction(
          operaDb,
          name,
          transactionType,
          limit,
        );
        res.json(result);
      } catch (err: any) {
        ctx.logger.error('suggest-account failed', err);
        res.status(500).json({
          success: false,
          error: err?.message ?? String(err),
        });
      }
    },
  );

  /**
   * POST /api/bank-import/preview-from-pdf
   *
   * Extract a bank statement from a PDF and return the structured
   * preview the import-review UI renders. Uses ctx.llm (Claude) for
   * the actual PDF→JSON extraction.
   *
   * Faithful port of `preview_bank_import_from_pdf`
   * (apps/bank_reconcile/api/routes.py:3623-3940).
   */
  router.post(
    '/api/bank-import/preview-from-pdf',
    async (req: Request, res: Response) => {
      const operaDb = getOperaDb(req, res);
      if (!operaDb) return;
      const llm = (ctx.llm as LlmService | undefined) ?? null;
      const extractorAdapter = (ctx as unknown as {
        bankPdfExtractor?: PdfExtractor;
      }).bankPdfExtractor ?? builtinPdfExtractor ?? null;
      if (!llm && !extractorAdapter) {
        res.status(503).json({
          success: false,
          error:
            'Neither ctx.bankPdfExtractor nor ctx.llm is configured. Wire a PDF extractor (standalone: set GEMINI_API_KEY; SAM: enable LLM via manifest.consumes.llm).',
        });
        return;
      }
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const result = await previewBankImportFromPdf(
          operaDb,
          llm,
          {
            filePath: String(req.query.file_path ?? body.file_path ?? '') || undefined,
            bankCode: String(req.query.bank_code ?? body.bank_code ?? ''),
            filename: (body.filename as string) ?? undefined,
          },
          extractorAdapter,
          getAppDb(req, res) ?? null,
        );
        res.json(result);
      } catch (err: any) {
        ctx.logger.error('preview-from-pdf failed', err);
        res.status(500).json({
          success: false,
          error: err?.message ?? String(err),
        });
      }
    },
  );

  /**
   * POST /api/bank-import/preview-from-email
   *
   * Same as preview-from-pdf, but the PDF is downloaded from an
   * email attachment first. Faithful port of
   * preview_bank_import_from_email (routes.py:8645-8870).
   */
  router.post(
    '/api/bank-import/preview-from-email',
    async (req: Request, res: Response) => {
      const operaDb = getOperaDb(req, res);
      if (!operaDb) return;
      const llm = (ctx.llm as LlmService | undefined) ?? null;
      const attachments = (ctx as unknown as {
        bankEmailAttachments?: EmailAttachmentProvider;
      }).bankEmailAttachments;
      if (!llm || !attachments) {
        res.status(503).json({
          success: false,
          error:
            'ctx.llm and ctx.bankEmailAttachments must both be configured. SAM team must enable the LLM and email-attachment fetcher.',
        });
        return;
      }
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const result = await previewBankImportFromEmail(
          operaDb,
          llm,
          attachments,
          {
            emailId: Number(req.query.email_id ?? body.email_id ?? 0),
            attachmentId: String(
              req.query.attachment_id ?? body.attachment_id ?? '',
            ),
            bankCode: String(req.query.bank_code ?? body.bank_code ?? ''),
          },
        );
        res.json(result);
      } catch (err: any) {
        ctx.logger.error('preview-from-email failed', err);
        res.status(500).json({
          success: false,
          error: err?.message ?? String(err),
        });
      }
    },
  );

  // ---------------------------------------------------------------
  // Archive endpoints — file lifecycle management
  // ---------------------------------------------------------------

  router.post('/api/archive/file', async (req: Request, res: Response) => {
    const appDb = getAppDb(req, res);
    if (!appDb) return;
    const storage =
      (ctx as unknown as { fileStorage?: FileStorageAdapter }).fileStorage ??
      builtinFileStorage;
    if (!storage) {
      res.status(503).json({
        success: false,
        error:
          'ctx.fileStorage adapter not configured. SAM team must wire a storage adapter.',
      });
      return;
    }
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const importType =
        (req.query.import_type as ImportType | undefined) ??
        (body.import_type as ImportType);
      const result = await archiveFile(appDb, storage, {
        filePath: String(req.query.file_path ?? body.file_path ?? ''),
        importType,
        transactionsExtracted: req.query.transactions_extracted
          ? Number(req.query.transactions_extracted)
          : (body.transactions_extracted as number | undefined),
        transactionsMatched: req.query.transactions_matched
          ? Number(req.query.transactions_matched)
          : (body.transactions_matched as number | undefined),
        transactionsReconciled: req.query.transactions_reconciled
          ? Number(req.query.transactions_reconciled)
          : (body.transactions_reconciled as number | undefined),
      });
      if (!result.success) {
        res.status(400).json(result);
        return;
      }
      res.json(result);
    } catch (err: any) {
      ctx.logger.error('archive file failed', err);
      res.status(500).json({
        success: false,
        error: err?.message ?? String(err),
      });
    }
  });

  router.get('/api/archive/history', async (req: Request, res: Response) => {
    const appDb = getAppDb(req, res);
    if (!appDb) return;
    try {
      const importType = (req.query.import_type as ImportType | undefined) ?? null;
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const result = await getArchiveHistory(appDb, importType, limit);
      res.json(result);
    } catch (err: any) {
      ctx.logger.error('archive history failed', err);
      res.status(500).json({
        success: false,
        error: err?.message ?? String(err),
      });
    }
  });

  router.post('/api/archive/restore', async (req: Request, res: Response) => {
    const appDb = getAppDb(req, res);
    if (!appDb) return;
    const storage =
      (ctx as unknown as { fileStorage?: FileStorageAdapter }).fileStorage ??
      builtinFileStorage;
    if (!storage) {
      res.status(503).json({
        success: false,
        error: 'ctx.fileStorage adapter not configured.',
      });
      return;
    }
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const archivePath = String(
        req.query.archive_path ?? body.archive_path ?? '',
      );
      const result = await restoreArchivedFile(appDb, storage, archivePath);
      if (!result.success) {
        res.status(400).json(result);
        return;
      }
      res.json(result);
    } catch (err: any) {
      ctx.logger.error('archive restore failed', err);
      res.status(500).json({
        success: false,
        error: err?.message ?? String(err),
      });
    }
  });

  router.get('/api/archive/pending', async (req: Request, res: Response) => {
    const storage =
      (ctx as unknown as { fileStorage?: FileStorageAdapter }).fileStorage ??
      builtinFileStorage;
    if (!storage) {
      res.status(503).json({
        success: false,
        error: 'ctx.fileStorage adapter not configured.',
        files: [],
      });
      return;
    }
    try {
      const importType = String(req.query.import_type ?? '') as ImportType;
      const result = await getPendingFiles(storage, importType);
      res.json(result);
    } catch (err: any) {
      ctx.logger.error('archive pending failed', err);
      res.status(500).json({
        success: false,
        error: err?.message ?? String(err),
        files: [],
      });
    }
  });

  /**
   * POST /api/reconcile/process-statement
   *
   * Extract a statement via ctx.llm and run duplicate detection +
   * account suggestion in one pass. Used by the unified import UI
   * that wants the matched preview in a single round-trip.
   *
   * Faithful port of `process_bank_statement`
   * (apps/bank_reconcile/api/routes.py:1370-1645). Also wires the
   * `process-statement-unified` alias which Python exposes for the
   * newer UI but uses the same flow underneath.
   */
  const handleProcessStatement = async (req: Request, res: Response) => {
    const operaDb = getOperaDb(req, res);
    if (!operaDb) return;
    const llm = (ctx.llm as LlmService | undefined) ?? null;
    if (!llm) {
      res.status(503).json({
        success: false,
        error: 'ctx.llm not configured.',
      });
      return;
    }
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await processStatement(
        operaDb,
        llm,
        {
          filePath: String(req.query.file_path ?? body.file_path ?? '') || undefined,
          bankCode: String(req.query.bank_code ?? body.bank_code ?? ''),
        },
        ctx.db.app,
      );
      res.json(result);
    } catch (err: any) {
      ctx.logger.error('process-statement failed', err);
      res.status(500).json({
        success: false,
        error: err?.message ?? String(err),
      });
    }
  };
  router.post('/api/reconcile/process-statement', handleProcessStatement);
  router.post(
    '/api/reconcile/process-statement-unified',
    handleProcessStatement,
  );

  /**
   * POST /api/bank-import/import-with-overrides — alias for
   * /api/bank-import/import-from-pdf. Python's separate endpoint
   * exists for legacy reasons (the older UI hit this URL with the
   * same body shape). Behaviour is identical, so we register the
   * alias as a thin re-route.
   */
  router.post(
    '/api/bank-import/import-with-overrides',
    async (req: Request, res: Response) => {
      // Same logic as /api/bank-import/import-from-pdf — Python's
      // separate endpoint accepts the same body shape so we just
      // forward via Express's internal dispatch.
      req.url = '/api/bank-import/import-from-pdf';
      (router as unknown as {
        handle: (req: Request, res: Response, next: () => void) => void;
      }).handle(req, res, () => undefined);
    },
  );

  // ---------------------------------------------------------------
  // Bank-reconciliation status / unreconciled / statement-transactions
  // ---------------------------------------------------------------

  router.get('/api/bank-reconciliation/status', async (req, res) => {
    const operaDb = getOperaDb(req, res);
    if (!operaDb) return;
    res.json(await getBankReconciliationStatus(operaDb));
  });

  router.get('/api/bank-reconciliation/unreconciled-entries', async (req, res) => {
    const operaDb = getOperaDb(req, res);
    if (!operaDb) return;
    const bankCode = (req.query.bank_code as string) || null;
    res.json(await getUnreconciledEntriesForBank(operaDb, bankCode));
  });

  router.get(
    '/api/bank-reconciliation/statement-transactions/:import_id',
    async (req, res) => {
      const appDb = getAppDb(req, res);
      if (!appDb) return;
      const importId = Number(req.params.import_id);
      res.json(await getStatementTransactionsForImport(appDb, importId));
    },
  );

  // ---------------------------------------------------------------
  // Deferred items + ignored-transaction by record_id
  // ---------------------------------------------------------------

  router.post(
    '/api/reconcile/bank/:bank_code/audit-defer',
    async (req, res) => {
      const appDb = getAppDb(req, res);
      if (!appDb) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await recordDeferredTransaction(appDb, {
        bankCode: String(req.params.bank_code ?? ''),
        statementDate: String(body.statement_date ?? ''),
        amount: Number(body.amount ?? 0),
        description: String(body.description ?? ''),
        deferredBy: String(body.deferred_by ?? 'system'),
      });
      res.json(result);
    },
  );

  router.get(
    '/api/reconcile/bank/:bank_code/deferred-items',
    async (req, res) => {
      const appDb = getAppDb(req, res);
      if (!appDb) return;
      res.json(
        await listDeferredItems(
          appDb,
          String(req.params.bank_code ?? ''),
        ),
      );
    },
  );

  router.delete(
    '/api/reconcile/bank/:bank_code/deferred-items',
    async (req, res) => {
      const appDb = getAppDb(req, res);
      if (!appDb) return;
      const body = (req.body ?? {}) as { ids?: number[] };
      res.json(
        await deleteDeferredItems(
          appDb,
          String(req.params.bank_code ?? ''),
          Array.isArray(body.ids) ? body.ids : undefined,
        ),
      );
    },
  );

  router.delete(
    '/api/reconcile/bank/ignored-transaction/:record_id',
    async (req, res) => {
      const appDb = getAppDb(req, res);
      if (!appDb) return;
      res.json(
        await deleteIgnoredTransactionByRecordId(
          appDb,
          Number(req.params.record_id),
        ),
      );
    },
  );

  // ---------------------------------------------------------------
  // Cashbook create / bank-accounts / auto-match
  // ---------------------------------------------------------------

  router.get('/api/cashbook/bank-accounts', async (req, res) => {
    const operaDb = getOperaDb(req, res);
    if (!operaDb) return;
    res.json(await listCashbookBankAccounts(operaDb));
  });

  router.post('/api/cashbook/create-entry', async (req, res) => {
    const operaDb = getOperaDb(req, res);
    if (!operaDb) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    res.json(
      await createCashbookEntry(operaDb, {
        bankCode: String(body.bank_code ?? ''),
        date: String(body.date ?? ''),
        amount: Number(body.amount ?? 0),
        matchedAccount: String(body.matched_account ?? ''),
        action:
          (body.action as
            | 'sales_receipt'
            | 'purchase_payment'
            | 'sales_refund'
            | 'purchase_refund'
            | 'nominal_payment'
            | 'nominal_receipt') ?? 'sales_receipt',
        reference: (body.reference as string) ?? '',
        memo: (body.memo as string) ?? '',
        cbtype: (body.cbtype as string | null) ?? null,
      }),
    );
  });

  router.post('/api/cashbook/create-bank-transfer', async (req, res) => {
    const operaDb = getOperaDb(req, res);
    if (!operaDb) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    res.json(
      await createBankTransfer(operaDb, {
        sourceBank: String(body.source_bank ?? ''),
        destBank: String(body.dest_bank ?? ''),
        amount: Number(body.amount ?? 0),
        date: String(body.date ?? ''),
        reference: (body.reference as string) ?? '',
        memo: (body.memo as string) ?? '',
      }),
    );
  });

  router.post('/api/cashbook/auto-match-statement-lines', async (req, res) => {
    const operaDb = getOperaDb(req, res);
    if (!operaDb) return;
    const body = (req.body ?? {}) as { bank_code?: string; import_id?: number };
    res.json(
      await autoMatchStatementLines(
        operaDb,
        String(body.bank_code ?? ''),
        Number(body.import_id ?? 0),
      ),
    );
  });

  // ---------------------------------------------------------------
  // Statement-archive endpoints
  // ---------------------------------------------------------------

  router.post('/api/bank-import/archive-statement', async (req, res) => {
    const appDb = getAppDb(req, res);
    if (!appDb) return;
    const body = (req.body ?? {}) as { import_id?: number; archived_by?: string };
    res.json(
      await archiveStatement(
        appDb,
        Number(body.import_id ?? req.query.import_id ?? 0),
        String(body.archived_by ?? 'system'),
      ),
    );
  });

  router.get('/api/bank-import/archived-statements', async (req, res) => {
    const appDb = getAppDb(req, res);
    if (!appDb) return;
    res.json(
      await listArchivedStatements(
        appDb,
        (req.query.bank_code as string) || null,
        req.query.limit ? Number(req.query.limit) : 200,
      ),
    );
  });

  router.post('/api/bank-import/restore-statement', async (req, res) => {
    const appDb = getAppDb(req, res);
    if (!appDb) return;
    const body = (req.body ?? {}) as { import_id?: number };
    res.json(
      await restoreStatement(
        appDb,
        Number(body.import_id ?? req.query.import_id ?? 0),
      ),
    );
  });

  router.get(
    '/api/bank-import/archived-statement-pdf/:record_id',
    async (req, res) => {
      const appDb = getAppDb(req, res);
      if (!appDb) return;
      const storage =
        (ctx as unknown as { fileStorage?: FileStorageAdapter }).fileStorage ??
        builtinFileStorage;
      res.json(
        await getArchivedStatementPdf(
          appDb,
          storage,
          Number(req.params.record_id),
        ),
      );
    },
  );

  router.post('/api/bank-import/delete-archived-statement', async (req, res) => {
    const appDb = getAppDb(req, res);
    if (!appDb) return;
    const body = (req.body ?? {}) as { record_id?: number };
    res.json(
      await deleteArchivedStatement(
        appDb,
        Number(body.record_id ?? req.query.record_id ?? 0),
      ),
    );
  });

  router.post('/api/bank-import/manage-statements', async (req, res) => {
    const appDb = getAppDb(req, res);
    if (!appDb) return;
    const body = (req.body ?? {}) as {
      bank_code?: string;
      include_archived?: boolean;
    };
    res.json(
      await manageStatements(
        appDb,
        body.bank_code ?? null,
        !!body.include_archived,
      ),
    );
  });

  // ---------------------------------------------------------------
  // File-list / scan-folder / scan-all-banks / pdf-content
  // ---------------------------------------------------------------

  const getFileStorage = () =>
    (ctx as unknown as { fileStorage?: FileStorageAdapter }).fileStorage ??
    builtinFileStorage;
  const getPdfReader = () =>
    (ctx as unknown as { pdfContentReader?: PdfContentReader }).pdfContentReader ??
    builtinPdfReader;
  const getMultiformatParser = () =>
    (ctx as unknown as { multiformatParser?: MultiformatParser })
      .multiformatParser ?? defaultMultiformatParser;
  const getEmailAttachments = () =>
    (ctx as unknown as { bankEmailAttachments?: EmailAttachmentProvider })
      .bankEmailAttachments ?? builtinEmailIngest?.attachments ?? null;

  router.get('/api/bank-import/list-csv', async (_req, res) => {
    res.json(await listCsvFiles(getFileStorage()));
  });

  router.get('/api/bank-import/list-pdf', async (_req, res) => {
    res.json(await listPdfFiles(getFileStorage()));
  });

  router.get('/api/bank-import/pdf-content', async (req, res) => {
    res.json(
      await getPdfContent(
        getPdfReader(),
        String(req.query.file_path ?? ''),
      ),
    );
  });

  router.get('/api/bank-import/scan-folder', async (_req, res) => {
    res.json(await scanFolder(getFileStorage()));
  });

  router.post('/api/bank-import/fetch-emails-to-folder', async (req, res) => {
    const body = (req.body ?? {}) as {
      emails?: Array<{ emailId: number; attachmentId: string }>;
    };
    res.json(
      await fetchEmailsToFolder(
        getEmailAttachments(),
        getFileStorage(),
        Array.isArray(body.emails) ? body.emails : [],
      ),
    );
  });

  router.get('/api/bank-import/scan-all-banks', async (req, res) => {
    const operaDb = getOperaDb(req, res);
    if (!operaDb) return;
    const appDb = ctx.db.app ?? null;
    const adapter = ctx as unknown as {
      bankMailboxAdapter?: BankMailboxAdapter;
    };
    const mailbox =
      adapter.bankMailboxAdapter ?? builtinEmailIngest?.mailbox ?? null;
    const daysBack = req.query.days_back ? Number(req.query.days_back) : 30;
    const validateBalances = req.query.validate_balances !== 'false';
    const { scanAllBanksFaithful } = await import(
      './services/scan-all-banks.js'
    );
    res.json(
      await scanAllBanksFaithful(operaDb, mailbox, appDb, ctx.logger, {
        daysBack,
        validateBalances,
      }),
    );
  });

  /**
   * GET /api/bank-import/restore-check
   *
   * Tenant-wide Opera-restore detection — runs the per-bank
   * divergence + per-line orphan checks across every bank in nbank
   * and returns one aggregated summary. The Bank Statement Hub
   * page calls this on load (alongside scan-all-banks) so the user
   * sees a single banner when ANY bank's SAM tracking is out of
   * sync with Opera. Read-only.
   */
  router.get('/api/bank-import/restore-check', async (req, res) => {
    const operaDb = getOperaDb(req, res);
    if (!operaDb) return;
    const appDb = getAppDb(req, res);
    if (!appDb) return;
    try {
      const result = await checkRestoreAcrossAllBanks(operaDb, appDb);
      res.json(result);
    } catch (err: any) {
      ctx.logger.error('Restore-check failed', err);
      res.status(500).json({ success: false, error: err?.message ?? String(err) });
    }
  });

  // ---------------------------------------------------------------
  // Raw / multiformat preview endpoints (LLM/parser-bound)
  // ---------------------------------------------------------------

  router.get('/api/bank-import/raw-preview', async (req, res) => {
    const llm = (ctx.llm as LlmService | undefined) ?? null;
    res.json(
      await rawPreviewFromPdf(
        llm,
        null,
        String(req.query.file_path ?? '') || null,
      ),
    );
  });

  router.get('/api/bank-import/raw-preview-email', async (req, res) => {
    const llm = (ctx.llm as LlmService | undefined) ?? null;
    const attachments = getEmailAttachments();
    if (!attachments) {
      res.status(503).json({ success: false, error: 'attachments not configured' });
      return;
    }
    const emailId = Number(req.query.email_id ?? 0);
    const attachmentId = String(req.query.attachment_id ?? '');
    let bytes: Uint8Array | null = null;
    try {
      const att = await attachments.fetchAttachment({ emailId, attachmentId });
      bytes = att?.bytes ?? null;
    } catch {
      // fall through
    }
    if (!bytes) {
      res.status(404).json({ success: false, error: 'attachment not found' });
      return;
    }
    res.json(await rawPreviewFromPdf(llm, bytes, null));
  });

  router.post('/api/bank-import/preview-multiformat', async (req, res) => {
    const body = (req.body ?? {}) as { content?: string; format?: string };
    res.json(
      await previewMultiformat(
        getMultiformatParser(),
        String(body.content ?? ''),
        body.format ?? null,
      ),
    );
  });

  router.post('/api/bank-import/validate-csv', async (req, res) => {
    const body = (req.body ?? {}) as { content?: string };
    res.json(
      await validateCsv(getMultiformatParser(), String(body.content ?? '')),
    );
  });

  router.get('/api/bank-import/statement-review/:import_id', async (req, res) => {
    const appDb = getAppDb(req, res);
    if (!appDb) return;
    res.json(
      await getStatementReview(appDb, Number(req.params.import_id)),
    );
  });

  // ---------------------------------------------------------------
  // import-from-email + import-from-statement
  // ---------------------------------------------------------------

  const handleImportFromEmail = async (req: Request, res: Response) => {
    const operaDb = getOperaDb(req, res);
    if (!operaDb) return;
    const appDb = getAppDb(req, res);
    if (!appDb) return;
    const adapter = ctx as unknown as {
      bankPdfExtractor?: PdfExtractor;
      bankImportExecutor?: ImportPostingExecutor;
      bankImportLock?: ImportLockAdapter;
      bankPeriodOverlapChecker?: PeriodOverlapChecker;
      bankEmailAttachments?: EmailAttachmentProvider;
    };
    const extractor = adapter.bankPdfExtractor ?? builtinPdfExtractor;
    if (!extractor || !adapter.bankEmailAttachments) {
      res.status(503).json({
        success: false,
        error:
          'PDF extractor (or ctx.llm) and email-attachment provider must both be configured.',
      });
      return;
    }
    const executor = adapter.bankImportExecutor ?? bankImportPostingExecutor;
    const lock = adapter.bankImportLock ?? inMemoryImportLock;
    const overlap = adapter.bankPeriodOverlapChecker ?? makeBankStatementOverlapChecker(appDb);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input: BankImportFromEmailInput = {
      emailId: Number(req.query.email_id ?? body.email_id ?? 0),
      attachmentId: String(req.query.attachment_id ?? body.attachment_id ?? ''),
      bankCode: String(req.query.bank_code ?? body.bank_code ?? ''),
      autoAllocate: req.query.auto_allocate === '1',
      autoReconcile: req.query.auto_reconcile === '1',
      resumeImportId: req.query.resume_import_id
        ? Number(req.query.resume_import_id)
        : null,
      overrides: Array.isArray(body.overrides) ? body.overrides : [],
      selectedRows: Array.isArray(body.selected_rows)
        ? (body.selected_rows as number[])
        : null,
      dateOverrides: Array.isArray(body.date_overrides)
        ? body.date_overrides
        : [],
      rejectedRefundRows: Array.isArray(body.rejected_refund_rows)
        ? (body.rejected_refund_rows as number[])
        : [],
      skipOverlapCheck: body.skip_overlap_check === true,
    };
    res.json(
      await importBankStatementFromEmail(
        operaDb,
        appDb,
        adapter.bankEmailAttachments,
        extractor,
        executor,
        lock,
        overlap,
        input,
      ),
    );
  };
  router.post('/api/bank-import/import-from-email', handleImportFromEmail);
  // Composite alias used by the legacy UI
  router.post(
    '/api/reconcile/bank/:bank_code/import-from-statement',
    async (req, res) => {
      // Forward to import-from-pdf with the bank_code from the path
      req.url = '/api/bank-import/import-from-pdf';
      (req.query as Record<string, string>).bank_code = String(
        req.params.bank_code ?? '',
      );
      (router as unknown as {
        handle: (req: Request, res: Response, next: () => void) => void;
      }).handle(req, res, () => undefined);
    },
  );

  return router;
}

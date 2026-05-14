/**
 * Bank-import / import-from-pdf — orchestration shell.
 *
 * Faithful port of the route-level orchestration from
 * `import_bank_statement_from_pdf` (apps/bank_reconcile/api/routes.py:4031-4787)
 * with the heavy lifting (PDF extraction, transaction matching, the
 * actual aentry/atran/sname/pname/ntran writes, auto-allocate, and
 * auto-reconcile) delegated to discrete executor adapters.
 *
 * Why split this up?
 *   - PDF extraction needs `ctx.llm` (Claude vision) — not yet wired.
 *   - The 750-line posting body has many seams that the SAM team will
 *     fill against the unified Knex client. Carving the contract now
 *     lets the frontend wire while the executor is built independently.
 *   - Keeping the orchestration shell deterministic means the route
 *     can run validations + audit-row writes today without ctx.llm.
 *
 * Validations performed here (Python parity):
 *   - bank_code exists in nbank
 *   - file path provided + non-empty
 *   - import-lock acquired/released around the executor
 *   - import history row written on success
 *
 * Everything between extraction and posting is an executor seam.
 */
import type { Knex } from 'knex';
import {
  validateBankCode,
  SqlInputValidationError,
} from '../_shared/index.js';
import { markEntriesReconciled } from './mark-reconciled.js';

export interface PdfExtractionResult {
  bank_name: string | null;
  account_number: string | null;
  sort_code: string | null;
  statement_date: string | null;
  period_start: string | null;
  period_end: string | null;
  opening_balance: number | null;
  closing_balance: number | null;
  transactions: Array<{
    date: string | null;
    name: string | null;
    memo: string | null;
    amount: number;
    type: 'credit' | 'debit' | string;
    /** Running balance after this transaction, when the statement shows it. */
    balance?: number | null;
    line_number?: number;
  }>;
}

export interface PdfExtractor {
  /**
   * Read a PDF (or PDF bytes) and return extracted statement +
   * transactions. Implementation will use ctx.llm when wired.
   */
  extractFromPdf(opts: {
    filePath?: string;
    bytes?: Uint8Array;
    filename?: string;
  }): Promise<PdfExtractionResult>;
}

export interface PostedLine {
  line_number: number;
  post_date: string;
  amount: number;
  posted_entry_number: string;
  description: string;
  /**
   * The Opera at_type that was posted (1 nom-pay, 2 nom-rec, 3 sale-
   * refund, 4 sale-rec, 5 pur-pay, 6 pur-refund, 8 transfer). Used by
   * later validation passes.
   */
  at_type: number;
}

export interface ImportPostingExecutor {
  postBankImport(opts: {
    operaDb: Knex;
    bankCode: string;
    statementInfo: PdfExtractionResult;
    transactions: PdfExtractionResult['transactions'];
    overrides: unknown[];
    selectedRows: number[] | null;
    autoAllocate: boolean;
    autoReconcile: boolean;
  }): Promise<{
    success: boolean;
    records_imported: number;
    records_failed: number;
    skipped_count: number;
    errors: string[];
    warnings: string[];
    import_id?: number | null;
    /**
     * Per-line posted-entry record — populated by the executor for
     * every line that posted successfully. Used by the import flow to
     * write `bank_statement_transactions` rows so subsequent
     * Opera-restore detection can validate per-line. New in SAM port.
     */
    posted_lines?: PostedLine[];
  }>;
}

export interface ImportLockAdapter {
  acquire(key: string, locker: string): Promise<boolean>;
  release(key: string): Promise<void>;
}

export interface PeriodOverlapChecker {
  checkOverlap(opts: {
    bankCode: string;
    periodStart: string | null;
    periodEnd: string | null;
    filename: string;
    resumeImportId: number | null;
    skipOverlapCheck: boolean;
  }): Promise<{
    overlapError?: { success: false; error: string } | null;
    resumeImportId: number | null;
  }>;
}

export interface ImportFromPdfInput {
  filePath: string;
  bankCode: string;
  filename?: string;
  autoAllocate?: boolean;
  autoReconcile?: boolean;
  resumeImportId?: number | null;
  overrides?: unknown[];
  selectedRows?: number[] | null;
  dateOverrides?: unknown[];
  rejectedRefundRows?: number[];
  skipOverlapCheck?: boolean;
  /** Operator username for the bank_statement_imports audit row.
   *  Legacy threads `request.state.user.username` here
   *  (routes.py:4502). When omitted, defaults to 'system'. */
  importedBy?: string | null;
}

export interface ImportFromPdfResponse {
  success: boolean;
  message?: string;
  records_imported?: number;
  records_failed?: number;
  skipped_count?: number;
  warnings?: string[];
  errors?: string[];
  error?: string;
  resume_import_id?: number | null;
  import_id?: number | null;
  /** Result of the post-import auto-reconciliation pass, populated
   *  only when input.autoReconcile is true. Mirrors legacy
   *  `result['reconciliation_result']` (routes.py:4680). */
  reconciliation_result?: {
    success: boolean;
    entries_reconciled: number;
    statement_number?: number;
    statement_date?: string;
    messages?: string[];
  };
  auto_reconcile_enabled?: boolean;
}

async function bankExists(operaDb: Knex, bankCode: string): Promise<boolean> {
  try {
    const row = (await operaDb('nbank')
      .whereRaw('RTRIM(nk_acnt) = ?', [bankCode])
      .select('nk_acnt')
      .first()) as { nk_acnt?: string } | undefined;
    return !!row;
  } catch {
    return false;
  }
}

export async function importBankStatementFromPdf(
  operaDb: Knex,
  appDb: Knex,
  input: ImportFromPdfInput,
  extractor: PdfExtractor,
  executor: ImportPostingExecutor,
  importLock: ImportLockAdapter,
  overlapChecker: PeriodOverlapChecker,
): Promise<ImportFromPdfResponse> {
  let bankCode: string;
  try {
    bankCode = validateBankCode(input.bankCode);
  } catch (e) {
    if (e instanceof SqlInputValidationError) {
      return { success: false, error: e.message };
    }
    return { success: false, error: (e as Error)?.message ?? String(e) };
  }

  if (!input.filePath || !input.filePath.trim()) {
    return { success: false, error: 'file_path is required' };
  }

  if (!(await bankExists(operaDb, bankCode))) {
    return {
      success: false,
      error: `Bank account '${bankCode}' not found in Opera.`,
    };
  }

  let extracted: PdfExtractionResult;
  try {
    extracted = await extractor.extractFromPdf({
      filePath: input.filePath,
      filename: input.filename,
    });
  } catch (e) {
    return {
      success: false,
      error: `PDF extraction failed: ${(e as Error)?.message ?? String(e)}`,
    };
  }

  if (!extracted || !extracted.transactions) {
    return {
      success: false,
      error: 'Failed to extract statement information from PDF',
    };
  }

  const overlap = await overlapChecker.checkOverlap({
    bankCode,
    periodStart: extracted.period_start,
    periodEnd: extracted.period_end,
    filename: input.filename ?? input.filePath.split('/').pop() ?? '',
    resumeImportId: input.resumeImportId ?? null,
    skipOverlapCheck: !!input.skipOverlapCheck,
  });
  if (overlap.overlapError) {
    return {
      ...overlap.overlapError,
      resume_import_id: overlap.resumeImportId,
    };
  }

  const lockKey = `bank-import:${bankCode}`;
  const acquired = await importLock.acquire(lockKey, 'import-from-pdf');
  if (!acquired) {
    return {
      success: false,
      error: `Bank account ${bankCode} is currently being imported by another user. Please wait for the current import to complete.`,
    };
  }

  try {
    // Closed-year guard: never create a new posting in a previous
    // Opera nominal year. Faithful port of
    // sql_rag/opera_config.get_open_year_start_date + the per-row check
    // at routes.py:4189-4223. We materialise the error per-row and
    // strip those rows from the effective selection so the executor
    // never sees them.
    let openYearStart: string | null = null;
    try {
      const rows = (await operaDb.raw(
        `SELECT TOP 1 MIN(ncd_stdate) AS open_start
         FROM nclndd WITH (NOLOCK)
         WHERE ncd_year = (SELECT TOP 1 np_year FROM nparm WITH (NOLOCK))`,
      )) as unknown as Array<{ open_start?: string | Date | null }>;
      const raw = Array.isArray(rows) ? rows[0]?.open_start : null;
      if (raw instanceof Date) {
        openYearStart = raw.toISOString().slice(0, 10);
      } else if (typeof raw === 'string' && raw.length >= 10) {
        openYearStart = raw.slice(0, 10);
      }
    } catch (yrErr) {
      // No nclndd / nparm available — treat as unconstrained. Legacy
      // does the same (opera_config.py:592-595).
      // eslint-disable-next-line no-console
      console.warn(
        `[bank-reconcile] could not determine open-year start: ${
          yrErr instanceof Error ? yrErr.message : String(yrErr)
        } — closed-year guard skipped`,
      );
    }

    const closedYearErrors: string[] = [];
    const closedYearSkipSet = new Set<number>();
    if (openYearStart) {
      for (let i = 0; i < extracted.transactions.length; i++) {
        const txn = extracted.transactions[i]!;
        const txnDate = (txn.date ?? '').slice(0, 10);
        if (!txnDate) continue;
        if (txnDate < openYearStart) {
          const rowNum = i + 1;
          closedYearSkipSet.add(rowNum);
          closedYearErrors.push(
            `Row ${rowNum}: transaction date ${txnDate} is before the open nominal year start (${openYearStart}). Year-end has been performed; postings to closed years are not allowed. Edit the date or skip this row.`,
          );
        }
      }
    }

    // Resume-import skip: when the caller passes resume_import_id,
    // legacy reads bank_statement_transactions for that import and
    // skips any line whose posted_entry_number is already populated
    // (routes.py:4151-4159, storage.get_posted_lines).
    let alreadyPosted: Map<number, string> = new Map();
    if (input.resumeImportId) {
      try {
        const rows = (await appDb('bank_statement_transactions')
          .where({ import_id: input.resumeImportId })
          .whereNotNull('posted_entry_number')
          .select('line_number', 'posted_entry_number')) as Array<{
          line_number: number;
          posted_entry_number: string;
        }>;
        for (const r of rows) {
          alreadyPosted.set(Number(r.line_number), String(r.posted_entry_number));
        }
        if (alreadyPosted.size > 0) {
          // eslint-disable-next-line no-console
          console.info(
            `[bank-reconcile] resume import: ${alreadyPosted.size} line(s) already posted for import_id=${input.resumeImportId}`,
          );
        }
      } catch (loadErr) {
        // eslint-disable-next-line no-console
        console.warn(
          `[bank-reconcile] could not load posted lines for resume: ${
            loadErr instanceof Error ? loadErr.message : String(loadErr)
          }`,
        );
      }
    }

    // Build the effective selectedRows set. selectedRows uses 1-based
    // line numbers (matches executor's i+1 convention). When the UI
    // sends null we treat it as "post everything"; on resume + closed-
    // year exclusions we then subtract those line numbers from a
    // fully-populated list.
    let effectiveSelected = input.selectedRows ?? null;
    if (alreadyPosted.size > 0 || closedYearSkipSet.size > 0) {
      const base =
        effectiveSelected ??
        Array.from({ length: extracted.transactions.length }, (_, i) => i + 1);
      effectiveSelected = base.filter(
        (n) => !alreadyPosted.has(n) && !closedYearSkipSet.has(n),
      );
    }

    const result = await executor.postBankImport({
      operaDb,
      bankCode,
      statementInfo: extracted,
      transactions: extracted.transactions,
      overrides: input.overrides ?? [],
      selectedRows: effectiveSelected,
      autoAllocate: !!input.autoAllocate,
      autoReconcile: !!input.autoReconcile,
    });

    if (result.success) {
      try {
        // Aggregate signed posted_lines into the receipt/payment totals
        // legacy persists (routes.py:4498-4508). Match legacy's
        // convention: receipts = sum of credits (amount > 0), payments
        // = sum of absolute debits (amount < 0).
        let totalReceipts = 0;
        let totalPayments = 0;
        for (const line of result.posted_lines ?? []) {
          if (line.amount > 0) totalReceipts += line.amount;
          else if (line.amount < 0) totalPayments += Math.abs(line.amount);
        }

        // Resume-import: UPDATE the existing bank_statement_imports row
        // rather than INSERT a new one (legacy routes.py:4502-4526). The
        // running totals accumulate so the audit reflects the full set
        // of posted lines across all attempts.
        let importId: number | undefined;
        if (input.resumeImportId) {
          try {
            const existing = (await appDb('bank_statement_imports')
              .where({ id: input.resumeImportId })
              .first()) as
              | {
                  records_imported?: number | null;
                  transactions_imported?: number | null;
                  total_receipts?: number | null;
                  total_payments?: number | null;
                }
              | undefined;
            const prevImported = Number(existing?.records_imported ?? 0);
            const prevTxImported = Number(existing?.transactions_imported ?? 0);
            const prevReceipts = Number(existing?.total_receipts ?? 0);
            const prevPayments = Number(existing?.total_payments ?? 0);
            await appDb('bank_statement_imports')
              .where({ id: input.resumeImportId })
              .update({
                closing_balance: extracted.closing_balance,
                total_receipts: prevReceipts + totalReceipts,
                total_payments: prevPayments + totalPayments,
                transactions_imported: prevTxImported + result.records_imported,
                records_imported: prevImported + result.records_imported,
                import_status: 'imported',
                imported_at: appDb.fn.now(),
                imported_by: input.importedBy ?? 'system',
              });
            importId = input.resumeImportId;
          } catch (resumeErr) {
            // eslint-disable-next-line no-console
            console.warn(
              `[bank-reconcile] resume UPDATE failed for import_id=${input.resumeImportId}: ${
                resumeErr instanceof Error ? resumeErr.message : String(resumeErr)
              } — falling back to fresh INSERT`,
            );
          }
        }
        if (!importId) {
          const [insertedId] = (await appDb('bank_statement_imports')
            .insert({
              bank_code: bankCode,
              source: 'file',
              source_ref: input.filename ?? input.filePath,
              // statement-info columns expected by statement-tracking.ts,
              // bank-reconciliation-status.ts and the scan-all-banks
              // gating chain. Faithful to legacy email/storage.py:1615.
              statement_date: extracted.statement_date ?? null,
              account_number: extracted.account_number ?? null,
              sort_code: extracted.sort_code ?? null,
              period_start: extracted.period_start ?? null,
              period_end: extracted.period_end ?? null,
              opening_balance: extracted.opening_balance,
              closing_balance: extracted.closing_balance,
              total_receipts: totalReceipts,
              total_payments: totalPayments,
              transactions_imported: result.records_imported,
              imported_at: appDb.fn.now(),
              import_status: 'imported',
              records_imported: result.records_imported,
              filename: input.filename ?? null,
              imported_by: input.importedBy ?? 'system',
            })
            .returning('id')) as unknown as Array<{ id: number } | number>;
          importId =
            typeof insertedId === 'number'
              ? insertedId
              : (insertedId as { id: number })?.id;
        }

        // Per-line tracking — write one row per posted statement
        // line so subsequent Opera-restore detection can verify the
        // posting still exists. New in SAM port (legacy had this
        // table but the SAM port omitted it until 2026-05; see
        // bank_statement_transactions migration 013).
        if (importId && Array.isArray(result.posted_lines) && result.posted_lines.length > 0) {
          const rows = result.posted_lines.map((line) => ({
            import_id: importId,
            line_number: line.line_number,
            post_date: line.post_date,
            description: line.description,
            amount: line.amount,
            transaction_type: String(line.at_type),
            posted_entry_number: line.posted_entry_number,
            posted_at: appDb.fn.now(),
            is_reconciled: 0,
          }));
          await appDb('bank_statement_transactions').insert(rows);
        }
      } catch (writeErr) {
        // History write failure is non-fatal at the import level —
        // log so it's visible, then proceed. (Legacy did the same.)
        // eslint-disable-next-line no-console
        console.warn(
          `[bank-reconcile] persist post-import tracking failed: ${
            writeErr instanceof Error ? writeErr.message : String(writeErr)
          }`,
        );
      }

      // Auto-reconcile pass. Faithful port of legacy routes.py:4609-4713.
      // Runs only when the operator asked for it AND the import landed
      // with at least one posted line and no errors.
      let reconciliationResult: ImportFromPdfResponse['reconciliation_result'];
      let autoReconcileEnabled = false;
      if (
        input.autoReconcile &&
        Array.isArray(result.posted_lines) &&
        result.posted_lines.length > 0 &&
        result.records_failed === 0
      ) {
        autoReconcileEnabled = true;
        try {
          // Legacy convention: statement_line = original PDF row × 10
          // (Opera reconcile screen expects increments of 10, with
          // gaps preserved for unmatched/skipped rows). routes.py:4634.
          const entries = result.posted_lines.map((line) => ({
            entry_number: line.posted_entry_number,
            statement_line: line.line_number * 10,
          }));

          let latestDate: string | null = null;
          for (const line of result.posted_lines) {
            if (line.post_date && (!latestDate || line.post_date > latestDate)) {
              latestDate = line.post_date;
            }
          }
          if (!latestDate) latestDate = new Date().toISOString().slice(0, 10);

          // Statement number from nbank.nk_lststno + 1 — Opera's
          // canonical next-statement counter. Falls back to a
          // yymmdd-derived value only if the nbank read fails.
          let statementNumber: number | null = null;
          try {
            const nbsnRows = (await operaDb.raw(
              `SELECT nk_lststno FROM nbank WITH (NOLOCK) WHERE RTRIM(nk_acnt) = ?`,
              [bankCode],
            )) as unknown as Array<{ nk_lststno?: number | null }>;
            const last = Array.isArray(nbsnRows) ? nbsnRows[0]?.nk_lststno : null;
            if (last !== null && last !== undefined) {
              statementNumber = Number(last) + 1;
            }
          } catch (nbsnErr) {
            // eslint-disable-next-line no-console
            console.warn(
              `[bank-reconcile] could not read nk_lststno for ${bankCode}: ${
                nbsnErr instanceof Error ? nbsnErr.message : String(nbsnErr)
              } — falling back to date-derived`,
            );
          }
          if (statementNumber === null) {
            // yymmdd
            const d = new Date(latestDate);
            statementNumber = Number(
              `${String(d.getFullYear()).slice(2)}${String(
                d.getMonth() + 1,
              ).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`,
            );
          }

          const reconRes = await markEntriesReconciled(appDb, operaDb, {
            bankCode,
            entries,
            statementNumber,
            statementDate: latestDate,
            reconciliationDate: new Date().toISOString().slice(0, 10),
          });

          reconciliationResult = {
            success: !!reconRes.success,
            entries_reconciled: reconRes.success
              ? reconRes.records_reconciled ?? entries.length
              : 0,
            statement_number: statementNumber,
            statement_date: latestDate,
            messages: reconRes.success
              ? reconRes.details ?? []
              : reconRes.errors ?? [reconRes.error ?? 'reconciliation failed'],
          };
        } catch (reconErr) {
          // eslint-disable-next-line no-console
          console.error(
            `[bank-reconcile] PDF auto-reconciliation error: ${
              reconErr instanceof Error ? reconErr.message : String(reconErr)
            }`,
          );
          reconciliationResult = {
            success: false,
            entries_reconciled: 0,
            messages: [
              `Auto-reconciliation error: ${
                reconErr instanceof Error ? reconErr.message : String(reconErr)
              }`,
            ],
          };
        }
      }

      return {
        success: true,
        message: `Imported ${result.records_imported} transactions`,
        records_imported: result.records_imported,
        records_failed: result.records_failed,
        skipped_count: result.skipped_count,
        warnings: result.warnings,
        errors: closedYearErrors.length > 0 ? closedYearErrors : undefined,
        import_id: result.import_id ?? null,
        resume_import_id: overlap.resumeImportId,
        ...(reconciliationResult ? { reconciliation_result: reconciliationResult } : {}),
        ...(autoReconcileEnabled ? { auto_reconcile_enabled: true } : {}),
      };
    }
    return {
      success: false,
      error:
        [...closedYearErrors, ...result.errors].join('; ') || 'Import failed',
      errors: [...closedYearErrors, ...result.errors],
      warnings: result.warnings,
      resume_import_id: overlap.resumeImportId,
    };
  } finally {
    try {
      await importLock.release(lockKey);
    } catch {
      // best-effort
    }
  }
}

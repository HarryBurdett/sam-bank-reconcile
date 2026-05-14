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
    const result = await executor.postBankImport({
      operaDb,
      bankCode,
      statementInfo: extracted,
      transactions: extracted.transactions,
      overrides: input.overrides ?? [],
      selectedRows: input.selectedRows ?? null,
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
        const importId =
          typeof insertedId === 'number'
            ? insertedId
            : (insertedId as { id: number })?.id;

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
      return {
        success: true,
        message: `Imported ${result.records_imported} transactions`,
        records_imported: result.records_imported,
        records_failed: result.records_failed,
        skipped_count: result.skipped_count,
        warnings: result.warnings,
        import_id: result.import_id ?? null,
        resume_import_id: overlap.resumeImportId,
      };
    }
    return {
      success: false,
      error: result.errors.join('; ') || 'Import failed',
      errors: result.errors,
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

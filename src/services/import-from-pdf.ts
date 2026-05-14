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
import {
  validatePostingPeriod,
  getLedgerTypeForTransaction,
} from '../_shared/opera/period-validation.js';
import { markEntriesReconciled } from './mark-reconciled.js';
import { learnPattern } from './bank-pattern-learner.js';
import { recordDeferredTransaction } from './deferred-items.js';

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

/**
 * Lookup hook for the auto-allocate Rule 0 branch. Returns the
 * invoice_refs stored against a gc_payment_id, or null/[] when the
 * payment ID isn't known (e.g. gocardless plugin not active). Faithful
 * port surface for opera_sql_import.py:7128.
 */
export type PaymentRequestInvoiceLookup = (
  gcPaymentId: string,
) => Promise<string[] | null>;

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
    paymentRequestLookup?: PaymentRequestInvoiceLookup | null;
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
    /** Transaction dates from the extracted statement. Used as a
     *  fallback when periodStart/periodEnd are absent — some PDFs
     *  only print the statement date and we still need an effective
     *  range to overlap-check against. Faithful port of legacy
     *  import_orchestration.py:85-94. */
    transactionDates?: ReadonlyArray<string | null>;
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
  /** Tenant company code (e.g. 'intsys', 'cloudsis'). Threaded onto
   *  bank_import_patterns rows so the legacy upsert key
   *  (company_code, description_normalized) works. Defaults to
   *  'default' to match BankPatternLearner's fallback
   *  (bank_patterns.py:54). */
  companyCode?: string | null;
  /** Hook used by auto-allocate Rule 0 to fetch invoice_refs for a
   *  GoCardless payment ID. Wired from the standalone host
   *  (company-registry.ts) when the gocardless plugin is present;
   *  null in plain-SAM mode. */
  paymentRequestLookup?: PaymentRequestInvoiceLookup | null;
}

export interface ImportFromPdfResponse {
  success: boolean;
  message?: string;
  records_imported?: number;
  records_failed?: number;
  skipped_count?: number;
  deferred_count?: number;
  warnings?: string[];
  errors?: string[];
  error?: string;
  resume_import_id?: number | null;
  import_id?: number | null;
  // Legacy result-shape keys (routes.py:4417-4435). Kept alongside
  // the SAM keys so the FE can read either spelling.
  imported_count?: number;
  imported_transactions_count?: number;
  receipts_imported?: number;
  payments_imported?: number;
  refunds_imported?: number;
  transfers_imported?: number;
  total_receipts?: number;
  total_payments?: number;
  skipped_not_selected?: number;
  skipped_incomplete?: number;
  skipped_duplicates?: number;
  imported_transactions?: Array<Record<string, unknown>>;
  auto_allocate_enabled?: boolean;
  statement_info?: Record<string, unknown>;
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
    transactionDates: extracted.transactions.map((t) =>
      typeof t.date === 'string' ? t.date.slice(0, 10) : null,
    ),
    filename: input.filename ?? input.filePath.split('/').pop() ?? '',
    resumeImportId: input.resumeImportId ?? null,
    skipOverlapCheck: !!input.skipOverlapCheck,
  });
  if (overlap.overlapError) {
    // Legacy returns the overlap error verbatim (routes.py:4108-4109);
    // resume_import_id is only meaningful on the same-filename branch,
    // which the orchestrator handles internally (not surfaced to the
    // client). The FE keys off the error shape exactly as legacy
    // emitted it — no extra fields.
    return overlap.overlapError;
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

    // Build override + dateOverride lookup maps EARLY so the
    // closed-year and period-validation passes see the operator's
    // edited date and the override-supplied action (preview-pass
    // matcher result isn't on extracted.transactions; only overrides
    // carry action for the import endpoint). Pre-port TS built these
    // maps AFTER the validation loops, so the loops read pre-override
    // values and were effectively dead code. Audit 2026-05-14 BLOCKER.
    const earlyOverrideByRow = new Map<
      number,
      { transaction_type?: string | null }
    >();
    for (const raw of input.overrides ?? []) {
      const o = (raw ?? {}) as { row?: number; transaction_type?: string | null };
      const row = Number(o.row ?? 0);
      if (!row) continue;
      earlyOverrideByRow.set(row, { transaction_type: o.transaction_type });
    }
    const earlyDateOverrideByRow = new Map<number, string>();
    for (const raw of input.dateOverrides ?? []) {
      const d = raw as { row?: number; date?: string };
      if (!d?.row || !d?.date) continue;
      earlyDateOverrideByRow.set(Number(d.row), String(d.date));
    }
    const effectiveDateForRow = (i: number, fallback: string | null): string => {
      const dateOverride = earlyDateOverrideByRow.get(i + 1);
      return (dateOverride ?? fallback ?? '').slice(0, 10);
    };

    const closedYearErrors: string[] = [];
    const closedYearSkipSet = new Set<number>();
    if (openYearStart) {
      for (let i = 0; i < extracted.transactions.length; i++) {
        const txn = extracted.transactions[i]!;
        const txnDate = effectiveDateForRow(i, txn.date ?? null);
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

    // Belt-and-braces per-period status check. Faithful port of the
    // routes.py:4226-4240 "secondary" guard — catches blocked /
    // closed individual periods inside the open nominal year (i.e.
    // the period exists in nclndd but has ncd_nlstat / ncd_slstat /
    // ncd_plstat != 0). Uses the already-faithful
    // validatePostingPeriod helper in _shared/opera/period-validation.ts.
    const periodErrors: string[] = [];
    const periodSkipSet = new Set<number>();
    for (let i = 0; i < extracted.transactions.length; i++) {
      const txn = extracted.transactions[i]!;
      const rowNum = i + 1;
      if (closedYearSkipSet.has(rowNum)) continue;
      // Read action from override (operator's pick in the UI) first,
      // then fall back to extracted.transactions (which is almost
      // always null on the import endpoint — the preview matcher's
      // result isn't carried through). Pre-port TS only read txn.action
      // → always null → entire loop was dead. Audit 2026-05-14.
      const overrideAction =
        earlyOverrideByRow.get(rowNum)?.transaction_type ?? null;
      const txnAction =
        (txn as unknown as { action?: string | null }).action ?? null;
      const action = overrideAction || txnAction;
      if (!action || action === 'skip' || action === 'defer') continue;
      const txnDate = effectiveDateForRow(i, txn.date ?? null);
      if (!txnDate) continue;
      try {
        const ledger = getLedgerTypeForTransaction(action);
        const pv = await validatePostingPeriod(operaDb, txnDate, ledger);
        if (!pv.is_valid) {
          periodSkipSet.add(rowNum);
          periodErrors.push(
            `Row ${rowNum}: ${pv.error_message ?? 'Posting period not open'}`,
          );
        }
      } catch (pvErr) {
        // Tolerate per-row failures — match legacy line 4239-4240.
        // eslint-disable-next-line no-console
        console.warn(
          `[bank-reconcile] period validation skipped for row ${rowNum}: ${
            pvErr instanceof Error ? pvErr.message : String(pvErr)
          }`,
        );
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

    // Audit deferred rows. Faithful port of routes.py:4119-4140.
    // Operator-marked 'defer' rows must NOT post to Opera but MUST
    // appear in deferred_transactions so Sequential Statement Gating
    // surfaces 'imported' state on the next scan. Overrides from the
    // UI carry transaction_type='defer'; we walk those first and
    // record each one.
    let deferredCount = 0;
    try {
      const deferredBy = input.importedBy ?? 'unknown';
      for (const raw of input.overrides ?? []) {
        const ov = (raw ?? {}) as { row?: number; transaction_type?: string | null };
        if (ov.transaction_type !== 'defer' || !ov.row) continue;
        const txn = extracted.transactions[Number(ov.row) - 1] as
          | { date?: string | null; amount?: number; name?: string | null; memo?: string | null }
          | undefined;
        if (!txn) continue;
        const statementDate = (txn.date ?? '').slice(0, 10);
        const description = (txn.memo ?? txn.name ?? '').toString().slice(0, 255);
        const recRes = await recordDeferredTransaction(appDb, {
          bankCode,
          statementDate,
          amount: Number(txn.amount ?? 0),
          description,
          deferredBy,
        });
        if (recRes.success) deferredCount += 1;
      }
      if (deferredCount > 0) {
        // eslint-disable-next-line no-console
        console.info(
          `[bank-reconcile] recorded ${deferredCount} deferred transaction(s) for ${bankCode}`,
        );
      }
    } catch (defErr) {
      // eslint-disable-next-line no-console
      console.warn(
        `[bank-reconcile] deferred audit failed: ${
          defErr instanceof Error ? defErr.message : String(defErr)
        }`,
      );
    }

    // Apply per-row overrides + date_overrides + rejected_refund_rows
    // BEFORE handing transactions to the executor. Faithful port of
    // routes.py:4259-4308 (_apply_overrides / _apply_dates /
    // rejected_refund_set / bank_transfer_details).
    //
    // The orchestration shell mutates txn shape directly so the
    // executor keeps its contract: read `t.action`, `t.matched_account`,
    // `t.manual_account`, `t.cbtype`. For bank_transfer rows, the
    // destination bank is mapped onto `manual_account` because the
    // executor uses txn.matchedAccount for the other side of the
    // transfer.
    type OverrideRow = {
      row?: number;
      account?: string | null;
      ledger_type?: string | null;
      transaction_type?: string | null;
      nominal_code?: string | null;
      vat_code?: string | null;
      project_code?: string | null;
      department_code?: string | null;
      cbtype?: string | null;
      net_amount?: number | null;
      // FE always sends `bank_transfer_details`; legacy and the
      // orchestrator should both read this key. The shorter
      // `bank_transfer` form was a typo in the TS port — kept here as
      // a backwards-compat alias so older payloads still work.
      bank_transfer_details?: { dest_bank?: string | null } | null;
      bank_transfer?: { dest_bank?: string | null } | null;
    };
    const overrideByRow = new Map<number, OverrideRow>();
    for (const raw of input.overrides ?? []) {
      const o = (raw ?? {}) as OverrideRow;
      const row = Number(o.row ?? 0);
      if (!row) continue;
      overrideByRow.set(row, o);
    }
    const dateOverrideByRow = new Map<number, string>();
    for (const raw of input.dateOverrides ?? []) {
      const d = raw as { row?: number; date?: string };
      if (!d?.row || !d?.date) continue;
      dateOverrideByRow.set(Number(d.row), String(d.date));
    }
    const rejectedRefundSet = new Set<number>(
      (input.rejectedRefundRows ?? []).map((n) => Number(n)),
    );

    // Mutate a working copy so we don't disturb the cached extraction
    // result (extractor cache returns shared references).
    const txnList = extracted.transactions.map((t, i) => {
      const rowNum = i + 1;
      const overlay: Record<string, unknown> = { ...t };
      const ov = overrideByRow.get(rowNum);
      if (ov) {
        if (ov.transaction_type) overlay.action = ov.transaction_type;
        if (ov.account) {
          overlay.manual_account = ov.account;
          // Also populate matched_account so the executor's primary read
          // hits a value. Without this, the matcher-set matched_account
          // from the preview pass is lost on re-extract (no cache), and
          // matched rows with action set but no override-account would
          // throw "Missing matched_account".
          overlay.matched_account = ov.account;
        }
        if (ov.cbtype) overlay.cbtype = ov.cbtype;
        if (ov.nominal_code) overlay.nominal_code = ov.nominal_code;
        if (ov.vat_code) overlay.vat_code = ov.vat_code;
        if (ov.project_code) overlay.project_code = ov.project_code;
        if (ov.department_code) overlay.department_code = ov.department_code;
        if (ov.net_amount !== undefined && ov.net_amount !== null) {
          overlay.net_amount = ov.net_amount;
        }
        // FE sends `bank_transfer_details`; legacy import_orchestration
        // also uses that key. Keep `bank_transfer` as a back-compat alias.
        const btDest =
          ov.bank_transfer_details?.dest_bank ?? ov.bank_transfer?.dest_bank;
        if (
          (ov.transaction_type === 'bank_transfer' ||
            overlay.action === 'bank_transfer') &&
          btDest
        ) {
          overlay.manual_account = btDest;
        }
      }
      const dateOverride = dateOverrideByRow.get(rowNum);
      if (dateOverride) overlay.date = dateOverride;
      return overlay as typeof t;
    });

    // Build the effective selectedRows set. selectedRows uses 1-based
    // line numbers (matches executor's i+1 convention). When the UI
    // sends null OR an empty array we treat it as "post everything";
    // on resume + closed-year + rejected-refund exclusions we then
    // subtract those line numbers from a fully-populated list.
    // Legacy: `selected_rows_set = set(selected_rows) if selected_rows
    // else None` — falsy treats `[]` and None the same way (routes.py:
    // 4067, 4143, 4193). Empty array would otherwise be truthy in JS
    // and turn into an empty Set → "select nothing".
    let effectiveSelected =
      input.selectedRows && input.selectedRows.length > 0
        ? input.selectedRows
        : null;
    if (
      alreadyPosted.size > 0 ||
      closedYearSkipSet.size > 0 ||
      periodSkipSet.size > 0 ||
      rejectedRefundSet.size > 0
    ) {
      const base =
        effectiveSelected ??
        Array.from({ length: extracted.transactions.length }, (_, i) => i + 1);
      effectiveSelected = base.filter(
        (n) =>
          !alreadyPosted.has(n) &&
          !closedYearSkipSet.has(n) &&
          !periodSkipSet.has(n) &&
          !rejectedRefundSet.has(n),
      );
    }

    const result = await executor.postBankImport({
      operaDb,
      bankCode,
      statementInfo: extracted,
      transactions: txnList,
      overrides: input.overrides ?? [],
      selectedRows: effectiveSelected,
      autoAllocate: !!input.autoAllocate,
      autoReconcile: !!input.autoReconcile,
      paymentRequestLookup: input.paymentRequestLookup ?? null,
    });

    // Aggregate signed posted_lines into the receipt/payment totals
    // legacy persists. Legacy filters strictly to the customer/
    // supplier ledger postings:
    //   total_receipts = sum where action == 'sales_receipt'
    //   total_payments = sum where action == 'purchase_payment'
    // routes.py:4411-4412. Pre-port TS bucketed every positive line as
    // a receipt and every negative as a payment — inflating both
    // totals with nominal/refund/transfer lines. The at_type provides
    // the same discriminator: 4 = sales_receipt, 5 = purchase_payment.
    // Audit 2026-05-14 HIGH.
    let totalReceipts = 0;
    let totalPayments = 0;
    for (const line of result.posted_lines ?? []) {
      if (line.at_type === 4 && line.amount > 0) totalReceipts += line.amount;
      else if (line.at_type === 5 && line.amount < 0)
        totalPayments += Math.abs(line.amount);
    }

    // Faithful to legacy routes.py:4440 — only write the
    // bank_statement_imports audit row when something actually
    // happened (records imported OR rows deferred). Without this
    // guard, a "successful" import that posted zero rows (e.g.
    // because every txn was flagged is_duplicate at preview time)
    // creates a stub row that scan-all-banks then classifies as
    // "imported but not reconciled" — confusing the UI for the
    // next operator attempt. Legacy never persists a zero-result
    // import.
    const shouldPersistAudit =
      result.success &&
      (result.records_imported > 0 || deferredCount > 0);

    if (shouldPersistAudit) {
      try {

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

        // Per-line tracking — faithful port of
        // save_statement_transactions (storage.py:2241). Write a row
        // for EVERY extracted statement line so the reconcile screen
        // can display the original statement layout regardless of
        // whether the line was posted, skipped, or deferred. The
        // posted lines get their posted_entry_number stamped in a
        // follow-up UPDATE pass (legacy uses mark_transaction_posted
        // — we batch it here for efficiency).
        if (importId) {
          // Idempotent: clear any prior rows for this import_id.
          // Matches storage.py:2286.
          await appDb('bank_statement_transactions')
            .where({ import_id: importId })
            .delete();

          // Bulk insert the full extracted set.
          const allRows = extracted.transactions.map((t, idx) => ({
            import_id: importId,
            line_number: idx + 1,
            post_date: (t.date ?? '').slice(0, 10) || null,
            description: (t.memo ?? t.name ?? '').toString().slice(0, 500),
            amount: Number(t.amount ?? 0),
            balance: t.balance ?? null,
            transaction_type: String(t.type ?? ''),
            reference:
              (t as unknown as { reference?: string | null }).reference ?? null,
            posted_entry_number: null,
            posted_at: null,
            is_reconciled: 0,
          }));
          if (allRows.length > 0) {
            await appDb('bank_statement_transactions').insert(allRows);
          }

          // Stamp the posted lines with their Opera entry numbers.
          if (Array.isArray(result.posted_lines)) {
            for (const line of result.posted_lines) {
              await appDb('bank_statement_transactions')
                .where({ import_id: importId, line_number: line.line_number })
                .update({
                  posted_entry_number: line.posted_entry_number,
                  posted_at: appDb.fn.now(),
                });
            }
          }
        }

        // Opera-side audit row. Faithful port of routes.py:4466-4488.
        // The bank_import_history table is an installation-specific
        // extension to Opera SQL (not part of the stock Opera schema).
        // When the table doesn't exist we tolerate the error and log
        // it, exactly like legacy. This preserves compliance/audit
        // visibility for anything that reads bank_import_history
        // (e.g. the list-pdf already_processed badge at routes.py:3230).
        try {
          await operaDb.raw(
            `INSERT INTO bank_import_history
               (filename, source, bank_code, total_receipts, total_payments,
                transactions_imported, target_system, imported_by, statement_date,
                import_date)
             VALUES (?, 'pdf', ?, ?, ?, ?, 'Opera SQL', ?, ?, GETDATE())`,
            [
              (input.filename ?? input.filePath.split('/').pop() ?? '').slice(0, 255),
              bankCode,
              totalReceipts,
              totalPayments,
              result.records_imported,
              input.importedBy ?? 'system',
              extracted.statement_date ?? null,
            ],
          );
        } catch (histErr) {
          // eslint-disable-next-line no-console
          console.warn(
            `[bank-reconcile] could not insert into bank_import_history (Opera SQL): ${
              histErr instanceof Error ? histErr.message : String(histErr)
            }`,
          );
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

      // Pattern learning. Faithful port of routes.py:4583-4606.
      // For every operator override with an account+ledger_type, write
      // the (description -> account) mapping to bank_import_patterns so
      // subsequent imports auto-match. Non-fatal on failure.
      try {
        const companyForPatterns = input.companyCode ?? 'default';
        let learned = 0;
        for (const raw of input.overrides ?? []) {
          const ov = (raw ?? {}) as {
            row?: number;
            account?: string | null;
            account_name?: string | null;
            ledger_type?: string | null;
            transaction_type?: string | null;
            vat_code?: string | null;
            nominal_code?: string | null;
            net_amount?: number | null;
          };
          if (!ov.account || !ov.ledger_type) continue;
          const txn = txnList[(Number(ov.row) || 0) - 1] as
            | { name?: string | null; memo?: string | null; amount?: number }
            | undefined;
          if (!txn) continue;
          const desc = (txn.memo ?? txn.name ?? '').toString();
          if (!desc) continue;
          const defaultType =
            Number(txn.amount ?? 0) < 0 ? 'PI' : 'SI';
          const ok = await learnPattern(appDb, {
            companyCode: companyForPatterns,
            description: desc,
            transactionType: ov.transaction_type ?? defaultType,
            accountCode: ov.account,
            accountName: ov.account_name ?? null,
            ledgerType: ov.ledger_type,
            vatCode: ov.vat_code ?? null,
            nominalCode: ov.nominal_code ?? null,
            netAmount: ov.net_amount ?? null,
          });
          if (ok) learned += 1;
        }
        if (learned > 0) {
          // eslint-disable-next-line no-console
          console.info(
            `[bank-reconcile] learned ${learned} pattern(s) from ${
              (input.overrides ?? []).length
            } override(s)`,
          );
        }
      } catch (patErr) {
        // eslint-disable-next-line no-console
        console.warn(
          `[bank-reconcile] pattern learner pass failed: ${
            patErr instanceof Error ? patErr.message : String(patErr)
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
          //
          // On resume-import, include the ALREADY-POSTED entries
          // from the prior batch so auto-reconcile marks the whole
          // statement, not just the latest sliver. Legacy at
          // routes.py:4243-4256 adds these into the `imported` list
          // (with `already_posted: true`) before the reconcile pass
          // at :4625-4634. Pre-port TS dropped already-posted lines
          // from `effectiveSelected` AND never re-added them for
          // reconcile, so resumed statements left earlier batches
          // unreconciled in Opera. Audit 2026-05-14 HIGH.
          const entries: Array<{ entry_number: string; statement_line: number }> = [];
          const seenEntries = new Set<string>();
          for (const line of result.posted_lines) {
            const key = String(line.posted_entry_number).trim();
            if (!key || seenEntries.has(key)) continue;
            seenEntries.add(key);
            entries.push({
              entry_number: key,
              statement_line: line.line_number * 10,
            });
          }
          for (const [lineNumber, entryNumber] of alreadyPosted.entries()) {
            const key = String(entryNumber).trim();
            if (!key || seenEntries.has(key)) continue;
            seenEntries.add(key);
            entries.push({
              entry_number: key,
              statement_line: lineNumber * 10,
            });
          }

          let latestDate: string | null = null;
          for (const line of result.posted_lines) {
            if (line.post_date && (!latestDate || line.post_date > latestDate)) {
              latestDate = line.post_date;
            }
          }
          // Also consider prior batches' dates when picking latestDate
          // so a final-line resume on an old statement uses the
          // earlier batch's most-recent date, not today's.
          if (alreadyPosted.size > 0) {
            for (let i = 0; i < extracted.transactions.length; i += 1) {
              const rowNum = i + 1;
              if (!alreadyPosted.has(rowNum)) continue;
              const d = (extracted.transactions[i]?.date ?? '').slice(0, 10);
              if (d && (!latestDate || d > latestDate)) latestDate = d;
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

      // Build the legacy result-shape companion keys (routes.py:4400-
      // 4434). The SAM keys above are unchanged so callers of either
      // spelling work. at_type bucketing:
      //   4 = sales_receipt, 5 = purchase_payment,
      //   3 = sales_refund,  6 = purchase_refund,
      //   1 = nominal_payment, 2 = nominal_receipt,
      //   8 = bank_transfer.
      let receiptsImported = 0;
      let paymentsImported = 0;
      let refundsImported = 0;
      let transfersImported = 0;
      const importedTransactions: Array<Record<string, unknown>> = [];
      for (const line of result.posted_lines ?? []) {
        switch (line.at_type) {
          case 4:
            receiptsImported += 1;
            break;
          case 5:
            paymentsImported += 1;
            break;
          case 3:
          case 6:
            refundsImported += 1;
            break;
          case 8:
            transfersImported += 1;
            break;
        }
        importedTransactions.push({
          row: line.line_number,
          date: line.post_date,
          amount: line.amount,
          entry_number: line.posted_entry_number,
          at_type: line.at_type,
          description: line.description,
        });
      }
      const statementInfoOut = {
        bank_name: extracted.bank_name,
        account_number: extracted.account_number,
        sort_code: extracted.sort_code,
        statement_date: extracted.statement_date,
        period_start: extracted.period_start,
        period_end: extracted.period_end,
        opening_balance: extracted.opening_balance,
        closing_balance: extracted.closing_balance,
      };

      return {
        success: true,
        message: `Imported ${result.records_imported} transactions${
          deferredCount > 0 ? ` (${deferredCount} deferred)` : ''
        }`,
        records_imported: result.records_imported,
        records_failed: result.records_failed,
        skipped_count: result.skipped_count,
        deferred_count: deferredCount,
        warnings: result.warnings,
        errors:
          closedYearErrors.length + periodErrors.length > 0
            ? [...closedYearErrors, ...periodErrors]
            : undefined,
        import_id: result.import_id ?? null,
        resume_import_id: overlap.resumeImportId,
        // Legacy keys (routes.py:4417-4434).
        imported_count: result.records_imported,
        imported_transactions_count: result.records_imported,
        receipts_imported: receiptsImported,
        payments_imported: paymentsImported,
        refunds_imported: refundsImported,
        transfers_imported: transfersImported,
        total_receipts: totalReceipts,
        total_payments: totalPayments,
        skipped_not_selected: result.skipped_count,
        skipped_incomplete: 0,
        skipped_duplicates: 0,
        imported_transactions: importedTransactions,
        auto_allocate_enabled: !!input.autoAllocate,
        statement_info: statementInfoOut,
        ...(reconciliationResult ? { reconciliation_result: reconciliationResult } : {}),
        ...(autoReconcileEnabled ? { auto_reconcile_enabled: true } : {}),
      };
    }
    // No-op success case: the executor ran cleanly (no errors) but
    // posted zero rows — e.g. a re-attempt where every transaction
    // is already in Opera and was correctly skipped by the dup-check.
    // Pre-fix the function silently returned `success: false, error:
    // 'Import failed'` because the success-return was nested inside
    // the shouldPersistAudit block. Treat this as success and report
    // nothing to do.
    if (
      result.success &&
      result.records_imported === 0 &&
      deferredCount === 0 &&
      closedYearErrors.length === 0 &&
      periodErrors.length === 0
    ) {
      return {
        success: true,
        message:
          result.skipped_count > 0
            ? `Nothing to import — ${result.skipped_count} transaction(s) already in Opera.`
            : 'Nothing to import.',
        records_imported: 0,
        records_failed: 0,
        skipped_count: result.skipped_count ?? 0,
        deferred_count: 0,
        warnings: result.warnings,
        imported_count: 0,
        imported_transactions: [],
        resume_import_id: overlap.resumeImportId,
      };
    }
    return {
      success: false,
      error:
        [...closedYearErrors, ...periodErrors, ...result.errors].join('; ') ||
        'Import failed',
      errors: [...closedYearErrors, ...periodErrors, ...result.errors],
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

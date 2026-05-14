import { validateBankCode, SqlInputValidationError, } from '../_shared/index.js';
import { validatePostingPeriod, getLedgerTypeForTransaction, } from '../_shared/opera/period-validation.js';
import { markEntriesReconciled } from './mark-reconciled.js';
import { learnPattern } from './bank-pattern-learner.js';
import { recordDeferredTransaction } from './deferred-items.js';
async function bankExists(operaDb, bankCode) {
    try {
        const row = (await operaDb('nbank')
            .whereRaw('RTRIM(nk_acnt) = ?', [bankCode])
            .select('nk_acnt')
            .first());
        return !!row;
    }
    catch {
        return false;
    }
}
export async function importBankStatementFromPdf(operaDb, appDb, input, extractor, executor, importLock, overlapChecker) {
    let bankCode;
    try {
        bankCode = validateBankCode(input.bankCode);
    }
    catch (e) {
        if (e instanceof SqlInputValidationError) {
            return { success: false, error: e.message };
        }
        return { success: false, error: e?.message ?? String(e) };
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
    let extracted;
    try {
        extracted = await extractor.extractFromPdf({
            filePath: input.filePath,
            filename: input.filename,
        });
    }
    catch (e) {
        return {
            success: false,
            error: `PDF extraction failed: ${e?.message ?? String(e)}`,
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
        let openYearStart = null;
        try {
            const rows = (await operaDb.raw(`SELECT TOP 1 MIN(ncd_stdate) AS open_start
         FROM nclndd WITH (NOLOCK)
         WHERE ncd_year = (SELECT TOP 1 np_year FROM nparm WITH (NOLOCK))`));
            const raw = Array.isArray(rows) ? rows[0]?.open_start : null;
            if (raw instanceof Date) {
                openYearStart = raw.toISOString().slice(0, 10);
            }
            else if (typeof raw === 'string' && raw.length >= 10) {
                openYearStart = raw.slice(0, 10);
            }
        }
        catch (yrErr) {
            // No nclndd / nparm available — treat as unconstrained. Legacy
            // does the same (opera_config.py:592-595).
            // eslint-disable-next-line no-console
            console.warn(`[bank-reconcile] could not determine open-year start: ${yrErr instanceof Error ? yrErr.message : String(yrErr)} — closed-year guard skipped`);
        }
        const closedYearErrors = [];
        const closedYearSkipSet = new Set();
        if (openYearStart) {
            for (let i = 0; i < extracted.transactions.length; i++) {
                const txn = extracted.transactions[i];
                const txnDate = (txn.date ?? '').slice(0, 10);
                if (!txnDate)
                    continue;
                if (txnDate < openYearStart) {
                    const rowNum = i + 1;
                    closedYearSkipSet.add(rowNum);
                    closedYearErrors.push(`Row ${rowNum}: transaction date ${txnDate} is before the open nominal year start (${openYearStart}). Year-end has been performed; postings to closed years are not allowed. Edit the date or skip this row.`);
                }
            }
        }
        // Belt-and-braces per-period status check. Faithful port of the
        // routes.py:4226-4240 "secondary" guard — catches blocked /
        // closed individual periods inside the open nominal year (i.e.
        // the period exists in nclndd but has ncd_nlstat / ncd_slstat /
        // ncd_plstat != 0). Uses the already-faithful
        // validatePostingPeriod helper in _shared/opera/period-validation.ts.
        const periodErrors = [];
        const periodSkipSet = new Set();
        for (let i = 0; i < extracted.transactions.length; i++) {
            const txn = extracted.transactions[i];
            const rowNum = i + 1;
            if (closedYearSkipSet.has(rowNum))
                continue;
            const action = txn.action ?? null;
            if (!action || action === 'skip' || action === 'defer')
                continue;
            const txnDate = (txn.date ?? '').slice(0, 10);
            if (!txnDate)
                continue;
            try {
                const ledger = getLedgerTypeForTransaction(action);
                const pv = await validatePostingPeriod(operaDb, txnDate, ledger);
                if (!pv.is_valid) {
                    periodSkipSet.add(rowNum);
                    periodErrors.push(`Row ${rowNum}: ${pv.error_message ?? 'Posting period not open'}`);
                }
            }
            catch (pvErr) {
                // Tolerate per-row failures — match legacy line 4239-4240.
                // eslint-disable-next-line no-console
                console.warn(`[bank-reconcile] period validation skipped for row ${rowNum}: ${pvErr instanceof Error ? pvErr.message : String(pvErr)}`);
            }
        }
        // Resume-import skip: when the caller passes resume_import_id,
        // legacy reads bank_statement_transactions for that import and
        // skips any line whose posted_entry_number is already populated
        // (routes.py:4151-4159, storage.get_posted_lines).
        let alreadyPosted = new Map();
        if (input.resumeImportId) {
            try {
                const rows = (await appDb('bank_statement_transactions')
                    .where({ import_id: input.resumeImportId })
                    .whereNotNull('posted_entry_number')
                    .select('line_number', 'posted_entry_number'));
                for (const r of rows) {
                    alreadyPosted.set(Number(r.line_number), String(r.posted_entry_number));
                }
                if (alreadyPosted.size > 0) {
                    // eslint-disable-next-line no-console
                    console.info(`[bank-reconcile] resume import: ${alreadyPosted.size} line(s) already posted for import_id=${input.resumeImportId}`);
                }
            }
            catch (loadErr) {
                // eslint-disable-next-line no-console
                console.warn(`[bank-reconcile] could not load posted lines for resume: ${loadErr instanceof Error ? loadErr.message : String(loadErr)}`);
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
                const ov = (raw ?? {});
                if (ov.transaction_type !== 'defer' || !ov.row)
                    continue;
                const txn = extracted.transactions[Number(ov.row) - 1];
                if (!txn)
                    continue;
                const statementDate = (txn.date ?? '').slice(0, 10);
                const description = (txn.memo ?? txn.name ?? '').toString().slice(0, 255);
                const recRes = await recordDeferredTransaction(appDb, {
                    bankCode,
                    statementDate,
                    amount: Number(txn.amount ?? 0),
                    description,
                    deferredBy,
                });
                if (recRes.success)
                    deferredCount += 1;
            }
            if (deferredCount > 0) {
                // eslint-disable-next-line no-console
                console.info(`[bank-reconcile] recorded ${deferredCount} deferred transaction(s) for ${bankCode}`);
            }
        }
        catch (defErr) {
            // eslint-disable-next-line no-console
            console.warn(`[bank-reconcile] deferred audit failed: ${defErr instanceof Error ? defErr.message : String(defErr)}`);
        }
        const overrideByRow = new Map();
        for (const raw of input.overrides ?? []) {
            const o = (raw ?? {});
            const row = Number(o.row ?? 0);
            if (!row)
                continue;
            overrideByRow.set(row, o);
        }
        const dateOverrideByRow = new Map();
        for (const raw of input.dateOverrides ?? []) {
            const d = raw;
            if (!d?.row || !d?.date)
                continue;
            dateOverrideByRow.set(Number(d.row), String(d.date));
        }
        const rejectedRefundSet = new Set((input.rejectedRefundRows ?? []).map((n) => Number(n)));
        // Mutate a working copy so we don't disturb the cached extraction
        // result (extractor cache returns shared references).
        const txnList = extracted.transactions.map((t, i) => {
            const rowNum = i + 1;
            const overlay = { ...t };
            const ov = overrideByRow.get(rowNum);
            if (ov) {
                if (ov.transaction_type)
                    overlay.action = ov.transaction_type;
                if (ov.account)
                    overlay.manual_account = ov.account;
                if (ov.cbtype)
                    overlay.cbtype = ov.cbtype;
                if (ov.nominal_code)
                    overlay.nominal_code = ov.nominal_code;
                if (ov.vat_code)
                    overlay.vat_code = ov.vat_code;
                if (ov.project_code)
                    overlay.project_code = ov.project_code;
                if (ov.department_code)
                    overlay.department_code = ov.department_code;
                if (ov.net_amount !== undefined && ov.net_amount !== null) {
                    overlay.net_amount = ov.net_amount;
                }
                if ((ov.transaction_type === 'bank_transfer' ||
                    overlay.action === 'bank_transfer') &&
                    ov.bank_transfer?.dest_bank) {
                    overlay.manual_account = ov.bank_transfer.dest_bank;
                }
            }
            const dateOverride = dateOverrideByRow.get(rowNum);
            if (dateOverride)
                overlay.date = dateOverride;
            return overlay;
        });
        // Build the effective selectedRows set. selectedRows uses 1-based
        // line numbers (matches executor's i+1 convention). When the UI
        // sends null we treat it as "post everything"; on resume + closed-
        // year + rejected-refund exclusions we then subtract those line
        // numbers from a fully-populated list.
        let effectiveSelected = input.selectedRows ?? null;
        if (alreadyPosted.size > 0 ||
            closedYearSkipSet.size > 0 ||
            periodSkipSet.size > 0 ||
            rejectedRefundSet.size > 0) {
            const base = effectiveSelected ??
                Array.from({ length: extracted.transactions.length }, (_, i) => i + 1);
            effectiveSelected = base.filter((n) => !alreadyPosted.has(n) &&
                !closedYearSkipSet.has(n) &&
                !periodSkipSet.has(n) &&
                !rejectedRefundSet.has(n));
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
        // legacy persists (routes.py:4498-4508). Declared at the outer
        // scope so the success-branch's legacy result-shape keys can
        // reference them without re-walking the array.
        let totalReceipts = 0;
        let totalPayments = 0;
        for (const line of result.posted_lines ?? []) {
            if (line.amount > 0)
                totalReceipts += line.amount;
            else if (line.amount < 0)
                totalPayments += Math.abs(line.amount);
        }
        if (result.success) {
            try {
                // Resume-import: UPDATE the existing bank_statement_imports row
                // rather than INSERT a new one (legacy routes.py:4502-4526). The
                // running totals accumulate so the audit reflects the full set
                // of posted lines across all attempts.
                let importId;
                if (input.resumeImportId) {
                    try {
                        const existing = (await appDb('bank_statement_imports')
                            .where({ id: input.resumeImportId })
                            .first());
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
                    }
                    catch (resumeErr) {
                        // eslint-disable-next-line no-console
                        console.warn(`[bank-reconcile] resume UPDATE failed for import_id=${input.resumeImportId}: ${resumeErr instanceof Error ? resumeErr.message : String(resumeErr)} — falling back to fresh INSERT`);
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
                        .returning('id'));
                    importId =
                        typeof insertedId === 'number'
                            ? insertedId
                            : insertedId?.id;
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
                        reference: t.reference ?? null,
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
                    await operaDb.raw(`INSERT INTO bank_import_history
               (filename, source, bank_code, total_receipts, total_payments,
                transactions_imported, target_system, imported_by, statement_date,
                import_date)
             VALUES (?, 'pdf', ?, ?, ?, ?, 'Opera SQL', ?, ?, GETDATE())`, [
                        (input.filename ?? input.filePath.split('/').pop() ?? '').slice(0, 255),
                        bankCode,
                        totalReceipts,
                        totalPayments,
                        result.records_imported,
                        input.importedBy ?? 'system',
                        extracted.statement_date ?? null,
                    ]);
                }
                catch (histErr) {
                    // eslint-disable-next-line no-console
                    console.warn(`[bank-reconcile] could not insert into bank_import_history (Opera SQL): ${histErr instanceof Error ? histErr.message : String(histErr)}`);
                }
            }
            catch (writeErr) {
                // History write failure is non-fatal at the import level —
                // log so it's visible, then proceed. (Legacy did the same.)
                // eslint-disable-next-line no-console
                console.warn(`[bank-reconcile] persist post-import tracking failed: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
            }
            // Pattern learning. Faithful port of routes.py:4583-4606.
            // For every operator override with an account+ledger_type, write
            // the (description -> account) mapping to bank_import_patterns so
            // subsequent imports auto-match. Non-fatal on failure.
            try {
                const companyForPatterns = input.companyCode ?? 'default';
                let learned = 0;
                for (const raw of input.overrides ?? []) {
                    const ov = (raw ?? {});
                    if (!ov.account || !ov.ledger_type)
                        continue;
                    const txn = txnList[(Number(ov.row) || 0) - 1];
                    if (!txn)
                        continue;
                    const desc = (txn.memo ?? txn.name ?? '').toString();
                    if (!desc)
                        continue;
                    const defaultType = Number(txn.amount ?? 0) < 0 ? 'PI' : 'SI';
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
                    if (ok)
                        learned += 1;
                }
                if (learned > 0) {
                    // eslint-disable-next-line no-console
                    console.info(`[bank-reconcile] learned ${learned} pattern(s) from ${(input.overrides ?? []).length} override(s)`);
                }
            }
            catch (patErr) {
                // eslint-disable-next-line no-console
                console.warn(`[bank-reconcile] pattern learner pass failed: ${patErr instanceof Error ? patErr.message : String(patErr)}`);
            }
            // Auto-reconcile pass. Faithful port of legacy routes.py:4609-4713.
            // Runs only when the operator asked for it AND the import landed
            // with at least one posted line and no errors.
            let reconciliationResult;
            let autoReconcileEnabled = false;
            if (input.autoReconcile &&
                Array.isArray(result.posted_lines) &&
                result.posted_lines.length > 0 &&
                result.records_failed === 0) {
                autoReconcileEnabled = true;
                try {
                    // Legacy convention: statement_line = original PDF row × 10
                    // (Opera reconcile screen expects increments of 10, with
                    // gaps preserved for unmatched/skipped rows). routes.py:4634.
                    const entries = result.posted_lines.map((line) => ({
                        entry_number: line.posted_entry_number,
                        statement_line: line.line_number * 10,
                    }));
                    let latestDate = null;
                    for (const line of result.posted_lines) {
                        if (line.post_date && (!latestDate || line.post_date > latestDate)) {
                            latestDate = line.post_date;
                        }
                    }
                    if (!latestDate)
                        latestDate = new Date().toISOString().slice(0, 10);
                    // Statement number from nbank.nk_lststno + 1 — Opera's
                    // canonical next-statement counter. Falls back to a
                    // yymmdd-derived value only if the nbank read fails.
                    let statementNumber = null;
                    try {
                        const nbsnRows = (await operaDb.raw(`SELECT nk_lststno FROM nbank WITH (NOLOCK) WHERE RTRIM(nk_acnt) = ?`, [bankCode]));
                        const last = Array.isArray(nbsnRows) ? nbsnRows[0]?.nk_lststno : null;
                        if (last !== null && last !== undefined) {
                            statementNumber = Number(last) + 1;
                        }
                    }
                    catch (nbsnErr) {
                        // eslint-disable-next-line no-console
                        console.warn(`[bank-reconcile] could not read nk_lststno for ${bankCode}: ${nbsnErr instanceof Error ? nbsnErr.message : String(nbsnErr)} — falling back to date-derived`);
                    }
                    if (statementNumber === null) {
                        // yymmdd
                        const d = new Date(latestDate);
                        statementNumber = Number(`${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
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
                }
                catch (reconErr) {
                    // eslint-disable-next-line no-console
                    console.error(`[bank-reconcile] PDF auto-reconciliation error: ${reconErr instanceof Error ? reconErr.message : String(reconErr)}`);
                    reconciliationResult = {
                        success: false,
                        entries_reconciled: 0,
                        messages: [
                            `Auto-reconciliation error: ${reconErr instanceof Error ? reconErr.message : String(reconErr)}`,
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
            const importedTransactions = [];
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
                message: `Imported ${result.records_imported} transactions${deferredCount > 0 ? ` (${deferredCount} deferred)` : ''}`,
                records_imported: result.records_imported,
                records_failed: result.records_failed,
                skipped_count: result.skipped_count,
                deferred_count: deferredCount,
                warnings: result.warnings,
                errors: closedYearErrors.length + periodErrors.length > 0
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
        return {
            success: false,
            error: [...closedYearErrors, ...periodErrors, ...result.errors].join('; ') ||
                'Import failed',
            errors: [...closedYearErrors, ...periodErrors, ...result.errors],
            warnings: result.warnings,
            resume_import_id: overlap.resumeImportId,
        };
    }
    finally {
        try {
            await importLock.release(lockKey);
        }
        catch {
            // best-effort
        }
    }
}
//# sourceMappingURL=import-from-pdf.js.map
function dateToYmd(d) {
    if (!d)
        return '';
    if (d instanceof Date) {
        if (Number.isNaN(d.getTime()))
            return '';
        const yr = d.getFullYear();
        const mo = String(d.getMonth() + 1).padStart(2, '0');
        const da = String(d.getDate()).padStart(2, '0');
        return `${yr}-${mo}-${da}`;
    }
    return String(d).slice(0, 10);
}
export async function getUnreconciledEntries(operaDb, bankCode, includeIncomplete = false) {
    try {
        const completeFilter = includeIncomplete ? '' : 'AND ae_complet = 1';
        const sql = `
      SELECT ae_entry, ae_value/100.0 as value_pounds, ae_lstdate,
             ae_cbtype, ae_entref, ae_comment, ae_complet
      FROM aentry WITH (NOLOCK)
      WHERE ae_acnt = ?
        AND ae_reclnum = 0
        ${completeFilter}
      ORDER BY ae_lstdate, ae_entry
    `;
        const rows = (await operaDb.raw(sql, [bankCode]));
        const entries = (Array.isArray(rows) ? rows : []).map((r) => ({
            ae_entry: String(r.ae_entry ?? '').trim(),
            value_pounds: Number(r.value_pounds ?? 0),
            ae_lstdate: dateToYmd(r.ae_lstdate),
            ae_cbtype: (r.ae_cbtype ?? '').trim(),
            ae_entref: (r.ae_entref ?? '').trim(),
            ae_comment: (r.ae_comment ?? '').trim(),
            ae_complet: Number(r.ae_complet ?? 0),
            is_complete: Number(r.ae_complet ?? 0) !== 0,
        }));
        return {
            success: true,
            bank_code: bankCode,
            count: entries.length,
            entries,
        };
    }
    catch (err) {
        return {
            success: false,
            bank_code: bankCode,
            count: 0,
            entries: [],
            error: err?.message ?? String(err),
        };
    }
}
/**
 * Normalise a filename for case + whitespace-insensitive comparison.
 * Mirrors the legacy `_norm_fn` helper that lets a stored
 * "Statement 17-APR-26 AC X  Y.pdf" (double space) match an inbound
 * "Statement 17-APR-26 AC X Y.pdf" (single space).
 */
function normFilename(fn) {
    if (!fn)
        return '';
    return fn.split(/\s+/).filter(Boolean).join(' ').trim().toLowerCase();
}
export async function getReconciliationStatus(operaDb, bankCode, appDb = null, currentFilename = null) {
    try {
        const nbankRows = (await operaDb.raw(`
      SELECT nk_recbal/100.0 as reconciled_balance,
             nk_curbal/100.0 as current_balance,
             nk_lstrecl as last_rec_line,
             nk_lststno as last_stmt_no,
             nk_lststdt as last_stmt_date,
             nk_recldte as last_rec_date,
             nk_reccfwd/100.0 as rec_cfwd_balance
      FROM nbank WITH (NOLOCK)
      WHERE nk_acnt = ?
      `, [bankCode]));
        if (!Array.isArray(nbankRows) || nbankRows.length === 0) {
            return { success: false, error: `Bank account ${bankCode} not found` };
        }
        const nbank = nbankRows[0];
        const unrecRows = (await operaDb.raw(`
      SELECT COUNT(*) as count, COALESCE(SUM(ae_value), 0)/100.0 as total
      FROM aentry WITH (NOLOCK)
      WHERE ae_acnt = ?
        AND ae_reclnum = 0
        AND ae_complet = 1
      `, [bankCode]));
        const unrec = (Array.isArray(unrecRows) && unrecRows.length > 0)
            ? unrecRows[0]
            : { count: 0, total: 0 };
        const reconciledBalance = Number(nbank.reconciled_balance ?? 0);
        const unreconciledTotal = Number(unrec.total ?? 0);
        const currentBalance = reconciledBalance + unreconciledTotal;
        // Partial-reconciliation check — ae_tmpstat is non-zero when Opera
        // has half-reconciled entries waiting for the user to finish a
        // deferred row. Faithful port of
        // `StatementReconciler.check_reconciliation_in_progress`
        // (sql_rag/statement_reconcile.py:266-299).
        let partialEntries = 0;
        let inProgressMessage = null;
        let sequentialGating = false;
        let sequentialGatingSelf = false;
        try {
            const partialRows = (await operaDb.raw(`
        SELECT COUNT(*) AS partial_count
        FROM aentry WITH (NOLOCK)
        WHERE ae_acnt = ?
          AND ae_tmpstat <> 0
          AND ae_tmpstat IS NOT NULL
        `, [bankCode]));
            partialEntries = Number(partialRows?.[0]?.partial_count ?? 0);
        }
        catch {
            partialEntries = 0;
        }
        if (partialEntries > 0) {
            // Default message — pre-gating.
            inProgressMessage =
                `${partialEntries} entries have partial reconciliation markers from ` +
                    `Opera or a previous session. These will be cleared automatically ` +
                    `when you reconcile.`;
            // Sequential gating: differentiate the message based on whether
            // the user is processing the deferred-row statement itself
            // (sequential_gating_self) vs a subsequent statement in the
            // chain. Faithful port of routes.py:743-797.
            if (appDb) {
                try {
                    const pendingRows = (await appDb('bank_statement_imports')
                        .distinct('filename')
                        .where('bank_code', bankCode)
                        .andWhere(function notReconciled() {
                        this.where('is_reconciled', 0).orWhereNull('is_reconciled');
                    })
                        .andWhere(function notArchived() {
                        this.whereNotIn('target_system', [
                            'archived',
                            'deleted',
                            'retained',
                        ]).orWhereNull('target_system');
                    })
                        .whereNotNull('filename'));
                    const pendingFiles = (pendingRows ?? [])
                        .map((r) => (r.filename ?? '').toString())
                        .filter((f) => f.length > 0);
                    if (pendingFiles.length > 0) {
                        const names = pendingFiles.slice(0, 2).join(', ');
                        const more = pendingFiles.length > 2 ? ` (+${pendingFiles.length - 2} more)` : '';
                        const curNorm = normFilename(currentFilename);
                        const isSelf = !!(curNorm && pendingFiles.some((p) => normFilename(p) === curNorm));
                        if (isSelf) {
                            inProgressMessage =
                                `This statement has ${partialEntries} partial reconciliation ` +
                                    `markers from a previous session and is awaiting a ` +
                                    `deferred-row resolution. Resolve the deferred row, then ` +
                                    `reconcile — the markers will clear automatically.`;
                        }
                        else {
                            inProgressMessage =
                                `This statement cannot be fully reconciled until ` +
                                    `statement ${names}${more} is completed (it's awaiting a ` +
                                    `deferred-row resolution). You can still process and ` +
                                    `import this statement to keep Opera up to date — ` +
                                    `reconciliation will run once the prior statement is done.`;
                        }
                        sequentialGating = true;
                        sequentialGatingSelf = isSelf;
                    }
                }
                catch {
                    // best-effort — sequential-gating message is advisory
                }
            }
        }
        // ============================================================
        // SAM enhancement — Opera divergence / restore detection
        // ============================================================
        // The reconciled balance moves both UP and DOWN naturally between
        // statements (receipts increase it, payments decrease it). So a
        // naive "any closing > current" check produces false positives.
        //
        // Correct detection: the closing balance of the MOST RECENTLY
        // reconciled statement should equal Opera's current `nk_recbal`.
        // If it doesn't, the chain is broken — either Opera was restored
        // (most likely), someone unreconciled directly in Opera Cashbook,
        // or someone reconciled additional entries outside SAM.
        //
        // For recovery, we find the "anchor" — the SAM statement whose
        // closing matches current `nk_recbal` — and mark every statement
        // reconciled AFTER that anchor as un-reconciled. If no anchor
        // exists, we flag the divergence but refuse to auto-correct
        // (could be the rare coincidence the user flagged where Opera
        // ended up on a value SAM never saw).
        let operaDivergenceDetected = false;
        let operaDivergenceMessage = null;
        let staleStatements = [];
        if (appDb) {
            try {
                const mostRecent = (await appDb('bank_statement_imports')
                    .select('id', 'filename', 'statement_date', 'closing_balance', 'reconciled_at')
                    .where('bank_code', bankCode)
                    .andWhere('is_reconciled', 1)
                    .orderBy('reconciled_at', 'desc')
                    .orderBy('statement_date', 'desc')
                    .orderBy('id', 'desc')
                    .first());
                if (mostRecent &&
                    Math.abs(Number(mostRecent.closing_balance ?? 0) - reconciledBalance) > 0.005) {
                    operaDivergenceDetected = true;
                    const recentClosing = Number(mostRecent.closing_balance ?? 0);
                    const direction = recentClosing > reconciledBalance ? 'restore' : 'extra';
                    // Find anchor statement that matches current nk_recbal —
                    // everything reconciled after it is stale and can be safely
                    // un-marked. The anchor is the LATEST reconciled statement
                    // whose closing == nk_recbal.
                    const anchor = (await appDb('bank_statement_imports')
                        .select('id', 'reconciled_at', 'statement_date')
                        .where('bank_code', bankCode)
                        .andWhere('is_reconciled', 1)
                        .andWhereRaw('ABS(closing_balance - ?) < 0.005', [reconciledBalance])
                        .orderBy('reconciled_at', 'desc')
                        .orderBy('statement_date', 'desc')
                        .orderBy('id', 'desc')
                        .first());
                    if (anchor) {
                        const staleRows = (await appDb('bank_statement_imports')
                            .select('id', 'filename', 'statement_date', 'closing_balance')
                            .where('bank_code', bankCode)
                            .andWhere('is_reconciled', 1)
                            .andWhere('id', '!=', anchor.id)
                            .andWhere(function afterAnchor() {
                            if (anchor.reconciled_at) {
                                this.where('reconciled_at', '>', anchor.reconciled_at).orWhere(function tieBreaker() {
                                    this.where('reconciled_at', anchor.reconciled_at).andWhere('id', '>', anchor.id);
                                });
                            }
                            else {
                                this.where('id', '>', anchor.id);
                            }
                        }));
                        staleStatements = staleRows.map((r) => ({
                            import_id: Number(r.id),
                            filename: r.filename,
                            statement_date: dateToYmd(r.statement_date) || null,
                            closing_balance: Number(r.closing_balance ?? 0),
                        }));
                    }
                    if (direction === 'restore') {
                        operaDivergenceMessage =
                            `Opera's reconciled balance (£${reconciledBalance.toFixed(2)}) ` +
                                `is lower than the closing balance of the most recent ` +
                                `statement SAM has marked as reconciled ` +
                                `(${mostRecent.filename ?? `id=${mostRecent.id}`} closed at ` +
                                `£${recentClosing.toFixed(2)}). This usually means Opera was ` +
                                `restored from a backup, or that statement's reconciliation ` +
                                `was undone directly in Opera Cashbook. ` +
                                (staleStatements.length > 0
                                    ? `Found an earlier anchor matching the current balance — ` +
                                        `${staleStatements.length} statement(s) reconciled since then ` +
                                        `can be cleared via the recovery endpoint.`
                                    : `No anchor statement matches Opera's current balance — ` +
                                        `please investigate manually (the chain may have been ` +
                                        `interrupted by direct Opera changes).`);
                    }
                    else {
                        operaDivergenceMessage =
                            `Opera's reconciled balance (£${reconciledBalance.toFixed(2)}) ` +
                                `is HIGHER than the closing of SAM's most-recent reconciled ` +
                                `statement (£${recentClosing.toFixed(2)}). Someone reconciled ` +
                                `additional entries in Opera Cashbook outside SAM. Update ` +
                                `SAM's history manually to match Opera.`;
                    }
                }
            }
            catch {
                // detection is advisory — never block the status response
            }
        }
        return {
            success: true,
            bank_account: bankCode,
            reconciled_balance: reconciledBalance,
            current_balance: currentBalance,
            unreconciled_difference: unreconciledTotal,
            unreconciled_count: Number(unrec.count ?? 0),
            unreconciled_total: unreconciledTotal,
            last_rec_line: Number(nbank.last_rec_line ?? 0),
            last_stmt_no: nbank.last_stmt_no !== null ? Number(nbank.last_stmt_no) : null,
            last_stmt_date: dateToYmd(nbank.last_stmt_date) || null,
            last_rec_date: dateToYmd(nbank.last_rec_date) || null,
            rec_cfwd_balance: Number(nbank.rec_cfwd_balance ?? 0),
            reconciliation_in_progress: partialEntries > 0,
            reconciliation_in_progress_message: inProgressMessage,
            partial_entries: partialEntries,
            sequential_gating: sequentialGating,
            sequential_gating_self: sequentialGatingSelf,
            opera_divergence_detected: operaDivergenceDetected,
            opera_divergence_message: operaDivergenceMessage,
            stale_reconciled_statements: staleStatements,
        };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
/**
 * Find the SAM-reconciled statement whose closing balance matches
 * Opera's current `nk_recbal` (the anchor), then mark every statement
 * reconciled AFTER it as un-reconciled. This handles the legitimate
 * Opera-restore case without false positives from the natural
 * up-and-down movement of the reconciled balance between statements.
 *
 * Refuses to act if no anchor matches — that's the corner case the
 * user flagged where Opera could coincidentally land on a value SAM
 * never saw. In that case the caller is told to investigate manually.
 *
 * Returns the rows that were cleared so the caller can list them in
 * the UI.
 */
export async function recoverFromOperaDivergence(operaDb, appDb, bankCode) {
    try {
        const nbank = (await operaDb('nbank')
            .select(operaDb.raw('nk_recbal / 100.0 AS reconciled_balance'))
            .where('nk_acnt', bankCode)
            .first());
        if (!nbank) {
            return { success: false, cleared: 0, error: `Bank ${bankCode} not found in nbank` };
        }
        const reconciledBalance = Number(nbank.reconciled_balance ?? 0);
        // Most recent reconciled statement — if it matches nk_recbal, no
        // divergence; nothing to clear.
        const mostRecent = (await appDb('bank_statement_imports')
            .select('id', 'closing_balance')
            .where('bank_code', bankCode)
            .andWhere('is_reconciled', 1)
            .orderBy('reconciled_at', 'desc')
            .orderBy('statement_date', 'desc')
            .orderBy('id', 'desc')
            .first());
        if (!mostRecent ||
            Math.abs(Number(mostRecent.closing_balance ?? 0) - reconciledBalance) <= 0.005) {
            return { success: true, cleared: 0, cleared_imports: [] };
        }
        // Find anchor — the latest SAM-reconciled statement whose closing
        // balance equals Opera's current nk_recbal. Statements reconciled
        // after this anchor are stale.
        const anchor = (await appDb('bank_statement_imports')
            .select('id', 'reconciled_at')
            .where('bank_code', bankCode)
            .andWhere('is_reconciled', 1)
            .andWhereRaw('ABS(closing_balance - ?) < 0.005', [reconciledBalance])
            .orderBy('reconciled_at', 'desc')
            .orderBy('statement_date', 'desc')
            .orderBy('id', 'desc')
            .first());
        if (!anchor) {
            return {
                success: false,
                cleared: 0,
                error: `Cannot auto-recover: no SAM statement matches Opera's current ` +
                    `reconciled balance (£${reconciledBalance.toFixed(2)}). The reconciliation ` +
                    `chain has been broken in a way SAM can't safely auto-resolve — ` +
                    `please investigate manually (Opera Cashbook history vs. SAM imports).`,
            };
        }
        const stale = (await appDb('bank_statement_imports')
            .select('id', 'filename', 'statement_date', 'closing_balance')
            .where('bank_code', bankCode)
            .andWhere('is_reconciled', 1)
            .andWhere('id', '!=', anchor.id)
            .andWhere(function afterAnchor() {
            if (anchor.reconciled_at) {
                this.where('reconciled_at', '>', anchor.reconciled_at).orWhere(function tieBreaker() {
                    this.where('reconciled_at', anchor.reconciled_at).andWhere('id', '>', anchor.id);
                });
            }
            else {
                this.where('id', '>', anchor.id);
            }
        }));
        if (stale.length === 0) {
            return { success: true, cleared: 0, cleared_imports: [] };
        }
        const ids = stale.map((s) => s.id);
        const cleared = Number(await appDb('bank_statement_imports')
            .whereIn('id', ids)
            .update({
            is_reconciled: 0,
            reconciled_count: 0,
            reconciled_at: null,
            reconciled_by: null,
        }));
        return {
            success: true,
            cleared,
            cleared_imports: stale.map((s) => ({
                import_id: Number(s.id),
                filename: s.filename,
                statement_date: dateToYmd(s.statement_date) || null,
                closing_balance: Number(s.closing_balance ?? 0),
            })),
        };
    }
    catch (err) {
        return { success: false, cleared: 0, error: err?.message ?? String(err) };
    }
}
//# sourceMappingURL=reconciliation-status.js.map
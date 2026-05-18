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
        let operaDivergenceDirection = null;
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
                    operaDivergenceDirection = direction;
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
                        // direction === 'extra' (Opera ahead of SAM).
                        //
                        // If the self-heal pass that runs before this detection
                        // didn't promote anything, one of three things is true:
                        //   (a) Multiple unreconciled SAM statements share the
                        //       matching closing → ambiguous, operator must pick
                        //       one in Reconcile.
                        //   (b) No unreconciled SAM statement matches → genuinely
                        //       reconciled outside SAM (in Opera Cashbook), OR
                        //       SAM never imported the missing statement, OR a
                        //       SAM statement was deleted before being marked.
                        //   (c) A match exists but its statement_date is earlier
                        //       than SAM's anchor — refused to promote a stale
                        //       row.
                        //
                        // Look up unreconciled candidates so the message can
                        // describe the real situation.
                        const matchingCount = (await appDb('bank_statement_imports')
                            .where('bank_code', bankCode)
                            .andWhere('is_reconciled', 0)
                            .andWhereRaw('ABS(closing_balance - ?) < 0.005', [
                            reconciledBalance,
                        ])
                            .count({ c: '*' })
                            .first());
                        const candidateRows = Number(matchingCount?.c ?? 0);
                        if (candidateRows >= 2) {
                            operaDivergenceMessage =
                                `Opera's reconciled balance (£${reconciledBalance.toFixed(2)}) ` +
                                    `matches ${candidateRows} unreconciled SAM statements with ` +
                                    `the same closing balance. SAM can't safely auto-pick which ` +
                                    `one is the one Opera reconciled — open Reconcile and ` +
                                    `complete the correct statement, then re-scan.`;
                        }
                        else if (candidateRows === 0) {
                            operaDivergenceMessage =
                                `Opera's reconciled balance (£${reconciledBalance.toFixed(2)}) ` +
                                    `doesn't correspond to any statement currently in SAM. ` +
                                    `Either (a) the reconciled statement was deleted from SAM ` +
                                    `before being marked reconciled, (b) someone reconciled ` +
                                    `entries directly in Opera Cashbook without going through ` +
                                    `SAM, or (c) SAM never imported the statement that matches ` +
                                    `Opera's current balance. Review Opera Cashbook history ` +
                                    `vs. SAM imports.`;
                        }
                        else {
                            // candidateRows === 1 — self-heal must have refused on the
                            // statement_date-older guard. Tell the operator which row
                            // SAM thinks is the candidate so they can decide.
                            const refused = (await appDb('bank_statement_imports')
                                .select('id', 'filename', 'statement_date')
                                .where('bank_code', bankCode)
                                .andWhere('is_reconciled', 0)
                                .andWhereRaw('ABS(closing_balance - ?) < 0.005', [
                                reconciledBalance,
                            ])
                                .first());
                            const refusedFn = refused?.filename ?? `id=${refused?.id ?? '?'}`;
                            const refusedDate = dateToYmd(refused?.statement_date ?? null);
                            operaDivergenceMessage =
                                `Opera's reconciled balance (£${reconciledBalance.toFixed(2)}) ` +
                                    `matches an OLDER SAM statement (${refusedFn}` +
                                    (refusedDate ? `, dated ${refusedDate}` : '') +
                                    `) than SAM's most-recently-reconciled row. Auto-promotion ` +
                                    `refused because that would suggest a statement was ` +
                                    `reconciled out of order. Review manually in Reconcile.`;
                        }
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
            opera_divergence_direction: operaDivergenceDirection,
            stale_reconciled_statements: staleStatements,
        };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
/**
 * Bidirectional Opera-divergence recovery.
 *
 * Two scenarios, both handled symmetrically:
 *
 *   restore (SAM ahead of Opera) — Opera's nk_recbal is LOWER than
 *     SAM's most-recent reconciled closing. Likely Opera DB
 *     restored from backup. Find the SAM "anchor" statement whose
 *     closing == nk_recbal and mark every statement reconciled
 *     AFTER it as un-reconciled.
 *
 *   extra (Opera ahead of SAM) — Opera's nk_recbal is HIGHER than
 *     SAM's most-recent reconciled closing. Either someone
 *     reconciled in Opera Cashbook outside SAM, or (the common
 *     case) a SAM reconcile workflow completed but failed to
 *     flip is_reconciled=1 on the import row (silent UPDATE
 *     failure or missing import_id at the FE). Find SAM
 *     unreconciled statements whose closing chains forward to
 *     Opera's nk_recbal, promote them to is_reconciled=1.
 *
 * Both directions refuse to act when there's no safe match
 * (returns success=true, cleared=0 + a diagnostic message),
 * so the operator can investigate the corner cases manually.
 */
export async function recoverFromOperaDivergence(operaDb, appDb, bankCode, opts = {}) {
    try {
        const nbank = (await operaDb('nbank')
            .select(operaDb.raw('nk_recbal / 100.0 AS reconciled_balance'))
            .where('nk_acnt', bankCode)
            .first());
        if (!nbank) {
            return {
                success: false,
                cleared: 0,
                direction: 'none',
                error: `Bank ${bankCode} not found in nbank`,
            };
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
        const mostRecentClosing = Number(mostRecent?.closing_balance ?? 0);
        const noReconciledSamRows = !mostRecent;
        if (mostRecent &&
            Math.abs(mostRecentClosing - reconciledBalance) <= 0.005) {
            return {
                success: true,
                cleared: 0,
                cleared_imports: [],
                promoted: 0,
                promoted_imports: [],
                direction: 'none',
            };
        }
        // Decide direction. When SAM has no reconciled rows but Opera
        // is non-zero, treat as "extra" — SAM never tracked it.
        const direction = !noReconciledSamRows && mostRecentClosing > reconciledBalance
            ? 'restore'
            : 'extra';
        // ============================================================
        // EXTRA direction — Opera ahead of SAM. Promote unreconciled
        // SAM statements whose closing == nk_recbal (or chain forward
        // to it). The common case: SAM imported + processed + posted
        // to Opera, but the workflow didn't flip is_reconciled=1 on
        // the import row.
        // ============================================================
        if (direction === 'extra') {
            // Find unreconciled statements whose closing matches Opera's
            // current nk_recbal. The latest matching one is the "Opera
            // anchor" — every unreconciled SAM statement between
            // mostRecent (the last-reconciled SAM row) and the Opera
            // anchor should be promoted.
            const matchingUnreconciled = (await appDb('bank_statement_imports')
                .select('id', 'filename', 'statement_date', 'closing_balance', 'statement_date')
                .where('bank_code', bankCode)
                .andWhere('is_reconciled', 0)
                .andWhereRaw('ABS(closing_balance - ?) < 0.005', [reconciledBalance])
                .orderBy('statement_date', 'desc')
                .orderBy('id', 'desc')
                .first());
            if (!matchingUnreconciled) {
                return {
                    success: false,
                    cleared: 0,
                    direction: 'extra',
                    error: `Cannot auto-recover (Opera ahead of SAM): no SAM statement ` +
                        `closing balance matches Opera's current reconciled balance ` +
                        `(£${reconciledBalance.toFixed(2)}). The reconciliation chain ` +
                        `has been broken in a way SAM can't safely auto-resolve — ` +
                        `someone may have reconciled entries directly in Opera ` +
                        `Cashbook outside SAM. Investigate Opera Cashbook history ` +
                        `vs. SAM imports.`,
                };
            }
            // Promote the directly-matching unreconciled statement. We
            // intentionally don't chain-pickup earlier unreconciled
            // statements here — if there are intermediates, the operator
            // should review them in Reconcile manually so they get a
            // proper line-by-line reconcile pass rather than a blind
            // auto-flag. The common case (08-MAY-26 BC010 type) is a
            // single-statement promotion, which this handles.
            const targets = [
                {
                    id: matchingUnreconciled.id,
                    filename: matchingUnreconciled.filename,
                    statement_date: matchingUnreconciled.statement_date,
                    closing_balance: matchingUnreconciled.closing_balance,
                },
            ];
            const recCount = (await appDb('bank_statement_transactions')
                .where('import_id', matchingUnreconciled.id)
                .count({ c: '*' })
                .first());
            const reconciledLineCount = Number(recCount?.c ?? 0);
            const promoted = Number(await appDb('bank_statement_imports')
                .where({ id: matchingUnreconciled.id })
                .update({
                is_reconciled: 1,
                reconciled_count: reconciledLineCount,
                reconciled_at: appDb.fn.now(),
                reconciled_by: opts.user ?? 'sync-with-opera',
            }));
            return {
                success: true,
                cleared: 0,
                promoted,
                promoted_imports: targets.map((s) => ({
                    import_id: Number(s.id),
                    filename: s.filename,
                    statement_date: dateToYmd(s.statement_date) || null,
                    closing_balance: Number(s.closing_balance ?? 0),
                })),
                direction: 'extra',
            };
        }
        // ============================================================
        // RESTORE direction — SAM ahead of Opera. Find anchor + clear
        // stale is_reconciled flags after it.
        // ============================================================
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
                direction: 'restore',
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
            direction: 'restore',
        };
    }
    catch (err) {
        return { success: false, cleared: 0, error: err?.message ?? String(err) };
    }
}
/**
 * Convenience — read statement_date for a given import id. Used by
 * the "extra" recovery direction to scope which unreconciled
 * statements to promote.
 */
async function getStatementDate(appDb, importId) {
    const row = (await appDb('bank_statement_imports')
        .select('statement_date')
        .where({ id: importId })
        .first());
    return dateToYmd(row?.statement_date ?? null) || null;
}
//# sourceMappingURL=reconciliation-status.js.map
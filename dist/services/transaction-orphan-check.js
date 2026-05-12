function dateToYmd(d) {
    if (!d)
        return null;
    if (d instanceof Date) {
        if (Number.isNaN(d.getTime()))
            return null;
        return d.toISOString().slice(0, 10);
    }
    return String(d).slice(0, 10);
}
/**
 * Look up which Opera `at_entry`/`ae_entry` values from the provided
 * list currently exist in `aentry` for the given bank. Returns the
 * set that ARE present — caller diffs against the requested list to
 * find orphans.
 *
 * Batched (200 entries per query) to stay below MSSQL's 2100-param
 * cap when a statement has lots of posted lines.
 */
async function entriesPresentInOpera(operaDb, bankCode, entryNumbers) {
    const present = new Set();
    const unique = Array.from(new Set(entryNumbers.map((e) => e.trim()).filter(Boolean)));
    if (unique.length === 0)
        return present;
    const batchSize = 200;
    for (let i = 0; i < unique.length; i += batchSize) {
        const batch = unique.slice(i, i + batchSize);
        try {
            const placeholders = batch.map(() => '?').join(',');
            const rows = (await operaDb('aentry')
                .select(operaDb.raw('RTRIM(ae_entry) AS ae_entry'))
                .whereRaw('RTRIM(ae_acnt) = ?', [bankCode])
                .andWhereRaw(`RTRIM(ae_entry) IN (${placeholders})`, batch));
            for (const r of rows ?? []) {
                const v = (r.ae_entry ?? '').trim();
                if (v)
                    present.add(v);
            }
        }
        catch {
            // Best-effort — if Opera read fails, assume present rather
            // than over-report orphans (false positives mis-direct the
            // user to re-post things that are actually fine).
            for (const e of batch)
                present.add(e);
        }
    }
    return present;
}
async function fetchPostedLines(appDb, bankCode) {
    // Pull imports for this bank that have at least one posted line.
    // Join against the transactions table to avoid loading statements
    // with nothing posted.
    const imports = (await appDb('bank_statement_imports')
        .select('id', 'filename', 'statement_date', 'opening_balance', 'closing_balance')
        .where('bank_code', bankCode));
    const importMap = new Map();
    for (const r of imports)
        importMap.set(r.id, r);
    if (importMap.size === 0)
        return { imports: importMap, lines: [] };
    const lines = (await appDb('bank_statement_transactions')
        .select('id', 'import_id', 'line_number', 'post_date', 'description', 'amount', 'posted_entry_number')
        .whereIn('import_id', Array.from(importMap.keys()))
        .whereNotNull('posted_entry_number')
        .andWhereRaw("TRIM(posted_entry_number) <> ''"));
    return { imports: importMap, lines };
}
function buildOrphanResult(importMap, lines, presentInOpera) {
    const byImport = new Map();
    for (const line of lines) {
        const entry = (line.posted_entry_number ?? '').trim();
        if (!entry || presentInOpera.has(entry))
            continue;
        const arr = byImport.get(line.import_id) ?? [];
        arr.push({
            import_id: line.import_id,
            transaction_id: line.id,
            line_number: line.line_number,
            post_date: dateToYmd(line.post_date),
            amount: Number(line.amount ?? 0),
            posted_entry_number: entry,
            description: (line.description ?? '').toString(),
        });
        byImport.set(line.import_id, arr);
    }
    const orphan_statements = [];
    let orphan_line_count = 0;
    for (const [importId, orphanLines] of byImport) {
        const imp = importMap.get(importId);
        orphan_line_count += orphanLines.length;
        orphan_statements.push({
            import_id: importId,
            filename: imp?.filename ?? null,
            statement_date: dateToYmd(imp?.statement_date) || null,
            opening_balance: imp?.opening_balance !== undefined ? Number(imp.opening_balance) : null,
            closing_balance: imp?.closing_balance !== undefined ? Number(imp.closing_balance) : null,
            orphan_lines: orphanLines.sort((a, b) => a.line_number - b.line_number),
            orphan_total: Math.round(orphanLines.reduce((s, l) => s + l.amount, 0) * 100) / 100,
        });
    }
    orphan_statements.sort((a, b) => (a.statement_date ?? '').localeCompare(b.statement_date ?? ''));
    return { orphan_statements, orphan_line_count };
}
/**
 * Read-only orphan detection for a single bank. Walks every
 * statement on the bank, finds each `bank_statement_transactions`
 * row with a `posted_entry_number`, validates each against Opera
 * `aentry`, returns the statements with one or more orphaned lines.
 *
 * Suitable to wire into:
 *   - the bank's reconcile-status response
 *   - scan-all-banks per-bank enrichment
 *   - a dedicated read-only check endpoint
 */
export async function checkOrphanedTransactions(operaDb, appDb, bankCode) {
    const code = (bankCode ?? '').trim();
    if (!code) {
        return {
            success: false,
            bank_code: code,
            statement_count: 0,
            orphan_line_count: 0,
            orphan_statements: [],
            error: 'bank_code required',
        };
    }
    try {
        const { imports, lines } = await fetchPostedLines(appDb, code);
        if (lines.length === 0) {
            return {
                success: true,
                bank_code: code,
                statement_count: 0,
                orphan_line_count: 0,
                orphan_statements: [],
            };
        }
        const entryNumbers = lines
            .map((l) => (l.posted_entry_number ?? '').trim())
            .filter(Boolean);
        const presentInOpera = await entriesPresentInOpera(operaDb, code, entryNumbers);
        const { orphan_statements, orphan_line_count } = buildOrphanResult(imports, lines, presentInOpera);
        return {
            success: true,
            bank_code: code,
            statement_count: orphan_statements.length,
            orphan_line_count,
            orphan_statements,
        };
    }
    catch (err) {
        return {
            success: false,
            bank_code: code,
            statement_count: 0,
            orphan_line_count: 0,
            orphan_statements: [],
            error: err?.message ?? String(err),
        };
    }
}
/**
 * Explicit-confirmation recovery. Re-runs the detection and clears
 * `posted_entry_number` + `posted_at` on every orphaned line so the
 * normal import-from-pdf flow can re-post them. Statement-level
 * `is_reconciled` is also cleared on any affected import (those
 * statements clearly aren't reconciled anymore since Opera lost the
 * entries).
 *
 * Never auto-runs — caller is an explicit POST endpoint after the
 * user has reviewed the detection result and confirmed an Opera
 * restore has happened.
 */
export async function recoverOrphanedTransactions(operaDb, appDb, bankCode) {
    const code = (bankCode ?? '').trim();
    if (!code) {
        return {
            success: false,
            bank_code: code,
            cleared_lines: 0,
            cleared_statements: [],
            error: 'bank_code required',
        };
    }
    try {
        const detection = await checkOrphanedTransactions(operaDb, appDb, code);
        if (!detection.success) {
            return {
                success: false,
                bank_code: code,
                cleared_lines: 0,
                cleared_statements: [],
                error: detection.error,
            };
        }
        if (detection.orphan_statements.length === 0) {
            return {
                success: true,
                bank_code: code,
                cleared_lines: 0,
                cleared_statements: [],
            };
        }
        const txIds = [];
        const importIds = new Set();
        for (const stmt of detection.orphan_statements) {
            importIds.add(stmt.import_id);
            for (const line of stmt.orphan_lines)
                txIds.push(line.transaction_id);
        }
        // Clear the orphaned line tracking + the parent statement's
        // reconciliation flag in a single transaction to keep them
        // consistent. Also re-sync each affected statement's stored
        // `transactions_imported` count to the live count of lines that
        // still have a `posted_entry_number` — otherwise the Hub display
        // ("N/M posted") stays frozen at the pre-recovery count and the
        // statement looks like it's still partially posted to Opera.
        await appDb.transaction(async (trx) => {
            await trx('bank_statement_transactions')
                .whereIn('id', txIds)
                .update({
                posted_entry_number: null,
                posted_at: null,
                is_reconciled: 0,
            });
            for (const importId of importIds) {
                const row = await trx('bank_statement_transactions')
                    .where({ import_id: importId })
                    .whereNotNull('posted_entry_number')
                    .andWhereRaw("TRIM(posted_entry_number) <> ''")
                    .count({ c: '*' })
                    .first();
                const remainingPosted = Number(row?.c ?? 0);
                await trx('bank_statement_imports').where({ id: importId }).update({
                    is_reconciled: 0,
                    reconciled_count: 0,
                    reconciled_at: null,
                    reconciled_by: null,
                    transactions_imported: remainingPosted,
                });
            }
        });
        return {
            success: true,
            bank_code: code,
            cleared_lines: txIds.length,
            cleared_statements: detection.orphan_statements,
        };
    }
    catch (err) {
        return {
            success: false,
            bank_code: code,
            cleared_lines: 0,
            cleared_statements: [],
            error: err?.message ?? String(err),
        };
    }
}
//# sourceMappingURL=transaction-orphan-check.js.map
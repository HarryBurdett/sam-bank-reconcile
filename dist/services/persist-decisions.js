const ARCHIVED_STATUSES = new Set(['archived', 'deleted', 'retained']);
export async function persistImportDecisions(appDb, input) {
    const bankCode = (input.bankCode ?? '').trim();
    const filename = (input.filename ?? '').trim();
    const sourceRaw = (input.source ?? 'pdf').trim();
    const stmt = input.statementInfo ?? {};
    const deferred = Array.isArray(input.deferredTransactions)
        ? input.deferredTransactions
        : [];
    const importedBy = (input.importedBy ?? 'admin').trim() || 'admin';
    if (!bankCode || !filename) {
        return {
            success: false,
            error: 'bank_code and filename are required',
        };
    }
    // Normalise source: pdf → file, email → email
    const source = sourceRaw === 'pdf' ? 'file' : sourceRaw;
    try {
        // Step 1: UPSERT-ish bank_statement_imports row
        let importId;
        try {
            const existing = (await appDb('bank_statement_imports')
                .where({ bank_code: bankCode, filename })
                .whereNotIn('target_system', [...ARCHIVED_STATUSES])
                .orderBy('id', 'desc')
                .first());
            if (existing) {
                importId = existing.id;
            }
            else {
                const inserted = await appDb('bank_statement_imports')
                    .insert({
                    bank_code: bankCode,
                    filename,
                    source,
                    target_system: 'opera_se',
                    transactions_imported: 0,
                    total_receipts: 0,
                    total_payments: 0,
                    imported_by: importedBy,
                    opening_balance: stmt.opening_balance ?? null,
                    closing_balance: stmt.closing_balance ?? null,
                    statement_date: stmt.statement_date ?? null,
                    account_number: stmt.account_number ?? null,
                    sort_code: stmt.sort_code ?? null,
                    period_start: stmt.period_start ?? null,
                    period_end: stmt.period_end ?? null,
                    is_reconciled: false,
                })
                    .returning('id');
                importId =
                    Array.isArray(inserted) && inserted.length > 0
                        ? typeof inserted[0] === 'object'
                            ? inserted[0].id
                            : Number(inserted[0])
                        : undefined;
            }
        }
        catch (err) {
            return {
                success: false,
                error: `Could not create tracking record: ${err?.message ?? String(err)}`,
            };
        }
        // Step 2: Replace defer set for this bank+period
        let deferredCount = 0;
        try {
            let delQuery = appDb('deferred_transactions').where({
                bank_code: bankCode,
            });
            if (stmt.period_start && stmt.period_end) {
                delQuery = delQuery
                    .andWhere('post_date', '>=', stmt.period_start)
                    .andWhere('post_date', '<=', stmt.period_end);
            }
            await delQuery.delete();
            for (const d of deferred) {
                const post_date = (d.date ?? '').toString().slice(0, 10);
                const amount = Number.isFinite(Number(d.amount)) ? Number(d.amount) : 0;
                const description = (d.description ?? '').toString().slice(0, 500);
                try {
                    await appDb('deferred_transactions').insert({
                        bank_code: bankCode,
                        post_date: post_date || null,
                        amount,
                        description,
                        reason: 'persist-decisions',
                    });
                    deferredCount++;
                }
                catch {
                    // Log+continue — same behaviour as Python
                }
            }
        }
        catch {
            // Defer-set replacement failed; tracking row still committed.
            // Caller's idempotent flow will catch up next click.
        }
        return {
            success: true,
            import_id: importId,
            deferred_count: deferredCount,
        };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
//# sourceMappingURL=persist-decisions.js.map
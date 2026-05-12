export async function recordDeferredTransaction(appDb, args) {
    if (!args.bankCode)
        return { success: false, error: 'bank_code required' };
    try {
        const [id] = (await appDb('deferred_transactions')
            .insert({
            bank_code: args.bankCode,
            statement_date: args.statementDate,
            amount: args.amount,
            description: args.description.slice(0, 255),
            deferred_by: args.deferredBy,
        })
            .returning('id'));
        const numericId = typeof id === 'number' ? id : Number(id?.id ?? 0);
        return { success: true, id: numericId };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
export async function listDeferredItems(appDb, bankCode) {
    try {
        const rows = (await appDb('deferred_transactions')
            .where({ bank_code: bankCode })
            .orderBy('deferred_at', 'desc'));
        return {
            success: true,
            items: rows.map((r) => ({
                id: Number(r.id),
                bank_code: r.bank_code,
                statement_date: r.statement_date instanceof Date
                    ? r.statement_date.toISOString().slice(0, 10)
                    : String(r.statement_date ?? '').slice(0, 10),
                amount: Number(r.amount),
                description: r.description,
                deferred_by: r.deferred_by,
                deferred_at: r.deferred_at instanceof Date
                    ? r.deferred_at.toISOString()
                    : String(r.deferred_at),
            })),
        };
    }
    catch (err) {
        return { success: false, items: [], error: err?.message ?? String(err) };
    }
}
export async function deleteDeferredItems(appDb, bankCode, ids) {
    try {
        let q = appDb('deferred_transactions').where({ bank_code: bankCode });
        if (ids && ids.length > 0) {
            q = q.whereIn('id', ids);
        }
        const deleted = await q.delete();
        return { success: true, deleted };
    }
    catch (err) {
        return {
            success: false,
            deleted: 0,
            error: err?.message ?? String(err),
        };
    }
}
export async function deleteIgnoredTransactionByRecordId(appDb, recordId) {
    if (!Number.isFinite(recordId) || recordId <= 0) {
        return { success: false, deleted: 0, error: 'invalid record_id' };
    }
    try {
        const deleted = await appDb('ignored_transactions')
            .where({ id: recordId })
            .delete();
        return { success: true, deleted };
    }
    catch (err) {
        return {
            success: false,
            deleted: 0,
            error: err?.message ?? String(err),
        };
    }
}
//# sourceMappingURL=deferred-items.js.map
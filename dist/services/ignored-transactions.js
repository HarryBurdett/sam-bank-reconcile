function dateToYmd(d) {
    if (!d)
        return '';
    if (d instanceof Date) {
        if (Number.isNaN(d.getTime()))
            return '';
        return d.toISOString().slice(0, 10);
    }
    return String(d).slice(0, 10);
}
export async function ignoreTransaction(appDb, input) {
    try {
        const inserted = await appDb('ignored_bank_transactions')
            .insert({
            bank_code: input.bankCode,
            transaction_date: input.transactionDate,
            amount: input.amount,
            description: input.description ?? null,
            reference: input.reference ?? null,
            reason: input.reason ?? null,
            ignored_by: input.ignoredBy ?? 'API',
        })
            .returning('id');
        const recordId = Array.isArray(inserted) && inserted.length > 0
            ? typeof inserted[0] === 'object'
                ? inserted[0].id
                : Number(inserted[0])
            : 0;
        return {
            success: true,
            message: `Transaction ignored: £${input.amount.toFixed(2)} on ${input.transactionDate}`,
            record_id: recordId,
        };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
export async function listIgnoredTransactions(appDb, bankCode, limit = 100) {
    try {
        const rows = (await appDb('ignored_bank_transactions')
            .where({ bank_code: bankCode })
            .orderBy('transaction_date', 'desc')
            .limit(limit));
        const transactions = rows.map((r) => ({
            id: r.id,
            bank_code: r.bank_code,
            transaction_date: dateToYmd(r.transaction_date),
            amount: Number(r.amount ?? 0),
            description: r.description ?? '',
            reference: r.reference ?? '',
            reason: r.reason ?? '',
            ignored_by: r.ignored_by ?? '',
            ignored_at: r.ignored_at instanceof Date
                ? r.ignored_at.toISOString()
                : String(r.ignored_at ?? ''),
        }));
        return { success: true, transactions, count: transactions.length };
    }
    catch (err) {
        return {
            success: false,
            transactions: [],
            count: 0,
            error: err?.message ?? String(err),
        };
    }
}
/** Remove an ignored-transaction record by id. */
export async function unignoreTransactionById(appDb, recordId) {
    try {
        const deleted = await appDb('ignored_bank_transactions')
            .where({ id: recordId })
            .delete();
        if (deleted > 0) {
            return { success: true, message: 'Transaction removed from ignored list' };
        }
        return { success: false, error: 'Record not found' };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
/**
 * Remove an ignored transaction by matching bank+date+amount.
 * Used when the user re-checks the include checkbox on an unmatched item.
 */
export async function unignoreTransactionByMatch(appDb, bankCode, transactionDate, amount) {
    try {
        const deleted = await appDb('ignored_bank_transactions')
            .where({
            bank_code: bankCode,
            transaction_date: transactionDate,
            amount,
        })
            .delete();
        if (deleted > 0) {
            return { success: true, message: 'Transaction removed from ignored list' };
        }
        return { success: false, error: 'No matching ignored transaction found' };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
//# sourceMappingURL=ignored-transactions.js.map
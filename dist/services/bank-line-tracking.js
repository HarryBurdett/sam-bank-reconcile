/**
 * Build the (date|amount) → tracking map for one bank statement.
 * Best-effort: any error short-circuits to an empty map and the
 * matcher falls back to Opera-only findDuplicates.
 */
export async function buildBankLineTracking(input) {
    const out = new Map();
    const { appDb, bankCode, scopeAnchor, toleranceDays = 7 } = input;
    if (!appDb || !scopeAnchor)
        return out;
    const anchorMs = Date.parse(scopeAnchor);
    if (!Number.isFinite(anchorMs))
        return out;
    try {
        const lo = new Date(anchorMs - toleranceDays * 86400000)
            .toISOString()
            .slice(0, 10);
        const hi = new Date(anchorMs + toleranceDays * 86400000)
            .toISOString()
            .slice(0, 10);
        const stored = (await appDb('bank_statement_transactions')
            .join('bank_statement_imports', 'bank_statement_transactions.import_id', 'bank_statement_imports.id')
            .where('bank_statement_imports.bank_code', bankCode)
            .andWhere('bank_statement_imports.statement_date', '>=', lo)
            .andWhere('bank_statement_imports.statement_date', '<=', hi)
            .select('bank_statement_transactions.post_date as post_date', 'bank_statement_transactions.amount as amount', 'bank_statement_transactions.posted_entry_number as posted_entry_number', 'bank_statement_transactions.is_reconciled as is_reconciled'));
        for (const row of stored) {
            const ymd = row.post_date instanceof Date
                ? row.post_date.toISOString().slice(0, 10)
                : String(row.post_date ?? '').slice(0, 10);
            if (!ymd)
                continue;
            const amt = Number(row.amount ?? 0);
            const key = `${ymd}|${amt.toFixed(2)}`;
            const pen = (row.posted_entry_number ?? '').trim() || null;
            const reconciled = !!row.is_reconciled;
            const existing = out.get(key);
            if (!existing) {
                out.set(key, {
                    posted_entry_number: pen,
                    is_reconciled: reconciled,
                    count: 1,
                });
            }
            else {
                // Multiple stored rows share this (date, amount) — ambiguous.
                // Increment count; callers gate on count === 1 before trusting
                // the override. We still OR-in the flags so a reconciled twin
                // can be reported through other channels if needed.
                existing.count += 1;
                if (pen && !existing.posted_entry_number) {
                    existing.posted_entry_number = pen;
                }
                if (reconciled)
                    existing.is_reconciled = true;
            }
        }
    }
    catch {
        // Tracking lookup is best-effort; fall through to Opera-only
        // findDuplicates if anything goes wrong.
        return out;
    }
    return out;
}
/**
 * Standard (date, amount) key used everywhere `BankLineTrackingMap`
 * is indexed. Centralised so callers don't drift on formatting.
 */
export function bankLineTrackingKey(dateYmd, amountPounds) {
    return `${dateYmd.slice(0, 10)}|${Number(amountPounds ?? 0).toFixed(2)}`;
}
//# sourceMappingURL=bank-line-tracking.js.map
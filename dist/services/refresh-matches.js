import { findDuplicates } from './duplicate-detection.js';
export async function refreshMatches(operaDb, bankCode, transactions, opts = {}) {
    const threshold = opts.posted_threshold ?? 0.85;
    if (!Array.isArray(transactions) || transactions.length === 0) {
        return {
            success: true,
            transactions: [],
            matched_count: 0,
            total: 0,
            message: 'no transactions',
        };
    }
    try {
        const out = [];
        let matched = 0;
        for (const t of transactions) {
            const name = (t.name ?? t.description ?? '');
            const date = t.date ?? new Date().toISOString().slice(0, 10);
            const candidates = await findDuplicates(operaDb, {
                name,
                amount: Number(t.amount ?? 0),
                date,
                bank_code: bankCode,
                account: (t.matched_account ?? null),
                fit_id: (t.fit_id ?? null),
                reference: (t.reference ?? null),
            });
            const top = candidates.find((c) => c.confidence >= threshold);
            const isPosted = !!top;
            if (isPosted)
                matched += 1;
            const skipReason = top
                ? `already posted: ${top.table}.${top.record_id} (${top.match_type})`
                : (t.skip_reason ?? '');
            const action = isPosted ? 'skip' : (t.action ?? '');
            out.push({
                ...t,
                is_duplicate: isPosted,
                skip_reason: String(skipReason ?? ''),
                action: String(action ?? ''),
            });
        }
        return {
            success: true,
            transactions: out,
            matched_count: matched,
            total: transactions.length,
            message: `${matched} transaction(s) now matched to Opera entries`,
        };
    }
    catch (err) {
        return {
            success: false,
            transactions: [],
            matched_count: 0,
            total: transactions.length,
            error: err?.message ?? String(err),
        };
    }
}
//# sourceMappingURL=refresh-matches.js.map
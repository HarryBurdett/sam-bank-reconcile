import { lookupRepeatEntryAlias } from './bank-aliases.js';
const NO_MATCH = {
    is_match: false,
    entry_ref: '',
    entry_desc: '',
    next_post_date: null,
    posted: 0,
    topost: 0,
    freq: '',
    every: 1,
    match_kind: 'none',
};
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
function withinToleranceDays(txnDate, nextPostDate, toleranceDays = 10) {
    if (!nextPostDate)
        return true; // no date to compare against — accept
    const t = Date.parse(`${txnDate}T00:00:00Z`);
    const n = Date.parse(`${nextPostDate}T00:00:00Z`);
    if (!Number.isFinite(t) || !Number.isFinite(n))
        return true;
    return t >= n - toleranceDays * 86_400_000;
}
async function validateAliasMatch(operaDb, entryRef, bankCode) {
    try {
        const row = (await operaDb('arhead')
            .select('ae_entry', 'ae_desc', 'ae_nxtpost', 'ae_freq', 'ae_every', 'ae_posted', 'ae_topost')
            .where('ae_entry', entryRef)
            .andWhereRaw('RTRIM(ae_acnt) = ?', [bankCode])
            .andWhere(function unposted() {
            this.where('ae_topost', 0).orWhereRaw('ae_posted < ae_topost');
        })
            .first());
        return row ?? null;
    }
    catch {
        return null;
    }
}
function buildMatch(row, kind) {
    return {
        is_match: true,
        entry_ref: (row.ae_entry ?? '').toString().trim(),
        entry_desc: (row.ae_desc ?? '').toString().trim(),
        next_post_date: dateToYmd(row.ae_nxtpost),
        posted: Number(row.ae_posted ?? 0),
        topost: Number(row.ae_topost ?? 0),
        freq: (row.ae_freq ?? '').toString().trim().toUpperCase(),
        every: Number(row.ae_every ?? 1) || 1,
        match_kind: kind,
    };
}
function escapeLike(s) {
    // Opera uses MSSQL LIKE — escape the wildcards and brackets so
    // a literal '%' in a payee doesn't act as a wildcard. FoxPro LIKE
    // also accepts these in a forgiving fashion (it ignores [] entirely
    // but doesn't error). Same approach as legacy audit 2026-05-05 F9.
    return s.replace(/'/g, "''").replace(/\[/g, '[[]').replace(/%/g, '[%]').replace(/_/g, '[_]');
}
export async function checkRepeatEntry(operaDb, appDb, txn) {
    // === Phase 1 — alias fast-path ===
    if (appDb) {
        try {
            const alias = await lookupRepeatEntryAlias(appDb, txn.name, txn.bankCode);
            if (alias?.entry_ref) {
                const row = await validateAliasMatch(operaDb, alias.entry_ref, txn.bankCode);
                if (row) {
                    const nextDate = dateToYmd(row.ae_nxtpost);
                    if (withinToleranceDays(txn.date, nextDate)) {
                        return buildMatch(row, 'alias');
                    }
                }
            }
        }
        catch {
            // fall through to scan
        }
    }
    // === Phase 2 — amount / reference scan ===
    try {
        const amountPenceAbs = Math.abs(Math.round(Number(txn.amountPounds) * 100));
        // Build search terms from name/reference/memo (≥3 chars, first 3 words each).
        const searchTerms = [];
        for (const text of [txn.name, txn.reference, txn.memo]) {
            if (text && text.trim().length >= 3) {
                const escaped = escapeLike(text.trim().toUpperCase());
                const words = escaped.split(/\s+/).filter((w) => w.length >= 3);
                searchTerms.push(...words.slice(0, 3));
            }
        }
        const terms = searchTerms.slice(0, 5);
        let query = operaDb({ h: 'arhead' })
            .join({ l: 'arline' }, function joinHL() {
            this.on('h.ae_entry', '=', 'l.at_entry').andOn('h.ae_acnt', '=', 'l.at_acnt');
        })
            .select('h.ae_entry', 'h.ae_desc', 'h.ae_nxtpost', 'h.ae_freq', 'h.ae_every', 'h.ae_posted', 'h.ae_topost', 'l.at_value', 'l.at_comment')
            .whereRaw('RTRIM(h.ae_acnt) = ?', [txn.bankCode])
            .andWhere(function unposted() {
            this.where('h.ae_topost', 0).orWhereRaw('h.ae_posted < h.ae_topost');
        });
        if (terms.length > 0) {
            query = query.andWhere(function matchAmountOrTerms() {
                // Strict integer-pence equality. Accounting amounts have no
                // tolerance — £54.99 ≠ £55.00, ever. Both at_value (Opera)
                // and amountPenceAbs (bank line via Math.round) are
                // integers, so SQL `=` is the right operator.
                this.whereRaw('ABS(l.at_value) = ?', [amountPenceAbs]);
                for (const t of terms) {
                    this.orWhereRaw(`UPPER(h.ae_desc) LIKE '%${t}%'`)
                        .orWhereRaw(`UPPER(l.at_comment) LIKE '%${t}%'`);
                }
            });
        }
        else {
            query = query.andWhereRaw('ABS(l.at_value) = ?', [amountPenceAbs]);
        }
        const rows = (await query.limit(20));
        if (!rows.length)
            return NO_MATCH;
        // Score in JS: amount-match > ref-match; then date proximity.
        const txnTs = Date.parse(`${txn.date}T00:00:00Z`);
        const scored = rows.map((r) => {
            // Strict integer-pence equality — same rule as the SQL filter.
            // No tolerance: accounting amounts must match exactly.
            const amountMatch = Math.abs(Number(r.at_value)) === amountPenceAbs;
            const desc = (r.ae_desc ?? '').toString().toUpperCase();
            const comment = (r.at_comment ?? '').toString().toUpperCase();
            let refMatch = false;
            for (const t of terms) {
                if (desc.includes(t) || comment.includes(t)) {
                    refMatch = true;
                    break;
                }
            }
            const nextTs = (() => {
                const d = dateToYmd(r.ae_nxtpost);
                if (!d)
                    return Number.POSITIVE_INFINITY;
                const ts = Date.parse(`${d}T00:00:00Z`);
                return Number.isFinite(ts) ? ts : Number.POSITIVE_INFINITY;
            })();
            const dateGap = Number.isFinite(txnTs) ? Math.abs(nextTs - txnTs) : 0;
            return { row: r, amountMatch, refMatch, dateGap };
        });
        scored.sort((a, b) => {
            // Amount-match preferred over ref-match
            if (a.amountMatch !== b.amountMatch)
                return a.amountMatch ? -1 : 1;
            // Then closest date
            return a.dateGap - b.dateGap;
        });
        const best = scored[0];
        // Finance-grade gate: a repeat match requires the bank line's
        // amount to equal the Opera repeat's amount EXACTLY (within
        // float-safe pence). A reference-only hit with a different
        // amount is by definition a different transaction — even if
        // the payee text overlaps. The user might have e.g. "Card
        // Payment to Amazon" matching a different £-value repeat;
        // we must not classify that as a repeat.
        if (!best.amountMatch)
            return NO_MATCH;
        const nextDate = dateToYmd(best.row.ae_nxtpost);
        if (!withinToleranceDays(txn.date, nextDate))
            return NO_MATCH;
        // All matches at this point are amount-exact (the guard above
        // rejected anything else). The kind stays 'amount' regardless
        // of whether the reference also overlapped — they're treated
        // the same downstream.
        return buildMatch(best.row, 'amount');
    }
    catch {
        return NO_MATCH;
    }
}
//# sourceMappingURL=check-repeat-entry.js.map
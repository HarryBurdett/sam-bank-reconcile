import { validateBankCode, SqlInputValidationError, } from '../_shared/index.js';
import { getPeriodPostingDecision, } from './period-posting-decision.js';
import { getRecurringEntriesMode } from './settings.js';
// Recurring-entry header types (ae_type). Faithful port of the
// TYPE_DESCRIPTIONS map from api/main.py.
const TYPE_DESCRIPTIONS = {
    1: 'Nominal Payment',
    2: 'Nominal Receipt',
    3: 'Sales Refund',
    4: 'Sales Receipt',
    5: 'Purchase Payment',
    6: 'Purchase Refund',
};
// Frequency code descriptions for the UI.
const FREQ_DESCRIPTIONS = {
    D: 'Daily',
    W: 'Weekly',
    M: 'Monthly',
    Q: 'Quarterly',
    Y: 'Yearly',
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
function ymdToDate(ymd) {
    // Build at midnight UTC so the arithmetic helpers below stay stable
    // regardless of the host's local timezone.
    return new Date(`${ymd}T00:00:00Z`);
}
function dateToYmdUtc(d) {
    return d.toISOString().slice(0, 10);
}
/**
 * Add `n` months to a UTC date, clamping the day-of-month to the
 * length of the target month (so 31 Jan + 1 month → 28/29 Feb). Mirrors
 * Python's `dateutil.relativedelta` clamp.
 */
function addMonthsUtc(d, n) {
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const day = d.getUTCDate();
    const targetMonth = m + n;
    const targetYear = y + Math.floor(targetMonth / 12);
    const normMonth = ((targetMonth % 12) + 12) % 12;
    // Last day of target month
    const lastDay = new Date(Date.UTC(targetYear, normMonth + 1, 0)).getUTCDate();
    return new Date(Date.UTC(targetYear, normMonth, Math.min(day, lastDay)));
}
function addDaysUtc(d, n) {
    return new Date(d.getTime() + n * 86_400_000);
}
/**
 * Generate every outstanding posting date from `nxtPostYmd` up to
 * (and including) today, respecting the frequency / every / remaining
 * iterations from arhead. Mirrors `_outstanding_dates`
 * (api/main.py:10423-10445).
 *
 * Safety cap: when `total === 0` (unlimited), we still cap at 24
 * iterations so a misconfigured very-old start date can't produce
 * thousands of rows.
 */
function outstandingDates(nxtPostYmd, freq, every, posted, total, todayYmd) {
    const dates = [];
    let current = ymdToDate(nxtPostYmd);
    const todayMs = ymdToDate(todayYmd).getTime();
    const maxRemaining = total > 0 ? Math.max(0, total - posted) : 24;
    const fu = (freq ?? '').toUpperCase().trim();
    const step = Math.max(1, every || 1);
    let safety = 0;
    while (current.getTime() <= todayMs && dates.length < maxRemaining) {
        dates.push(dateToYmdUtc(current));
        if (fu === 'D') {
            current = addDaysUtc(current, step);
        }
        else if (fu === 'W') {
            current = addDaysUtc(current, 7 * step);
        }
        else if (fu === 'M') {
            current = addMonthsUtc(current, step);
        }
        else if (fu === 'Q') {
            current = addMonthsUtc(current, 3 * step);
        }
        else if (fu === 'Y') {
            current = addMonthsUtc(current, 12 * step);
        }
        else {
            // Unknown freq — default to months, mirroring legacy fallback.
            current = addMonthsUtc(current, step);
        }
        if (++safety > 240)
            break; // hard safety
    }
    return dates;
}
function ledgerTypeForAeType(aeType) {
    if (aeType === 3 || aeType === 4)
        return 'SL';
    if (aeType === 5 || aeType === 6)
        return 'PL';
    return 'NL';
}
/**
 * Look up display-friendly account descriptions for the set of
 * nominal / customer / supplier accounts referenced by the lines.
 * Best-effort: any join failure leaves the affected codes mapped to ''.
 */
async function loadAccountDescriptions(operaDb, nominalCodes, customerCodes, supplierCodes) {
    const out = new Map();
    const fetchInto = async (table, codeCol, descCol, codes) => {
        if (codes.size === 0)
            return;
        try {
            // Knex's typed `.whereIn(raw, list)` overload is finicky; use
            // whereRaw with placeholders to stay backend-portable
            // (MSSQL/sqlite both accept `RTRIM(x) IN (?, ?, …)`).
            const list = Array.from(codes);
            const placeholders = list.map(() => '?').join(',');
            const rows = (await operaDb(table)
                .select(operaDb.raw(`RTRIM(${codeCol}) AS code`), operaDb.raw(`RTRIM(${descCol}) AS description`))
                .whereRaw(`RTRIM(${codeCol}) IN (${placeholders})`, list));
            for (const r of rows) {
                const c = (r.code ?? '').toString().trim();
                const d = (r.description ?? '').toString().trim();
                if (c)
                    out.set(c, d);
            }
        }
        catch {
            // table missing or perms — leave codes without descriptions
        }
    };
    await Promise.all([
        fetchInto('nacnt', 'na_acnt', 'na_desc', nominalCodes),
        fetchInto('sname', 'sn_account', 'sn_name', customerCodes),
        fetchInto('pname', 'pn_account', 'pn_name', supplierCodes),
    ]);
    return out;
}
/**
 * Find all active recurring entries on this bank that are due
 * (ae_nxtpost <= today), expand each into its outstanding posting
 * dates, validate each date against the period gates, and return the
 * full UI shape.
 *
 * Read-only: no Opera writes. Safe to call before the operator has
 * made any decisions.
 */
export async function checkRecurringEntries(operaDb, appDb, bankCode) {
    let bc;
    try {
        bc = validateBankCode(bankCode);
    }
    catch (e) {
        if (e instanceof SqlInputValidationError) {
            return { success: false, error: e.message };
        }
        throw e;
    }
    // Mode default = 'process' when settings table unavailable.
    let mode = 'process';
    if (appDb) {
        try {
            const m = await getRecurringEntriesMode(appDb);
            if (m.success)
                mode = m.mode;
        }
        catch {
            // ignore; mode stays 'process'
        }
    }
    // "Today" is computed server-side and bound as a parameter rather
    // than calling MSSQL's GETDATE(). That keeps the query portable to
    // sqlite (used by the test harness) and lets future tests inject a
    // fake clock. We pass YYYY-MM-DD; MSSQL coerces it to datetime for
    // comparison against ae_nxtpost.
    const today = dateToYmdUtc(new Date());
    let rows = [];
    try {
        rows = (await operaDb.raw(`SELECT
         h.ae_entry, h.ae_type, h.ae_desc,
         h.ae_freq, h.ae_every, h.ae_nxtpost, h.ae_lstpost,
         h.ae_posted, h.ae_topost, h.ae_vatanal,
         l.at_line, RTRIM(l.at_account) AS at_account,
         RTRIM(l.at_cbtype) AS at_cbtype,
         l.at_value, RTRIM(l.at_entref) AS at_entref, l.at_comment,
         RTRIM(l.at_project) AS at_project, RTRIM(l.at_job) AS at_job,
         l.at_vatcde, l.at_vatval,
         (SELECT COUNT(*) FROM arline l2            WHERE l2.at_entry = h.ae_entry AND l2.at_acnt = h.ae_acnt) AS line_count
       FROM arhead h       JOIN arline l         ON l.at_entry = h.ae_entry AND l.at_acnt = h.ae_acnt
       WHERE RTRIM(h.ae_acnt) = ?
         AND (h.ae_topost = 0 OR h.ae_posted < h.ae_topost)
         AND h.ae_nxtpost <= ?
       ORDER BY h.ae_nxtpost ASC`, [bc, today]));
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
    if (!Array.isArray(rows) || rows.length === 0) {
        return {
            success: true,
            mode,
            entries: [],
            total_due: 0,
            postable_count: 0,
            blocked_count: 0,
        };
    }
    // Description lookups: nominal accounts always; customers when any
    // ae_type ∈ {3,4}; suppliers when any ae_type ∈ {5,6}.
    const nominalCodes = new Set();
    const customerCodes = new Set();
    const supplierCodes = new Set();
    for (const r of rows) {
        const acct = (r.at_account ?? '').toString().trim();
        if (!acct)
            continue;
        nominalCodes.add(acct);
        const t = Number(r.ae_type ?? 0);
        if (t === 3 || t === 4)
            customerCodes.add(acct);
        else if (t === 5 || t === 6)
            supplierCodes.add(acct);
    }
    const accountDescs = await loadAccountDescriptions(operaDb, nominalCodes, customerCodes, supplierCodes);
    // Group rows by ae_entry — the JOIN produces one row per arline.
    const grouped = new Map();
    for (const r of rows) {
        const ref = (r.ae_entry ?? '').toString().trim();
        if (!ref)
            continue;
        let g = grouped.get(ref);
        if (!g) {
            g = { header: r, lines: [] };
            grouped.set(ref, g);
        }
        g.lines.push(r);
    }
    const entries = [];
    let postableCount = 0;
    let blockedCount = 0;
    for (const [entryRef, group] of grouped) {
        const h = group.header;
        const lines = group.lines;
        const aeType = Number(h.ae_type ?? 0);
        const freq = (h.ae_freq ?? '').toString().trim();
        const aeEvery = Number(h.ae_every ?? 1) || 1;
        const aePosted = Number(h.ae_posted ?? 0);
        const aeTopost = Number(h.ae_topost ?? 0);
        const nxt = dateToYmd(h.ae_nxtpost);
        const totalAmountPence = lines.reduce((acc, l) => acc + Math.abs(Number(l.at_value ?? 0)), 0);
        const totalAmountPounds = Math.round((totalAmountPence / 100) * 100) / 100; // round to 2dp
        const lineCount = lines.length;
        const firstLine = lines[0];
        const firstAccount = (firstLine.at_account ?? '').toString().trim();
        const firstVatCode = (firstLine.at_vatcde ?? '').toString().trim();
        const firstVatVal = Number(firstLine.at_vatval ?? 0);
        const lineDetails = lines.map((l) => {
            const acct = (l.at_account ?? '').toString().trim();
            const lValue = Number(l.at_value ?? 0);
            return {
                account: acct,
                account_desc: accountDescs.get(acct) ?? '',
                amount_pence: lValue,
                amount_pounds: Math.round((Math.abs(lValue) / 100) * 100) / 100,
                vat_code: (l.at_vatcde ?? '').toString().trim(),
                vat_amount_pence: Number(l.at_vatval ?? 0),
                project: (l.at_project ?? '').toString().trim(),
                department: (l.at_job ?? '').toString().trim(),
                comment: (l.at_comment ?? '').toString().trim(),
            };
        });
        const description = (h.ae_desc ?? '').toString().trim() ||
            (firstLine.at_entref ?? '').toString().trim();
        // Outstanding-date expansion — surfaces every missed cycle, not
        // just the most recent one. If somehow there are no outstanding
        // dates (e.g. ae_nxtpost null), fall back to a single row with
        // null date so the operator still sees the entry.
        const outstanding = nxt
            ? outstandingDates(nxt, freq, aeEvery, aePosted, aeTopost, today)
            : [];
        const dateList = outstanding.length > 0 ? outstanding : [nxt];
        for (const postDate of dateList) {
            let canPost = true;
            let blockedReason = null;
            if (![1, 2, 3, 4, 5, 6].includes(aeType)) {
                canPost = false;
                blockedReason = `Type ${aeType} (${TYPE_DESCRIPTIONS[aeType] ?? 'Unknown'}) — process in Opera`;
            }
            else if (postDate) {
                try {
                    const decision = await getPeriodPostingDecision(operaDb, postDate, ledgerTypeForAeType(aeType));
                    if (!decision.canPost) {
                        canPost = false;
                        blockedReason = decision.errorMessage || 'Period is blocked';
                    }
                }
                catch (pe) {
                    canPost = false;
                    blockedReason = `Period validation error: ${pe?.message ?? String(pe)}`;
                }
            }
            if (canPost)
                postableCount += 1;
            else
                blockedCount += 1;
            const compositeRef = dateList.length > 1 && postDate ? `${entryRef}:${postDate}` : entryRef;
            entries.push({
                entry_ref: compositeRef,
                base_entry_ref: entryRef,
                type: aeType,
                type_desc: TYPE_DESCRIPTIONS[aeType] ?? `Type ${aeType}`,
                description,
                account: firstAccount,
                account_desc: accountDescs.get(firstAccount) ?? '',
                cbtype: (firstLine.at_cbtype ?? '').toString().trim(),
                amount_pence: totalAmountPence,
                amount_pounds: totalAmountPounds,
                next_post_date: postDate,
                posted_count: aePosted,
                total_posts: aeTopost,
                frequency: FREQ_DESCRIPTIONS[freq] ?? freq,
                project: (firstLine.at_project ?? '').toString().trim(),
                department: (firstLine.at_job ?? '').toString().trim(),
                can_post: canPost,
                blocked_reason: blockedReason,
                comment: (firstLine.at_comment ?? '').toString().trim(),
                vat_code: firstVatCode,
                vat_amount_pence: firstVatVal,
                line_count: lineCount,
                lines: lineDetails,
            });
        }
    }
    return {
        success: true,
        mode,
        entries,
        total_due: entries.length,
        postable_count: postableCount,
        blocked_count: blockedCount,
    };
}
//# sourceMappingURL=check-recurring-entries.js.map
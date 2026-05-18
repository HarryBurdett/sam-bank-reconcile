import { validateBankCode, validateEntryNumber, SqlInputValidationError, getControlAccounts, } from '../_shared/index.js';
import { executeWithDeadlockRetry } from '../_shared/deadlock-retry.js';
import { getPeriodPostingDecision, } from './period-posting-decision.js';
import { _postOneTransaction_internal as postOneTransaction, _postNominalEntry_internal as postNominalEntry, _dateAsYmd_internal as dateAsYmd, } from './import-posting-executor.js';
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
function ymdToUtcDate(ymd) {
    return new Date(`${ymd}T00:00:00Z`);
}
function addMonthsUtc(d, n) {
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const day = d.getUTCDate();
    const target = m + n;
    const ty = y + Math.floor(target / 12);
    const nm = ((target % 12) + 12) % 12;
    const lastDay = new Date(Date.UTC(ty, nm + 1, 0)).getUTCDate();
    return new Date(Date.UTC(ty, nm, Math.min(day, lastDay)));
}
function advanceByFrequency(from, freq, every) {
    const f = (freq ?? '').toUpperCase().trim();
    const step = Math.max(1, every || 1);
    if (f === 'D')
        return new Date(from.getTime() + step * 86_400_000);
    if (f === 'W')
        return new Date(from.getTime() + 7 * step * 86_400_000);
    if (f === 'M')
        return addMonthsUtc(from, step);
    if (f === 'Q')
        return addMonthsUtc(from, 3 * step);
    if (f === 'Y')
        return addMonthsUtc(from, 12 * step);
    // Unknown frequency — match legacy fallback (monthly).
    return addMonthsUtc(from, step);
}
const AE_TYPE_TO_ACTION = {
    1: 'nominal_payment',
    2: 'nominal_receipt',
    3: 'sales_refund',
    4: 'sales_receipt',
    5: 'purchase_payment',
    6: 'purchase_refund',
};
const AE_TYPE_NAMES = {
    1: 'Nominal Payment',
    2: 'Nominal Receipt',
    3: 'Sales Refund',
    4: 'Sales Receipt',
    5: 'Purchase Payment',
    6: 'Purchase Refund',
};
function ledgerForAeType(aeType) {
    if (aeType === 3 || aeType === 4)
        return 'SL';
    if (aeType === 5 || aeType === 6)
        return 'PL';
    return 'NL';
}
/**
 * Split a composite key. Plain refs return `{ ref, date: null }`.
 * Composite refs (`REC0000002:2026-05-15`) return both parts.
 */
function parseCompositeRef(raw) {
    const trimmed = raw.trim();
    const sep = trimmed.lastIndexOf(':');
    if (sep < 0)
        return { ref: trimmed, dateFromKey: null };
    const datePart = trimmed.slice(sep + 1);
    if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
        return { ref: trimmed.slice(0, sep), dateFromKey: datePart };
    }
    return { ref: trimmed, dateFromKey: null };
}
/**
 * Post a single recurring entry. Atomic — either the aentry+atran
 * are created AND arhead is advanced, or neither (transaction
 * rollback).
 */
export async function postRecurringEntry(operaDb, input) {
    // ------------------------------------------------------------------
    // Validate inputs
    // ------------------------------------------------------------------
    let bankCode;
    let entryRef;
    let dateFromKey = null;
    try {
        bankCode = validateBankCode(input.bankCode);
        const parsed = parseCompositeRef(input.entryRef);
        dateFromKey = parsed.dateFromKey;
        entryRef = validateEntryNumber(parsed.ref);
    }
    catch (e) {
        if (e instanceof SqlInputValidationError) {
            return { success: false, entry_ref: input.entryRef, error: e.message };
        }
        throw e;
    }
    const inputBy = (input.inputBy ?? 'RECUR').slice(0, 8);
    // ------------------------------------------------------------------
    // Read arhead + arline (outside transaction; read-only)
    // ------------------------------------------------------------------
    let headerRow = null;
    let lineRows = [];
    try {
        const heads = (await operaDb('arhead')
            .select('ae_entry', 'ae_acnt', 'ae_type', 'ae_desc', 'ae_freq', 'ae_every', 'ae_nxtpost', 'ae_lstpost', 'ae_posted', 'ae_topost', 'ae_vatanal')
            .whereRaw('RTRIM(ae_entry) = ?', [entryRef])
            .andWhereRaw('RTRIM(ae_acnt) = ?', [bankCode]));
        headerRow = heads[0] ?? null;
        if (!headerRow) {
            return {
                success: false,
                entry_ref: input.entryRef,
                error: `Recurring entry ${entryRef} not found for bank ${bankCode}`,
            };
        }
        lineRows = (await operaDb('arline')
            .select('at_line', 'at_account', 'at_cbtype', 'at_value', 'at_entref', 'at_comment', 'at_project', 'at_job', 'at_vatcde', 'at_vatval')
            .whereRaw('RTRIM(at_entry) = ?', [entryRef])
            .andWhereRaw('RTRIM(at_acnt) = ?', [bankCode])
            .orderBy('at_line', 'asc'));
        if (lineRows.length === 0) {
            return {
                success: false,
                entry_ref: input.entryRef,
                error: `No detail lines found for recurring entry ${entryRef}`,
            };
        }
    }
    catch (err) {
        return {
            success: false,
            entry_ref: input.entryRef,
            error: err?.message ?? String(err),
        };
    }
    const aeType = Number(headerRow.ae_type ?? 0);
    const aeDesc = (headerRow.ae_desc ?? '').toString().trim();
    const aeFreq = (headerRow.ae_freq ?? '').toString().trim();
    const aeEvery = Math.max(1, Number(headerRow.ae_every ?? 1) || 1);
    const aePosted = Number(headerRow.ae_posted ?? 0);
    const aeTopost = Number(headerRow.ae_topost ?? 0);
    const aeNxtpostYmd = dateToYmd(headerRow.ae_nxtpost);
    // ------------------------------------------------------------------
    // State checks
    // ------------------------------------------------------------------
    if (aeTopost !== 0 && aePosted >= aeTopost) {
        return {
            success: false,
            entry_ref: input.entryRef,
            error: `Recurring entry ${entryRef} is exhausted (${aePosted}/${aeTopost} posted)`,
        };
    }
    const action = AE_TYPE_TO_ACTION[aeType];
    if (!action) {
        return {
            success: false,
            entry_ref: input.entryRef,
            error: `Unsupported recurring entry type ${aeType} — process in Opera`,
        };
    }
    // ------------------------------------------------------------------
    // Multi-line fallback
    // ------------------------------------------------------------------
    if (lineRows.length > 1) {
        return {
            success: false,
            entry_ref: input.entryRef,
            error: `Recurring entry ${entryRef} has ${lineRows.length} lines. ` +
                `Multi-line recurring entries must be posted from ` +
                `Opera Cashbook → Repeat Entries → Post.`,
        };
    }
    const line = lineRows[0];
    // ------------------------------------------------------------------
    // Determine posting date
    // ------------------------------------------------------------------
    const postDate = (input.overrideDate && /^\d{4}-\d{2}-\d{2}$/.test(input.overrideDate)
        ? input.overrideDate
        : null) ||
        dateFromKey ||
        aeNxtpostYmd;
    if (!postDate || !/^\d{4}-\d{2}-\d{2}$/.test(postDate)) {
        return {
            success: false,
            entry_ref: input.entryRef,
            error: `Recurring entry ${entryRef} has no posting date`,
        };
    }
    // ------------------------------------------------------------------
    // Period-posting validation
    // ------------------------------------------------------------------
    let decision;
    try {
        decision = await getPeriodPostingDecision(operaDb, postDate, ledgerForAeType(aeType));
    }
    catch (err) {
        return {
            success: false,
            entry_ref: input.entryRef,
            error: `Period validation failed: ${err?.message ?? String(err)}`,
        };
    }
    if (!decision.canPost) {
        return {
            success: false,
            entry_ref: input.entryRef,
            error: decision.errorMessage ?? 'Period closed for posting',
        };
    }
    // ------------------------------------------------------------------
    // Control accounts
    // ------------------------------------------------------------------
    let defaults;
    try {
        const ctrl = await getControlAccounts(operaDb);
        defaults = {
            sl_control: ctrl.debtorsControl,
            pl_control: ctrl.creditorsControl,
        };
    }
    catch (err) {
        return {
            success: false,
            entry_ref: input.entryRef,
            error: `Control-account lookup failed: ${err?.message ?? String(err)}`,
        };
    }
    // ------------------------------------------------------------------
    // Build PreparedTransaction. Sign convention matches the bank-import
    // flow: receipts +ve, payments -ve.
    // ------------------------------------------------------------------
    const isReceipt = aeType === 2 || aeType === 4 || aeType === 6;
    const grossPence = Math.abs(Number(line.at_value ?? 0));
    const grossPounds = grossPence / 100;
    const signedAmount = isReceipt ? grossPounds : -grossPounds;
    const reference = (line.at_entref ?? '').trim() || aeDesc;
    const memo = (line.at_comment ?? '').trim() || aeDesc;
    const cbtype = (line.at_cbtype ?? '').trim() ||
        (aeType === 2 ? 'NR' : 'NP');
    const vatCodeRaw = (line.at_vatcde ?? '').trim();
    const vatVal = Number(line.at_vatval ?? 0);
    const hasVat = vatCodeRaw.length > 0 &&
        !['0', 'N', 'Z', 'E'].includes(vatCodeRaw.toUpperCase()) &&
        Math.abs(vatVal) > 0;
    const prepared = {
        index: 1,
        date: dateAsYmd(postDate),
        amount: signedAmount,
        name: aeDesc,
        memo,
        action,
        matchedAccount: (line.at_account ?? '').trim() || null,
        cbtype,
        reference: reference.slice(0, 20),
        vatCode: hasVat ? vatCodeRaw : null,
        netAmount: null, // executor recomputes from rate
    };
    if (!prepared.matchedAccount) {
        return {
            success: false,
            entry_ref: input.entryRef,
            error: `Recurring entry ${entryRef} line has no at_account`,
        };
    }
    // ------------------------------------------------------------------
    // Atomic post: aentry + atran + ntran/anoml + stran/ptran (if any) +
    // VAT (if any) + arhead advancement. Deadlock-retry mirrors the
    // bank-import flow's policy.
    // ------------------------------------------------------------------
    let entryNumber = null;
    try {
        await executeWithDeadlockRetry(operaDb, async (trx) => {
            let result;
            if (action === 'nominal_payment' || action === 'nominal_receipt') {
                result = await postNominalEntry({
                    trx,
                    bankCode,
                    txn: prepared,
                    defaults,
                    decision,
                });
            }
            else {
                result = await postOneTransaction({
                    trx,
                    bankCode,
                    txn: prepared,
                    defaults,
                    decision,
                });
            }
            entryNumber = result.entry_number;
            // Advance the schedule. Mirrors legacy
            // `_advance_recurring_entry_in_txn`:
            //   1. ae_posted += 1
            //   2. ae_lstpost = post_date
            //   3. ae_nxtpost = first cycle AFTER post_date (skips intervening
            //      occurrences if the operator posted late)
            const currentNxtYmd = aeNxtpostYmd ?? postDate;
            let nextDate = ymdToUtcDate(currentNxtYmd);
            const postDateUtc = ymdToUtcDate(postDate);
            // Cap the loop — a misconfigured very-old start could otherwise
            // iterate forever. 480 covers 40 years of monthly cycles.
            for (let i = 0; i < 480 && nextDate.getTime() <= postDateUtc.getTime(); i++) {
                nextDate = advanceByFrequency(nextDate, aeFreq, aeEvery);
            }
            const newNxtYmd = nextDate.toISOString().slice(0, 10);
            await trx('arhead')
                .whereRaw('RTRIM(ae_entry) = ?', [entryRef])
                .andWhereRaw('RTRIM(ae_acnt) = ?', [bankCode])
                .update({
                ae_posted: trx.raw('ae_posted + 1'),
                ae_lstpost: postDate,
                ae_nxtpost: newNxtYmd,
                sq_amdate: trx.raw('CONVERT(DATE, GETDATE())'),
                sq_amtime: trx.raw('CONVERT(TIME, GETDATE())'),
                sq_amuser: inputBy,
            });
        });
    }
    catch (err) {
        return {
            success: false,
            entry_ref: input.entryRef,
            error: err?.message ?? String(err),
        };
    }
    if (!entryNumber) {
        return {
            success: false,
            entry_ref: input.entryRef,
            error: 'Post completed without returning an entry number',
        };
    }
    const typeName = AE_TYPE_NAMES[aeType] ?? `Type ${aeType}`;
    return {
        success: true,
        entry_ref: input.entryRef,
        entry_number: entryNumber,
        message: `Posted recurring ${typeName}: ${entryRef} → entry ${entryNumber}`,
        warnings: [
            `Amount: £${grossPounds.toFixed(2)}`,
            `Posted on ${postDate}; next cycle bumped in arhead`,
        ],
    };
}
/**
 * Batch wrapper — posts each entry in turn, collecting per-entry
 * results. Continues on individual failures so the operator can see
 * which succeeded and which need attention.
 */
export async function postRecurringEntriesBatch(operaDb, input) {
    if (!input.bankCode || !input.bankCode.trim()) {
        return {
            success: false,
            results: [],
            posted_count: 0,
            failed_count: 0,
            error: 'bank_code is required',
        };
    }
    if (!Array.isArray(input.entries) || input.entries.length === 0) {
        return {
            success: false,
            results: [],
            posted_count: 0,
            failed_count: 0,
            error: 'No entries to post',
        };
    }
    const results = [];
    let posted = 0;
    let failed = 0;
    for (const e of input.entries) {
        const r = await postRecurringEntry(operaDb, {
            bankCode: input.bankCode,
            entryRef: e.entry_ref,
            overrideDate: e.override_date ?? null,
            inputBy: input.inputBy,
        });
        results.push(r);
        if (r.success)
            posted += 1;
        else
            failed += 1;
    }
    return {
        success: posted > 0 || failed === 0,
        results,
        posted_count: posted,
        failed_count: failed,
    };
}
//# sourceMappingURL=post-recurring-entry.js.map
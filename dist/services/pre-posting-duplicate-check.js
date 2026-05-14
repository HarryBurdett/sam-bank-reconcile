const AT_TYPE_FOR_ACTION = {
    sales_receipt: 4,
    sales_refund: 3,
    purchase_payment: 5,
    purchase_refund: 6,
    nominal_payment: 1,
    nominal_receipt: 2,
    bank_transfer: 8,
};
/**
 * stran/ptran transaction-type for the LEDGER_ALLOCATION_TARGET
 * advisory check. Only refund actions have a meaningful ledger
 * counterpart (the credit-note row that this refund will allocate to).
 * Matches ACTION_TYPE_MAP in sql_rag/duplicate_check.py:72.
 */
const REFUND_LEDGER_TYPE_FOR_ACTION = {
    sales_refund: { table: 'stran', trtype: 'F' },
    purchase_refund: { table: 'ptran', trtype: 'F' },
};
function addDays(ymd, days) {
    const d = new Date(`${ymd.slice(0, 10)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}
/**
 * Type-blind atran lookup fallback. Faithful port of
 * `_is_already_posted_typeblind` (bank_import.py:1584). Looks for ANY
 * atran row on the bank with matching signed amount within ±7 days,
 * regardless of at_type. Catches:
 *   - Statements whose matcher couldn't classify the row (no action),
 *     so the type-aware check can't run at all.
 *   - Statements where the matcher picked the wrong type (e.g. action=
 *     purchase_payment / at_type=5 but Opera holds the entry as
 *     at_type=1 nominal_payment to that supplier's NL account — real
 *     example: Cloudsis BB005 April 2026 HISCOX DD P100000754).
 *
 * Sign-aware: signedPence carries the sign (negative = payment) and
 * is compared exactly to atran.at_value. Open-for-rec rule applies
 * (ae_reclnum = 0 AND ae_remove = 0).
 */
async function typeBlindAtranMatch(operaDb, bankCode, transactionDate, signedAmountPounds, excludeEntryNumbers = [], dateToleranceDays = 7) {
    const signedPence = Math.round(signedAmountPounds * 100);
    if (signedPence === 0)
        return { entryNumber: null, atType: null, postedDate: null };
    const dateFrom = addDays(transactionDate, -dateToleranceDays);
    const dateTo = addDays(transactionDate, dateToleranceDays);
    const excludeList = Array.from(excludeEntryNumbers)
        .map((e) => String(e).trim())
        .filter((e) => e.length > 0);
    let query = `
    SELECT TOP 1 t.at_entry AS ae_entry, t.at_pstdate AS pstdate, t.at_type AS at_type
    FROM atran t WITH (NOLOCK)
    JOIN aentry a WITH (NOLOCK)
      ON a.ae_entry = t.at_entry AND a.ae_acnt = t.at_acnt
    WHERE t.at_acnt = ?
      AND t.at_value = ?
      AND t.at_pstdate BETWEEN ? AND ?
      AND a.ae_reclnum = 0
      AND a.ae_remove = 0`;
    const bindings = [bankCode, signedPence, dateFrom, dateTo];
    if (excludeList.length > 0) {
        const placeholders = excludeList.map(() => '?').join(',');
        query += ` AND RTRIM(a.ae_entry) NOT IN (${placeholders})`;
        bindings.push(...excludeList);
    }
    query += ` ORDER BY ABS(DATEDIFF(day, t.at_pstdate, ?))`;
    bindings.push(transactionDate);
    try {
        const rows = (await operaDb.raw(query, bindings));
        if (Array.isArray(rows) && rows.length > 0) {
            const r = rows[0];
            const postedDate = r.pstdate instanceof Date
                ? r.pstdate.toISOString().slice(0, 10)
                : typeof r.pstdate === 'string'
                    ? r.pstdate.slice(0, 10)
                    : null;
            return {
                entryNumber: String(r.ae_entry ?? '').trim() || null,
                atType: r.at_type != null ? Number(r.at_type) : null,
                postedDate,
            };
        }
    }
    catch {
        // Tolerated — caller falls back to "no duplicate" on query failure.
    }
    return { entryNumber: null, atType: null, postedDate: null };
}
/**
 * Public entry point for the type-blind check. Use directly when the
 * matcher couldn't assign an action; the type-aware path calls it
 * internally as a fallback after a no-match return.
 */
export async function checkTypeBlindAtranMatch(args) {
    const hit = await typeBlindAtranMatch(args.operaDb, args.bankCode, args.transactionDate, args.signedAmountPounds, args.excludeEntryNumbers, args.dateToleranceDays ?? 7);
    if (hit.entryNumber) {
        return {
            isDuplicate: true,
            entryNumber: hit.entryNumber,
            reason: `Already in Opera as ${hit.entryNumber} ` +
                `(at_type=${hit.atType ?? '?'}, posted ${hit.postedDate ?? '?'}) ` +
                `— type-blind match on ${args.bankCode} ` +
                `${args.signedAmountPounds.toFixed(2)} ±${args.dateToleranceDays ?? 7}d`,
        };
    }
    return {
        isDuplicate: false,
        entryNumber: null,
        reason: `no type-blind cashbook match for ${args.bankCode} ` +
            `(${args.signedAmountPounds.toFixed(2)}, ${args.transactionDate})`,
    };
}
export async function checkCashbookDuplicateBeforePosting(args) {
    const { operaDb, bankCode, transactionDate, signedAmountPounds, action, excludeEntryNumbers, dateToleranceDays = 1, } = args;
    const expectedAtType = AT_TYPE_FOR_ACTION[action];
    if (!expectedAtType) {
        // Unknown action — treat as non-duplicate, matching the legacy
        // ValueError-tolerant wrapper at opera_sql_import.py:8170-8174.
        return {
            isDuplicate: false,
            entryNumber: null,
            reason: `unknown action ${action} — duplicate check skipped`,
        };
    }
    const dateFrom = addDays(transactionDate, -dateToleranceDays);
    const dateTo = addDays(transactionDate, dateToleranceDays);
    const signedPence = Math.round(signedAmountPounds * 100);
    const excludeList = Array.from(excludeEntryNumbers ?? [])
        .map((e) => String(e).trim())
        .filter((e) => e.length > 0);
    // Match opera_open_items.OPEN_FOR_REC_SQL: ae_reclnum = 0 AND ae_remove = 0.
    // Parameterised throughout for SQL injection safety (legacy used
    // string interpolation; we don't).
    let query = `
    SELECT TOP 5 a.at_entry AS ae_entry, a.at_value AS ae_value, a.at_type
    FROM atran a WITH (NOLOCK)
    JOIN aentry e WITH (NOLOCK)
      ON e.ae_entry = a.at_entry AND e.ae_acnt = a.at_acnt
    WHERE a.at_acnt = ?
      AND a.at_pstdate BETWEEN ? AND ?
      AND ABS(a.at_value - ?) < 1
      AND a.at_type = ?
      AND e.ae_reclnum = 0
      AND e.ae_remove = 0`;
    const bindings = [
        bankCode,
        dateFrom,
        dateTo,
        signedPence,
        expectedAtType,
    ];
    if (excludeList.length > 0) {
        const placeholders = excludeList.map(() => '?').join(',');
        query += ` AND RTRIM(e.ae_entry) NOT IN (${placeholders})`;
        bindings.push(...excludeList);
    }
    try {
        const rows = (await operaDb.raw(query, bindings));
        if (Array.isArray(rows) && rows.length > 0) {
            const r = rows[0];
            const entryNumber = String(r.ae_entry ?? '').trim() || null;
            return {
                isDuplicate: true,
                entryNumber,
                reason: `cashbook entry ${entryNumber} already posted ` +
                    `(at_type=${expectedAtType}, ae_value≈${signedPence}p) ` +
                    `on ${bankCode} in window ${dateFrom}..${dateTo}`,
            };
        }
    }
    catch (err) {
        // Tolerate query failures — they shouldn't block the post. The
        // legacy wrapper catches generic Exception (opera_sql_import.py:
        // 8170) and continues.
        return {
            isDuplicate: false,
            entryNumber: null,
            reason: `cashbook duplicate check failed: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
    // No cashbook duplicate. For refund actions, look for a credit-note
    // row on the matched ledger account whose value matches — that's the
    // suggested allocation target. Faithful port of
    // duplicate_check.py:205-241 (LEDGER_ALLOCATION_TARGET branch).
    // Informational only — caller still posts the refund.
    const refundLedger = REFUND_LEDGER_TYPE_FOR_ACTION[action];
    const accountCode = (args.accountCode ?? '').trim();
    if (refundLedger && accountCode) {
        try {
            const table = refundLedger.table;
            const trtype = refundLedger.trtype;
            const refCol = table === 'stran' ? 'st_trref' : 'pt_trref';
            const valCol = table === 'stran' ? 'st_trvalue' : 'pt_trvalue';
            const dateCol = table === 'stran' ? 'st_trdate' : 'pt_trdate';
            const acctCol = table === 'stran' ? 'st_account' : 'pt_account';
            const typeCol = table === 'stran' ? 'st_trtype' : 'pt_trtype';
            const rows = (await operaDb.raw(`SELECT TOP 5 ${refCol} AS ref, ${valCol} AS val, ${typeCol} AS trtype
         FROM ${table} WITH (NOLOCK)
         WHERE RTRIM(${acctCol}) = ?
           AND ${dateCol} BETWEEN ? AND ?
           AND ABS(${valCol} - ?) < 0.01
           AND ${typeCol} = ?`, [accountCode, dateFrom, dateTo, signedAmountPounds, trtype]));
            if (Array.isArray(rows) && rows.length > 0) {
                const r = rows[0];
                const ref = String(r.ref ?? '').trim() || null;
                return {
                    isDuplicate: false,
                    entryNumber: null,
                    reason: `no cashbook match for ${action} on ${bankCode} (${signedAmountPounds.toFixed(2)}, ${transactionDate})`,
                    ledgerAllocationHint: {
                        table,
                        ref,
                        trtype,
                        value: Number(r.val ?? 0),
                        reason: `${table} row ${ref} (type=${trtype}, value=${r.val}) is an ` +
                            `allocation target for this refund — POST, then optionally allocate`,
                    },
                };
            }
        }
        catch (advErr) {
            // Advisory branch failures degrade silently — they're hints, not
            // gates. The caller still posts the refund.
            // eslint-disable-next-line no-console
            console.warn(`[bank-reconcile] ledger allocation hint failed: ${advErr instanceof Error ? advErr.message : String(advErr)}`);
        }
    }
    // Type-aware found nothing AND no ledger advisory. Fall through to
    // the type-blind atran lookup as a safety net. Faithful port of
    // bank_import.py:1572-1582. Catches the case where Opera holds the
    // entry under a different at_type than the matcher assigned
    // (HISCOX-as-supplier-but-posted-as-nominal class of bug). Uses
    // ±7d window like legacy, sign-aware.
    const blind = await typeBlindAtranMatch(operaDb, bankCode, transactionDate, signedAmountPounds, excludeEntryNumbers ?? [], 7);
    if (blind.entryNumber) {
        return {
            isDuplicate: true,
            entryNumber: blind.entryNumber,
            reason: `Already in Opera as ${blind.entryNumber} ` +
                `(at_type=${blind.atType ?? '?'}, posted ${blind.postedDate ?? '?'}) ` +
                `— type-blind match (type-aware ${action} missed)`,
        };
    }
    return {
        isDuplicate: false,
        entryNumber: null,
        reason: `no cashbook match for ${action} on ${bankCode} (${signedAmountPounds.toFixed(2)}, ${transactionDate})`,
        ledgerAllocationHint: null,
    };
}
//# sourceMappingURL=pre-posting-duplicate-check.js.map
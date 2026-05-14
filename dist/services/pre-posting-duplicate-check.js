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
    return {
        isDuplicate: false,
        entryNumber: null,
        reason: `no cashbook match for ${action} on ${bankCode} (${signedAmountPounds.toFixed(2)}, ${transactionDate})`,
        ledgerAllocationHint: null,
    };
}
//# sourceMappingURL=pre-posting-duplicate-check.js.map
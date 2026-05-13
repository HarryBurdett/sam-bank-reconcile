function ekey(emailId, attachmentId) {
    return `${emailId == null ? '' : emailId}:${attachmentId == null ? '' : attachmentId}`;
}
const MANAGED_SYSTEMS = new Set(['archived', 'deleted', 'retained']);
export async function getAllStatementTrackingData(appDb) {
    const data = {
        reconciled_keys: new Set(),
        reconciled_filenames: new Set(),
        imported_nr_keys: new Set(),
        imported_nr_filenames: new Set(),
        reconciled_closing_balances: new Map(),
        reconciled_opening_balances: new Map(),
        managed_keys: new Set(),
        managed_filenames: new Set(),
        cached_stmt_info: new Map(),
        imported_hashes: new Map(),
        imported_identities: new Set(),
    };
    // Single query matching legacy. ORDER BY id DESC so `cached_stmt_info`
    // keeps the LATEST row per filename (first-seen-wins on a desc scan).
    // The SAM schema uses source_ref instead of explicit email_id +
    // attachment_id columns — recover those by splitting "<email>:<att>"
    // when source = 'email'. pdf_hash was dropped in the SAM port; legacy
    // uses it only for cross-row dedup so we tolerate its absence.
    let rows;
    try {
        rows = (await appDb('bank_statement_imports')
            .select('id', 'source', 'source_ref', 'filename', 'bank_code', 'sort_code', 'account_number', 'opening_balance', 'closing_balance', 'statement_date', 'period_start', 'period_end', 'target_system', 'is_reconciled')
            .orderBy('id', 'desc'));
    }
    catch {
        // Table not provisioned (e.g. in tests with a stub DB) — return
        // the empty shell. Matches legacy's silent-skip if email_storage
        // can't open the connection.
        return data;
    }
    for (const row of rows) {
        const filename = (row.filename ?? null);
        const bankCode = (row.bank_code ?? null);
        const sortCode = (row.sort_code ?? null);
        const accountNumber = (row.account_number ?? null);
        const openingBalance = row.opening_balance == null ? null : Number(row.opening_balance);
        const closingBalance = row.closing_balance == null ? null : Number(row.closing_balance);
        const targetSystem = (row.target_system ?? '') || '';
        const isReconciled = row.is_reconciled === true ||
            row.is_reconciled === 1 ||
            row.is_reconciled === '1';
        const rowId = Number(row.id);
        const isManaged = MANAGED_SYSTEMS.has(targetSystem);
        // Recover (email_id, attachment_id) from source_ref where source=email.
        let emailId = null;
        let attachmentId = null;
        if (row.source === 'email' && typeof row.source_ref === 'string') {
            const colon = row.source_ref.indexOf(':');
            if (colon >= 0) {
                const e = Number(row.source_ref.slice(0, colon));
                if (Number.isFinite(e))
                    emailId = e;
                attachmentId = row.source_ref.slice(colon + 1);
            }
        }
        // --- reconciled keys / filenames ---
        if (isReconciled) {
            if (emailId !== null) {
                data.reconciled_keys.add(ekey(emailId, attachmentId));
            }
            if (filename !== null)
                data.reconciled_filenames.add(filename);
            // reconciled closing balances — max per bank
            if (bankCode && bankCode !== 'DEDUP' && closingBalance !== null) {
                const cur = data.reconciled_closing_balances.get(bankCode);
                if (cur === undefined || closingBalance > cur) {
                    data.reconciled_closing_balances.set(bankCode, closingBalance);
                }
            }
            // reconciled opening balances — set per bank (rounded 2dp)
            if (bankCode && bankCode !== 'DEDUP' && openingBalance !== null) {
                let s = data.reconciled_opening_balances.get(bankCode);
                if (!s) {
                    s = new Set();
                    data.reconciled_opening_balances.set(bankCode, s);
                }
                s.add(round2(openingBalance));
            }
        }
        // --- imported-not-reconciled keys / filenames ---
        if (!isReconciled && !isManaged) {
            if (emailId !== null) {
                data.imported_nr_keys.add(ekey(emailId, attachmentId));
            }
            if (filename !== null)
                data.imported_nr_filenames.add(filename);
        }
        // --- managed keys / filenames ---
        if (isManaged) {
            if (emailId !== null) {
                data.managed_keys.add(ekey(emailId, attachmentId));
            }
            if (filename !== null)
                data.managed_filenames.add(filename);
        }
        // --- cached statement info (latest per filename, skip archived/deleted) ---
        if (filename !== null &&
            sortCode !== null &&
            accountNumber !== null &&
            openingBalance !== null &&
            closingBalance !== null &&
            !MANAGED_SYSTEMS.has(targetSystem) &&
            !(targetSystem === 'archived' || targetSystem === 'deleted') &&
            bankCode !== 'DEDUP') {
            if (!data.cached_stmt_info.has(filename)) {
                data.cached_stmt_info.set(filename, {
                    filename,
                    bank_code: bankCode ?? '',
                    sort_code: sortCode,
                    account_number: accountNumber,
                    opening_balance: openingBalance,
                    closing_balance: closingBalance,
                    statement_date: (row.statement_date ?? null),
                    period_start: (row.period_start ?? null),
                    period_end: (row.period_end ?? null),
                });
            }
        }
        // --- imported pdf hashes (earliest/min id per hash) ---
        // SAM schema dropped pdf_hash; legacy keeps the earliest id per
        // hash. Skipped here; cross-row dedup is handled by `imported_identities`.
        // --- imported statement identities ---
        if (sortCode !== null &&
            accountNumber !== null &&
            openingBalance !== null &&
            closingBalance !== null &&
            !isManaged) {
            data.imported_identities.add(`${sortCode}|${accountNumber}|${round2(openingBalance)}|${round2(closingBalance)}`);
        }
    }
    return data;
}
function round2(n) {
    return Math.round(n * 100) / 100;
}
//# sourceMappingURL=statement-tracking.js.map
const r2 = (n) => Math.round(n * 100) / 100;
const SOURCE_DESC = {
    P: 'Purchase',
    S: 'Sales',
    A: 'Cashbook',
    J: 'Journal',
};
export async function reconcileBankDashboard(operaDb, bankCode) {
    if (!bankCode) {
        return { success: false, error: 'bank_code is required' };
    }
    try {
        // Bank info
        const bankRows = (await operaDb.raw(`SELECT nk_acnt, RTRIM(nk_desc) AS description, nk_sort, nk_number, nk_curbal
       FROM nbank WITH (NOLOCK)
       WHERE RTRIM(nk_acnt) = ?`, [bankCode]));
        if (!Array.isArray(bankRows) || bankRows.length === 0) {
            return {
                success: false,
                error: `Bank account ${bankCode} not found`,
            };
        }
        const bank = bankRows[0];
        // Current year (from ntran or fallback)
        const cyRows = (await operaDb.raw(`SELECT MAX(nt_year) AS current_year FROM ntran WITH (NOLOCK)`));
        const currentYear = Array.isArray(cyRows) && cyRows[0]?.current_year != null
            ? Number(cyRows[0].current_year)
            : new Date().getFullYear();
        // Cashbook current year
        const cbCyRows = (await operaDb.raw(`SELECT
         COUNT(DISTINCT at_entry) AS entry_count,
         COUNT(*) AS transaction_count,
         SUM(CASE WHEN at_value > 0 THEN at_value ELSE 0 END) AS receipts_pence,
         SUM(CASE WHEN at_value < 0 THEN ABS(at_value) ELSE 0 END) AS payments_pence,
         SUM(at_value) AS net_pence
       FROM atran WITH (NOLOCK)
       WHERE at_acnt = ? AND YEAR(at_pstdate) = ?`, [bankCode, currentYear]));
        const cbCy = cbCyRows[0] ?? {
            entry_count: 0,
            transaction_count: 0,
            receipts_pence: 0,
            payments_pence: 0,
            net_pence: 0,
        };
        const cbCyEntries = Number(cbCy.entry_count ?? 0);
        const cbCyTxns = Number(cbCy.transaction_count ?? 0);
        const cbCyReceiptsPounds = Number(cbCy.receipts_pence ?? 0) / 100;
        const cbCyPaymentsPounds = Number(cbCy.payments_pence ?? 0) / 100;
        const cbCyMovements = Number(cbCy.net_pence ?? 0) / 100;
        // Cashbook all-time
        const cbAllRows = (await operaDb.raw(`SELECT COUNT(DISTINCT at_entry) AS entry_count,
              COUNT(*) AS transaction_count,
              SUM(at_value) AS net_pence
       FROM atran WITH (NOLOCK)
       WHERE at_acnt = ?`, [bankCode]));
        const cbAll = cbAllRows[0];
        const cbAllEntries = Number(cbAll?.entry_count ?? 0);
        const cbAllTotal = Number(cbAll?.net_pence ?? 0) / 100;
        // Bank master balance
        const nbankCurbalPence = Number(bank.nk_curbal ?? 0);
        const nbankCurbalPounds = nbankCurbalPence / 100;
        // Nominal ledger
        const nacntRows = (await operaDb.raw(`SELECT na_acnt, RTRIM(na_desc) AS description, na_ytddr, na_ytdcr, na_prydr, na_prycr
       FROM nacnt WITH (NOLOCK)
       WHERE na_acnt = ?`, [bankCode]));
        let nlTotal = 0;
        let bfBalance = 0;
        let nlDetails = {
            source: 'ntran (Nominal Ledger)',
            account: bankCode,
            description: 'Account not found in nacnt',
            total_balance: 0,
        };
        if (Array.isArray(nacntRows) && nacntRows.length > 0) {
            const acc = nacntRows[0];
            const pryDr = Number(acc.na_prydr ?? 0);
            const pryCr = Number(acc.na_prycr ?? 0);
            bfBalance = pryDr - pryCr;
            const ntranRows = (await operaDb.raw(`SELECT
           SUM(CASE WHEN nt_value > 0 THEN nt_value ELSE 0 END) AS debits,
           SUM(CASE WHEN nt_value < 0 THEN ABS(nt_value) ELSE 0 END) AS credits,
           SUM(nt_value) AS net
         FROM ntran WITH (NOLOCK)
         WHERE nt_acnt = ? AND nt_year = ?`, [bankCode, currentYear]));
            const ntr = ntranRows[0] ?? { debits: 0, credits: 0, net: 0 };
            const cyDebits = Number(ntr.debits ?? 0);
            const cyCredits = Number(ntr.credits ?? 0);
            const cyNet = Number(ntr.net ?? 0);
            nlTotal = cyNet;
            nlDetails = {
                source: 'ntran (Nominal Ledger)',
                account: bankCode,
                description: (acc.description ?? '').toString().trim(),
                current_year: currentYear,
                brought_forward: r2(bfBalance),
                current_year_debits: r2(cyDebits),
                current_year_credits: r2(cyCredits),
                current_year_net: r2(cyNet),
                closing_balance: r2(cyNet),
                total_balance: r2(nlTotal),
            };
        }
        const cbExpectedClosing = nacntRows.length > 0
            ? cbCyMovements + bfBalance
            : cbCyMovements;
        // Transfer file (anoml)
        let pendingRows = [];
        let summaryRows = [];
        try {
            pendingRows = (await operaDb.raw(`SELECT
           ax_nacnt AS nominal_account,
           ax_source AS source,
           ax_date AS date,
           ax_value AS value,
           ax_tref AS reference,
           ax_comment AS comment
         FROM anoml WITH (NOLOCK)
         WHERE ax_nacnt = ? AND (ax_done <> 'Y' OR ax_done IS NULL)
         ORDER BY ax_date DESC`, [bankCode]));
        }
        catch {
            pendingRows = [];
        }
        try {
            summaryRows = (await operaDb.raw(`SELECT
           CASE WHEN ax_done = 'Y' THEN 'Posted' ELSE 'Pending' END AS status,
           COUNT(*) AS count,
           SUM(ax_value) AS total
         FROM anoml WITH (NOLOCK)
         WHERE ax_nacnt = ?
         GROUP BY CASE WHEN ax_done = 'Y' THEN 'Posted' ELSE 'Pending' END`, [bankCode]));
        }
        catch {
            summaryRows = [];
        }
        let postedCount = 0;
        let postedTotal = 0;
        let pendingCount = 0;
        let pendingTotal = 0;
        for (const row of summaryRows) {
            if (row.status === 'Posted') {
                postedCount = Number(row.count ?? 0);
                postedTotal = Number(row.total ?? 0);
            }
            else {
                pendingCount = Number(row.count ?? 0);
                pendingTotal = Number(row.total ?? 0);
            }
        }
        const pendingTransactions = pendingRows.map((row) => {
            const value = Number(row.value ?? 0);
            const src = (row.source ?? '').toString().trim();
            const date = row.date instanceof Date
                ? row.date.toISOString().slice(0, 10)
                : (row.date ? String(row.date).slice(0, 10) : '');
            return {
                nominal_account: (row.nominal_account ?? '').toString().trim(),
                source: src,
                source_desc: SOURCE_DESC[src] ?? src,
                date,
                value: r2(value),
                reference: (row.reference ?? '').toString().trim(),
                comment: (row.comment ?? '').toString().trim(),
            };
        });
        // Variance calc
        const varianceCbNbank = cbExpectedClosing - nbankCurbalPounds;
        const varianceNbankNl = nbankCurbalPounds - nlTotal;
        const varianceCbNl = cbExpectedClosing - nlTotal;
        const allReconciled = Math.abs(varianceCbNbank) < 0.005 && Math.abs(varianceNbankNl) < 0.005;
        const status = allReconciled
            ? 'RECONCILED'
            : 'UNRECONCILED';
        const message = allReconciled
            ? pendingCount > 0
                ? `Bank ${bankCode} reconciles across all sources. ${pendingCount} entries (£${Math.abs(pendingTotal).toFixed(2)}) in transfer file pending.`
                : `Bank ${bankCode} fully reconciles: Cashbook = Bank Master = Nominal Ledger`
            : 'Variance detected — review the variance section for details.';
        const reconciliationDate = new Date()
            .toISOString()
            .slice(0, 19)
            .replace('T', ' ');
        return {
            success: true,
            reconciliation_date: reconciliationDate,
            bank_code: bankCode,
            bank_account: {
                code: (bank.nk_acnt ?? '').toString().trim(),
                description: (bank.description ?? '').toString().trim() || '',
                sort_code: (bank.nk_sort ?? '').toString().trim(),
                account_number: (bank.nk_number ?? '').toString().trim(),
            },
            cashbook: {
                source: 'atran (Cashbook Transactions)',
                current_year: currentYear,
                current_year_entries: cbCyEntries,
                current_year_transactions: cbCyTxns,
                current_year_receipts: r2(cbCyReceiptsPounds),
                current_year_payments: r2(cbCyPaymentsPounds),
                current_year_movements: r2(cbCyMovements),
                prior_year_bf: nacntRows.length > 0 ? r2(bfBalance) : 0,
                expected_closing: r2(cbExpectedClosing),
                all_time_entries: cbAllEntries,
                all_time_net: r2(cbAllTotal),
                transfer_file: {
                    source: 'anoml (Cashbook to Nominal Transfer File)',
                    posted_to_nl: { count: postedCount, total: r2(postedTotal) },
                    pending_transfer: {
                        count: pendingCount,
                        total: r2(pendingTotal),
                        transactions: pendingTransactions,
                    },
                },
            },
            bank_master: {
                source: 'nbank.nk_curbal (Bank Master Balance)',
                balance_pence: Math.round(nbankCurbalPence),
                balance_pounds: r2(nbankCurbalPounds),
            },
            nominal_ledger: nlDetails,
            variance: {
                cashbook_vs_bank_master: {
                    description: 'atran movements + B/F vs nbank.nk_curbal',
                    cashbook_expected: r2(cbExpectedClosing),
                    bank_master: r2(nbankCurbalPounds),
                    amount: r2(varianceCbNbank),
                    absolute: r2(Math.abs(varianceCbNbank)),
                    reconciled: Math.abs(varianceCbNbank) < 0.005,
                },
                bank_master_vs_nominal: {
                    description: 'nbank.nk_curbal vs ntran current year',
                    bank_master: r2(nbankCurbalPounds),
                    nominal_ledger: r2(nlTotal),
                    amount: r2(varianceNbankNl),
                    absolute: r2(Math.abs(varianceNbankNl)),
                    reconciled: Math.abs(varianceNbankNl) < 0.005,
                },
                cashbook_vs_nominal: {
                    description: 'atran expected vs ntran',
                    cashbook_expected: r2(cbExpectedClosing),
                    nominal_ledger: r2(nlTotal),
                    amount: r2(varianceCbNl),
                    absolute: r2(Math.abs(varianceCbNl)),
                    reconciled: Math.abs(varianceCbNl) < 0.005,
                },
                summary: {
                    current_year: currentYear,
                    cashbook_movements: r2(cbCyMovements),
                    prior_year_bf: nacntRows.length > 0 ? r2(bfBalance) : 0,
                    cashbook_expected_closing: r2(cbExpectedClosing),
                    bank_master_balance: r2(nbankCurbalPounds),
                    nominal_ledger_balance: r2(nlTotal),
                    transfer_file_pending: r2(pendingTotal),
                    all_reconciled: allReconciled,
                    has_pending_transfers: pendingCount > 0,
                },
            },
            status,
            message,
        };
    }
    catch (err) {
        return {
            success: false,
            error: err?.message ?? String(err),
        };
    }
}
//# sourceMappingURL=reconcile-dashboard.js.map
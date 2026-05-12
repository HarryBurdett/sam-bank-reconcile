export async function getBankReconciliationStatus(operaDb) {
    try {
        const rows = (await operaDb.raw(`SELECT
         RTRIM(nk_acnt) AS bank_code,
         RTRIM(nk_desc) AS description,
         nk_recbal / 100.0 AS reconciled_balance,
         nk_curbal / 100.0 AS current_balance
       FROM nbank WITH (NOLOCK)
       ORDER BY nk_acnt`));
        const banks = [];
        for (const r of rows) {
            const code = (r.bank_code ?? '').toString().trim();
            const unrecRows = (await operaDb.raw(`SELECT COUNT(*) AS cnt, SUM(at_value) / 100.0 AS total
         FROM atran WITH (NOLOCK)
         WHERE at_acnt = ? AND (at_statln IS NULL OR at_statln = 0)`, [code]));
            banks.push({
                bank_code: code,
                description: (r.description ?? '').toString().trim(),
                reconciled_balance: r.reconciled_balance,
                current_balance: r.current_balance,
                unreconciled_count: Number(unrecRows[0]?.cnt ?? 0),
                unreconciled_total: Number(unrecRows[0]?.total ?? 0),
                last_reconciled: null,
            });
        }
        return { success: true, banks };
    }
    catch (err) {
        return { success: false, banks: [], error: err?.message ?? String(err) };
    }
}
export async function getUnreconciledEntriesForBank(operaDb, bankCode) {
    try {
        let query = `
      SELECT
        RTRIM(at_acnt) AS bank_code,
        at_pstdate AS date,
        RTRIM(ae_entref) AS reference,
        at_value / 100.0 AS amount,
        RTRIM(at_comment) AS comment,
        RTRIM(at_entry) AS entry_number
      FROM atran WITH (NOLOCK)
      JOIN aentry WITH (NOLOCK) ON at_acnt = ae_acnt AND at_cntr = ae_cntr
        AND at_cbtype = ae_cbtype AND at_entry = ae_entry
      WHERE (at_statln IS NULL OR at_statln = 0)
    `;
        const params = [];
        if (bankCode) {
            query += ' AND at_acnt = ?';
            params.push(bankCode);
        }
        query += ' ORDER BY at_pstdate DESC';
        const rows = (await operaDb.raw(query, params));
        return {
            success: true,
            entries: rows.map((r) => ({
                bank_code: (r.bank_code ?? '').toString().trim(),
                date: r.date instanceof Date
                    ? r.date.toISOString().slice(0, 10)
                    : String(r.date ?? '').slice(0, 10),
                reference: (r.reference ?? '').toString().trim(),
                amount: Number(r.amount ?? 0),
                comment: (r.comment ?? '').toString().trim(),
                entry_number: (r.entry_number ?? '').toString().trim(),
            })),
        };
    }
    catch (err) {
        return { success: false, entries: [], error: err?.message ?? String(err) };
    }
}
export async function getStatementTransactionsForImport(appDb, importId) {
    if (!Number.isFinite(importId) || importId <= 0) {
        return { success: false, transactions: [], error: 'invalid import_id' };
    }
    try {
        // Columns mirror the SAM migration 013 schema. Frontend
        // (Imports.tsx alreadyPostedRows loader) reads `line_number` +
        // `posted_entry_number`; the matching view also consumes the
        // per-line matched_entry/match_* fields so re-opening a statement
        // shows prior analysis. Omitting `posted_entry_number` here was
        // why orphan-recovery cleared SAM tracking but the UI continued
        // to show every line as Posted — alreadyPostedRows was being
        // populated from legacy email_data.db instead.
        const rows = (await appDb('bank_statement_transactions')
            .where({ import_id: importId })
            .orderBy('line_number', 'asc'));
        return {
            success: true,
            transactions: rows.map((r) => ({
                line_number: Number(r.line_number),
                date: r.post_date instanceof Date
                    ? r.post_date.toISOString().slice(0, 10)
                    : r.post_date
                        ? String(r.post_date).slice(0, 10)
                        : null,
                description: r.description ?? null,
                amount: Number(r.amount ?? 0),
                balance: r.balance === null || r.balance === undefined
                    ? null
                    : Number(r.balance),
                type: r.transaction_type ?? 'credit',
                reference: r.reference ?? null,
                matched_entry: r.matched_entry ?? null,
                match_confidence: r.match_confidence === null || r.match_confidence === undefined
                    ? null
                    : Number(r.match_confidence),
                match_type: r.match_type ?? null,
                is_reconciled: !!r.is_reconciled,
                posted_entry_number: (r.posted_entry_number ?? '').toString().trim() || null,
                posted_at: r.posted_at instanceof Date
                    ? r.posted_at.toISOString()
                    : r.posted_at
                        ? String(r.posted_at)
                        : null,
            })),
        };
    }
    catch (err) {
        return { success: false, transactions: [], error: err?.message ?? String(err) };
    }
}
//# sourceMappingURL=bank-reconciliation-status.js.map
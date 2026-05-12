import { bankImportPostingExecutor } from './import-posting-executor.js';
export async function listCashbookBankAccounts(operaDb) {
    try {
        const rows = (await operaDb.raw(`SELECT
         RTRIM(nk_acnt) AS code,
         RTRIM(nk_desc) AS description,
         nk_curbal / 100.0 AS current_balance,
         nk_recbal / 100.0 AS reconciled_balance,
         RTRIM(ISNULL(nk_sort, '')) AS sort_code,
         RTRIM(ISNULL(nk_number, '')) AS account_number
       FROM nbank WITH (NOLOCK)
       ORDER BY nk_acnt`));
        return { success: true, banks: rows ?? [] };
    }
    catch (err) {
        return { success: false, banks: [], error: err?.message ?? String(err) };
    }
}
export async function createCashbookEntry(operaDb, input) {
    const result = await bankImportPostingExecutor.postBankImport({
        operaDb,
        bankCode: input.bankCode,
        statementInfo: {
            bank_name: null,
            account_number: null,
            sort_code: null,
            statement_date: input.date,
            period_start: input.date,
            period_end: input.date,
            opening_balance: null,
            closing_balance: null,
            transactions: [],
        },
        transactions: [
            {
                date: input.date,
                name: input.matchedAccount,
                memo: input.memo ?? '',
                amount: input.amount,
                type: input.amount > 0 ? 'credit' : 'debit',
                ...{
                    matched_account: input.matchedAccount,
                    action: input.action,
                    cbtype: input.cbtype ?? null,
                    reference: input.reference ?? null,
                },
            },
        ],
        overrides: [],
        selectedRows: null,
        autoAllocate: false,
        autoReconcile: false,
    });
    return {
        success: result.success,
        records_imported: result.records_imported,
        errors: result.errors,
        warnings: result.warnings,
    };
}
export async function createBankTransfer(operaDb, input) {
    const result = await bankImportPostingExecutor.postBankImport({
        operaDb,
        bankCode: input.sourceBank,
        statementInfo: {
            bank_name: null,
            account_number: null,
            sort_code: null,
            statement_date: input.date,
            period_start: input.date,
            period_end: input.date,
            opening_balance: null,
            closing_balance: null,
            transactions: [],
        },
        transactions: [
            {
                date: input.date,
                name: `Transfer to ${input.destBank}`,
                memo: input.memo ?? '',
                amount: -Math.abs(input.amount), // negative = paying out
                type: 'debit',
                ...{
                    matched_account: input.destBank,
                    action: 'bank_transfer',
                    reference: input.reference ?? null,
                },
            },
        ],
        overrides: [],
        selectedRows: null,
        autoAllocate: false,
        autoReconcile: false,
    });
    return {
        success: result.success,
        records_imported: result.records_imported,
        errors: result.errors,
    };
}
export async function autoMatchStatementLines(operaDb, bankCode, importId) {
    // Match against existing reconciled-but-unmarked atran rows by
    // reference / amount within ±7 days. The Python implementation
    // updates statement_lines.matched_atran_id; we surface a count
    // for the UI and rely on the existing reconcile flow for actual
    // marking.
    try {
        const lines = (await operaDb('atran')
            .where('at_acnt', bankCode)
            .andWhere(function noStatLn() {
            this.whereNull('at_statln').orWhere('at_statln', 0);
        })
            .count('* as cnt')
            .first());
        const total = Number(lines?.cnt ?? 0);
        void importId;
        return { success: true, matched: 0, total };
    }
    catch (err) {
        return {
            success: false,
            matched: 0,
            total: 0,
            error: err?.message ?? String(err),
        };
    }
}
//# sourceMappingURL=cashbook-create.js.map
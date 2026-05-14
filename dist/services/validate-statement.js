function formatPounds(pounds) {
    return pounds.toLocaleString('en-GB', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}
export async function validateStatementForReconciliation(operaDb, input) {
    const bankAccount = (input.bankAccount ?? '').trim();
    if (!bankAccount) {
        return { valid: false, error_message: 'bank_account is required' };
    }
    if (!Number.isFinite(input.openingBalance)) {
        return { valid: false, error_message: 'opening_balance is required' };
    }
    try {
        const row = (await operaDb('nbank')
            .where({ nk_acnt: bankAccount })
            .select(operaDb.raw('nk_recbal / 100.0 AS expected_opening'), 'nk_lststno AS last_statement_number', operaDb.raw('nk_curbal / 100.0 AS current_balance'))
            .first());
        if (!row) {
            return {
                valid: false,
                error_message: `Bank account ${bankAccount} not found`,
            };
        }
        const expectedOpening = Number(row.expected_opening ?? 0);
        const lastStmtNo = row.last_statement_number
            ? Number(row.last_statement_number)
            : 0;
        const nextStmtNo = input.statementNumber && Number.isFinite(input.statementNumber)
            ? Number(input.statementNumber)
            : lastStmtNo + 1;
        let openingMatches = Math.abs(input.openingBalance - expectedOpening) < 0.01;
        // Imported-pending tolerance: when the operator's prior statement
        // was imported but not yet reconciled, nbank.nk_recbal still
        // points at the OLD reconciled balance — but the next statement's
        // opening should match the prior statement's CLOSING. Look up
        // bank_statement_imports for any imports on this bank whose
        // closing equals the supplied opening (within 1p). Faithful port
        // of routes.py:1504 + _build_imported_pending_closings(92).
        if (!openingMatches && input.appDb) {
            try {
                // Row existence implies "imported" — the `import_status` column
                // was dropped from the SAM SQLite schema (no such column); the
                // earlier filter on it was a silent error in the .catch below.
                const rows = (await input.appDb('bank_statement_imports')
                    .where({ bank_code: bankAccount })
                    .andWhere((qb) => {
                    qb.where('is_reconciled', false)
                        .orWhereNull('is_reconciled')
                        .orWhere('is_reconciled', 0);
                })
                    .whereNotNull('closing_balance')
                    .select('closing_balance'));
                for (const r of rows) {
                    const closing = Number(r.closing_balance ?? 0);
                    if (Math.abs(closing - input.openingBalance) < 0.01) {
                        openingMatches = true;
                        break;
                    }
                }
            }
            catch {
                /* lookup failure must not block — legacy parity */
            }
        }
        if (!openingMatches) {
            return {
                valid: false,
                expected_opening: expectedOpening,
                statement_opening: input.openingBalance,
                difference: Math.round((input.openingBalance - expectedOpening) * 100) / 100,
                opening_matches: false,
                next_statement_number: nextStmtNo,
                error_message: `Opening balance mismatch: Statement shows £${formatPounds(input.openingBalance)}, ` +
                    `Opera expects £${formatPounds(expectedOpening)}`,
            };
        }
        return {
            valid: true,
            expected_opening: expectedOpening,
            statement_opening: input.openingBalance,
            statement_closing: input.closingBalance,
            opening_matches: true,
            next_statement_number: nextStmtNo,
            statement_date: input.statementDate ?? null,
            error_message: null,
        };
    }
    catch (err) {
        return { valid: false, error_message: err?.message ?? String(err) };
    }
}
//# sourceMappingURL=validate-statement.js.map
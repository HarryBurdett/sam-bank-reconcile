import { validateBankCode, SqlInputValidationError, } from '../_shared/index.js';
import { markEntriesReconciled, } from './mark-reconciled.js';
export async function confirmStatementMatches(appDb, operaDb, input) {
    let bankCode;
    try {
        bankCode = validateBankCode(input.bankCode);
    }
    catch (e) {
        if (e instanceof SqlInputValidationError) {
            return { success: false, error: e.message };
        }
        throw e;
    }
    const entryIds = (input.matches ?? [])
        .map((m) => (m.ae_entry ?? m.opera_entry?.ae_entry ?? '').toString().trim())
        .filter((e) => e.length > 0);
    if (entryIds.length === 0) {
        return { success: false, error: 'No valid entry IDs provided' };
    }
    // Read next statement number from nbank.nk_lststno + 1
    const nbankRows = (await operaDb.raw(`SELECT ISNULL(nk_lststno, 0) AS lststno
     FROM nbank WITH (NOLOCK)
     WHERE RTRIM(nk_acnt) = ?`, [bankCode]));
    if (!Array.isArray(nbankRows) || nbankRows.length === 0) {
        return {
            success: false,
            error: `Bank account ${bankCode} not found in nbank`,
        };
    }
    const nextStatementNumber = Number(nbankRows[0]?.lststno ?? 0) + 1;
    // Build entries with Opera-convention statement lines (10, 20, 30, ...)
    const entries = entryIds.map((eid, i) => ({
        entry_number: eid,
        statement_line: (i + 1) * 10,
    }));
    const result = await markEntriesReconciled(appDb, operaDb, {
        bankCode,
        entries,
        statementNumber: nextStatementNumber,
        statementDate: input.statementDate ?? null,
        reconciliationDate: new Date().toISOString().slice(0, 10),
        partial: false,
        closingBalance: input.statementBalance,
    });
    if (!result.success) {
        return result;
    }
    return {
        ...result,
        reconciled_count: entries.length,
        batch_number: nextStatementNumber - 1,
        statement_balance: input.statementBalance,
        message: `Reconciled ${entries.length} entries`,
    };
}
//# sourceMappingURL=confirm-matches.js.map
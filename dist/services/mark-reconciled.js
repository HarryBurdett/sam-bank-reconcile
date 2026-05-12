import { validateBankCode, validateEntryNumber, SqlInputValidationError, } from '../_shared/index.js';
import { withImportLock, ImportLockError } from './import-lock.js';
function todayISO() {
    return new Date().toISOString().slice(0, 10);
}
function maxStatementLine(entries) {
    return entries.reduce((m, e) => Math.max(m, Number(e.statement_line ?? 0)), 0);
}
function formatGbp(pence) {
    const sign = pence < 0 ? '-' : '';
    const abs = Math.abs(pence) / 100;
    const fixed = abs.toFixed(2);
    const [whole = '0', frac = '00'] = fixed.split('.');
    const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${sign}£${withCommas}.${frac}`;
}
export async function markEntriesReconciled(appDb, operaDb, input) {
    // SQL injection guard at boundary
    let bankCode;
    let entries;
    try {
        bankCode = validateBankCode(input.bankCode);
        entries = (input.entries ?? []).map((e) => {
            validateEntryNumber(e.entry_number);
            return {
                entry_number: e.entry_number.trim(),
                statement_line: Math.trunc(Number(e.statement_line ?? 0)),
            };
        });
    }
    catch (e) {
        if (e instanceof SqlInputValidationError) {
            return { success: false, error: e.message };
        }
        throw e;
    }
    if (entries.length === 0) {
        return {
            success: false,
            errors: ['No entries provided for reconciliation'],
        };
    }
    const stmtDate = input.statementDate ?? todayISO();
    const recDate = input.reconciliationDate ?? todayISO();
    const statementNumber = Math.trunc(Number(input.statementNumber ?? 0));
    const partial = !!input.partial;
    try {
        return await withImportLock(appDb, bankCode, { locked_by: 'api', endpoint: 'mark-reconciled' }, async () => operaDb.transaction(async (trx) => {
            // 1. Read nbank with UPDLOCK so concurrent recs serialise
            //    on this bank.
            const nbankRows = (await trx.raw(`SELECT nk_lstrecl, nk_recbal, nk_curbal, nk_lststno
             FROM nbank WITH (UPDLOCK, ROWLOCK)
             WHERE nk_acnt = ?`, [bankCode]));
            const nbank = Array.isArray(nbankRows) ? nbankRows[0] : undefined;
            if (!nbank) {
                throw new Error(`Bank account ${bankCode} not found in nbank`);
            }
            let currentRecLine = Number(nbank.nk_lstrecl ?? 0);
            const currentRecBalance = Number(nbank.nk_recbal ?? 0); // pence
            const currentBalance = Number(nbank.nk_curbal ?? 0); // pence
            // Auto-recover fresh-bank state: bump nk_lstrecl + nk_reclnum
            // to 1 so rec_batch_number is never 0.
            if (currentRecLine < 1) {
                await trx.raw(`UPDATE nbank WITH (ROWLOCK)
               SET nk_lstrecl = 1,
                   nk_reclnum = 1,
                   datemodified = GETDATE()
               WHERE nk_acnt = ?
                 AND nk_lstrecl < 1`, [bankCode]);
                currentRecLine = 1;
            }
            const recBatchNumber = currentRecLine;
            // 2. Validate entries exist and not already reconciled
            const placeholders = entries.map(() => '?').join(',');
            const validationRows = (await trx.raw(`SELECT ae_entry, ae_value, ae_reclnum
             FROM aentry WITH (UPDLOCK, ROWLOCK)
             WHERE ae_acnt = ?
               AND ae_entry IN (${placeholders})`, [bankCode, ...entries.map((e) => e.entry_number)]));
            const found = new Map();
            for (const r of validationRows ?? []) {
                const key = (r.ae_entry ?? '').toString().trim();
                if (key) {
                    found.set(key, {
                        value: Number(r.ae_value ?? 0),
                        reclnum: Number(r.ae_reclnum ?? 0),
                    });
                }
            }
            const errors = [];
            let totalValue = 0;
            for (const e of entries) {
                const f = found.get(e.entry_number);
                if (!f) {
                    errors.push(`Entry ${e.entry_number} not found`);
                }
                else if (f.reclnum !== 0) {
                    errors.push(`Entry ${e.entry_number} already reconciled (reclnum=${f.reclnum})`);
                }
                else {
                    totalValue += f.value;
                }
            }
            if (errors.length > 0) {
                // The transaction wrapper rollbacks automatically on throw.
                const err = new Error('Validation failed');
                err.errors = errors;
                throw err;
            }
            // 3. Clear ae_tmpstat on entries we're about to reconcile
            //    (only those — never touch other entries' tmpstat).
            await trx.raw(`UPDATE aentry WITH (ROWLOCK)
             SET ae_tmpstat = 0
             WHERE ae_acnt = ?
               AND ae_entry IN (${placeholders})
               AND ae_tmpstat != 0`, [bankCode, ...entries.map((e) => e.entry_number)]);
            // 4. Update each aentry — sort by statement_line so the
            //    running balance walks in the same order Opera's report
            //    will display. Running balance starts at currentRecBalance
            //    and accumulates AFTER each entry.
            const sorted = [...entries].sort((a, b) => a.statement_line - b.statement_line);
            let running = currentRecBalance;
            for (const e of sorted) {
                const f = found.get(e.entry_number);
                running += f.value;
                const entryRecBal = Math.trunc(running);
                if (partial) {
                    await trx.raw(`UPDATE aentry WITH (ROWLOCK)
                 SET ae_tmpstat = ?,
                     datemodified = GETDATE()
                 WHERE ae_acnt = ?
                   AND ae_entry = ?`, [e.statement_line, bankCode, e.entry_number]);
                }
                else {
                    await trx.raw(`UPDATE aentry WITH (ROWLOCK)
                 SET ae_reclnum = ?,
                     ae_recdate = ?,
                     ae_statln = ?,
                     ae_frstat = ?,
                     ae_tostat = ?,
                     ae_tmpstat = 0,
                     ae_recbal = ?,
                     datemodified = GETDATE()
                 WHERE ae_acnt = ?
                   AND ae_entry = ?`, [
                        recBatchNumber,
                        recDate,
                        e.statement_line,
                        statementNumber,
                        statementNumber,
                        entryRecBal,
                        bankCode,
                        e.entry_number,
                    ]);
                }
            }
            // 5. Update nbank
            const newRecLine = recBatchNumber + 1;
            const newRecBalance = currentRecBalance + totalValue;
            const closingPence = input.closingBalance !== undefined &&
                input.closingBalance !== null &&
                !Number.isNaN(input.closingBalance)
                ? Math.round(Number(input.closingBalance) * 100)
                : null;
            const maxLine = maxStatementLine(sorted);
            if (partial) {
                // Partial: leave nk_recbal alone; update statement tracking
                const cfwdSql = closingPence !== null
                    ? 'nk_reccfwd = ?,'
                    : '';
                const sql = `
              UPDATE nbank WITH (ROWLOCK)
              SET ${cfwdSql}
                  nk_lstrecl = ?,
                  nk_lststno = ?,
                  nk_lststdt = ?,
                  nk_reclnum = ?,
                  nk_recldte = ?,
                  nk_recstfr = ?,
                  nk_recstto = ?,
                  nk_recstdt = ?,
                  nk_recstln = ?,
                  datemodified = GETDATE()
              WHERE nk_acnt = ?
            `;
                const params = [];
                if (closingPence !== null)
                    params.push(closingPence);
                params.push(newRecLine, statementNumber, stmtDate, newRecLine, recDate, statementNumber, statementNumber, stmtDate, maxLine, bankCode);
                await trx.raw(sql, params);
            }
            else {
                // Full: also advance nk_recbal + reset nk_reccfwd to 0
                await trx.raw(`UPDATE nbank WITH (ROWLOCK)
               SET nk_recbal = ?,
                   nk_reccfwd = 0,
                   nk_lstrecl = ?,
                   nk_lststno = ?,
                   nk_lststdt = ?,
                   nk_reclnum = ?,
                   nk_recldte = ?,
                   nk_recstfr = ?,
                   nk_recstto = ?,
                   nk_recstdt = ?,
                   nk_recstln = ?,
                   datemodified = GETDATE()
               WHERE nk_acnt = ?`, [
                    Math.trunc(newRecBalance),
                    newRecLine,
                    statementNumber,
                    stmtDate,
                    newRecLine,
                    recDate,
                    statementNumber,
                    statementNumber,
                    stmtDate,
                    maxLine,
                    bankCode,
                ]);
            }
            // 6. Re-read nk_recbal so the response reflects the
            //    committed value (catches any silent UPDATE failures).
            const verifyRows = (await trx.raw(`SELECT nk_recbal FROM nbank WITH (NOLOCK) WHERE nk_acnt = ?`, [bankCode]));
            const verified = Array.isArray(verifyRows) && verifyRows[0]
                ? Number(verifyRows[0].nk_recbal ?? 0) / 100
                : null;
            const totalPounds = totalValue / 100;
            const newRecPounds = newRecBalance / 100;
            const remainingPounds = (currentBalance - newRecBalance) / 100;
            if (partial) {
                return {
                    success: true,
                    records_reconciled: entries.length,
                    new_reconciled_balance: verified,
                    message: `Partial reconciliation: ${entries.length} entries marked`,
                    details: [
                        `Partial reconciliation: ${entries.length} entries marked with statement line numbers`,
                        verified !== null
                            ? `Reconciled balance unchanged: ${formatGbp(currentRecBalance)}`
                            : 'Reconciled balance unchanged',
                        'Complete remaining items in Opera Cashbook > Reconcile',
                        `Statement number: ${statementNumber}`,
                        `Reconciliation batch: ${recBatchNumber}`,
                    ],
                };
            }
            return {
                success: true,
                records_reconciled: entries.length,
                new_reconciled_balance: verified,
                message: `Reconciled ${entries.length} entries`,
                details: [
                    `Reconciled ${entries.length} entries totalling ${formatGbp(totalValue)}`,
                    `New reconciled balance: ${formatGbp(Math.trunc(newRecPounds * 100))}`,
                    `Remaining unreconciled: ${formatGbp(Math.trunc(remainingPounds * 100))}`,
                    `Statement number: ${statementNumber}`,
                    `Reconciliation batch: ${recBatchNumber}`,
                ],
            };
        }));
    }
    catch (err) {
        if (err instanceof ImportLockError) {
            return { success: false, error: err.message };
        }
        if (Array.isArray(err?.errors)) {
            return { success: false, errors: err.errors };
        }
        return { success: false, error: err?.message ?? String(err) };
    }
}
//# sourceMappingURL=mark-reconciled.js.map
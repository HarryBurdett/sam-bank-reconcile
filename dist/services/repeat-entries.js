import { validateBankCode, validateEntryNumber, SqlInputValidationError, } from '../_shared/index.js';
import { withImportLock, ImportLockError } from './import-lock.js';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export async function listRepeatEntries(operaDb, bankCode) {
    let bc;
    try {
        bc = validateBankCode(bankCode);
    }
    catch (e) {
        if (e instanceof SqlInputValidationError) {
            return {
                success: false,
                bank_code: bankCode,
                repeat_entries: [],
                count: 0,
                error: e.message,
            };
        }
        throw e;
    }
    try {
        const rows = (await operaDb.raw(`SELECT
         h.ae_entry, h.ae_desc, h.ae_nxtpost, h.ae_freq, h.ae_every,
         h.ae_posted, h.ae_topost, h.ae_type,
         l.at_value, l.at_account, l.at_cbtype, l.at_comment,
         CASE WHEN h.ae_topost = 0 OR h.ae_posted < h.ae_topost
              THEN 'Active'
              ELSE 'Completed'
         END AS status
       FROM arhead h WITH (NOLOCK)
       JOIN arline l WITH (NOLOCK)
         ON h.ae_entry = l.at_entry AND h.ae_acnt = l.at_acnt
       WHERE RTRIM(h.ae_acnt) = ?
       ORDER BY h.ae_nxtpost DESC`, [bc]));
        if (!Array.isArray(rows) || rows.length === 0) {
            return {
                success: true,
                bank_code: bc,
                repeat_entries: [],
                count: 0,
                message: `No repeat entries found for bank ${bc}`,
            };
        }
        const entries = rows.map((r) => {
            const amountPence = Number(r.at_value ?? 0);
            const status = r.status === 'Completed' ? 'Completed' : 'Active';
            const nextPost = r.ae_nxtpost instanceof Date
                ? r.ae_nxtpost.toISOString().slice(0, 10)
                : r.ae_nxtpost
                    ? String(r.ae_nxtpost).slice(0, 10)
                    : null;
            return {
                entry_ref: (r.ae_entry ?? '').toString().trim(),
                description: (r.ae_desc ?? '').toString().trim() ||
                    (r.at_comment ?? '').toString().trim(),
                next_post_date: nextPost,
                frequency: r.ae_freq ?? '',
                every: Number(r.ae_every ?? 1),
                posted_count: Number(r.ae_posted ?? 0),
                total_posts: Number(r.ae_topost ?? 0),
                status,
                amount_pence: amountPence,
                amount_pounds: Math.abs(amountPence) / 100,
                account: (r.at_account ?? '').toString().trim(),
                cb_type: (r.at_cbtype ?? '').toString().trim(),
            };
        });
        return {
            success: true,
            bank_code: bc,
            repeat_entries: entries,
            count: entries.length,
        };
    }
    catch (err) {
        return {
            success: false,
            bank_code: bc,
            repeat_entries: [],
            count: 0,
            error: err?.message ?? String(err),
        };
    }
}
export async function updateRepeatEntryDate(appDb, operaDb, input) {
    let bankCode;
    let entryRef;
    try {
        bankCode = validateBankCode(input.bankCode);
        entryRef = validateEntryNumber(input.entryRef);
    }
    catch (e) {
        if (e instanceof SqlInputValidationError) {
            return { success: false, error: e.message };
        }
        throw e;
    }
    const newDate = (input.newDate ?? '').trim();
    if (!DATE_RE.test(newDate)) {
        return {
            success: false,
            error: `Invalid date format: ${newDate}. Expected YYYY-MM-DD`,
        };
    }
    try {
        return await withImportLock(appDb, bankCode, { locked_by: 'api', endpoint: 'update-repeat-entry-date' }, async () => {
            // Verify the entry exists
            const verifyRows = (await operaDb.raw(`SELECT ae_entry, ae_desc, ae_nxtpost
           FROM arhead WITH (NOLOCK)
           WHERE RTRIM(ae_entry) = ?
             AND RTRIM(ae_acnt) = ?`, [entryRef, bankCode]));
            const existing = Array.isArray(verifyRows) ? verifyRows[0] : undefined;
            if (!existing) {
                return {
                    success: false,
                    error: `Repeat entry '${entryRef}' not found for bank '${bankCode}'`,
                };
            }
            const oldDate = existing.ae_nxtpost instanceof Date
                ? existing.ae_nxtpost.toISOString().slice(0, 10)
                : existing.ae_nxtpost
                    ? String(existing.ae_nxtpost).slice(0, 10)
                    : null;
            const description = (existing.ae_desc ?? '').toString().trim();
            // UPDATE arhead with audit fields — query-builder form so
            // rowsAffected is driver-agnostic (mssql/foxpro/sqlite).
            const rowsAffected = Number(await operaDb('arhead')
                .whereRaw('RTRIM(ae_entry) = ?', [entryRef])
                .andWhereRaw('RTRIM(ae_acnt) = ?', [bankCode])
                .update({
                ae_nxtpost: newDate,
                sq_amdate: operaDb.raw('CONVERT(varchar(10), GETDATE(), 23)'),
                sq_amtime: operaDb.raw('CONVERT(varchar(8), GETDATE(), 108)'),
                sq_amuser: 'BANKIMP',
            }));
            if (rowsAffected === 0) {
                return {
                    success: false,
                    error: 'No rows updated - entry may have been modified',
                };
            }
            // Best-effort alias save
            let aliasSaved = false;
            const statementName = (input.statementName ?? '').trim();
            if (statementName) {
                try {
                    const existingAlias = (await appDb('repeat_entry_aliases')
                        .where({ bank_code: bankCode, memo_pattern: statementName })
                        .first());
                    if (existingAlias) {
                        await appDb('repeat_entry_aliases')
                            .where({ id: existingAlias.id })
                            .update({
                            opera_repeat_ref: entryRef,
                            // description not in this table — keep schema simple
                        });
                        aliasSaved = true;
                    }
                    else {
                        await appDb('repeat_entry_aliases').insert({
                            bank_code: bankCode,
                            memo_pattern: statementName,
                            opera_repeat_ref: entryRef,
                        });
                        aliasSaved = true;
                    }
                }
                catch {
                    // best-effort — alias save failure doesn't fail the operation
                }
            }
            return {
                success: true,
                message: `Updated '${description}' next posting date to ${newDate}`,
                entry_ref: entryRef,
                old_date: oldDate,
                new_date: newDate,
                alias_saved: aliasSaved,
            };
        });
    }
    catch (err) {
        if (err instanceof ImportLockError) {
            return { success: false, error: err.message };
        }
        return { success: false, error: err?.message ?? String(err) };
    }
}
//# sourceMappingURL=repeat-entries.js.map
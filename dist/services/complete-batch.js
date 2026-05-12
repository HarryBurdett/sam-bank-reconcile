import { validateBankCode, validateEntryNumber, SqlInputValidationError, getPeriodForDate, getNextJournal, getNextId, getNacntType, updateNacntBalance, updateNbankBalance, insertNjmemo, generateOperaUniqueId, } from '../_shared/index.js';
import { withImportLock, ImportLockError } from './import-lock.js';
export async function completeBatch(appDb, operaDb, input) {
    let bankCode;
    let entryNumber;
    try {
        bankCode = validateBankCode(input.bankCode);
        entryNumber = validateEntryNumber(input.entryNumber);
    }
    catch (e) {
        if (e instanceof SqlInputValidationError) {
            return { success: false, error: e.message };
        }
        throw e;
    }
    try {
        return await withImportLock(appDb, bankCode, { locked_by: 'api', endpoint: 'complete-batch' }, async () => {
            // 1. Validate aentry
            const aentryRows = (await operaDb.raw(`SELECT ae_entry, ae_acnt, ae_complet, ae_value, ae_lstdate, ae_cbtype
           FROM aentry WITH (NOLOCK)
           WHERE ae_entry = ? AND RTRIM(ae_acnt) = ?`, [entryNumber, bankCode]));
            const entry = Array.isArray(aentryRows) ? aentryRows[0] : undefined;
            if (!entry) {
                return {
                    success: false,
                    errors: [`Entry ${entryNumber} not found for bank ${bankCode}`],
                };
            }
            if (Number(entry.ae_complet) === 1) {
                return {
                    success: false,
                    errors: [`Entry ${entryNumber} is already complete`],
                };
            }
            const postDate = entry.ae_lstdate instanceof Date
                ? entry.ae_lstdate.toISOString().slice(0, 10)
                : String(entry.ae_lstdate).slice(0, 10);
            const { period, year } = await getPeriodForDate(operaDb, postDate);
            // 2. Read atran's at_unique values for this entry
            const atranRows = (await operaDb.raw(`SELECT at_unique FROM atran WITH (NOLOCK)
           WHERE ae_entry = ? AND RTRIM(ae_acnt) = ?`, [entryNumber, bankCode]));
            if (!Array.isArray(atranRows) || atranRows.length === 0) {
                return {
                    success: false,
                    errors: [`No atran records found for entry ${entryNumber}`],
                };
            }
            const uniqueIds = atranRows.map((r) => String(r.at_unique).trim()).filter((s) => s.length > 0);
            if (uniqueIds.length === 0) {
                return {
                    success: false,
                    errors: [`No usable at_unique values for entry ${entryNumber}`],
                };
            }
            // Read unposted anoml rows
            const anomlPlaceholders = uniqueIds.map(() => '?').join(',');
            const anomlRows = (await operaDb.raw(`SELECT ax_nacnt, ax_ncntr, ax_source, ax_date, ax_value, ax_tref,
                  ax_comment, ax_done, ax_unique, ax_project, ax_job, ax_nlpdate
           FROM anoml WITH (NOLOCK)
           WHERE RTRIM(ax_unique) IN (${anomlPlaceholders})
             AND ax_done = 'N'
           ORDER BY ax_nacnt`, uniqueIds));
            // 3. No unposted anoml — just mark entry complete
            if (!Array.isArray(anomlRows) || anomlRows.length === 0) {
                await operaDb.raw(`UPDATE aentry WITH (ROWLOCK)
             SET ae_complet = 1, datemodified = GETDATE()
             WHERE ae_entry = ? AND RTRIM(ae_acnt) = ?`, [entryNumber, bankCode]);
                return {
                    success: true,
                    entry_number: entryNumber,
                    message: `Entry ${entryNumber} marked complete (no unposted transfer file records)`,
                    details: ['No unposted transfer file records found — entry marked complete'],
                };
            }
            // 4. Single transaction for the full posting
            return operaDb.transaction(async (trx) => {
                const nextJournal = await getNextJournal(trx);
                let ntranCount = 0;
                let bankDeltaPounds = 0;
                for (const a of anomlRows) {
                    const nacntCode = String(a.ax_nacnt ?? '').trim();
                    const axValue = Number(a.ax_value ?? 0);
                    const axSource = String(a.ax_source ?? '').trim();
                    const axTref = String(a.ax_tref ?? '').trim();
                    const axComment = String(a.ax_comment ?? '').trim();
                    const axUnique = String(a.ax_unique ?? '').trim();
                    const axDate = a.ax_date instanceof Date
                        ? a.ax_date.toISOString().slice(0, 10)
                        : String(a.ax_date).slice(0, 10);
                    // Look up nacnt type/subtype
                    const typeInfo = await getNacntType(trx, nacntCode);
                    if (!typeInfo) {
                        // Skip — same as Python warning + continue
                        continue;
                    }
                    // Generate ntran row
                    const ntranId = await getNextId(trx, 'ntran');
                    const ntranPstid = generateOperaUniqueId();
                    const trnref = `${axComment.padEnd(30, ' ').slice(0, 30)}${axTref.padEnd(10, ' ').slice(0, 10)}(RT)     `.slice(0, 50);
                    await trx.raw(`INSERT INTO ntran (
                 id,
                 nt_acnt, nt_cntr, nt_type, nt_subt, nt_jrnl,
                 nt_ref, nt_inp, nt_trtype, nt_cmnt, nt_trnref,
                 nt_entr, nt_value, nt_year, nt_period, nt_rvrse,
                 nt_prevyr, nt_consol, nt_fcurr, nt_fvalue, nt_fcrate,
                 nt_fcmult, nt_fcdec, nt_srcco, nt_cdesc, nt_project,
                 nt_job, nt_posttyp, nt_pstgrp, nt_pstid, nt_srcnlid,
                 nt_recurr, nt_perpost, nt_rectify, nt_recjrnl, nt_vatanal,
                 nt_distrib, datecreated, datemodified, state
               ) VALUES (
                 ?,
                 ?, '    ', ?, ?, ?,
                 ?, 'IMPORT', ?, ?, ?,
                 ?, ?, ?, ?, 0,
                 0, 0, '   ', 0, 0,
                 0, 0, 'I', '', '        ',
                 '        ', 'T', 0, ?, 0,
                 0, 0, 0, 0, 0,
                 0, GETDATE(), GETDATE(), 1
               )`, [
                        ntranId,
                        nacntCode,
                        typeInfo.na_type,
                        typeInfo.na_subt,
                        nextJournal,
                        axTref.slice(0, 10),
                        axSource,
                        axComment.slice(0, 50),
                        trnref,
                        axDate,
                        axValue,
                        year,
                        period,
                        ntranPstid,
                    ]);
                    ntranCount++;
                    await updateNacntBalance(trx, nacntCode, axValue, { period, year });
                    if (nacntCode === bankCode.trim()) {
                        bankDeltaPounds += axValue;
                    }
                    await trx.raw(`UPDATE anoml WITH (ROWLOCK)
               SET ax_done = 'Y', ax_jrnl = ?, datemodified = GETDATE()
               WHERE RTRIM(ax_unique) = ?
                 AND RTRIM(ax_nacnt) = ?
                 AND ax_done = 'N'`, [nextJournal, axUnique, nacntCode]);
                }
                if (bankDeltaPounds !== 0) {
                    await updateNbankBalance(trx, bankCode, bankDeltaPounds);
                }
                if (ntranCount > 0) {
                    await insertNjmemo(trx, nextJournal, 'Cashbook Ledger Transfer (RT)');
                }
                await trx.raw(`UPDATE aentry WITH (ROWLOCK)
             SET ae_complet = 1, datemodified = GETDATE()
             WHERE ae_entry = ? AND RTRIM(ae_acnt) = ?`, [entryNumber, bankCode]);
                const valuePounds = Number(entry.ae_value) / 100;
                return {
                    success: true,
                    entry_number: entryNumber,
                    message: `Batch ${entryNumber} completed and posted to nominal`,
                    details: [
                        `Posted ${ntranCount} nominal entries (journal ${nextJournal})`,
                        `Value: £${valuePounds.toFixed(2)}`,
                    ],
                };
            });
        });
    }
    catch (err) {
        if (err instanceof ImportLockError) {
            return { success: false, error: err.message };
        }
        return { success: false, error: err?.message ?? String(err) };
    }
}
//# sourceMappingURL=complete-batch.js.map
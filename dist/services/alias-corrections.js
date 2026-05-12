const DIRECTION_FOR_LEDGER = {
    S: 'payment', // Supplier → outgoing payment
    C: 'receipt', // Customer → incoming receipt
};
const MATCH_TYPE_FOR_LEDGER = {
    S: 'supplier',
    C: 'customer',
};
export async function recordCorrection(appDb, input) {
    const bankName = (input.bank_name ?? '').trim();
    const wrongAccount = (input.wrong_account ?? '').trim();
    const correctAccount = (input.correct_account ?? '').trim();
    const ledgerRaw = (input.ledger_type ?? '').trim().toUpperCase();
    const correctedBy = (input.corrected_by ?? 'USER').trim() || 'USER';
    if (!bankName || !wrongAccount || !correctAccount) {
        return {
            success: false,
            error: 'bank_name, wrong_account, and correct_account are required',
        };
    }
    if (ledgerRaw !== 'S' && ledgerRaw !== 'C') {
        return {
            success: false,
            error: "ledger_type must be 'S' (supplier) or 'C' (customer)",
        };
    }
    const ledger = ledgerRaw;
    try {
        await appDb.transaction(async (trx) => {
            // 1. Audit log
            await trx('alias_corrections').insert({
                bank_name: bankName,
                wrong_account: wrongAccount,
                correct_account: correctAccount,
                ledger_type: ledger,
                corrected_by: correctedBy,
            });
            // 2. Upsert positive alias with confidence=1.0. The primary
            //    alias table is bank_import_aliases (per migration 001) —
            //    keyed by (bank_code, payee_pattern). We don't have a
            //    bank_code at this layer (correction is bank-agnostic in
            //    the Python code) so use '*' as a wildcard bank_code.
            const existing = (await trx('bank_import_aliases')
                .where({
                bank_code: '*',
                payee_pattern: bankName,
                match_type: MATCH_TYPE_FOR_LEDGER[ledger],
            })
                .first());
            if (existing) {
                await trx('bank_import_aliases')
                    .where({ id: existing.id })
                    .update({
                    opera_account: correctAccount,
                    confidence: 1.0,
                    direction: DIRECTION_FOR_LEDGER[ledger],
                    updated_at: trx.fn.now(),
                });
            }
            else {
                await trx('bank_import_aliases').insert({
                    bank_code: '*',
                    payee_pattern: bankName,
                    match_type: MATCH_TYPE_FOR_LEDGER[ledger],
                    opera_account: correctAccount,
                    confidence: 1.0,
                    direction: DIRECTION_FOR_LEDGER[ledger],
                    match_count: 0,
                });
            }
            // 3. Negative example. UNIQUE(bank_name, wrong_account) — on
            //    conflict, skip silently (matches Python's INSERT OR IGNORE).
            const negKey = bankName.toUpperCase();
            const negExisting = (await trx('negative_aliases')
                .where({ bank_name: negKey, wrong_account: wrongAccount })
                .first());
            if (!negExisting) {
                await trx('negative_aliases').insert({
                    bank_name: negKey,
                    wrong_account: wrongAccount,
                });
            }
        });
        return {
            success: true,
            message: `Correction recorded: '${bankName}' -> ${correctAccount}`,
        };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
// ---------------------------------------------------------------------
// isNegativeMatch — used by the matcher to avoid known-wrong mappings
// ---------------------------------------------------------------------
export async function isNegativeMatch(appDb, bankName, account) {
    const key = (bankName ?? '').trim().toUpperCase();
    const acct = (account ?? '').trim();
    if (!key || !acct)
        return false;
    try {
        const row = (await appDb('negative_aliases')
            .where({ bank_name: key, wrong_account: acct })
            .first());
        return !!row;
    }
    catch {
        return false;
    }
}
function dateToIso(d) {
    if (!d)
        return '';
    if (d instanceof Date) {
        if (Number.isNaN(d.getTime()))
            return '';
        return d.toISOString();
    }
    return String(d);
}
export async function listCorrections(appDb, opts = {}) {
    try {
        const limit = opts.limit ?? 200;
        let query = appDb('alias_corrections')
            .orderBy('created_at', 'desc')
            .limit(limit);
        if (opts.bankName) {
            query = query.where({ bank_name: opts.bankName });
        }
        if (opts.correctAccount) {
            query = query.where({ correct_account: opts.correctAccount });
        }
        const rows = (await query);
        const entries = rows.map((r) => ({
            id: r.id,
            bank_name: r.bank_name,
            wrong_account: r.wrong_account ?? '',
            correct_account: r.correct_account ?? '',
            ledger_type: (r.ledger_type ?? 'C'),
            corrected_by: r.corrected_by ?? '',
            created_at: dateToIso(r.created_at),
        }));
        return { success: true, entries, count: entries.length };
    }
    catch (err) {
        return {
            success: false,
            entries: [],
            count: 0,
            error: err?.message ?? String(err),
        };
    }
}
//# sourceMappingURL=alias-corrections.js.map
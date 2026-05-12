function ledgerToMatchType(ledger) {
    return ledger === 'C' ? 'customer' : 'supplier';
}
/**
 * Look up an alias for a (payee, ledger) pair, preferring a bank-scoped
 * row over a global one. Returns null when no row matches.
 */
export async function lookupAlias(appDb, payeeName, ledger, bankCode) {
    if (!appDb)
        return null;
    const name = (payeeName ?? '').trim();
    if (!name)
        return null;
    const matchType = ledgerToMatchType(ledger);
    const code = (bankCode ?? '').trim();
    try {
        // Bank-scoped first.
        if (code) {
            const scoped = (await appDb('bank_import_aliases')
                .select('opera_account', 'confidence', 'match_type')
                .whereRaw('UPPER(payee_pattern) = ?', [name.toUpperCase()])
                .andWhere('match_type', matchType)
                .andWhere('bank_code', code)
                .first());
            if (scoped?.opera_account) {
                return {
                    account: scoped.opera_account.trim(),
                    matchType: scoped.match_type,
                    confidence: Number(scoped.confidence ?? 1),
                };
            }
        }
        // Global (empty bank_code) fallback.
        const global = (await appDb('bank_import_aliases')
            .select('opera_account', 'confidence', 'match_type')
            .whereRaw('UPPER(payee_pattern) = ?', [name.toUpperCase()])
            .andWhere('match_type', matchType)
            .andWhere(function emptyBankCode() {
            this.whereNull('bank_code').orWhere('bank_code', '');
        })
            .first());
        if (global?.opera_account) {
            return {
                account: global.opera_account.trim(),
                matchType: global.match_type,
                confidence: Number(global.confidence ?? 1),
            };
        }
        return null;
    }
    catch {
        return null;
    }
}
/**
 * Save (insert-or-update) an alias. Matches legacy `save_alias` upsert
 * semantics: per-bank if `bankCode` non-empty, else global.
 */
export async function saveAlias(appDb, opts) {
    if (!appDb)
        return false;
    const name = (opts.payeeName ?? '').trim();
    const account = (opts.operaAccount ?? '').trim();
    if (!name || !account)
        return false;
    const matchType = ledgerToMatchType(opts.ledger);
    const bankCode = (opts.bankCode ?? '').trim();
    const confidence = Math.min(1, Math.max(0, Number(opts.matchScore || 0)));
    const direction = opts.direction ?? 'either';
    try {
        const existing = (await appDb('bank_import_aliases')
            .select('id', 'match_count')
            .whereRaw('UPPER(payee_pattern) = ?', [name.toUpperCase()])
            .andWhere('match_type', matchType)
            .andWhere(function scope() {
            if (bankCode) {
                this.where('bank_code', bankCode);
            }
            else {
                this.whereNull('bank_code').orWhere('bank_code', '');
            }
        })
            .first());
        const nowIso = new Date().toISOString();
        if (existing?.id) {
            const updated = Number(await appDb('bank_import_aliases')
                .where({ id: existing.id })
                .update({
                opera_account: account,
                confidence,
                direction,
                match_count: Number(existing.match_count ?? 0) + 1,
                updated_at: nowIso,
            }));
            return updated > 0;
        }
        await appDb('bank_import_aliases').insert({
            bank_code: bankCode,
            payee_pattern: name,
            match_type: matchType,
            opera_account: account,
            confidence,
            direction,
            match_count: 1,
            created_at: nowIso,
            updated_at: nowIso,
        });
        return true;
    }
    catch {
        return false;
    }
}
export async function lookupRepeatEntryAlias(appDb, memoPattern, bankCode) {
    if (!appDb)
        return null;
    const pattern = (memoPattern ?? '').trim();
    if (!pattern)
        return null;
    try {
        const row = (await appDb('repeat_entry_aliases')
            .select('opera_repeat_ref', 'bank_code')
            .whereRaw('UPPER(memo_pattern) = ?', [pattern.toUpperCase()])
            .andWhere('bank_code', bankCode)
            .first());
        if (!row?.opera_repeat_ref)
            return null;
        return {
            entry_ref: row.opera_repeat_ref.trim(),
            bank_code: row.bank_code.trim(),
        };
    }
    catch {
        return null;
    }
}
export async function saveRepeatEntryAlias(appDb, memoPattern, bankCode, operaRepeatRef) {
    if (!appDb)
        return false;
    const pattern = (memoPattern ?? '').trim();
    const ref = (operaRepeatRef ?? '').trim();
    if (!pattern || !ref)
        return false;
    try {
        const existing = (await appDb('repeat_entry_aliases')
            .select('id')
            .whereRaw('UPPER(memo_pattern) = ?', [pattern.toUpperCase()])
            .andWhere('bank_code', bankCode)
            .first());
        if (existing?.id) {
            await appDb('repeat_entry_aliases')
                .where({ id: existing.id })
                .update({ opera_repeat_ref: ref });
            return true;
        }
        await appDb('repeat_entry_aliases').insert({
            bank_code: bankCode,
            memo_pattern: pattern,
            opera_repeat_ref: ref,
            created_at: new Date().toISOString(),
        });
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=bank-aliases.js.map
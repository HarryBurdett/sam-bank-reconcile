const NOT_TRANSFER = {
    is_transfer: false,
    dest_bank_code: '',
    dest_bank_description: '',
    match_score: 0,
    match_source: 'none',
};
/**
 * Load every other (non-this) Opera bank account that has either a
 * sort code or an account number — those are the only banks we can
 * meaningfully match against. Petty-cash and foreign-currency banks
 * are excluded (legacy filter).
 */
export async function loadOtherBankAccounts(operaDb, thisBankCode) {
    try {
        const rows = (await operaDb('nbank')
            .select(operaDb.raw('RTRIM(nk_acnt) as code'), operaDb.raw('RTRIM(nk_desc) as description'), operaDb.raw("RTRIM(ISNULL(nk_sort, '')) as sort_code"), operaDb.raw("RTRIM(ISNULL(nk_number, '')) as account_number"))
            .whereRaw('RTRIM(nk_acnt) <> ?', [thisBankCode])
            .andWhere('nk_petty', 0)
            .andWhere(function noForeignCurrency() {
            this.whereNull('nk_fcurr').orWhereRaw("RTRIM(nk_fcurr) = ''");
        }));
        return (rows ?? [])
            .map((r) => {
            const sortNorm = (r.sort_code ?? '').replace(/[\s-]/g, '');
            const acctNorm = (r.account_number ?? '').replace(/\s/g, '');
            return {
                code: (r.code ?? '').trim(),
                description: (r.description ?? '').trim(),
                sort_code: sortNorm,
                account_number: acctNorm,
            };
        })
            .filter((b) => b.sort_code || b.account_number);
    }
    catch {
        return [];
    }
}
/**
 * Detect whether `(memo + name + reference)` describes a transfer to
 * another Opera bank account.
 */
export function checkBankTransfer(otherBanks, memo, name, reference) {
    if (!otherBanks.length)
        return NOT_TRANSFER;
    const raw = `${memo ?? ''} ${name ?? ''} ${reference ?? ''}`;
    // Normalised (digits-only) text — used for account-number checks
    // and the digit-substring half of the sort-code check.
    const search = raw.replace(/[\s-]/g, '');
    for (const bank of otherBanks) {
        // 1. Account-number match — most specific.
        if (bank.account_number && bank.account_number.length >= 6) {
            if (search.includes(bank.account_number)) {
                return {
                    is_transfer: true,
                    dest_bank_code: bank.code,
                    dest_bank_description: bank.description,
                    match_score: 1.0,
                    match_source: 'bank_account_number',
                };
            }
        }
        // 2. Sort-code match — only with extra evidence (literal dashed
        // or spaced form in the raw text).
        if (bank.sort_code && bank.sort_code.length >= 6) {
            const sort = bank.sort_code;
            const dashed = `${sort.slice(0, 2)}-${sort.slice(2, 4)}-${sort.slice(4, 6)}`;
            const spaced = `${sort.slice(0, 2)} ${sort.slice(2, 4)} ${sort.slice(4, 6)}`;
            if (search.includes(sort) &&
                (raw.includes(dashed) || raw.includes(spaced))) {
                return {
                    is_transfer: true,
                    dest_bank_code: bank.code,
                    dest_bank_description: bank.description,
                    match_score: 0.9,
                    match_source: 'bank_sort_code_formatted',
                };
            }
        }
    }
    return NOT_TRANSFER;
}
//# sourceMappingURL=check-bank-transfer.js.map
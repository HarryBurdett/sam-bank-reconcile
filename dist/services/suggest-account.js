import { sequenceMatcherRatio } from '../_shared/index.js';
const SALES_TYPES = new Set(['sales_receipt', 'sales_refund']);
async function loadCustomers(operaDb) {
    try {
        return (await operaDb('sname')
            .select('sn_account as code', operaDb.raw('RTRIM(sn_name) as name'))
            .where(function notStopped() {
            this.where('sn_stop', 0).orWhereNull('sn_stop');
        })
            .andWhere(function notDormant() {
            this.where('sn_dormant', 0).orWhereNull('sn_dormant');
        })
            .orderBy('sn_name'));
    }
    catch {
        return [];
    }
}
async function loadSuppliers(operaDb) {
    try {
        return (await operaDb('pname')
            .select('pn_account as code', operaDb.raw('RTRIM(pn_name) as name'))
            .where(function notStopped() {
            this.where('pn_stop', 0).orWhereNull('pn_stop');
        })
            .andWhere(function notDormant() {
            this.where('pn_dormant', 0).orWhereNull('pn_dormant');
        })
            .orderBy('pn_name'));
    }
    catch {
        return [];
    }
}
function significantWords(s) {
    return new Set(s.split(/\s+/).filter((w) => w.length > 2));
}
export async function suggestAccountForTransaction(operaDb, name, transactionType, limit = 5) {
    try {
        const isCustomer = SALES_TYPES.has(transactionType);
        const accounts = isCustomer
            ? await loadCustomers(operaDb)
            : await loadSuppliers(operaDb);
        if (accounts.length === 0) {
            return {
                success: true,
                suggestions: [],
                ledger_type: isCustomer ? 'C' : 'S',
                searched_count: 0,
                search_term: name,
            };
        }
        const nameUpper = (name ?? '').toUpperCase().trim();
        const nameWords = significantWords(nameUpper);
        const matches = [];
        for (const a of accounts) {
            const code = (a.code ?? '').toString().trim();
            const accName = (a.name ?? '').toString().trim();
            if (!accName)
                continue;
            const accUpper = accName.toUpperCase();
            // Strategy 1: substring
            if (accUpper.includes(nameUpper) || nameUpper.includes(accUpper)) {
                matches.push({
                    code,
                    name: accName,
                    score: 95,
                    match_type: 'substring',
                });
                continue;
            }
            // Strategy 2: significant-word intersection
            const accWords = significantWords(accUpper);
            const common = new Set();
            for (const w of nameWords)
                if (accWords.has(w))
                    common.add(w);
            if (common.size > 0 && common.size >= Math.min(2, accWords.size)) {
                const rawScore = (common.size / Math.max(nameWords.size, accWords.size)) * 100;
                if (rawScore >= 40) {
                    matches.push({
                        code,
                        name: accName,
                        score: Math.floor(Math.min(90, rawScore + 30)),
                        match_type: 'word_match',
                    });
                    continue;
                }
            }
            // Strategy 3: Ratcliff/Obershelp ratio
            const ratio = sequenceMatcherRatio(nameUpper, accUpper) * 100;
            if (ratio >= 60) {
                matches.push({
                    code,
                    name: accName,
                    score: Math.floor(ratio),
                    match_type: 'fuzzy',
                });
            }
        }
        matches.sort((a, b) => b.score - a.score);
        return {
            success: true,
            suggestions: matches.slice(0, limit),
            ledger_type: isCustomer ? 'C' : 'S',
            searched_count: accounts.length,
            search_term: name,
        };
    }
    catch (err) {
        return {
            success: false,
            suggestions: [],
            error: err?.message ?? String(err),
        };
    }
}
//# sourceMappingURL=suggest-account.js.map
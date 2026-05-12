/**
 * Fuzzy name matching for bank statement transactions.
 *
 * Faithful port of `BankMatcher` and supporting dataclasses in
 * `sql_rag/bank_matching.py:43-490`. Identical behaviour on Opera SE
 * and Opera 3 — pure JS, no DB.
 *
 * Each `MatchCandidate` carries a primary name plus optional payee
 * name, vendor ref, and search keys; the matcher tries every name and
 * keeps the best score. Scoring combines:
 *   - SequenceMatcher ratio   (character-level similarity, weight 0.25)
 *   - Token Jaccard           (word-order independence,    weight 0.35)
 *   - Word containment        (truncated names,             weight 0.40)
 *   - Prefix-match boost      (one-is-prefix-of-the-other  bonus  +0.30)
 *
 * Two short-circuit rules from legacy:
 *   - prefix score > 0.5 → take that score directly (overrides combined)
 *   - containment ≥ 0.9 AND token ≥ 0.5 → floor at 0.85
 */
import { sequenceMatcherRatio } from '../_shared/index.js';
const ABBREVIATIONS = {
    LTD: 'LIMITED',
    CO: 'COMPANY',
    CORP: 'CORPORATION',
    INC: 'INCORPORATED',
    INTL: 'INTERNATIONAL',
    INT: 'INTERNATIONAL',
    MGMT: 'MANAGEMENT',
    MGT: 'MANAGEMENT',
    SVCS: 'SERVICES',
    SVC: 'SERVICE',
    SERV: 'SERVICES',
    TECH: 'TECHNOLOGY',
    TECHS: 'TECHNOLOGIES',
    ASSOC: 'ASSOCIATES',
    ASSOCS: 'ASSOCIATES',
    BROS: 'BROTHERS',
    MFG: 'MANUFACTURING',
    DIST: 'DISTRIBUTION',
    DISTRIB: 'DISTRIBUTION',
    GOVT: 'GOVERNMENT',
    NATL: 'NATIONAL',
    ENGR: 'ENGINEERING',
    ENG: 'ENGINEERING',
    ELEC: 'ELECTRICAL',
    ELECT: 'ELECTRICAL',
    COMMS: 'COMMUNICATIONS',
    COMM: 'COMMUNICATIONS',
    UK: 'UNITED KINGDOM',
    GRP: 'GROUP',
    HLDGS: 'HOLDINGS',
    ACCT: 'ACCOUNT',
    ACCTS: 'ACCOUNTS',
    ADMIN: 'ADMINISTRATION',
    ADV: 'ADVERTISING',
    ADVTG: 'ADVERTISING',
    CONS: 'CONSULTING',
    CONSULT: 'CONSULTING',
};
const STOPWORDS = new Set([
    'THE',
    'AND',
    'OF',
    'FOR',
    'A',
    'AN',
    'IN',
    'ON',
    'AT',
    'TO',
    'BY',
]);
export const EMPTY_MATCH = {
    account: null,
    name: null,
    score: 0,
    source: '',
};
function getAllMatchNames(c) {
    const names = [];
    if (c.primary_name)
        names.push({ name: c.primary_name, source: 'primary' });
    if (c.payee_name?.trim())
        names.push({ name: c.payee_name, source: 'payee' });
    if (c.vendor_ref?.trim())
        names.push({ name: c.vendor_ref, source: 'vendor_ref' });
    if (Array.isArray(c.search_keys)) {
        c.search_keys.forEach((key, i) => {
            if (key?.trim())
                names.push({ name: key, source: `key${i + 1}` });
        });
    }
    return names;
}
export function normaliseName(name) {
    if (!name)
        return '';
    let n = name.toUpperCase();
    // Keep letters/digits/underscore/whitespace, replace anything else with space
    n = n.replace(/[^\w\s]/g, ' ');
    const words = n.split(/\s+/).filter(Boolean);
    const expanded = words.map((w) => ABBREVIATIONS[w] ?? w);
    return expanded.join(' ').trim();
}
function getSignificantTokens(name) {
    if (!name)
        return new Set();
    const tokens = name.toUpperCase().split(/\s+/).filter(Boolean);
    return new Set(tokens.filter((t) => !STOPWORDS.has(t) && t.length > 1));
}
function tokenMatch(a, b) {
    if (!a || !b)
        return 0;
    const aT = getSignificantTokens(a);
    const bT = getSignificantTokens(b);
    if (aT.size === 0 || bT.size === 0)
        return 0;
    let intersection = 0;
    for (const t of aT)
        if (bT.has(t))
            intersection += 1;
    const union = aT.size + bT.size - intersection;
    if (union === 0)
        return 0;
    return intersection / union;
}
function wordContainmentScore(name, candidate) {
    if (!name || !candidate)
        return 0;
    const nameT = getSignificantTokens(name);
    const candT = getSignificantTokens(candidate);
    if (nameT.size === 0)
        return 0;
    let matches = 0;
    for (const t of nameT)
        if (candT.has(t))
            matches += 1;
    return matches / nameT.size;
}
function prefixMatchScore(name, candidate) {
    if (!name || !candidate)
        return 0;
    const a = name.toUpperCase();
    const b = candidate.toUpperCase();
    if (a.startsWith(b) || b.startsWith(a)) {
        const min = Math.min(a.length, b.length);
        const max = Math.max(a.length, b.length);
        const base = min / max;
        return Math.min(1, base + 0.3);
    }
    return 0;
}
export function calculateMatchScore(bankName, candidateName) {
    if (!bankName || !candidateName)
        return 0;
    const normBank = normaliseName(bankName);
    const normCand = normaliseName(candidateName);
    if (!normBank || !normCand)
        return 0;
    const seqScore = sequenceMatcherRatio(normBank, normCand);
    const tokScore = tokenMatch(normBank, normCand);
    const contScore = wordContainmentScore(normBank, normCand);
    const prefScore = prefixMatchScore(bankName, candidateName);
    let combined = seqScore * 0.25 + tokScore * 0.35 + contScore * 0.4;
    if (prefScore > 0.5)
        combined = Math.max(combined, prefScore);
    if (contScore >= 0.9 && tokScore >= 0.5)
        combined = Math.max(combined, 0.85);
    return Math.min(1, combined);
}
function matchAgainst(name, candidates) {
    if (!name || candidates.size === 0)
        return { ...EMPTY_MATCH };
    let best = { ...EMPTY_MATCH };
    for (const [account, candidate] of candidates) {
        for (const { name: candName, source } of getAllMatchNames(candidate)) {
            if (!candName)
                continue;
            let score = calculateMatchScore(name, candName);
            // Slight preference for primary-name matches.
            if (source !== 'primary' && score > 0)
                score *= 0.95;
            if (score > best.score) {
                best = {
                    account,
                    name: candidate.primary_name,
                    score,
                    source,
                };
            }
        }
    }
    return best;
}
export class BankMatcher {
    minScore;
    customers = new Map();
    suppliers = new Map();
    constructor(minScore = 0.6) {
        this.minScore = minScore;
    }
    loadCustomers(customers) {
        this.customers.clear();
        for (const c of customers)
            this.customers.set(c.account, c);
    }
    loadSuppliers(suppliers) {
        this.suppliers.clear();
        for (const s of suppliers)
            this.suppliers.set(s.account, s);
    }
    matchCustomer(name) {
        const r = matchAgainst(name, this.customers);
        const isMatch = r.account !== null && r.score >= this.minScore;
        if (!isMatch) {
            return { ...EMPTY_MATCH, score: r.score, is_match: false };
        }
        return { ...r, is_match: true };
    }
    matchSupplier(name) {
        const r = matchAgainst(name, this.suppliers);
        const isMatch = r.account !== null && r.score >= this.minScore;
        if (!isMatch) {
            return { ...EMPTY_MATCH, score: r.score, is_match: false };
        }
        return { ...r, is_match: true };
    }
}
/**
 * Load the customer set from Opera (sname) into MatchCandidate shape.
 * Excludes dormant + stopped accounts per CLAUDE.md rule.
 */
export async function loadCustomerCandidates(operaDb) {
    try {
        const rows = (await operaDb('sname')
            .select(operaDb.raw('RTRIM(sn_account) as account'), operaDb.raw('RTRIM(sn_name) as primary_name'), operaDb.raw("RTRIM(ISNULL(sn_key1, '')) as key1"), operaDb.raw("RTRIM(ISNULL(sn_key2, '')) as key2"), operaDb.raw("RTRIM(ISNULL(sn_key3, '')) as key3"), operaDb.raw("RTRIM(ISNULL(sn_key4, '')) as key4"), operaDb.raw("RTRIM(ISNULL(sn_vendor, '')) as vendor_ref"))
            .where(function notStopped() {
            this.where('sn_stop', 0).orWhereNull('sn_stop');
        })
            .andWhere(function notDormant() {
            this.where('sn_dormant', 0).orWhereNull('sn_dormant');
        }));
        return rows.map((r) => ({
            account: (r.account ?? '').trim(),
            primary_name: (r.primary_name ?? '').trim(),
            search_keys: [r.key1, r.key2, r.key3, r.key4].map((k) => (k ?? '').trim()),
            vendor_ref: (r.vendor_ref ?? '').trim() || null,
        }));
    }
    catch {
        return [];
    }
}
/**
 * Load the supplier set from Opera (pname) into MatchCandidate shape.
 * Excludes dormant + stopped accounts per CLAUDE.md rule.
 */
export async function loadSupplierCandidates(operaDb) {
    try {
        const rows = (await operaDb('pname')
            .select(operaDb.raw('RTRIM(pn_account) as account'), operaDb.raw('RTRIM(pn_name) as primary_name'), operaDb.raw("RTRIM(ISNULL(pn_payee, '')) as payee_name"), operaDb.raw("RTRIM(ISNULL(pn_key1, '')) as key1"), operaDb.raw("RTRIM(ISNULL(pn_key2, '')) as key2"), operaDb.raw("RTRIM(ISNULL(pn_key3, '')) as key3"), operaDb.raw("RTRIM(ISNULL(pn_key4, '')) as key4"))
            .where(function notStopped() {
            this.where('pn_stop', 0).orWhereNull('pn_stop');
        })
            .andWhere(function notDormant() {
            this.where('pn_dormant', 0).orWhereNull('pn_dormant');
        }));
        return rows.map((r) => ({
            account: (r.account ?? '').trim(),
            primary_name: (r.primary_name ?? '').trim(),
            payee_name: (r.payee_name ?? '').trim() || null,
            search_keys: [r.key1, r.key2, r.key3, r.key4].map((k) => (k ?? '').trim()),
        }));
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=bank-matcher.js.map
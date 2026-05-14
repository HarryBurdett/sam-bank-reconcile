/**
 * Extract payee/payer name from bank statement description.
 *
 * Faithful port of `extract_payee_name_full`
 * (sql_rag/bank_import.py:135-216). Used by the matcher to clean
 * AI-extracted descriptions before fuzzy matching, e.g.:
 *
 *   "Giro Direct Credit From Balladeer Limited Ref: Inv.26395"
 *     → "Balladeer Limited"
 *
 *   "DD Direct Debit to HMRC E VAT Ref: 000917304990"
 *     → "HMRC E VAT"
 *
 *   "Card Purchase Tyreland Limited On 10 Feb"
 *     → "Tyreland Limited"
 *
 *   "MJM DATA CAPTURE LTD, SUPPLIER, FP 23/03/26 40, 11013128004084000N"
 *     → "MJM DATA CAPTURE LTD"
 *
 * Pure text manipulation — no DB, identical behaviour on Opera SE and
 * Opera 3.
 */
const BANK_METHOD_SUFFIX_RE = /\s*\(\s*(?:faster\s*pay(?:\.\.\.|…|ments?)|direct\s*debit|standing\s*order|bacs|chaps|card\s*payment|cheque|cash|online\s*payment|transfer)\s*\)\s*$/i;
const CLASSIFICATION_LABEL_RE = /^(?:SUPPLIER|CUSTOMER|PAYMENT|RECEIPT|TRANSFER|SALARY|WAGES|REFUND)\s*[-–:]\s*/i;
const PRIMARY_MATCH_RE = /(?:(?:dd\s+)?direct\s+debit\s+to|(?:giro\s+)?direct\s+credit\s+from|card\s+payment\s+to|card\s+purchase|faster\s+payment\s+to|faster\s+payment\s+from|standing\s+order\s+to|bank\s+giro\s+credit\s+from|(?:on[-\s]?line\s+banking\s+)?bill\s+payment\s+to|(?:on[-\s]?line\s+banking\s+)?transfer\s+to|(?:on[-\s]?line\s+banking\s+)?transfer\s+from)\s+(.+)/i;
const TAIL_STRIP_RE = /\s+(?:on\s+\d{1,2}\s|ref:\s|ref\s|\d{5,})|\*/i;
const FALLBACK_PREFIX_RE = /^(?:dd\s+)?(?:card\s+payment|direct\s+debit|direct\s+credit|faster\s+payment|standing\s+order|(?:giro\s+)?(?:bank\s+)?giro\s+credit|counter\s+credit)\s*/i;
const TAIL_TO_FROM_RE = /\s+(?:to|from)\s*$/i;
const CLASSIFICATION_WORDS = new Set([
    'SUPPLIER',
    'CUSTOMER',
    'VOLUNTEER',
    'SALARY',
    'WAGES',
    'GP',
    'EMPLOYEE',
    'STAFF',
    'REFUND',
    'PENSION',
]);
const PAYMENT_REF_PREFIX_RE = /^(?:FP|DD|SO|BGC|CHQ|BACS)\s/i;
const DIGITS_PREFIX_RE = /^\d{8,}/;
export function extractPayeeName(description) {
    if (!description)
        return '';
    let text = description.replace(/\n/g, ' ').replace(/\r/g, ' ').trim();
    // Strip AI-added classification labels ("SUPPLIER - Name", "CUSTOMER: Name", etc.).
    text = text.replace(CLASSIFICATION_LABEL_RE, '').trim();
    // Comma-separated bank descriptions: keep just the payee name (first
    // field), stop when we hit a classification keyword or payment-ref
    // pattern.
    if (text.includes(',')) {
        const parts = text.split(',').map((p) => p.trim());
        for (let i = 1; i < parts.length; i++) {
            const upper = parts[i].toUpperCase();
            if (CLASSIFICATION_WORDS.has(upper) ||
                PAYMENT_REF_PREFIX_RE.test(upper) ||
                DIGITS_PREFIX_RE.test(upper)) {
                text = parts.slice(0, i).join(', ').trim();
                break;
            }
        }
    }
    // Try the canonical bank-method-prefix pattern first.
    const primary = text.match(PRIMARY_MATCH_RE);
    if (primary?.[1]) {
        const remainder = primary[1].trim();
        const head = remainder.split(TAIL_STRIP_RE)[0]?.trim() ?? '';
        const name = head.replace(/[\s*]+$/, '');
        if (name)
            return name;
    }
    // Fallback: just strip the well-known prefix.
    let cleaned = text.replace(FALLBACK_PREFIX_RE, '').trim();
    cleaned = cleaned.replace(TAIL_TO_FROM_RE, '').trim();
    let result = cleaned || text;
    // Loop to strip trailing bank-method suffixes — stripping one might
    // expose another.
    while (true) {
        const next = result.replace(BANK_METHOD_SUFFIX_RE, '').trim();
        if (next === result)
            break;
        result = next;
    }
    return result;
}
//# sourceMappingURL=extract-payee-name.js.map
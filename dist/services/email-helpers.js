/**
 * Deterministic helpers for bank-reconcile scan-emails.
 *
 * Faithful ports of the pure helpers in `api/main.py`:
 *   - BANK_STATEMENT_PATTERNS / BANK_STATEMENT_EXTENSIONS / BANK_STATEMENT_CONTENT_TYPES
 *   - detect_bank_from_email             (api/main.py:10734)
 *   - extract_statement_number_from_filename (api/main.py:10761)
 *   - is_bank_statement_attachment       (api/main.py:10835)
 *
 * These are used by the scan-emails service to filter, classify and
 * sort bank-statement attachments without needing a database or
 * external services.
 */
const BANK_STATEMENT_PATTERNS = {
    barclays: {
        sender_patterns: ['@barclays.co.uk', '@barclays.com', 'barclays'],
        filename_patterns: ['barclays', 'bcb_statement'],
    },
    lloyds: {
        sender_patterns: ['@lloydsbank.co.uk', '@lloydsbank.com', 'lloyds'],
        filename_patterns: ['lloyds', 'lbg_statement'],
    },
    hsbc: {
        sender_patterns: ['@hsbc.co.uk', '@hsbc.com', 'hsbc'],
        filename_patterns: ['hsbc'],
    },
    natwest: {
        sender_patterns: ['@natwest.com', 'natwest'],
        filename_patterns: ['natwest'],
    },
    santander: {
        sender_patterns: ['@santander.co.uk', 'santander'],
        filename_patterns: ['santander'],
    },
    tide: {
        sender_patterns: ['@tide.co', '@tidebank.co.uk', 'tide'],
        filename_patterns: ['tide'],
    },
    monzo: {
        sender_patterns: ['@monzo.com', 'monzo'],
        filename_patterns: ['monzo'],
    },
    starling: {
        sender_patterns: ['@starlingbank.com', 'starling'],
        filename_patterns: ['starling'],
    },
    nationwide: {
        sender_patterns: ['@nationwide.co.uk', 'nationwide'],
        filename_patterns: ['nationwide'],
    },
    rbs: {
        sender_patterns: ['@rbs.co.uk', 'royal bank of scotland'],
        filename_patterns: ['rbs'],
    },
    tsb: {
        sender_patterns: ['@tsb.co.uk', 'tsb'],
        filename_patterns: ['tsb'],
    },
    metro: {
        sender_patterns: ['@metrobankonline.co.uk', 'metro bank'],
        filename_patterns: ['metro'],
    },
    revolut: {
        sender_patterns: ['@revolut.com', 'revolut'],
        filename_patterns: ['revolut'],
    },
};
const BANK_STATEMENT_EXTENSIONS = new Set([
    '.csv', '.ofx', '.qif', '.mt940', '.sta', '.pdf',
]);
const BANK_STATEMENT_CONTENT_TYPES = new Set([
    'text/csv',
    'application/csv',
    'text/plain',
    'application/vnd.ms-excel',
    'application/ofx',
    'application/pdf',
    'application/x-ofx',
    'application/qif',
]);
const KNOWN_BANK_KEYWORDS = [
    'barclays',
    'lloyds',
    'hsbc',
    'natwest',
    'santander',
    'nationwide',
    'rbs',
    'tsb',
    'metro',
    'tide',
    'monzo',
    'starling',
    'revolut',
];
const MONTH_NAMES = {
    jan: 1, january: 1,
    feb: 2, february: 2,
    mar: 3, march: 3,
    apr: 4, april: 4,
    may: 5,
    jun: 6, june: 6,
    jul: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, september: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12,
};
const MONTH_ABBRS = [
    'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
    'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
];
export function detectBankFromEmail(fromAddress, filename, subject = '') {
    const fromLower = (fromAddress ?? '').toLowerCase();
    const filenameLower = (filename ?? '').toLowerCase();
    const subjectLower = (subject ?? '').toLowerCase();
    for (const [bankName, patterns] of Object.entries(BANK_STATEMENT_PATTERNS)) {
        for (const p of patterns.sender_patterns) {
            if (fromLower.includes(p.toLowerCase()))
                return bankName;
        }
        for (const p of patterns.filename_patterns) {
            if (filenameLower.includes(p.toLowerCase()))
                return bankName;
        }
        for (const p of patterns.filename_patterns) {
            if (subjectLower.includes(p.toLowerCase()))
                return bankName;
        }
    }
    return null;
}
function hashStringToInt(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    return Math.abs(h) % 1000;
}
export function extractStatementNumberFromFilename(filename, subject = null) {
    if (!filename) {
        return { sort_key: [9999, 99, 99, 0], display_date: null };
    }
    const searchText = subject
        ? `${filename.toLowerCase()} ${subject.toLowerCase()}`
        : filename.toLowerCase();
    const baseName = filename.toLowerCase().split('.').slice(0, -1).join('.') || filename.toLowerCase();
    const formatDay = (n) => `${n}`.padStart(2, '0');
    const monthAbbr = (n) => MONTH_ABBRS[n - 1] ?? '???';
    // Pattern 1: DD-MMM-YY or DD/MMM/YY (e.g., "08-JAN-26")
    for (const [name, num] of Object.entries(MONTH_NAMES)) {
        const re = new RegExp(`(\\d{1,2})[-/\\s](${name})[-/\\s](\\d{2,4})`, 'i');
        const m = re.exec(searchText);
        if (m) {
            const day = Number(m[1]);
            let year = Number(m[3]);
            if (Number.isFinite(day) && Number.isFinite(year)) {
                if (year < 100)
                    year = year < 50 ? 2000 + year : 1900 + year;
                return {
                    sort_key: [year, num, day, 0],
                    display_date: `${formatDay(day)}-${monthAbbr(num)}-${year}`,
                };
            }
        }
    }
    // Pattern 2: YYYY-MM-DD (must run BEFORE the DD-MM-YYYY pattern below
    // because filenames like "Monzo_bank_statement_2026-04-01-2026-04-28"
    // contain two YYYY-MM-DD dates joined by a hyphen — the DD-MM-YYYY
    // pattern would greedy-match the middle chunk "04-01-2026" and emit
    // a bogus "04-JAN-2026". When multiple ISO dates appear, pick the
    // LAST one — that's the statement end date (the value finance users
    // expect to see as the "statement date").
    const ymdRe = /(20\d{2})[-/](\d{1,2})[-/](\d{1,2})/g;
    let ymdMatch;
    let lastYmd = null;
    while ((ymdMatch = ymdRe.exec(searchText)) !== null) {
        const year = Number(ymdMatch[1]);
        const month = Number(ymdMatch[2]);
        const day = Number(ymdMatch[3]);
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
            lastYmd = ymdMatch;
        }
    }
    if (lastYmd) {
        const year = Number(lastYmd[1]);
        const month = Number(lastYmd[2]);
        const day = Number(lastYmd[3]);
        return {
            sort_key: [year, month, day, 0],
            display_date: `${formatDay(day)}-${monthAbbr(month)}-${year}`,
        };
    }
    // Pattern 3: DD/MM/YYYY or DD-MM-YYYY (UK-style)
    const dmy = /(\d{1,2})[/-](\d{1,2})[/-](20\d{2})/.exec(searchText);
    if (dmy) {
        const day = Number(dmy[1]);
        const month = Number(dmy[2]);
        const year = Number(dmy[3]);
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31 &&
            Number.isFinite(year)) {
            return {
                sort_key: [year, month, day, 0],
                display_date: `${formatDay(day)}-${monthAbbr(month)}-${year}`,
            };
        }
    }
    // Pattern 4: month-name + year (e.g., "jan2026")
    for (const [name, num] of Object.entries(MONTH_NAMES)) {
        const re = new RegExp(`(${name})[-_\\s]?(20\\d{2})`, 'i');
        const m = re.exec(searchText);
        if (m) {
            const year = Number(m[2]);
            if (Number.isFinite(year)) {
                return {
                    sort_key: [year, num, 1, 0],
                    display_date: `01-${monthAbbr(num)}-${year}`,
                };
            }
        }
    }
    // Pattern 5: YYYY-MM
    const ym = /(20\d{2})[-_](\d{2})/.exec(searchText);
    if (ym) {
        const year = Number(ym[1]);
        const month = Number(ym[2]);
        if (month >= 1 && month <= 12) {
            return {
                sort_key: [year, month, 1, 0],
                display_date: `01-${monthAbbr(month)}-${year}`,
            };
        }
    }
    return {
        sort_key: [9999, 99, 99, hashStringToInt(baseName)],
        display_date: null,
    };
}
export function isBankStatementAttachment(input) {
    if (!input.filename)
        return false;
    const filenameLower = input.filename.toLowerCase();
    const fromLower = (input.fromAddress ?? '').toLowerCase();
    const subjectLower = (input.subject ?? '').toLowerCase();
    const dotIdx = filenameLower.lastIndexOf('.');
    const ext = dotIdx >= 0 ? filenameLower.slice(dotIdx) : '';
    if (!BANK_STATEMENT_EXTENSIONS.has(ext)) {
        const ct = (input.contentType ?? '').toLowerCase();
        if (!ct || !BANK_STATEMENT_CONTENT_TYPES.has(ct))
            return false;
    }
    const isFromBank = KNOWN_BANK_KEYWORDS.some((b) => fromLower.includes(b));
    const hasStatementKeyword = filenameLower.includes('statement');
    const hasAccountNumber = /\b\d{8}\b/.test(filenameLower);
    const hasSortCode = /\d{2}[-\s]?\d{2}[-\s]?\d{2}/.test(filenameLower);
    const hasBankInFilename = KNOWN_BANK_KEYWORDS.some((b) => filenameLower.includes(b));
    const subjectBankPatterns = ['bank statement', 'account statement', 'your statement'];
    const hasBankSubject = subjectBankPatterns.some((p) => subjectLower.includes(p));
    const hasBankInSubject = KNOWN_BANK_KEYWORDS.some((b) => subjectLower.includes(b));
    if (isFromBank)
        return true;
    if (hasStatementKeyword && (hasAccountNumber || hasSortCode))
        return true;
    if (hasBankInFilename)
        return true;
    if (hasBankSubject)
        return true;
    if (hasStatementKeyword && ext === '.pdf')
        return true;
    if (hasBankInSubject && ext === '.pdf')
        return true;
    return false;
}
export function compareSortKeys(a, b) {
    for (let i = 0; i < 4; i++) {
        const av = a[i] ?? 0;
        const bv = b[i] ?? 0;
        if (av !== bv)
            return av - bv;
    }
    return 0;
}
//# sourceMappingURL=email-helpers.js.map
function detectFormat(content) {
    const trimmed = content.trim();
    if (!trimmed)
        return 'unknown';
    // OFX: starts with OFXHEADER or <OFX>
    if (/^(OFXHEADER:|<OFX>)/i.test(trimmed))
        return 'ofx';
    // QIF: starts with !Type:
    if (trimmed.startsWith('!Type:'))
        return 'qif';
    // MT940: starts with :20: or :25:
    if (/^(\{|:20:|:25:)/.test(trimmed))
        return 'mt940';
    // CSV: comma-separated header line with date/amount columns
    const firstLine = trimmed.split(/\r?\n/)[0] ?? '';
    if (/,/.test(firstLine) &&
        /\b(date|amount|description|memo|debit|credit|payee)\b/i.test(firstLine)) {
        return 'csv';
    }
    return 'unknown';
}
function parseDate(input) {
    const trimmed = input.trim();
    // YYYY-MM-DD
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
    if (m)
        return `${m[1]}-${m[2]}-${m[3]}`;
    // DD/MM/YYYY or DD-MM-YYYY
    m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(trimmed);
    if (m) {
        return `${m[3]}-${(m[2] ?? '').padStart(2, '0')}-${(m[1] ?? '').padStart(2, '0')}`;
    }
    // DD/MM/YY
    m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2})$/.exec(trimmed);
    if (m) {
        const yy = Number(m[3]);
        const year = yy < 50 ? 2000 + yy : 1900 + yy;
        return `${year}-${(m[2] ?? '').padStart(2, '0')}-${(m[1] ?? '').padStart(2, '0')}`;
    }
    return null;
}
function parseAmount(input) {
    const cleaned = input.replace(/[£$€,\s]/g, '').trim();
    if (!cleaned)
        return 0;
    // CR/DR suffix
    if (/cr$/i.test(cleaned))
        return Math.abs(Number(cleaned.replace(/cr$/i, ''))) || 0;
    if (/dr$/i.test(cleaned))
        return -Math.abs(Number(cleaned.replace(/dr$/i, ''))) || 0;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
}
function splitCsvLine(line) {
    // Simple CSV split; handles quoted commas
    const out = [];
    let buf = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            inQuote = !inQuote;
            continue;
        }
        if (ch === ',' && !inQuote) {
            out.push(buf);
            buf = '';
            continue;
        }
        buf += ch;
    }
    out.push(buf);
    return out.map((s) => s.trim());
}
function parseCsv(content) {
    const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0)
        return [];
    const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
    const dateIdx = header.findIndex((h) => h.includes('date'));
    const descIdx = header.findIndex((h) => h.includes('description') || h.includes('memo') || h.includes('payee'));
    const amountIdx = header.findIndex((h) => h === 'amount' || h.includes('value'));
    const debitIdx = header.findIndex((h) => h.includes('debit') || h.includes('out'));
    const creditIdx = header.findIndex((h) => h.includes('credit') || h.includes('in'));
    const out = [];
    for (let i = 1; i < lines.length; i++) {
        const cells = splitCsvLine(lines[i]);
        if (cells.length < 2)
            continue;
        const date = dateIdx >= 0 ? parseDate(cells[dateIdx] ?? '') : null;
        const desc = descIdx >= 0 ? (cells[descIdx] ?? '') : '';
        let amount = 0;
        if (amountIdx >= 0) {
            amount = parseAmount(cells[amountIdx] ?? '');
        }
        else if (debitIdx >= 0 || creditIdx >= 0) {
            const dr = debitIdx >= 0 ? parseAmount(cells[debitIdx] ?? '') : 0;
            const cr = creditIdx >= 0 ? parseAmount(cells[creditIdx] ?? '') : 0;
            amount = cr - dr;
        }
        if (!date && !amount)
            continue;
        out.push({
            date,
            name: desc.split(/\s+/).slice(0, 3).join(' ') || null,
            memo: desc || null,
            amount,
            type: amount >= 0 ? 'credit' : 'debit',
        });
    }
    return out;
}
function parseOfx(content) {
    const out = [];
    const stmtRe = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
    for (const match of content.matchAll(stmtRe)) {
        const block = match[1] ?? '';
        const dt = /<DTPOSTED>([^<\s]+)/i.exec(block)?.[1] ?? '';
        const amt = /<TRNAMT>([^<\s]+)/i.exec(block)?.[1] ?? '0';
        const name = /<NAME>([^<\n]+)/i.exec(block)?.[1] ?? '';
        const memo = /<MEMO>([^<\n]+)/i.exec(block)?.[1] ?? '';
        const isoDate = dt.length >= 8
            ? `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`
            : null;
        const amount = Number(amt) || 0;
        out.push({
            date: isoDate,
            name: name.trim() || null,
            memo: (memo || name).trim() || null,
            amount,
            type: amount >= 0 ? 'credit' : 'debit',
        });
    }
    return out;
}
function parseQif(content) {
    const out = [];
    const blocks = content.split(/^\^/m);
    for (const block of blocks) {
        const lines = block.split(/\r?\n/);
        let date = null;
        let amount = 0;
        let payee = '';
        let memo = '';
        for (const line of lines) {
            const code = line[0];
            const value = line.slice(1).trim();
            if (code === 'D')
                date = parseDate(value);
            else if (code === 'T' || code === 'U')
                amount = parseAmount(value);
            else if (code === 'P')
                payee = value;
            else if (code === 'M')
                memo = value;
        }
        if (!date && !amount)
            continue;
        out.push({
            date,
            name: payee || null,
            memo: memo || payee || null,
            amount,
            type: amount >= 0 ? 'credit' : 'debit',
        });
    }
    return out;
}
function parseMt940(content) {
    // MT940 lines start with :61: for transactions; format is dense.
    // Extract date (YYMMDD) + amount + description from :86:.
    const out = [];
    const blocks = content.split(/^:61:/m);
    for (let i = 1; i < blocks.length; i++) {
        const block = blocks[i] ?? '';
        const m = /^(\d{6})(?:\d{4})?([CD])([\d,]+)/.exec(block);
        if (!m)
            continue;
        const yy = Number(m[1]?.slice(0, 2));
        const mm = m[1]?.slice(2, 4);
        const dd = m[1]?.slice(4, 6);
        const year = yy < 50 ? 2000 + yy : 1900 + yy;
        const date = `${year}-${mm}-${dd}`;
        const sign = m[2] === 'D' ? -1 : 1;
        const amount = sign * Number((m[3] ?? '0').replace(',', '.'));
        const memoMatch = /:86:([^\n:]+)/.exec(block);
        const memo = memoMatch?.[1]?.trim() ?? '';
        out.push({
            date,
            name: memo.split(/\s+/).slice(0, 3).join(' ') || null,
            memo: memo || null,
            amount,
            type: amount >= 0 ? 'credit' : 'debit',
        });
    }
    return out;
}
export const defaultMultiformatParser = {
    detectFormat,
    parse(content, format) {
        switch (format) {
            case 'csv':
                return parseCsv(content);
            case 'ofx':
                return parseOfx(content);
            case 'qif':
                return parseQif(content);
            case 'mt940':
                return parseMt940(content);
            default:
                return [];
        }
    },
};
//# sourceMappingURL=default-multiformat-parser.js.map
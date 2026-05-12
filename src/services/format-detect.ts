/**
 * Bank statement format detection.
 *
 * Faithful port of the parser sniffing logic in
 * `sql_rag/bank_parsers.py` and `BankStatementImport.detect_file_format`
 * in `sql_rag/bank_import.py:1879-1908`.
 *
 * Returns the format name ('CSV', 'OFX', 'QIF', 'MT940') or null when
 * none of the parsers can claim the content.
 *
 * Detection priority follows Python's PARSERS list order:
 *   1. CSV  — extension OR header containing 'date' / 'transaction'
 *   2. OFX  — extension .ofx/.qfx OR content starting with OFXHEADER:/<?OFX/<OFX>
 *   3. QIF  — extension .qif OR content starting with !TYPE:
 *   4. MT940— extension .mt940/.sta/.940 OR :20:/{1:/:60F:/:61:
 *
 * NOTE: CSV is greedy by design — its `can_parse` matches any file
 * containing the word 'date' or 'transaction' on the first line, so
 * many OFX/QIF/MT940 files will match CSV first if their content
 * contains those words. Faithful to Python's behaviour.
 */

const SUPPORTED_FORMATS = ['CSV', 'OFX', 'QIF', 'MT940'] as const;
export type BankFileFormat = (typeof SUPPORTED_FORMATS)[number];

export const supportedFormats: readonly BankFileFormat[] = SUPPORTED_FORMATS;

interface ParserSniffer {
  format: BankFileFormat;
  canParse: (content: string, filename: string) => boolean;
}

const csvSniffer: ParserSniffer = {
  format: 'CSV',
  canParse(content, filename) {
    if (filename.toLowerCase().endsWith('.csv')) return true;
    const firstLine = (content.split('\n')[0] ?? '').toLowerCase();
    return firstLine.includes('date') || firstLine.includes('transaction');
  },
};

const ofxSniffer: ParserSniffer = {
  format: 'OFX',
  canParse(content, filename) {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.ofx') || lower.endsWith('.qfx')) return true;
    const start = content.slice(0, 500).trim().toUpperCase();
    return (
      start.startsWith('OFXHEADER:') ||
      start.includes('<?OFX') ||
      start.includes('<OFX>')
    );
  },
};

const qifSniffer: ParserSniffer = {
  format: 'QIF',
  canParse(content, filename) {
    if (filename.toLowerCase().endsWith('.qif')) return true;
    const start = content.slice(0, 100).trim().toUpperCase();
    return start.startsWith('!TYPE:');
  },
};

const mt940Sniffer: ParserSniffer = {
  format: 'MT940',
  canParse(content, filename) {
    const lower = filename.toLowerCase();
    if (
      lower.endsWith('.mt940') ||
      lower.endsWith('.sta') ||
      lower.endsWith('.940')
    ) {
      return true;
    }
    const start = content.slice(0, 200).trim();
    return (
      start.startsWith(':20:') ||
      start.startsWith('{1:') ||
      start.includes(':60F:') ||
      start.includes(':61:')
    );
  },
};

// Order matters — same as Python's PARSERS list (CSV first).
const SNIFFERS: ParserSniffer[] = [csvSniffer, ofxSniffer, qifSniffer, mt940Sniffer];

/**
 * Detect the format of a bank statement from its content + filename.
 * Mirrors `bank_parsers.detect_format` exactly.
 */
export function detectFormat(content: string, filename: string = ''): BankFileFormat | null {
  for (const sniffer of SNIFFERS) {
    if (sniffer.canParse(content, filename)) return sniffer.format;
  }
  return null;
}

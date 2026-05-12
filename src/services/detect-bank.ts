/**
 * Detect the Opera bank account a bank statement file belongs to.
 *
 * Faithful port of `BankStatementImport.find_bank_account_by_details`
 * (sql_rag/bank_import.py:663-697) and the wrapping endpoint
 * `detect_bank_from_file` (apps/bank_reconcile/api/routes.py:2369-2490).
 *
 * Two detection strategies on the file's first 30 lines:
 *   Method 1: regex sniff for sort code (XX-XX-XX) AND 8-digit account
 *             number anywhere in any line
 *   Method 2: CSV header-row scan — find a row containing 'date' AND
 *             'account' headers, then read the next data row's
 *             'Account' field (format: "20-96-89 90764205")
 *
 * Once sort code + account number are extracted, look them up against
 * Opera nbank — both sides are normalised (spaces and dashes
 * stripped) before comparison so "20-96-89" matches "209689", and
 * "9076 4205" matches "90764205".
 *
 * Returns the bank code (e.g. "BC010") or null when no match.
 */
import type { Knex } from 'knex';

const SORT_CODE_REGEX = /(\d{2}-\d{2}-\d{2})/;
const ACCOUNT_NUMBER_REGEX = /(?<!\d)(\d{8})(?!\d)/;

export interface DetectedBankDetails {
  sort_code: string | null;
  account_number: string | null;
  /** Opera bank code (nbank.nk_acnt) or null */
  bank_code: string | null;
}

// ---------------------------------------------------------------------
// Pure helpers — no DB
// ---------------------------------------------------------------------

function normalize(s: string): string {
  return s.replace(/\s+/g, '').replace(/-/g, '');
}

/**
 * Method 1: regex-scan lines for SORT-CODE + 8-digit account number
 * pair on the same line (mirrors Python's "look for both patterns,
 * break on first hit").
 */
export function sniffBankByRegex(
  lines: string[],
): { sort_code: string; account_number: string } | null {
  for (const line of lines) {
    const sortMatch = SORT_CODE_REGEX.exec(line);
    const acctMatch = ACCOUNT_NUMBER_REGEX.exec(line);
    if (sortMatch && acctMatch && sortMatch[1] && acctMatch[1]) {
      return { sort_code: sortMatch[1], account_number: acctMatch[1] };
    }
  }
  return null;
}

/**
 * Method 2: CSV header-row scan. Finds a header row that contains both
 * 'date' and 'account' (case-insensitive), then reads the next CSV data
 * row's 'Account' field (which has format "20-96-89 90764205").
 *
 * Implements a minimal CSV parser — quoted fields with comma separator.
 * Sufficient for the bank-statement formats we see (Barclays, HSBC,
 * Lloyds, NatWest); doesn't try to be a general-purpose CSV library.
 */
export function sniffBankByCsvHeader(
  lines: string[],
): { sort_code: string; account_number: string } | null {
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const lower = (lines[i] ?? '').toLowerCase();
    if (lower.includes('date') && lower.includes('account')) {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex < 0) return null;

  const headerRow = parseCsvRow(lines[headerIndex] ?? '');
  const dataRow = parseCsvRow(lines[headerIndex + 1] ?? '');
  if (!dataRow) return null;

  // Find the 'Account' column (case-insensitive)
  const accountColIdx = headerRow.findIndex(
    (h) => h.toLowerCase().trim() === 'account',
  );
  if (accountColIdx < 0) return null;

  const accountField = (dataRow[accountColIdx] ?? '').trim();
  // Format: "20-96-89 90764205"
  const split = accountField.split(/\s+/);
  if (split.length < 2) return null;
  const [sort, ...rest] = split;
  if (!sort) return null;
  const accountNumber = rest.join(' ').trim();
  if (!accountNumber) return null;
  return { sort_code: sort, account_number: accountNumber };
}

/** Minimal RFC4180-style CSV row parser. Handles "quoted, fields". */
function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let buf = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      // Escaped quote inside quoted field
      if (inQuotes && line[i + 1] === '"') {
        buf += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  fields.push(buf);
  return fields;
}

// ---------------------------------------------------------------------
// Opera lookup
// ---------------------------------------------------------------------

export async function findBankAccountByDetails(
  operaDb: Knex,
  sortCode: string,
  accountNumber: string,
): Promise<string | null> {
  if (!sortCode || !accountNumber) return null;
  const sortNorm = normalize(sortCode);
  const acctNorm = normalize(accountNumber);

  const rows = (await operaDb.raw(`
    SELECT RTRIM(nk_acnt) as code,
           RTRIM(nk_sort) as sort_code,
           RTRIM(nk_number) as account_number
    FROM nbank WITH (NOLOCK)
    WHERE nk_sort IS NOT NULL AND nk_number IS NOT NULL
  `)) as unknown as Array<{
    code: string | null;
    sort_code: string | null;
    account_number: string | null;
  }>;

  for (const r of rows ?? []) {
    const dbSort = normalize((r.sort_code ?? '').toString());
    const dbAcct = normalize((r.account_number ?? '').toString());
    if (dbSort === sortNorm && dbAcct === acctNorm) {
      return (r.code ?? '').trim() || null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------
// Top-level: combine sniffers + Opera lookup
// ---------------------------------------------------------------------

export async function detectBankFromContent(
  operaDb: Knex,
  content: string,
): Promise<DetectedBankDetails> {
  const lines = content.split(/\r?\n/).slice(0, 30);

  // Method 1
  let extracted = sniffBankByRegex(lines);

  // Method 2 fallback
  if (!extracted) {
    extracted = sniffBankByCsvHeader(lines);
  }

  if (!extracted) {
    return { sort_code: null, account_number: null, bank_code: null };
  }

  const code = await findBankAccountByDetails(
    operaDb,
    extracted.sort_code,
    extracted.account_number,
  );

  return {
    sort_code: extracted.sort_code,
    account_number: extracted.account_number,
    bank_code: code,
  };
}

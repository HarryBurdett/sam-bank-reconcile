/**
 * Bank-reconcile import posting executor — the SQL-write body for
 * `POST /api/bank-import/import-from-pdf` (and -email).
 *
 * Faithful port of the per-transaction posting flows used by
 * `BankStatementImport.import_transaction`:
 *   - import_sales_receipt        (opera_sql_import.py:2048)
 *   - import_purchase_payment     (opera_sql_import.py:3060)
 *   - import_sales_refund         (opera_sql_import.py — sign-flipped sales receipt)
 *   - import_purchase_refund      (opera_sql_import.py — sign-flipped purchase payment)
 *
 * Per CLAUDE.md "complete data updates": every ntran INSERT is
 * followed by `updateNacntBalance`; every cashbook receipt/payment
 * updates `nbank.nk_curbal` via `updateNbankBalance`; ledger balance
 * adjusted via sname.sn_currbal / pname.pn_currbal.
 *
 * Scope this executor:
 *   - Posts one cashbook entry per transaction (single-line aentry).
 *   - Handles sales_receipt (at_type=4), purchase_payment (5),
 *     sales_refund (3), purchase_refund (6) — full ledger flow
 *     including stran/ptran + sname/pname balance updates.
 *   - nominal_payment (at_type=1) and nominal_receipt (at_type=2)
 *     post direct to nominal account (no ledger row, no party
 *     balance) via postNominalEntry.
 *   - bank_transfer (at_type=8) posts paired aentry/atran on
 *     source + destination banks via postBankTransfer.
 *   - Stamps at_refer with the BKIMP fingerprint after posting so
 *     the duplicate detector catches re-imports (matches Python's
 *     `_store_import_fingerprint` audit trail).
 *
 * Each transaction posts in its own database transaction so a
 * single failure doesn't roll back the entire batch. The Python
 * import flow has the same per-row rollback semantics.
 */
import type { Knex } from 'knex';
import {
  generateImportFingerprint,
  type CheckTransactionInput,
} from './duplicate-detection.js';
import type {
  ImportPostingExecutor,
  PdfExtractionResult,
} from './import-from-pdf.js';
import { checkCashbookDuplicateBeforePosting } from './pre-posting-duplicate-check.js';
import { autoAllocateReceipt, autoAllocatePayment } from './auto-allocate.js';
import {
  getPeriodPostingDecision,
  type PeriodPostingDecision,
} from './period-posting-decision.js';
import { executeWithDeadlockRetry, isRecordLocked } from '../_shared/index.js';
import {
  assertAentryAtran,
  assertLedgerRow,
  assertBalancedPair,
  verifyAentryCommitted,
  PostingVerificationError,
} from '../_shared/post-write-verify.js';
import {
  getControlAccounts,
  getNacntType,
  getNextId,
  getNextJournal,
  getPeriodForDate,
  generateOperaUniqueId,
  incrementAtypeEntry,
  insertNjmemo,
  updateNacntBalance,
  updateNbankBalance,
  type NacntType,
} from '../_shared/index.js';

export type TxnAction =
  | 'sales_receipt'
  | 'purchase_payment'
  | 'sales_refund'
  | 'purchase_refund'
  | 'nominal_payment'
  | 'nominal_receipt'
  | 'bank_transfer'
  | 'skip'
  | 'defer'
  | string;

interface PreparedTransaction {
  index: number;
  date: string;
  amount: number;
  name: string;
  memo: string;
  action: TxnAction;
  matchedAccount: string | null;
  cbtype: string | null;
  reference: string | null;
  /**
   * Operator override: VAT code (e.g. 'S20', 'Z', '1'). Non-empty value
   * triggers the VAT-split branch in `postNominalEntry`. Plumbed from
   * the override-row's `vat_code` field (routes.py override shape).
   */
  vatCode: string | null;
  /**
   * Operator override: pre-computed NET amount when the operator wants
   * to force the split (rarely used; legacy recomputes from gross+rate).
   * Carried through for parity with the override payload; the VAT
   * branch still computes net from rate per legacy
   * `opera_sql_import.py:3756`.
   */
  netAmount: number | null;
}

// ---------------------------------------------------------------------
// Unified prepared-entry shape — used by postOperaCashbookEntry
// (the core posting helper that handles 1..N lines uniformly).
//
// Mirrors Opera SE's actual transaction model: one aentry header
// (PreparedEntryHeader) plus 1..N atran detail lines
// (PreparedEntryLine[]). The bank-import flow passes a single-line
// array via the postOneTransaction / postNominalEntry thin
// wrappers; the recurring-entry orchestrator passes 1..N lines
// directly.
// ---------------------------------------------------------------------

export interface PreparedEntryHeader {
  /** YYYY-MM-DD posting date — shared across all lines. */
  date: string;
  /**
   * All lines share one ae_type → one action.
   * `bank_transfer` is intentionally excluded — paired source+dest
   * doesn't fit the 1..N-lines model; use postBankTransfer for that.
   */
  action: Exclude<TxnAction, 'bank_transfer'>;
  /** Cashbook type override (e.g. 'NR', 'NP'). Null → resolveCbtype defaults. */
  cbtype: string | null;
  /** Header-level reference (ae_entref). Used at aentry + as line default. */
  reference: string | null;
  /**
   * Header-level description (ae_comment). For bank-import: row name+memo.
   * For recurring: arhead.ae_desc.
   */
  comment: string;
  /** Audit user. 'BANK_IMP' for bank-import; 'RECUR' for recurring. ≤8 chars. */
  inputBy: string;
  /**
   * Header-level memo (txn.memo for bank-import; ae_desc for recurring).
   * Used in atran/anoml/ntran comment columns when the line carries no
   * comment of its own. Falls through to per-line comment for actual
   * INSERT values.
   */
  memo: string;
  /** Header-level payee/party name when known (txn.name for bank-import). */
  name: string;
}

export interface PreparedEntryLine {
  /** Per-line at_account: nominal / customer / supplier code. Required. */
  atAccount: string;
  /**
   * Per-line absolute amount in pence (always positive). Direction
   * comes from the header action — receipt actions become positive
   * signed pence in atran/aentry; payment actions become negative.
   */
  absPence: number;
  /** Per-line VAT code (empty / 0 / N / Z / E → no VAT). */
  vatCode: string | null;
  /** Per-line VAT pence (absolute). Zero when no VAT. */
  vatPence: number;
  /** Per-line reference; falls back to header.reference. ≤20 chars. */
  reference: string;
  /** Per-line at_comment / nt_cmnt; falls back to header.comment. */
  comment: string;
  /** Per-line project (8 chars). */
  project: string;
  /** Per-line department / job (8 chars). */
  department: string;
  /**
   * Operator-provided net override for VAT-bearing lines (rare). Null →
   * net is computed from gross + VAT rate (per legacy
   * opera_sql_import.py:3756).
   */
  netOverride: number | null;
}

export interface PostEntryArgs {
  trx: Knex;
  bankCode: string;
  header: PreparedEntryHeader;
  /** Length ≥ 1. */
  lines: PreparedEntryLine[];
  defaults: { sl_control: string; pl_control: string };
  decision: PeriodPostingDecision;
}

export interface PostEntryResult {
  entry_number: string;
  /**
   * Same fingerprint shape the bank-import flow returns from
   * postOneTransaction / postNominalEntry — used by the bank-import
   * executor to stamp `posted_lines[].fingerprint`. For recurring-entry
   * callers, it's informational.
   */
  fingerprint: string;
}

const AT_TYPE_FOR_ACTION: Record<string, number> = {
  sales_receipt: 4,
  purchase_payment: 5,
  sales_refund: 3,
  purchase_refund: 6,
  nominal_payment: 1,
  nominal_receipt: 2,
  bank_transfer: 8,
};

function nowParts(): { date: string; time: string; iso: string } {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
    now.getDate(),
  )}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(
    now.getSeconds(),
  )}`;
  return { date, time, iso: `${date} ${time}` };
}

function pence(amountPounds: number): number {
  return Math.round(amountPounds * 100);
}

function dateAsYmd(input: string | Date | null | undefined): string {
  if (!input) return new Date().toISOString().slice(0, 10);
  if (input instanceof Date) return input.toISOString().slice(0, 10);
  return String(input).slice(0, 10);
}

interface CbtypeInfo {
  code: string;
  desc: string;
}

async function resolveCbtype(
  trx: Knex,
  preferred: string | null,
  ayType: 'R' | 'P' | 'T',
): Promise<CbtypeInfo> {
  if (preferred) {
    const rows = (await trx.raw(
      `SELECT TOP 1 RTRIM(ay_cbtype) AS ay_cbtype, RTRIM(ay_desc) AS ay_desc
       FROM atype WITH (NOLOCK)
       WHERE RTRIM(ay_cbtype) = ? AND ay_type = ?`,
      [preferred, ayType],
    )) as unknown as Array<{ ay_cbtype: string | null; ay_desc: string | null }>;
    if (Array.isArray(rows) && rows.length > 0 && rows[0]?.ay_cbtype) {
      return {
        code: (rows[0].ay_cbtype ?? '').toString().trim(),
        desc: (rows[0].ay_desc ?? '').toString().trim(),
      };
    }
    throw new Error(
      `cbtype '${preferred}' not found as ay_type='${ayType}' in atype`,
    );
  }
  const rows = (await trx.raw(
    `SELECT TOP 1 RTRIM(ay_cbtype) AS ay_cbtype, RTRIM(ay_desc) AS ay_desc
     FROM atype WITH (NOLOCK)
     WHERE ay_type = ?`,
    [ayType],
  )) as unknown as Array<{ ay_cbtype: string | null; ay_desc: string | null }>;
  if (!Array.isArray(rows) || rows.length === 0 || !rows[0]?.ay_cbtype) {
    const kind = ayType === 'R' ? 'receipt' : ayType === 'P' ? 'payment' : 'transfer';
    throw new Error(`No ${kind} type found in atype`);
  }
  return {
    code: (rows[0].ay_cbtype ?? '').toString().trim(),
    desc: (rows[0].ay_desc ?? '').toString().trim(),
  };
}

interface PartyInfo {
  account: string;
  name: string;
  region: string;
  terr: string;
  type: string;
  controlAccount: string;
}

interface BankInfo {
  code: string;
  description: string;
  sortCode: string;
  accountNumber: string;
}

async function loadBankInfo(trx: Knex, bankCode: string): Promise<BankInfo> {
  const rows = (await trx.raw(
    `SELECT TOP 1 RTRIM(nk_desc) AS description,
            RTRIM(ISNULL(nk_sort, '')) AS sort_code,
            RTRIM(ISNULL(nk_number, '')) AS account_number
     FROM nbank WITH (NOLOCK)
     WHERE RTRIM(nk_acnt) = ?`,
    [bankCode],
  )) as unknown as Array<{
    description: string | null;
    sort_code: string | null;
    account_number: string | null;
  }>;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`Bank account '${bankCode}' not found in nbank`);
  }
  const r = rows[0]!;
  return {
    code: bankCode,
    description: (r.description ?? '').trim(),
    sortCode: (r.sort_code ?? '').trim(),
    accountNumber: (r.account_number ?? '').trim(),
  };
}

function describeDbError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as Error & {
    code?: string | number;
    number?: number;
    state?: number;
    originalError?: { message?: string; info?: { message?: string } };
  };
  const parts: string[] = [];
  if (e.message) parts.push(e.message);
  if (e.code != null) parts.push(`code=${e.code}`);
  if (e.number != null) parts.push(`sql#=${e.number}`);
  if (e.state != null) parts.push(`state=${e.state}`);
  const orig = e.originalError;
  if (orig) {
    const om = orig.message ?? orig.info?.message;
    if (om) parts.push(`orig="${om}"`);
  }
  return parts.filter(Boolean).join(' | ') || `<no message> (${e.name ?? 'Error'})`;
}

async function loadCustomerInfo(
  trx: Knex,
  customerAccount: string,
  defaultControl: string,
): Promise<PartyInfo> {
  let rows: Array<{
    sn_name: string | null;
    sn_region: string | null;
    sn_terrtry: string | null;
    sn_custype: string | null;
  }>;
  try {
    rows = (await trx.raw(
      `SELECT TOP 1 sn_name, sn_region, sn_terrtry, sn_custype
       FROM sname WITH (NOLOCK)
       WHERE RTRIM(sn_account) = ?`,
      [customerAccount],
    )) as unknown as Array<{
      sn_name: string | null;
      sn_region: string | null;
      sn_terrtry: string | null;
      sn_custype: string | null;
    }>;
  } catch (err) {
    throw new Error(
      `sname lookup failed for customer '${customerAccount}': ${describeDbError(err)}`,
    );
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`Customer account '${customerAccount}' not found in sname`);
  }
  const r = rows[0]!;
  let control = defaultControl;
  try {
    const ctlRows = (await trx.raw(
      `SELECT RTRIM(ISNULL(sp.sc_dbtctrl, '')) AS control_account
       FROM sname s WITH (NOLOCK)
       LEFT JOIN sprfls sp WITH (NOLOCK) ON RTRIM(s.sn_cprfl) = RTRIM(sp.sc_code)
       WHERE RTRIM(s.sn_account) = ?`,
      [customerAccount],
    )) as unknown as Array<{ control_account: string | null }>;
    if (Array.isArray(ctlRows) && ctlRows.length > 0) {
      const ctl = (ctlRows[0]?.control_account ?? '').trim();
      if (ctl) control = ctl;
    }
  } catch {
    // fall through to default
  }
  return {
    account: customerAccount,
    name: (r.sn_name ?? '').trim(),
    region: (r.sn_region ?? '').trim() || 'K',
    terr: (r.sn_terrtry ?? '').trim() || '001',
    type: (r.sn_custype ?? '').trim() || 'DD1',
    controlAccount: control,
  };
}

async function loadSupplierInfo(
  trx: Knex,
  supplierAccount: string,
  defaultControl: string,
): Promise<PartyInfo> {
  // pname's column shape is different from sname — no `pn_region`,
  // `pn_terrtry`, or `pn_custype`. Supplier type lives on `pn_suptype`.
  // The pre-port TS query SELECTed sname-style columns which fail with
  // "Invalid column name" on every supplier — matches legacy
  // `SELECT pn_name, pn_suptype FROM pname` (opera_sql_import.py:9865).
  let rows: Array<{
    pn_name: string | null;
    pn_suptype: string | null;
  }>;
  try {
    rows = (await trx.raw(
      `SELECT TOP 1 pn_name, pn_suptype
       FROM pname WITH (NOLOCK)
       WHERE RTRIM(pn_account) = ?`,
      [supplierAccount],
    )) as unknown as Array<{
      pn_name: string | null;
      pn_suptype: string | null;
    }>;
  } catch (err) {
    throw new Error(
      `pname lookup failed for supplier '${supplierAccount}': ${describeDbError(err)}`,
    );
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`Supplier account '${supplierAccount}' not found in pname`);
  }
  const r = rows[0]!;
  let control = defaultControl;
  try {
    const ctlRows = (await trx.raw(
      `SELECT RTRIM(ISNULL(pp.pc_crdctrl, '')) AS control_account
       FROM pname p WITH (NOLOCK)
       LEFT JOIN pprfls pp WITH (NOLOCK) ON RTRIM(p.pn_cprfl) = RTRIM(pp.pp_code)
       WHERE RTRIM(p.pn_account) = ?`,
      [supplierAccount],
    )) as unknown as Array<{ control_account: string | null }>;
    if (Array.isArray(ctlRows) && ctlRows.length > 0) {
      const ctl = (ctlRows[0]?.control_account ?? '').trim();
      if (ctl) control = ctl;
    }
  } catch {
    // fall through
  }
  // PartyInfo `region` and `terr` are sales-side fields (sname) — the
  // ptran INSERT does not use them. Returning empty strings keeps the
  // shared type happy without binding meaningless values.
  return {
    account: supplierAccount,
    name: (r.pn_name ?? '').trim(),
    region: '',
    terr: '',
    type: (r.pn_suptype ?? '').trim(),
    controlAccount: control,
  };
}

function deriveTxnDirection(action: TxnAction): {
  direction: 'in' | 'out';
  ledger: 'sales' | 'purchase';
  receiptOrPayment: 'R' | 'P';
} {
  switch (action) {
    case 'sales_receipt':
      return { direction: 'in', ledger: 'sales', receiptOrPayment: 'R' };
    case 'sales_refund':
      // Refund TO customer = money out of bank, but ledger entry is on sales
      // (offsetting their previous credit). Cashbook posts as payment.
      return { direction: 'out', ledger: 'sales', receiptOrPayment: 'P' };
    case 'purchase_payment':
      return { direction: 'out', ledger: 'purchase', receiptOrPayment: 'P' };
    case 'purchase_refund':
      return { direction: 'in', ledger: 'purchase', receiptOrPayment: 'R' };
    default:
      throw new Error(`Unsupported action: ${action}`);
  }
}

interface PostOneArgs {
  trx: Knex;
  bankCode: string;
  txn: PreparedTransaction;
  defaults: { sl_control: string; pl_control: string };
  /**
   * Period-posting decision. When `postToNominal=false`, the posting
   * functions skip ntran + nacnt updates and stamp anoml.ax_done=' '
   * so the nightly NL-transfer job picks the entry up later. When
   * `postToNominal=true`, ntran/nacnt are written immediately and
   * ax_done='Y'. Faithful port of legacy
   * `posting_decision.post_to_nominal` gating at opera_sql_import.py:
   * 2334, 3320, 3936, 9463.
   */
  decision: PeriodPostingDecision;
}

async function postOneTransaction(args: PostOneArgs): Promise<{
  entry_number: string;
  fingerprint: string;
}> {
  const { trx, bankCode, txn, defaults, decision } = args;
  if (!txn.matchedAccount) {
    throw new Error(
      `Missing matched_account for ${txn.action} ` +
        `(row ${txn.index}, name='${txn.name}', amount=${txn.amount}). ` +
        `Override required to pass 'account' for matched rows.`,
    );
  }
  if (txn.action === 'bank_transfer') {
    throw new Error(
      `postOneTransaction does not handle bank_transfer — use postBankTransfer`,
    );
  }
  if (txn.action === 'nominal_payment' || txn.action === 'nominal_receipt') {
    throw new Error(
      `postOneTransaction does not handle nominal entries — use postNominalEntry`,
    );
  }

  // Translate the legacy single-line PreparedTransaction shape into the
  // unified PreparedEntryHeader + PreparedEntryLine[] shape consumed by
  // postOperaCashbookEntry. Single-line input → one-element lines array.
  const absAmount = Math.abs(Number(txn.amount));
  const header: PreparedEntryHeader = {
    date: txn.date,
    action: txn.action as Exclude<TxnAction, 'bank_transfer'>,
    cbtype: txn.cbtype,
    reference: txn.reference,
    comment: txn.memo || txn.name || '',
    inputBy: 'BANK_IMP',
    memo: txn.memo,
    name: txn.name,
  };
  const line: PreparedEntryLine = {
    atAccount: txn.matchedAccount,
    absPence: Math.round(absAmount * 100),
    vatCode: txn.vatCode,
    vatPence: 0, // bank-import doesn't pre-compute VAT pence; core
                 // helper derives it via getVatRateForCode when vatCode is set.
    reference: txn.reference ?? '',
    comment: txn.memo ?? '',
    project: '',
    department: '',
    netOverride: txn.netAmount,
  };
  return postOperaCashbookEntry({
    trx, bankCode, header, lines: [line], defaults, decision,
  });
}

// ---------------------------------------------------------------------
// VAT helpers (faithful port of opera_sql_import.py:468 get_vat_rate
// — single-code lookup with date-effective rate selection)
// ---------------------------------------------------------------------

interface VatRateLookup {
  rate: number;
  nominal: string;
}

/**
 * Read ztax for one VAT code + trantyp, returning the date-effective
 * rate and VAT nominal account. Mirrors legacy `get_vat_rate`
 * (opera_sql_import.py:468-560):
 *   - filter ztax by tx_code, tx_trantyp, tx_ctrytyp='H'
 *   - if tx_rate2dy is set and post_date >= tx_rate2dy, use tx_rate2
 *   - otherwise use tx_rate1
 *   - fall back to a type-less ztax lookup if first query empty
 *
 * Returns null on any error or when no row exists — caller treats null
 * as has_vat=false (no VAT split). Legacy returns a dict with rate=0
 * for the same effect.
 */
async function getVatRateForCode(
  trx: Knex,
  vatCode: string,
  vatType: 'P' | 'S',
  refDate: string,
): Promise<VatRateLookup | null> {
  const code = vatCode.trim();
  if (!code) return null;
  // Skip sentinel codes that legacy explicitly treats as "no VAT"
  // (opera_sql_import.py:3747).
  const upper = code.toUpperCase();
  if (upper === 'N/A' || upper === 'NONE') return null;

  type Row = {
    tx_rate1: number | null;
    tx_rate2: number | null;
    tx_rate2dy: Date | string | null;
    tx_nominal: string | null;
  };

  const query = async (withType: boolean): Promise<Row[]> => {
    const sql = withType
      ? `SELECT tx_rate1, tx_rate2, tx_rate2dy, tx_nominal
           FROM ztax WITH (NOLOCK)
           WHERE RTRIM(tx_code) = ?
             AND tx_trantyp = ?
             AND tx_ctrytyp = 'H'`
      : `SELECT tx_rate1, tx_rate2, tx_rate2dy, tx_nominal
           FROM ztax WITH (NOLOCK)
           WHERE RTRIM(tx_code) = ?
             AND tx_ctrytyp = 'H'`;
    const params = withType ? [code, vatType] : [code];
    return (await trx.raw(sql, params)) as unknown as Row[];
  };

  let rows: Row[];
  try {
    rows = await query(true);
    if (!Array.isArray(rows) || rows.length === 0) {
      rows = await query(false);
    }
  } catch {
    return null;
  }
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const r = rows[0]!;
  let rate = Number(r.tx_rate1 ?? 0);
  if (r.tx_rate2dy !== null && r.tx_rate2dy !== undefined) {
    const rate2Date =
      r.tx_rate2dy instanceof Date
        ? r.tx_rate2dy.toISOString().slice(0, 10)
        : String(r.tx_rate2dy).slice(0, 10);
    if (refDate >= rate2Date && r.tx_rate2 != null) {
      rate = Number(r.tx_rate2);
    }
  }
  const nominal = (r.tx_nominal ?? '').toString().trim();
  if (!Number.isFinite(rate)) return null;
  return { rate, nominal };
}

/**
 * Lookup the nominal-account description (na_desc) for use in atran
 * at_name. Legacy `import_nominal_entry` reads from nacnt
 * (opera_sql_import.py:3644-3656). Returns the account code itself if
 * the lookup fails, so we always have something to write.
 */
async function loadNominalName(trx: Knex, account: string): Promise<string> {
  try {
    const rows = (await trx.raw(
      `SELECT TOP 1 RTRIM(ISNULL(na_desc, '')) AS na_desc
         FROM nacnt WITH (NOLOCK)
         WHERE RTRIM(na_acnt) = ?`,
      [account],
    )) as unknown as Array<{ na_desc: string | null }>;
    if (Array.isArray(rows) && rows.length > 0) {
      const desc = (rows[0]?.na_desc ?? '').toString().trim();
      if (desc) return desc;
    }
  } catch {
    // fall through
  }
  return account;
}

// ---------------------------------------------------------------------
// Nominal entry (at_type=1 payment, at_type=2 receipt)
// ---------------------------------------------------------------------

async function postNominalEntry(args: PostOneArgs): Promise<{
  entry_number: string;
  fingerprint: string;
}> {
  const { trx, bankCode, txn, defaults, decision } = args;
  if (!txn.matchedAccount) {
    throw new Error('Missing nominal account for nominal entry');
  }
  if (txn.action !== 'nominal_payment' && txn.action !== 'nominal_receipt') {
    throw new Error(
      `postNominalEntry does not handle ${txn.action} — use postOneTransaction`,
    );
  }

  const absAmount = Math.abs(Number(txn.amount));
  const header: PreparedEntryHeader = {
    date: txn.date,
    action: txn.action,
    cbtype: txn.cbtype,
    reference: txn.reference,
    comment: txn.memo || txn.name || '',
    inputBy: 'BANK_IMP',
    memo: txn.memo,
    name: txn.name,
  };
  const line: PreparedEntryLine = {
    atAccount: txn.matchedAccount,
    absPence: Math.round(absAmount * 100),
    vatCode: txn.vatCode,
    vatPence: 0, // core helper computes from rate via getVatRateForCode
    reference: txn.reference ?? '',
    comment: txn.memo ?? '',
    project: '',
    department: '',
    netOverride: txn.netAmount,
  };
  return postOperaCashbookEntry({
    trx, bankCode, header, lines: [line], defaults, decision,
  });
}

// ---------------------------------------------------------------------
// Bank transfer (at_type=8) — paired aentry/atran on source + dest
// ---------------------------------------------------------------------

async function postBankTransfer(args: PostOneArgs): Promise<{
  entry_number: string;
  fingerprint: string;
}> {
  const { trx, bankCode, txn, decision } = args;
  if (!txn.matchedAccount) {
    throw new Error('Missing destination bank for bank_transfer');
  }
  // Direction: negative amount = paying out (source = current bank);
  // positive amount = receiving (source = other bank, dest = current).
  const sourceBank = txn.amount < 0 ? bankCode : txn.matchedAccount;
  const destBank = txn.amount < 0 ? txn.matchedAccount : bankCode;
  const absAmount = Math.abs(Number(txn.amount));

  // Transfers use a single ay_type='T' cbtype for BOTH legs. Legacy
  // get_default_cbtype_for_transfer() returns e.g. 'T1' and passes it
  // to both source and destination INSERTs. The counter is then
  // incremented TWICE on the same cbtype so each leg gets its own
  // entry number (T100000704, T100000705). Pre-port TS looked up 'P'
  // and 'R' types separately — wrong and would either throw or pick
  // unrelated cbtypes. Audit 2026-05-14, legacy opera_sql_import.py:
  // 9257 + 9331-9332.
  const { code: transferCbtype, desc: transferDesc } = await resolveCbtype(
    trx,
    txn.cbtype,
    'T',
  );
  const sourceInfo = await loadBankInfo(trx, sourceBank);
  const destInfo = await loadBankInfo(trx, destBank);
  const now = nowParts();
  const { period, year } = await getPeriodForDate(trx, txn.date);

  const sharedUnique = generateOperaUniqueId();
  const ntranPstidSource = generateOperaUniqueId();
  const ntranPstidDest = generateOperaUniqueId();
  const journal = await getNextJournal(trx, 1);
  // Fingerprint includes reference/memo so back-to-back transfers
  // between the same banks don't trip the dup-check on identical
  // synthetic inputs.
  const fingerprint = generateImportFingerprint(
    `Transfer ${sourceBank}->${destBank} ${txn.reference ?? ''} ${txn.memo ?? ''}`,
    txn.amount,
    txn.date,
  );
  const reference = (txn.reference ?? '').slice(0, 20) || `TRF-${destBank}`;
  const transferComment = (txn.memo ?? '').slice(0, 40) || 'Bank transfer';

  // Source side: aentry + atran (negative). Both legs use the SAME
  // cbtype (transferCbtype, e.g. 'T1'); increment same counter twice
  // for two distinct entry numbers.
  const entryOut = await incrementAtypeEntry(trx, transferCbtype);
  const aentryOutId = await getNextId(trx, 'aentry');
  const atranOutId = await getNextId(trx, 'atran');
  await trx.raw(
    `INSERT INTO aentry (
      id, ae_acnt, ae_cntr, ae_cbtype, ae_entry, ae_reclnum,
      ae_lstdate, ae_frstat, ae_tostat, ae_statln, ae_entref,
      ae_value, ae_recbal, ae_remove, ae_tmpstat, ae_complet,
      ae_postgrp, sq_crdate, sq_crtime, sq_cruser, ae_comment,
      ae_payid, ae_batchid, ae_brwptr, datecreated, datemodified, state
    ) VALUES (
      ?, ?, '    ', ?, ?, 0,
      ?, 0, 0, 0, ?,
      ?, 0, 0, 0, 1,
      0, ?, ?, 'BANK_IMP', ?,
      0, 0, '  ', ?, ?, 1
    )`,
    [
      aentryOutId,
      sourceBank,
      transferCbtype,
      entryOut,
      txn.date,
      reference,
      -pence(absAmount),
      now.date,
      now.time.slice(0, 8),
      transferComment,
      now.iso,
      now.iso,
    ],
  );
  await trx.raw(
    `INSERT INTO atran (
      id, at_acnt, at_cntr, at_cbtype, at_entry, at_inputby,
      at_type, at_pstdate, at_sysdate, at_tperiod, at_value,
      at_disc, at_fcurr, at_fcexch, at_fcmult, at_fcdec,
      at_account, at_name, at_comment, at_payee, at_payname,
      at_sort, at_number, at_remove, at_chqprn, at_chqlst,
      at_bacprn, at_ccdprn, at_ccdno, at_payslp, at_pysprn,
      at_cash, at_remit, at_unique, at_postgrp, at_ccauth,
      at_refer, at_srcco, at_ecb, at_ecbtype, at_atpycd,
      at_bsref, at_bsname, at_vattycd, at_project, at_job,
      at_bic, at_iban, at_memo, datecreated, datemodified, state
    ) VALUES (
      ?, ?, '    ', ?, ?, 'BANK_IMP',
      8, ?, ?, 1, ?,
      0, '   ', 1.0, 0, 2,
      ?, ?, ?, '        ', '',
      ?, ?, 0, 0, 0,
      0, 0, '', 0, 0,
      0, 0, ?, 0, '0       ',
      ?, 'I', 0, ' ', '      ',
      '', '', '  ', '        ', '        ',
      '', '', ?, ?, ?, 1
    )`,
    [
      atranOutId,
      sourceBank,
      transferCbtype,
      entryOut,
      txn.date,
      txn.date,
      -pence(absAmount),
      destBank,
      destInfo.description.slice(0, 35),
      txn.memo.slice(0, 35),
      destInfo.sortCode.slice(0, 8).padEnd(8),
      destInfo.accountNumber.slice(0, 9).padEnd(9),
      sharedUnique,
      reference,
      txn.memo.slice(0, 200),
      now.iso,
      now.iso,
    ],
  );

  // Destination side: aentry + atran (positive). Same cbtype as source,
  // second increment of the same counter.
  const entryIn = await incrementAtypeEntry(trx, transferCbtype);
  const aentryInId = await getNextId(trx, 'aentry');
  const atranInId = await getNextId(trx, 'atran');
  await trx.raw(
    `INSERT INTO aentry (
      id, ae_acnt, ae_cntr, ae_cbtype, ae_entry, ae_reclnum,
      ae_lstdate, ae_frstat, ae_tostat, ae_statln, ae_entref,
      ae_value, ae_recbal, ae_remove, ae_tmpstat, ae_complet,
      ae_postgrp, sq_crdate, sq_crtime, sq_cruser, ae_comment,
      ae_payid, ae_batchid, ae_brwptr, datecreated, datemodified, state
    ) VALUES (
      ?, ?, '    ', ?, ?, 0,
      ?, 0, 0, 0, ?,
      ?, 0, 0, 0, 1,
      0, ?, ?, 'BANK_IMP', ?,
      0, 0, '  ', ?, ?, 1
    )`,
    [
      aentryInId,
      destBank,
      transferCbtype,
      entryIn,
      txn.date,
      reference,
      pence(absAmount),
      now.date,
      now.time.slice(0, 8),
      transferComment,
      now.iso,
      now.iso,
    ],
  );
  await trx.raw(
    `INSERT INTO atran (
      id, at_acnt, at_cntr, at_cbtype, at_entry, at_inputby,
      at_type, at_pstdate, at_sysdate, at_tperiod, at_value,
      at_disc, at_fcurr, at_fcexch, at_fcmult, at_fcdec,
      at_account, at_name, at_comment, at_payee, at_payname,
      at_sort, at_number, at_remove, at_chqprn, at_chqlst,
      at_bacprn, at_ccdprn, at_ccdno, at_payslp, at_pysprn,
      at_cash, at_remit, at_unique, at_postgrp, at_ccauth,
      at_refer, at_srcco, at_ecb, at_ecbtype, at_atpycd,
      at_bsref, at_bsname, at_vattycd, at_project, at_job,
      at_bic, at_iban, at_memo, datecreated, datemodified, state
    ) VALUES (
      ?, ?, '    ', ?, ?, 'BANK_IMP',
      8, ?, ?, 1, ?,
      0, '   ', 1.0, 0, 2,
      ?, ?, ?, '        ', '',
      '        ', '         ', 0, 0, 0,
      0, 0, '', 0, 0,
      0, 0, ?, 0, '0       ',
      ?, 'I', 0, ' ', '      ',
      '', '', '  ', '        ', '        ',
      '', '', ?, ?, ?, 1
    )`,
    [
      atranInId,
      destBank,
      transferCbtype,
      entryIn,
      txn.date,
      txn.date,
      pence(absAmount),
      sourceBank,
      sourceInfo.description.slice(0, 35),
      txn.memo.slice(0, 35),
      sharedUnique,
      reference,
      txn.memo.slice(0, 200),
      now.iso,
      now.iso,
    ],
  );

  // Both nbank balance updates
  await updateNbankBalance(trx, sourceBank, -absAmount);
  await updateNbankBalance(trx, destBank, absAmount);

  // Both ntran legs (bank-to-bank: source credit, dest debit) + nacnt
  // — GATED on decision.postToNominal (RTU=OFF → skip).
  if (decision.postToNominal) {
    const sourceType = (await getNacntType(trx, sourceBank)) ?? ({ na_type: 'B ', na_subt: 'BC' } as NacntType);
    const destType = (await getNacntType(trx, destBank)) ?? ({ na_type: 'B ', na_subt: 'BC' } as NacntType);
    const ntranIdStart = await getNextId(trx, 'ntran', 2);
    const ntranComment = (txn.memo ?? transferComment)
      .padEnd(50)
      .slice(0, 50);
    const ntranTrnref = (transferDesc + ' (RT)').padEnd(50).slice(0, 50);

    // Source CREDIT (negative)
    await trx.raw(
      `INSERT INTO ntran (
        id, nt_acnt, nt_cntr, nt_type, nt_subt, nt_jrnl,
        nt_ref, nt_inp, nt_trtype, nt_cmnt, nt_trnref,
        nt_entr, nt_value, nt_year, nt_period, nt_rvrse,
        nt_prevyr, nt_consol, nt_fcurr, nt_fvalue, nt_fcrate,
        nt_fcmult, nt_fcdec, nt_srcco, nt_cdesc, nt_project,
        nt_job, nt_posttyp, nt_pstgrp, nt_pstid, nt_srcnlid,
        nt_recurr, nt_perpost, nt_rectify, nt_recjrnl, nt_vatanal,
        nt_distrib, datecreated, datemodified, state
      ) VALUES (
        ?, ?, '    ', ?, ?, ?,
        '', 'BANK_IMP', 'A', ?, ?,
        ?, ?, ?, ?, 0,
        0, 0, '   ', 0, 0,
        0, 0, 'I', '', '        ',
        '        ', 'T', 0, ?, 0,
        0, 0, 0, 0, 0,
        0, ?, ?, 1
      )`,
      [
        ntranIdStart,
        sourceBank,
        sourceType.na_type,
        sourceType.na_subt,
        journal,
        ntranComment,
        ntranTrnref,
        txn.date,
        -absAmount,
        year,
        period,
        ntranPstidSource,
        now.iso,
        now.iso,
      ],
    );
    await updateNacntBalance(trx, sourceBank, -absAmount, { period, year });

    // Dest DEBIT (positive)
    await trx.raw(
      `INSERT INTO ntran (
        id, nt_acnt, nt_cntr, nt_type, nt_subt, nt_jrnl,
        nt_ref, nt_inp, nt_trtype, nt_cmnt, nt_trnref,
        nt_entr, nt_value, nt_year, nt_period, nt_rvrse,
        nt_prevyr, nt_consol, nt_fcurr, nt_fvalue, nt_fcrate,
        nt_fcmult, nt_fcdec, nt_srcco, nt_cdesc, nt_project,
        nt_job, nt_posttyp, nt_pstgrp, nt_pstid, nt_srcnlid,
        nt_recurr, nt_perpost, nt_rectify, nt_recjrnl, nt_vatanal,
        nt_distrib, datecreated, datemodified, state
      ) VALUES (
        ?, ?, '    ', ?, ?, ?,
        '', 'BANK_IMP', 'A', ?, ?,
        ?, ?, ?, ?, 0,
        0, 0, '   ', 0, 0,
        0, 0, 'I', '', '        ',
        '        ', 'T', 0, ?, 0,
        0, 0, 0, 0, 0,
        0, ?, ?, 1
      )`,
      [
        ntranIdStart + 1,
        destBank,
        destType.na_type,
        destType.na_subt,
        journal,
        ntranComment,
        ntranTrnref,
        txn.date,
        absAmount,
        year,
        period,
        ntranPstidDest,
        now.iso,
        now.iso,
      ],
    );
    await updateNacntBalance(trx, destBank, absAmount, { period, year });
    await insertNjmemo(trx, journal, 'Bank Transfer');
  }

  // anoml pair
  // ax_fcrate=1.0, ax_fcdec=2.0 per legacy import_bank_transfer
  // (opera_sql_import.py). Pre-port TS wrote 0,0. Audit 2026-05-14.
  const anomlIdStart = await getNextId(trx, 'anoml', 2);
  const doneFlag = decision.transferFileDoneFlag;
  await trx.raw(
    `INSERT INTO anoml (
      id, ax_nacnt, ax_ncntr, ax_source, ax_date, ax_value, ax_tref,
      ax_comment, ax_done, ax_fcurr, ax_fvalue, ax_fcrate, ax_fcmult, ax_fcdec,
      ax_srcco, ax_unique, ax_project, ax_job, ax_jrnl, ax_nlpdate,
      datecreated, datemodified, state
    ) VALUES (
      ?, ?, '    ', 'A', ?, ?, ?,
      ?, ?, '   ', ?, 1.0, 0, 2.0,
      'I', ?, '        ', '        ', ?, ?,
      ?, ?, 1
    )`,
    [
      anomlIdStart,
      sourceBank,
      txn.date,
      -absAmount,
      reference,
      `Transfer to ${destInfo.description}`.slice(0, 40),
      doneFlag,
      -pence(absAmount),
      sharedUnique,
      journal,
      txn.date,
      now.iso,
      now.iso,
    ],
  );
  await trx.raw(
    `INSERT INTO anoml (
      id, ax_nacnt, ax_ncntr, ax_source, ax_date, ax_value, ax_tref,
      ax_comment, ax_done, ax_fcurr, ax_fvalue, ax_fcrate, ax_fcmult, ax_fcdec,
      ax_srcco, ax_unique, ax_project, ax_job, ax_jrnl, ax_nlpdate,
      datecreated, datemodified, state
    ) VALUES (
      ?, ?, '    ', 'A', ?, ?, ?,
      ?, ?, '   ', ?, 1.0, 0, 2.0,
      'I', ?, '        ', '        ', ?, ?,
      ?, ?, 1
    )`,
    [
      anomlIdStart + 1,
      destBank,
      txn.date,
      absAmount,
      reference,
      `Transfer from ${sourceInfo.description}`.slice(0, 40),
      doneFlag,
      pence(absAmount),
      sharedUnique,
      journal,
      txn.date,
      now.iso,
      now.iso,
    ],
  );

  // --- Phase A verification (in-trx) ---
  // Both legs of the transfer: source (negative) and dest (positive).
  await assertAentryAtran(trx, {
    entryNumber: entryOut,
    bankAccount: sourceBank,
    expectedSignedPence: -pence(absAmount),
    expectedAtType: 8,
    expectedDate: txn.date,
    expectedReferPrefix: reference.slice(0, 20),
  });
  await assertAentryAtran(trx, {
    entryNumber: entryIn,
    bankAccount: destBank,
    expectedSignedPence: pence(absAmount),
    expectedAtType: 8,
    expectedDate: txn.date,
    expectedReferPrefix: reference.slice(0, 20),
  });
  if (decision.postToNominal) {
    await assertBalancedPair(trx, {
      table: 'ntran',
      journal,
      expectedCount: 2,
      entryNumber: entryOut,
    });
  }
  await assertBalancedPair(trx, {
    table: 'anoml',
    journal,
    expectedCount: 2,
    entryNumber: entryOut,
  });

  return { entry_number: entryOut, fingerprint };
}

// ---------------------------------------------------------------------
// postOperaCashbookEntry — unified 1..N-lines core helper.
//
// The core posting primitive for all cashbook entries. Handles 1..N
// lines under a single aentry header. Each line gets its own atran
// row; sales/purchase lines get stran/ptran + sname/pname balance
// updates; all lines get an anoml pair (bank + target); when
// decision.postToNominal is true, all lines also get an ntran pair
// (bank + target leg), plus an optional third VAT leg when a VAT
// code with a positive rate applies.
//
// SQL column lists and VALUES placeholders are copied verbatim from
// postOneTransaction (lines ~559-965) for sales/purchase entries
// and from postNominalEntry (lines ~1199-1718) for nominal entries.
// The only changes are: (a) per-line parameter values replace
// per-transaction values in the bind list; (b) the aentry ae_value
// carries the total across all lines; (c) sq_cruser is bound
// dynamically from header.inputBy instead of hardcoded 'BANK_IMP'.
// ---------------------------------------------------------------------

export async function postOperaCashbookEntry(
  args: PostEntryArgs,
): Promise<PostEntryResult> {
  const { trx, bankCode, header, lines, defaults, decision } = args;

  // Input validation
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error(
      `postOperaCashbookEntry: lines array must have ≥1 entry (got ${lines?.length ?? 0})`,
    );
  }
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!;
    if (!ln.atAccount || !ln.atAccount.trim()) {
      throw new Error(
        `postOperaCashbookEntry: every line needs atAccount (line ${i + 1} has '${ln.atAccount}')`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Entry-level setup (once per entry)
  // ---------------------------------------------------------------------------
  const isReceipt =
    header.action === 'sales_receipt' ||
    header.action === 'purchase_refund' ||
    header.action === 'nominal_receipt';
  const isNominal =
    header.action === 'nominal_payment' || header.action === 'nominal_receipt';
  const isSales =
    header.action === 'sales_receipt' || header.action === 'sales_refund';
  const isPurchase =
    header.action === 'purchase_payment' || header.action === 'purchase_refund';
  const at_type = AT_TYPE_FOR_ACTION[header.action]!;

  if (!at_type) {
    throw new Error(
      `postOperaCashbookEntry: unsupported action '${header.action}'`,
    );
  }

  const receiptOrPayment: 'R' | 'P' = isReceipt ? 'R' : 'P';
  const { code: cbtype, desc: cbtypeDesc } = await resolveCbtype(
    trx,
    header.cbtype,
    receiptOrPayment,
  );
  const paymentMethod = cbtypeDesc.slice(0, 20);
  const now = nowParts();
  const { period, year } = await getPeriodForDate(trx, header.date);
  // VAT type direction: receipts use output/sales VAT ('S'); payments use input/purchase ('P').
  const vatType: 'P' | 'S' = isReceipt ? 'S' : 'P';
  const inputBy = header.inputBy.slice(0, 8);

  // Sum of all line absPence (used for aentry total and nbank update).
  const totalAbsPence = lines.reduce((acc, ln) => acc + ln.absPence, 0);
  const totalSignedPence = isReceipt ? totalAbsPence : -totalAbsPence;
  const totalAbsAmount = totalAbsPence / 100;

  // Allocate entry-level IDs once.
  const entryNumber = await incrementAtypeEntry(trx, cbtype);
  const aentryId = await getNextId(trx, 'aentry');
  const journal = await getNextJournal(trx, 1);

  // Header reference: operator-supplied or derived from first line.
  const headerReference =
    (header.reference ?? '').slice(0, 20) ||
    (lines[0]!.reference ?? '').slice(0, 20) ||
    header.name.slice(0, 20);

  // Fingerprint (returned to caller; same shape as postOneTransaction /
  // postNominalEntry for compatibility with bank-import audit trail).
  const fingerprint = generateImportFingerprint(
    header.name || header.memo || lines[0]!.atAccount,
    isReceipt ? totalAbsAmount : -totalAbsAmount,
    header.date,
  );

  // ---------------------------------------------------------------------------
  // 1. INSERT aentry — one header row for the whole entry.
  // Column list + VALUES copied verbatim from postOneTransaction lines ~559-587.
  // Differences: ae_value = totalSignedPence (not per-line); sq_cruser bound.
  // ---------------------------------------------------------------------------
  await trx.raw(
    `INSERT INTO aentry (
      id, ae_acnt, ae_cntr, ae_cbtype, ae_entry, ae_reclnum,
      ae_lstdate, ae_frstat, ae_tostat, ae_statln, ae_entref,
      ae_value, ae_recbal, ae_remove, ae_tmpstat, ae_complet,
      ae_postgrp, sq_crdate, sq_crtime, sq_cruser, ae_comment,
      ae_payid, ae_batchid, ae_brwptr, datecreated, datemodified, state
    ) VALUES (
      ?, ?, '    ', ?, ?, 0,
      ?, 0, 0, 0, ?,
      ?, 0, 0, 0, 1,
      0, ?, ?, ?, ?,
      0, 0, '  ', ?, ?, 1
    )`,
    [
      aentryId,
      bankCode,
      cbtype,
      entryNumber,
      header.date,
      headerReference,
      totalSignedPence,
      now.date,
      now.time.slice(0, 8),
      inputBy,
      (header.comment || header.name).slice(0, 40),
      now.iso,
      now.iso,
    ],
  );

  // ---------------------------------------------------------------------------
  // Track total bank movement for nbank update at end.
  // ---------------------------------------------------------------------------
  let totalBankPounds = 0;

  // ---------------------------------------------------------------------------
  // 2. Per-line work: atran, stran/ptran (sales/purchase only),
  //    ntran×2-3 + nacnt (gated on postToNominal), anoml×2-3.
  // ---------------------------------------------------------------------------
  let vatLineCount = 0; // lines with actual VAT (for assertBalancedPair)

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!;
    const lineAbs = ln.absPence / 100;
    const lineSignedPence = isReceipt ? ln.absPence : -ln.absPence;
    const lineRef = (ln.reference || headerReference).slice(0, 20);
    const lineComment = (ln.comment || header.comment).slice(0, 200);
    const projectPad = (ln.project || '').padEnd(8).slice(0, 8);
    const departmentPad = (ln.department || '').padEnd(8).slice(0, 8);

    // -------------------------------------------------------------------------
    // 2a. Resolve target account + party info (varies by action family).
    // For nominal: target = line.atAccount directly; party.name from nacnt.
    // For sales: party = customer; target = controlAccount.
    // For purchase: party = supplier; target = controlAccount.
    // -------------------------------------------------------------------------
    let targetAccount: string;
    let partyName: string;
    let partyRegion = 'K  ';
    let partyTerr = '001';
    let partyType = '   ';

    if (isNominal) {
      targetAccount = ln.atAccount;
      partyName = (await loadNominalName(trx, ln.atAccount)) || ln.atAccount;
    } else if (isSales) {
      const party = await loadCustomerInfo(trx, ln.atAccount, defaults.sl_control);
      targetAccount = party.controlAccount;
      partyName = party.name;
      partyRegion = party.region.slice(0, 3);
      partyTerr = party.terr.slice(0, 3);
      partyType = party.type.slice(0, 3);
    } else if (isPurchase) {
      const party = await loadSupplierInfo(trx, ln.atAccount, defaults.pl_control);
      targetAccount = party.controlAccount;
      partyName = party.name;
    } else {
      throw new Error(`postOperaCashbookEntry: unsupported action '${header.action}'`);
    }

    // -------------------------------------------------------------------------
    // 2b. VAT lookup per line (nominal and sales/purchase can carry VAT).
    // Formula mirrors postNominalEntry lines ~1164-1168:
    //   vat = round(gross * rate / (100 + rate), 2)
    //   net = gross - vat
    // -------------------------------------------------------------------------
    const vatLookup = ln.vatCode
      ? await getVatRateForCode(trx, ln.vatCode, vatType, header.date)
      : null;
    const hasVat = !!(vatLookup && vatLookup.rate > 0 && vatLookup.nominal && ln.vatCode);
    const vatPounds = hasVat
      ? Math.round(((lineAbs * vatLookup!.rate) / (100 + vatLookup!.rate)) * 100) / 100
      : 0;
    const netPounds = hasVat
      ? Math.round((lineAbs - vatPounds) * 100) / 100
      : lineAbs;
    const vatNominalAccount = hasVat ? vatLookup!.nominal : '';
    if (hasVat) vatLineCount++;

    // -------------------------------------------------------------------------
    // 2c. INSERT atran (one per line).
    // Column list + VALUES copied verbatim from postOneTransaction lines ~591-636.
    // Differences: at_value = lineSignedPence (not totalSignedPence);
    // at_account = targetAccount; at_name = partyName; at_refer = lineRef;
    // at_project/at_job = projectPad/departmentPad; at_memo = lineComment;
    // sq_cruser bound from inputBy.
    // For nominal entries with VAT, the VAT split creates 2 atran rows per
    // line (net + VAT legs), following postNominalEntry lines ~1283-1372.
    // The non-VAT path inserts one row (this block). VAT path follows below.
    // -------------------------------------------------------------------------
    const lineUnique = generateOperaUniqueId();
    // For VAT split on nominal: a second unique for the VAT atran row
    // (mirrors postNominalEntry lines ~1179-1182).
    const lineUniqueVat = hasVat && isNominal ? generateOperaUniqueId() : null;

    const atranId = await getNextId(trx, 'atran');

    if (!hasVat || !isNominal) {
      // Single atran row (sales, purchase, or nominal-no-vat).
      // Exact copy of postOneTransaction atran INSERT (lines ~591-636).
      await trx.raw(
        `INSERT INTO atran (
          id, at_acnt, at_cntr, at_cbtype, at_entry, at_inputby,
          at_type, at_pstdate, at_sysdate, at_tperiod, at_value,
          at_disc, at_fcurr, at_fcexch, at_fcmult, at_fcdec,
          at_account, at_name, at_comment, at_payee, at_payname,
          at_sort, at_number, at_remove, at_chqprn, at_chqlst,
          at_bacprn, at_ccdprn, at_ccdno, at_payslp, at_pysprn,
          at_cash, at_remit, at_unique, at_postgrp, at_ccauth,
          at_refer, at_srcco, at_ecb, at_ecbtype, at_atpycd,
          at_bsref, at_bsname, at_vattycd, at_project, at_job,
          at_bic, at_iban, at_memo, datecreated, datemodified, state
        ) VALUES (
          ?, ?, '    ', ?, ?, ?,
          ?, ?, ?, 1, ?,
          0, '   ', 1.0, 0, 2,
          ?, ?, ?, '        ', '',
          '        ', '         ', 0, 0, 0,
          0, 0, '', 0, 0,
          0, 0, ?, 0, '0       ',
          ?, 'I', 0, ' ', '      ',
          '', '', '  ', ?, ?,
          '', '', ?, ?, ?, 1
        )`,
        [
          atranId,
          bankCode,
          cbtype,
          entryNumber,
          inputBy,
          at_type,
          header.date,
          header.date,
          lineSignedPence,
          ln.atAccount,
          partyName.slice(0, 35),
          lineComment.slice(0, 35),
          lineUnique,
          lineRef,
          projectPad,
          departmentPad,
          lineComment,
          now.iso,
          now.iso,
        ],
      );
    } else {
      // Nominal VAT-split: two atran rows per line (NET + VAT).
      // Column list + VALUES copied verbatim from postNominalEntry
      // lines ~1285-1372.
      const netSignedPence = isReceipt ? pence(netPounds) : -pence(netPounds);
      const vatSignedPence = isReceipt ? pence(vatPounds) : -pence(vatPounds);
      // loadNominalName for at_name on VAT rows (mirrors postNominalEntry ~1195).
      const nominalName = await loadNominalName(trx, ln.atAccount);
      const atranIdVat = await getNextId(trx, 'atran');

      // atran row 1 — NET amount to nominal account (at_cntr='    ').
      // Verbatim from postNominalEntry lines ~1285-1325.
      await trx.raw(
        `INSERT INTO atran (
          id, at_acnt, at_cntr, at_cbtype, at_entry, at_inputby,
          at_type, at_pstdate, at_sysdate, at_tperiod, at_value,
          at_disc, at_fcurr, at_fcexch, at_fcmult, at_fcdec,
          at_account, at_name, at_comment, at_payee, at_payname,
          at_sort, at_number, at_remove, at_chqprn, at_chqlst,
          at_bacprn, at_ccdprn, at_ccdno, at_payslp, at_pysprn,
          at_cash, at_remit, at_unique, at_postgrp, at_ccauth,
          at_refer, at_srcco, at_ecb, at_ecbtype, at_atpycd,
          at_bsref, at_bsname, at_vattycd, at_project, at_job,
          at_bic, at_iban, at_memo, datecreated, datemodified, state
        ) VALUES (
          ?, ?, '    ', ?, ?, ?,
          ?, ?, ?, 1, ?,
          0, '   ', 1.0, 0, 2,
          ?, ?, ?, '        ', '',
          '        ', '         ', 0, 0, 0,
          0, 0, '', 0, 0,
          0, 0, ?, 0, '0       ',
          ?, 'I', 0, ' ', '      ',
          '', '', '  ', '        ', '        ',
          '', '', ?, ?, ?, 1
        )`,
        [
          atranId,
          bankCode,
          cbtype,
          entryNumber,
          inputBy,
          at_type,
          header.date,
          header.date,
          netSignedPence,
          ln.atAccount,
          nominalName.slice(0, 35),
          lineComment.slice(0, 35),
          lineUnique,
          lineRef,
          lineComment,
          now.iso,
          now.iso,
        ],
      );

      // atran row 2 — VAT amount to vatNominalAccount (at_cntr='   1').
      // Verbatim from postNominalEntry lines ~1330-1372.
      await trx.raw(
        `INSERT INTO atran (
          id, at_acnt, at_cntr, at_cbtype, at_entry, at_inputby,
          at_type, at_pstdate, at_sysdate, at_tperiod, at_value,
          at_disc, at_fcurr, at_fcexch, at_fcmult, at_fcdec,
          at_account, at_name, at_comment, at_payee, at_payname,
          at_sort, at_number, at_remove, at_chqprn, at_chqlst,
          at_bacprn, at_ccdprn, at_ccdno, at_payslp, at_pysprn,
          at_cash, at_remit, at_unique, at_postgrp, at_ccauth,
          at_refer, at_srcco, at_ecb, at_ecbtype, at_atpycd,
          at_bsref, at_bsname, at_vattycd, at_project, at_job,
          at_bic, at_iban, at_memo, datecreated, datemodified, state
        ) VALUES (
          ?, ?, '   1', ?, ?, ?,
          ?, ?, ?, 1, ?,
          0, '   ', 1.0, 0, 2,
          ?, ?, ?, '        ', '',
          '        ', '         ', 0, 0, 0,
          0, 0, '', 0, 0,
          0, 0, ?, 0, '0       ',
          ?, 'I', 0, ' ', '      ',
          '', '', '  ', '        ', '        ',
          '', '', ?, ?, ?, 1
        )`,
        [
          atranIdVat,
          bankCode,
          cbtype,
          entryNumber,
          inputBy,
          at_type,
          header.date,
          header.date,
          vatSignedPence,
          vatNominalAccount,
          `${nominalName.slice(0, 31)} VAT`.slice(0, 35),
          lineComment.slice(0, 35),
          lineUniqueVat!,
          lineRef,
          lineComment,
          now.iso,
          now.iso,
        ],
      );
    }

    // -------------------------------------------------------------------------
    // 2d. Ledger row (stran for sales, ptran for purchases).
    // Column lists + VALUES copied verbatim from postOneTransaction
    // lines ~645-778.  Per-line differences: ledgerId, party.account, dates,
    // memo, cbtype, entryNumber, sharedUnique are now per-line values.
    // -------------------------------------------------------------------------
    if (isSales) {
      // stran: receipts stored negative, refunds positive.
      // Mirrors postOneTransaction lines ~641-708.
      const stValue = isReceipt ? -lineAbs : lineAbs;
      const stType = isReceipt ? 'R' : 'F';
      const ledgerId = await getNextId(trx, 'stran');
      await trx.raw(
        `INSERT INTO stran (
          id, st_account, st_trdate, st_trref, st_custref, st_trtype,
          st_trvalue, st_vatval, st_trbal, st_paid, st_crdate,
          st_advance, st_memo, st_payflag, st_set1day, st_set1,
          st_set2day, st_set2, st_dueday, st_fcurr, st_fcrate,
          st_fcdec, st_fcval, st_fcbal, st_fcmult, st_dispute,
          st_edi, st_editx, st_edivn, st_txtrep, st_binrep,
          st_advallc, st_cbtype, st_entry, st_unique, st_region,
          st_terr, st_type, st_fadval, st_delacc, st_euro,
          st_payadvl, st_eurind, st_origcur, st_fullamt, st_fullcb,
          st_fullnar, st_cash, st_rcode, st_ruser, st_revchrg,
          st_nlpdate, st_adjsv, st_fcvat, st_taxpoin,
          datecreated, datemodified, state
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, 0, ?, ' ', ?,
          'N', ?, 0, 0, 0,
          0, 0, ?, '   ', 0,
          0, 0, 0, 0, 0,
          0, 0, 0, '', 0,
          0, ?, ?, ?, ?,
          ?, ?, 0, ?, 0,
          0, ' ', '   ', 0, '  ',
          '          ', 0, '    ', '        ', 0,
          ?, 0, 0, ?,
          ?, ?, 1
        )`,
        [
          ledgerId,
          ln.atAccount,
          header.date,
          lineRef,
          paymentMethod,
          stType,
          stValue,
          stValue,
          header.date,
          lineComment,
          header.date,
          cbtype,
          entryNumber,
          lineUnique,
          partyRegion,
          partyTerr,
          partyType,   // st_type: customer type from sname.sn_custype
          ln.atAccount,
          header.date,
          header.date,
          now.iso,
          now.iso,
        ],
      );
      await trx.raw(
        `UPDATE sname WITH (ROWLOCK)
         SET sn_currbal = ISNULL(sn_currbal, 0) + ?,
             sn_nextpay = ISNULL(sn_nextpay, 0) + 1,
             datemodified = GETDATE()
         WHERE RTRIM(sn_account) = ?`,
        [stValue, ln.atAccount],
      );
    } else if (isPurchase) {
      // ptran: payments negative, refunds positive.
      // Column list + VALUES copied verbatim from postOneTransaction
      // lines ~731-778.
      const ptValue = isReceipt ? lineAbs : -lineAbs;
      const ptType = isReceipt ? 'F' : 'P';
      const ledgerId = await getNextId(trx, 'ptran');
      await trx.raw(
        `INSERT INTO ptran (
          id, pt_account, pt_trdate, pt_trref, pt_supref, pt_trtype,
          pt_trvalue, pt_vatval, pt_trbal, pt_paid, pt_crdate,
          pt_advance, pt_payflag, pt_set1day, pt_set1, pt_set2day,
          pt_set2, pt_held, pt_fcurr, pt_fcrate, pt_fcdec,
          pt_fcval, pt_fcbal, pt_adval, pt_fadval, pt_fcmult,
          pt_cbtype, pt_entry, pt_unique, pt_suptype, pt_euro,
          pt_payadvl, pt_origcur, pt_eurind, pt_revchrg, pt_nlpdate,
          pt_adjsv, pt_vatset1, pt_vatset2, pt_pyroute, pt_fcvat,
          datecreated, datemodified, state
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, 0, ?, ' ', ?,
          'N', 0, 0, 0, 0,
          0, ' ', '   ', 0, 0,
          0, 0, 0, 0, 0,
          ?, ?, ?, '   ', 0,
          0, '   ', ' ', 0, ?,
          0, 0, 0, 0, 0,
          ?, ?, 1
        )`,
        [
          ledgerId,
          ln.atAccount,
          header.date,
          lineRef,
          paymentMethod,
          ptType,
          ptValue,
          ptValue,
          header.date,
          cbtype,
          entryNumber,
          lineUnique,
          header.date,
          now.iso,
          now.iso,
        ],
      );
      await trx.raw(
        `UPDATE pname WITH (ROWLOCK)
         SET pn_currbal = ISNULL(pn_currbal, 0) + ?,
             pn_nextpay = ISNULL(pn_nextpay, 0) + 1,
             datemodified = GETDATE()
         WHERE RTRIM(pn_account) = ?`,
        [ptValue, ln.atAccount],
      );
    }

    // -------------------------------------------------------------------------
    // 2e. nbank movement tracking (summed; updateNbankBalance called once
    // at the end to avoid multiple partial updates within a loop).
    // -------------------------------------------------------------------------
    const bankDeltaPounds = isReceipt ? lineAbs : -lineAbs;
    totalBankPounds += bankDeltaPounds;

    // -------------------------------------------------------------------------
    // 2f. ntran pair (bank leg + target leg) — GATED on postToNominal.
    // Column lists + VALUES copied verbatim from:
    //   - sales/purchase: postOneTransaction lines ~817-897.
    //   - nominal: postNominalEntry lines ~1408-1536 (bank leg + nominal leg
    //     + optional VAT leg).
    // For multi-line the ntran nt_posttyp distinguishes action family.
    // -------------------------------------------------------------------------
    if (decision.postToNominal) {
      const bankType =
        (await getNacntType(trx, bankCode)) ??
        ({ na_type: 'B ', na_subt: 'BC' } as NacntType);
      const targetType =
        (await getNacntType(trx, targetAccount)) ??
        ({ na_type: isNominal ? 'P ' : 'B ', na_subt: isNominal ? 'PA' : 'BB' } as NacntType);

      // nt_posttyp: 'S' for sales+nominal, 'P' for purchase.
      // Mirrors postOneTransaction axSource logic + postNominalEntry hardcoded 'S'.
      const ntPosttyp = isPurchase ? 'P' : 'S';

      const ntranComment = (lineComment || lineRef || '').padEnd(50).slice(0, 50);
      const ntranTrnref = (
        partyName.slice(0, 30).padEnd(30) +
        cbtypeDesc.slice(0, 10).padEnd(10) +
        '(RT)     '
      ).slice(0, 50);

      // Bank leg ntran.
      // Verbatim from postOneTransaction lines ~816-852 / postNominalEntry ~1407-1443.
      const ntranBankId = await getNextId(trx, 'ntran');
      const ntranPstidBank = generateOperaUniqueId();
      await trx.raw(
        `INSERT INTO ntran (
          id, nt_acnt, nt_cntr, nt_type, nt_subt, nt_jrnl,
          nt_ref, nt_inp, nt_trtype, nt_cmnt, nt_trnref,
          nt_entr, nt_value, nt_year, nt_period, nt_rvrse,
          nt_prevyr, nt_consol, nt_fcurr, nt_fvalue, nt_fcrate,
          nt_fcmult, nt_fcdec, nt_srcco, nt_cdesc, nt_project,
          nt_job, nt_posttyp, nt_pstgrp, nt_pstid, nt_srcnlid,
          nt_recurr, nt_perpost, nt_rectify, nt_recjrnl, nt_vatanal,
          nt_distrib, datecreated, datemodified, state
        ) VALUES (
          ?, ?, '    ', ?, ?, ?,
          '', ?, 'A', ?, ?,
          ?, ?, ?, ?, 0,
          0, 0, '   ', 0, 0,
          0, 0, 'I', '', '        ',
          '        ', ?, 0, ?, 0,
          0, 0, 0, 0, 0,
          0, ?, ?, 1
        )`,
        [
          ntranBankId,
          bankCode,
          bankType.na_type,
          bankType.na_subt,
          journal,
          inputBy.slice(0, 10),
          ntranComment,
          ntranTrnref,
          header.date,
          bankDeltaPounds,
          year,
          period,
          ntPosttyp,
          ntranPstidBank,
          now.iso,
          now.iso,
        ],
      );
      await updateNacntBalance(trx, bankCode, bankDeltaPounds, { period, year });

      // Target leg ntran (opposite sign).
      // For non-VAT: controlValue = -bankDeltaPounds.
      // For VAT nominal: nominalLegValue = nominalNtranValue (net, opposite sign of bank).
      const nominalNtranValue = isReceipt ? -netPounds : netPounds;
      const targetLegValue = hasVat
        ? nominalNtranValue
        : -bankDeltaPounds;

      // Verbatim from postOneTransaction lines ~856-897 / postNominalEntry ~1449-1489.
      const ntranTargetId = await getNextId(trx, 'ntran');
      const ntranPstidTarget = generateOperaUniqueId();
      await trx.raw(
        `INSERT INTO ntran (
          id, nt_acnt, nt_cntr, nt_type, nt_subt, nt_jrnl,
          nt_ref, nt_inp, nt_trtype, nt_cmnt, nt_trnref,
          nt_entr, nt_value, nt_year, nt_period, nt_rvrse,
          nt_prevyr, nt_consol, nt_fcurr, nt_fvalue, nt_fcrate,
          nt_fcmult, nt_fcdec, nt_srcco, nt_cdesc, nt_project,
          nt_job, nt_posttyp, nt_pstgrp, nt_pstid, nt_srcnlid,
          nt_recurr, nt_perpost, nt_rectify, nt_recjrnl, nt_vatanal,
          nt_distrib, datecreated, datemodified, state
        ) VALUES (
          ?, ?, '    ', ?, ?, ?,
          '', ?, 'A', ?, ?,
          ?, ?, ?, ?, 0,
          0, 0, '   ', 0, 0,
          0, 0, 'I', '', ?,
          ?, ?, 0, ?, 0,
          0, 0, 0, 0, 0,
          0, ?, ?, 1
        )`,
        [
          ntranTargetId,
          targetAccount,
          targetType.na_type,
          targetType.na_subt,
          journal,
          inputBy.slice(0, 10),
          ntranComment,
          ntranTrnref,
          header.date,
          targetLegValue,
          year,
          period,
          projectPad,
          departmentPad,
          ntPosttyp,
          ntranPstidTarget,
          now.iso,
          now.iso,
        ],
      );
      await updateNacntBalance(trx, targetAccount, targetLegValue, { period, year });

      // VAT ntran leg + zvtran + nvat — only when VAT applies (nominal path).
      // Column list + VALUES copied verbatim from postNominalEntry lines ~1497-1536 (ntran)
      // and lines ~1656-1684 (nvat). There is no zvtran table in TS — the
      // legacy Python reference to 'zvtran' maps to 'nvat' in Opera SE.
      if (hasVat) {
        const vatNtranValue = isReceipt ? -vatPounds : vatPounds;
        const vatAcctType =
          (await getNacntType(trx, vatNominalAccount)) ??
          ({ na_type: 'B ', na_subt: 'BB' } as NacntType);
        const ntranVatComment = `${ntranComment.trim()} VAT`.slice(0, 50).padEnd(50);

        // VAT ntran leg. Verbatim from postNominalEntry lines ~1497-1532.
        const ntranVatId = await getNextId(trx, 'ntran');
        const ntranPstidVat = generateOperaUniqueId();
        await trx.raw(
          `INSERT INTO ntran (
            id, nt_acnt, nt_cntr, nt_type, nt_subt, nt_jrnl,
            nt_ref, nt_inp, nt_trtype, nt_cmnt, nt_trnref,
            nt_entr, nt_value, nt_year, nt_period, nt_rvrse,
            nt_prevyr, nt_consol, nt_fcurr, nt_fvalue, nt_fcrate,
            nt_fcmult, nt_fcdec, nt_srcco, nt_cdesc, nt_project,
            nt_job, nt_posttyp, nt_pstgrp, nt_pstid, nt_srcnlid,
            nt_recurr, nt_perpost, nt_rectify, nt_recjrnl, nt_vatanal,
            nt_distrib, datecreated, datemodified, state
          ) VALUES (
            ?, ?, '    ', ?, ?, ?,
            '', ?, 'A', ?, ?,
            ?, ?, ?, ?, 0,
            0, 0, '   ', 0, 0,
            0, 0, 'I', '', '        ',
            '        ', 'S', 0, ?, 0,
            0, 0, 0, 0, 0,
            0, ?, ?, 1
          )`,
          [
            ntranVatId,
            vatNominalAccount,
            vatAcctType.na_type,
            vatAcctType.na_subt,
            journal,
            inputBy.slice(0, 10),
            ntranVatComment,
            ntranTrnref,
            header.date,
            vatNtranValue,
            year,
            period,
            ntranPstidVat,
            now.iso,
            now.iso,
          ],
        );
        await updateNacntBalance(trx, vatNominalAccount, vatNtranValue, { period, year });

        // nvat — VAT-return tracking record.
        // Column list + VALUES copied verbatim from postNominalEntry lines ~1656-1684.
        const nvVattype = isReceipt ? 'S' : 'P';
        const nvatRowId = await getNextId(trx, 'nvat');
        const nvatComment = `${lineComment.slice(0, 36)} VAT`.slice(0, 40);
        await trx.raw(
          `INSERT INTO nvat (
            id, nv_acnt, nv_cntr, nv_date, nv_crdate, nv_taxdate,
            nv_ref, nv_type, nv_advance, nv_value, nv_vatval,
            nv_vatctry, nv_vattype, nv_vatcode, nv_vatrate, nv_comment,
            datecreated, datemodified, state
          ) VALUES (
            ?, ?, '', ?, ?, ?,
            ?, ?, 0, ?, ?,
            ' ', ?, ?, ?, ?,
            ?, ?, 1
          )`,
          [
            nvatRowId,
            vatNominalAccount,
            header.date,
            header.date,
            header.date,
            lineRef,
            nvVattype,
            netPounds,
            vatPounds,
            nvVattype,
            (ln.vatCode ?? '').trim(),
            vatLookup!.rate,
            nvatComment,
            now.iso,
            now.iso,
          ],
        );
      }

      // Journal memo — once per line (same shape as postNominalEntry ~1538).
      await insertNjmemo(trx, journal, 'Cashbook Ledger Transfer (RT)');
    }

    // -------------------------------------------------------------------------
    // 2g. anoml pair (bank leg + target leg) + optional VAT third leg.
    //
    // For nominal (isNominal=true): mirror postNominalEntry lines ~1553-1645.
    //   ax_source='A', ax_fcrate=1.0, ax_fcdec=2.0.
    // For sales/purchase: mirror postOneTransaction lines ~913-965.
    //   ax_source='S' or 'P', ax_fcrate=0, ax_fcdec=0.
    //
    // Column list + VALUES are copied verbatim; only the fcrate/fcdec literal
    // values change between the two families.
    //
    // anoml.ax_jrnl is always the journal number (not conditional on
    // postToNominal — both postOneTransaction and postNominalEntry always
    // write journal, regardless of postToNominal flag).
    // -------------------------------------------------------------------------
    const axSource = isNominal ? 'A' : isSales ? 'S' : 'P';
    const anomlComment = (
      partyName.slice(0, 30).padEnd(30) + paymentMethod
    ).slice(0, 40);
    const doneFlag = decision.transferFileDoneFlag;

    if (isNominal) {
      // Nominal anoml — verbatim from postNominalEntry lines ~1553-1606.
      // ax_fcrate=1.0, ax_fcdec=2.0 (audit-confirmed from Opera snapshot).
      const anomlBankValue = bankDeltaPounds;
      const anomlNominalValue = hasVat ? (isReceipt ? -netPounds : netPounds) : -bankDeltaPounds;

      const anomlBankId = await getNextId(trx, 'anoml');
      await trx.raw(
        `INSERT INTO anoml (
          id, ax_nacnt, ax_ncntr, ax_source, ax_date, ax_value, ax_tref,
          ax_comment, ax_done, ax_fcurr, ax_fvalue, ax_fcrate, ax_fcmult, ax_fcdec,
          ax_srcco, ax_unique, ax_project, ax_job, ax_jrnl, ax_nlpdate,
          datecreated, datemodified, state
        ) VALUES (
          ?, ?, '    ', 'A', ?, ?, ?,
          ?, ?, '   ', 0, 1.0, 0, 2.0,
          'I', ?, '        ', '        ', ?, ?,
          ?, ?, 1
        )`,
        [
          anomlBankId,
          bankCode,
          header.date,
          anomlBankValue,
          lineRef,
          anomlComment,
          doneFlag,
          lineUnique,
          journal,
          header.date,
          now.iso,
          now.iso,
        ],
      );

      const anomlNominalId = await getNextId(trx, 'anoml');
      await trx.raw(
        `INSERT INTO anoml (
          id, ax_nacnt, ax_ncntr, ax_source, ax_date, ax_value, ax_tref,
          ax_comment, ax_done, ax_fcurr, ax_fvalue, ax_fcrate, ax_fcmult, ax_fcdec,
          ax_srcco, ax_unique, ax_project, ax_job, ax_jrnl, ax_nlpdate,
          datecreated, datemodified, state
        ) VALUES (
          ?, ?, '    ', 'A', ?, ?, ?,
          ?, ?, '   ', 0, 1.0, 0, 2.0,
          'I', ?, '        ', '        ', ?, ?,
          ?, ?, 1
        )`,
        [
          anomlNominalId,
          targetAccount,
          header.date,
          anomlNominalValue,
          lineRef,
          anomlComment,
          doneFlag,
          lineUnique,
          journal,
          header.date,
          now.iso,
          now.iso,
        ],
      );

      // VAT leg anoml — verbatim from postNominalEntry lines ~1619-1645.
      if (hasVat) {
        const vatNtranValue = isReceipt ? -vatPounds : vatPounds;
        const anomlVatFvalue = Math.round(vatNtranValue * 100);
        const anomlVatId = await getNextId(trx, 'anoml');
        await trx.raw(
          `INSERT INTO anoml (
            id, ax_nacnt, ax_ncntr, ax_source, ax_date, ax_value, ax_tref,
            ax_comment, ax_done, ax_fcurr, ax_fvalue, ax_fcrate, ax_fcmult, ax_fcdec,
            ax_srcco, ax_unique, ax_project, ax_job, ax_jrnl, ax_nlpdate,
            datecreated, datemodified, state
          ) VALUES (
            ?, ?, '    ', 'A', ?, ?, ?,
            ?, ?, '   ', ?, 1.0, 0, 2.0,
            'I', ?, '        ', '        ', ?, ?,
            ?, ?, 1
          )`,
          [
            anomlVatId,
            vatNominalAccount,
            header.date,
            vatNtranValue,
            lineRef,
            `${anomlComment.trim().slice(0, 36)} VAT`.slice(0, 40),
            doneFlag,
            anomlVatFvalue,
            lineUniqueVat!,
            journal,
            header.date,
            now.iso,
            now.iso,
          ],
        );
      }
    } else {
      // Sales / purchase anoml — verbatim from postOneTransaction lines ~913-965.
      // ax_fcrate=0, ax_fcdec=0.
      const anomlBankValue = bankDeltaPounds;
      const controlValue = -bankDeltaPounds;

      const anomlBankId = await getNextId(trx, 'anoml');
      await trx.raw(
        `INSERT INTO anoml (
          id, ax_nacnt, ax_ncntr, ax_source, ax_date, ax_value, ax_tref,
          ax_comment, ax_done, ax_fcurr, ax_fvalue, ax_fcrate, ax_fcmult, ax_fcdec,
          ax_srcco, ax_unique, ax_project, ax_job, ax_jrnl, ax_nlpdate,
          datecreated, datemodified, state
        ) VALUES (
          ?, ?, '    ', '${axSource}', ?, ?, ?,
          ?, ?, '   ', 0, 0, 0, 0,
          'I', ?, '        ', '        ', ?, ?,
          ?, ?, 1
        )`,
        [
          anomlBankId,
          bankCode,
          header.date,
          anomlBankValue,
          lineRef,
          anomlComment,
          doneFlag,
          lineUnique,
          journal,
          header.date,
          now.iso,
          now.iso,
        ],
      );
      const anomlTargetId = await getNextId(trx, 'anoml');
      await trx.raw(
        `INSERT INTO anoml (
          id, ax_nacnt, ax_ncntr, ax_source, ax_date, ax_value, ax_tref,
          ax_comment, ax_done, ax_fcurr, ax_fvalue, ax_fcrate, ax_fcmult, ax_fcdec,
          ax_srcco, ax_unique, ax_project, ax_job, ax_jrnl, ax_nlpdate,
          datecreated, datemodified, state
        ) VALUES (
          ?, ?, '    ', '${axSource}', ?, ?, ?,
          ?, ?, '   ', 0, 0, 0, 0,
          'I', ?, '        ', '        ', ?, ?,
          ?, ?, 1
        )`,
        [
          anomlTargetId,
          targetAccount,
          header.date,
          controlValue,
          lineRef,
          anomlComment,
          doneFlag,
          lineUnique,
          journal,
          header.date,
          now.iso,
          now.iso,
        ],
      );
    }
  } // end per-line loop

  // ---------------------------------------------------------------------------
  // 3. UPDATE nbank — once, with the total bank movement across all lines.
  // ---------------------------------------------------------------------------
  await updateNbankBalance(trx, bankCode, totalBankPounds);

  // ---------------------------------------------------------------------------
  // 4. Entry-level verification asserts (Phase A, in-trx).
  // ---------------------------------------------------------------------------
  // For nominal entries each VAT-bearing line produces 2 atran rows (net +
  // VAT split). Sales/purchase entries have no atran VAT split (1 row each).
  const totalAtranCount = lines.length + (isNominal ? vatLineCount : 0);
  await assertAentryAtran(trx, {
    entryNumber,
    bankAccount: bankCode,
    expectedSignedPence: totalSignedPence,
    expectedAtType: at_type,
    expectedDate: header.date,
    expectedAtranCount: totalAtranCount,
  });

  if (isSales || isPurchase) {
    for (const ln of lines) {
      const lineAbs = ln.absPence / 100;
      await assertLedgerRow(trx, {
        ledger: isSales ? 'sales' : 'purchase',
        entryNumber,
        cbtype,
        account: ln.atAccount,
        expectedValuePounds: isSales
          ? (isReceipt ? -lineAbs : lineAbs)   // stran: receipt=negative, refund=positive
          : (isReceipt ? lineAbs : -lineAbs),  // ptran: payment=negative, refund=positive
      });
    }
  }

  if (decision.postToNominal) {
    // ntran count: 2 per line (bank + target), +1 per VAT line.
    await assertBalancedPair(trx, {
      table: 'ntran',
      journal,
      expectedCount: lines.length * 2 + vatLineCount,
      entryNumber,
    });
  }

  // anoml count: 2 per line (bank + target), +1 per VAT line (nominal only).
  const anomlVatCount = isNominal ? vatLineCount : 0;
  await assertBalancedPair(trx, {
    table: 'anoml',
    journal,
    expectedCount: lines.length * 2 + anomlVatCount,
    entryNumber,
  });

  return { entry_number: entryNumber, fingerprint };
}

// ---------------------------------------------------------------------
// Public executor
// ---------------------------------------------------------------------

export const bankImportPostingExecutor: ImportPostingExecutor = {
  async postBankImport({
    operaDb,
    bankCode,
    statementInfo,
    transactions,
    overrides: _overrides, // applied upstream by the route layer
    selectedRows,
    autoAllocate,
    autoReconcile: _autoReconcile, // wired in import-from-pdf.ts post-success
    paymentRequestLookup,
  }) {
    const errors: string[] = [];
    const warnings: string[] = [];
    const posted_lines: Array<{
      line_number: number;
      post_date: string;
      amount: number;
      posted_entry_number: string;
      description: string;
      at_type: number;
    }> = [];
    let imported = 0;
    let failed = 0;
    let skipped = 0;

    let controlAccounts;
    try {
      controlAccounts = await getControlAccounts(operaDb);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        records_imported: 0,
        records_failed: transactions.length,
        skipped_count: 0,
        errors: [msg],
        warnings: [],
        import_id: null,
      };
    }
    const defaults = {
      sl_control: controlAccounts.debtorsControl,
      pl_control: controlAccounts.creditorsControl,
    };

    void statementInfo;

    const selected = selectedRows ? new Set(selectedRows) : null;

    // Aentries claimed earlier in this batch by the just-in-time
    // duplicate check. Threaded across the loop so two identical-
    // amount transactions on the same statement allocate to distinct
    // existing aentries (matches legacy routes.py:4171-4180).
    const consumedAtEntries = new Set<string>();

    for (let i = 0; i < transactions.length; i++) {
      const t = transactions[i]!;
      if (selected && !selected.has(i + 1) && !selected.has(i)) {
        skipped += 1;
        continue;
      }
      const action = (t as unknown as { action?: string }).action ?? 'skip';
      if (action === 'skip' || action === 'defer') {
        skipped += 1;
        continue;
      }
      if (!AT_TYPE_FOR_ACTION[action]) {
        warnings.push(`Row ${i + 1}: unknown action '${action}'. Skipped.`);
        skipped += 1;
        continue;
      }

      const matchedAccount =
        ((t as unknown as { matched_account?: string | null }).matched_account ??
          null) ||
        ((t as unknown as { manual_account?: string | null }).manual_account ??
          null) ||
        ((t as unknown as { account?: string | null }).account ?? null);

      const prepared: PreparedTransaction = {
        index: i + 1,
        date: dateAsYmd(t.date),
        amount: Number(t.amount ?? 0),
        name: t.name ?? '',
        memo: t.memo ?? '',
        action,
        matchedAccount: matchedAccount ?? null,
        cbtype: (t as unknown as { cbtype?: string | null }).cbtype ?? null,
        reference:
          (t as unknown as { reference?: string | null }).reference ?? null,
        // VAT override fields plumbed from the orchestration shell
        // (import-from-pdf.ts lines 519-526 mutate txnList with
        // overlay.vat_code / overlay.net_amount). Consumed by the
        // VAT-split branch in postNominalEntry.
        vatCode:
          ((t as unknown as { vat_code?: string | null }).vat_code ?? null) ||
          null,
        netAmount: (() => {
          const v = (t as unknown as { net_amount?: number | null }).net_amount;
          return v === undefined || v === null ? null : Number(v);
        })(),
      };

      // Just-in-time cashbook duplicate check. Faithful port of
      // routes.py:4317-4348. Skipped for 'skip'/'defer' (handled
      // above) — applied to every action that creates a new aentry.
      try {
        const dup = await checkCashbookDuplicateBeforePosting({
          operaDb,
          bankCode,
          transactionDate: prepared.date,
          signedAmountPounds: prepared.amount,
          action,
          excludeEntryNumbers: consumedAtEntries,
          description: prepared.name || prepared.memo || '',
          accountCode: matchedAccount,
        });
        if (dup.isDuplicate) {
          skipped += 1;
          errors.push(`Row ${i + 1}: Skipped - ${dup.reason}`);
          if (dup.entryNumber) consumedAtEntries.add(dup.entryNumber);
          continue;
        }
        // LEDGER_ALLOCATION_TARGET: informational. Caller still posts;
        // surface the hint as a warning so the operator can see why
        // auto-allocate may have a candidate.
        if (dup.ledgerAllocationHint) {
          warnings.push(
            `Row ${i + 1}: ${dup.ledgerAllocationHint.reason}`,
          );
        }
      } catch (dupErr) {
        // Don't block the post on dup-check failure; the legacy
        // wrapper also logs and continues (routes.py:4347-4348).
        warnings.push(
          `Row ${i + 1}: pre-posting duplicate check failed: ${
            dupErr instanceof Error ? dupErr.message : String(dupErr)
          }`,
        );
      }

      // Pre-lock check on the customer/supplier master row. Faithful
      // port of `check_record_locked` (opera_sql_import.py:cf9cbde).
      // Catches the locked-by-another-user case BEFORE opening a
      // multi-table posting transaction that would block mid-write.
      // Skip for nominal_payment / nominal_receipt / bank_transfer —
      // they don't update sname or pname.
      if (
        prepared.matchedAccount &&
        (action === 'sales_receipt' || action === 'sales_refund')
      ) {
        const locked = await isRecordLocked(operaDb, {
          table: 'sname',
          keyColumn: 'sn_account',
          keyValue: prepared.matchedAccount,
        });
        if (locked) {
          errors.push(
            `Row ${i + 1}: customer ${prepared.matchedAccount} is locked ` +
              `by another Opera user — try again in a moment`,
          );
          failed += 1;
          continue;
        }
      } else if (
        prepared.matchedAccount &&
        (action === 'purchase_payment' || action === 'purchase_refund')
      ) {
        const locked = await isRecordLocked(operaDb, {
          table: 'pname',
          keyColumn: 'pn_account',
          keyValue: prepared.matchedAccount,
        });
        if (locked) {
          errors.push(
            `Row ${i + 1}: supplier ${prepared.matchedAccount} is locked ` +
              `by another Opera user — try again in a moment`,
          );
          failed += 1;
          continue;
        }
      }

      // Period-posting decision: queries RTU/OPA settings + nclndd
      // status for the posting date. Reject up-front if the period is
      // closed/blocked. Faithful port of opera_config.py:848.
      const ledgerForDecision: 'NL' | 'SL' | 'PL' =
        action === 'sales_receipt' || action === 'sales_refund'
          ? 'SL'
          : action === 'purchase_payment' || action === 'purchase_refund'
            ? 'PL'
            : 'NL';
      const decision = await getPeriodPostingDecision(
        operaDb,
        prepared.date,
        ledgerForDecision,
      );
      if (!decision.canPost) {
        errors.push(
          `Row ${i + 1}: ${decision.errorMessage ?? 'period closed for posting'}`,
        );
        failed += 1;
        continue;
      }

      try {
        let entryNumber: string | null = null;
        let postedRef: string | null = null;
        // Deadlock retry: SQL Server 1205 victims get 3 retries with
        // 100ms / 500ms / 1500ms backoff. Faithful port of
        // execute_with_deadlock_retry (opera_sql_import.py:271).
        await executeWithDeadlockRetry(operaDb, async (trx) => {
          let result: { entry_number: string; transaction_ref?: string };
          if (action === 'nominal_payment' || action === 'nominal_receipt') {
            result = await postNominalEntry({ trx, bankCode, txn: prepared, defaults, decision });
          } else if (action === 'bank_transfer') {
            result = await postBankTransfer({ trx, bankCode, txn: prepared, defaults, decision });
          } else {
            result = await postOneTransaction({ trx, bankCode, txn: prepared, defaults, decision });
          }
          entryNumber = result.entry_number;
          postedRef = (result as { transaction_ref?: string }).transaction_ref ?? null;

          // Auto-allocate within the same trx so the allocation rolls
          // back together with the posting on any failure. Faithful
          // port of routes.py:4369-4397: only fires for sales_receipt
          // and purchase_payment, against the matched ledger account.
          if (
            autoAllocate &&
            (action === 'sales_receipt' || action === 'purchase_payment') &&
            prepared.matchedAccount
          ) {
            const txnRef =
              postedRef ?? prepared.reference ?? prepared.name.slice(0, 20);
            // No outer try/catch — any DB-level allocation failure
            // MUST abort the enclosing trx so the receipt/payment is
            // rolled back together with the failed allocation. Soft
            // "no allocation target" answers come back as
            // {success:false, message:'...'} without throwing —
            // those land as a warning and the trx commits the
            // receipt as-is, which is correct (legacy behaviour).
            // Audit 2026-05-15.
            if (action === 'sales_receipt') {
              // Extract a candidate gc_payment_id from the
              // description. GoCardless payment IDs match the
              // pattern PM<alphanumeric> (e.g. 'PM000ABCDEF12345'
              // per opera_sql_import.py:7049). The lookup is a
              // no-op when no candidate is present.
              const descText = (prepared.memo || prepared.name) ?? '';
              const gcMatch = descText.match(/\bPM[A-Z0-9]{6,}\b/);
              const gcCandidate = gcMatch ? gcMatch[0] : null;
              const allocRes = await autoAllocateReceipt({
                trx,
                customerAccount: prepared.matchedAccount,
                receiptRef: txnRef,
                receiptAmount: Math.abs(prepared.amount),
                allocationDate: prepared.date,
                bankAccount: bankCode,
                description: descText,
                gcPaymentId: gcCandidate,
                paymentRequestLookup: paymentRequestLookup ?? null,
              });
              if (!allocRes.success && allocRes.message) {
                warnings.push(
                  `Row ${i + 1}: auto-allocate did not run: ${allocRes.message}`,
                );
              }
            } else {
              const allocRes = await autoAllocatePayment({
                trx,
                supplierAccount: prepared.matchedAccount,
                paymentRef: txnRef,
                paymentAmount: Math.abs(prepared.amount),
                allocationDate: prepared.date,
                bankAccount: bankCode,
                description: prepared.memo || prepared.name,
              });
              if (!allocRes.success && allocRes.message) {
                warnings.push(
                  `Row ${i + 1}: auto-allocate did not run: ${allocRes.message}`,
                );
              }
            }
          }
        }, `import-row-${i + 1}-${action}`);
        imported += 1;
        // Capture per-line record for production-correct restore
        // detection (bank_statement_transactions row written by the
        // import flow). The entry_number lets us validate later that
        // Opera still has this posting.
        if (entryNumber) {
          posted_lines.push({
            line_number: i + 1,
            post_date: prepared.date,
            amount: prepared.amount,
            posted_entry_number: entryNumber,
            description: prepared.memo || prepared.name || '',
            at_type: AT_TYPE_FOR_ACTION[action]!,
          });
        }

        // --- Phase C verification (post-commit, fresh pool connection) ---
        // The in-trx checks (Phase A) already confirmed the row landed
        // before the trx committed. Phase C re-reads from a separate
        // session to confirm the commit is visible outside our trx —
        // catches the rare cases where a trigger or replication issue
        // leaves the row only visible to us. NEVER silently retries:
        // if the row isn't visible, surface a hard operator-action
        // error rather than masking a real corruption.
        if (entryNumber) {
          const isTransfer = action === 'bank_transfer';
          const verifyBankAccount = isTransfer
            ? (prepared.amount < 0
                ? bankCode
                : prepared.matchedAccount ?? bankCode)
            : bankCode;
          const verifySignedPence = isTransfer
            ? -Math.round(Math.abs(prepared.amount) * 100)
            : Math.round(prepared.amount * 100);
          const vResult = await verifyAentryCommitted(operaDb, {
            entryNumber,
            bankAccount: verifyBankAccount,
            expectedSignedPence: verifySignedPence,
          });
          if (!vResult.verified) {
            errors.push(
              `Row ${i + 1}: POST-COMMIT VERIFICATION FAILED — entry ${entryNumber} ` +
                `posted to Opera but verification could not confirm: ${vResult.reason}. ` +
                `Check Opera manually before re-running.`,
            );
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof PostingVerificationError) {
          errors.push(
            `Row ${i + 1}: VERIFICATION FAILED (${err.phase}) — ${msg}. ` +
              `Trx rolled back; nothing posted for this row.`,
          );
        } else {
          errors.push(`Row ${i + 1}: ${msg}`);
        }
        failed += 1;
      }
    }

    return {
      success: errors.length === 0,
      records_imported: imported,
      records_failed: failed,
      skipped_count: skipped,
      errors,
      warnings,
      import_id: null,
      posted_lines,
    };
  },
};

// Helper exposed for tests + duplicate-detection re-use
export type { CheckTransactionInput };
export type { PdfExtractionResult };

/**
 * Internals reused by the recurring-entry posting flow
 * (src/services/post-recurring-entry.ts). The recurring-entry post
 * needs the same aentry/atran/ntran/anoml/stran/ptran/VAT insert
 * scaffolding as a regular bank-import row, so we expose the
 * single-line post helpers + the prepared-row shape rather than
 * duplicating ~600 lines of careful SQL.
 *
 * NOT a stable public API — internal to bank-reconcile services only.
 * Callers MUST run these inside a transaction (`trx`) they own and
 * must NOT use them concurrently with the bank-import flow on the
 * same trx.
 */
export {
  postOneTransaction as _postOneTransaction_internal,
  postNominalEntry as _postNominalEntry_internal,
  pence as _pence_internal,
  nowParts as _nowParts_internal,
  dateAsYmd as _dateAsYmd_internal,
  resolveCbtype as _resolveCbtype_internal,
  loadBankInfo as _loadBankInfo_internal,
};
export type { PreparedTransaction as _PreparedTransaction_internal };

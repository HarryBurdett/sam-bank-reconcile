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

type TxnAction =
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

  const dir = deriveTxnDirection(txn.action);
  // ax_source / nt_posttyp discriminators — legacy writes 'S' for sales
  // posts (opera_sql_import.py:import_sales_receipt anoml ax_source='S';
  // ntran nt_posttyp='S') and 'P' for purchase posts (import_purchase_payment
  // anoml ax_source='P'; ntran nt_posttyp='P'). The pre-port TS hardcoded
  // 'A' / 'S' regardless of ledger — confirmed wrong by 2026-05-14 audit.
  const axSource = dir.ledger === 'sales' ? 'S' : 'P';
  const ntPosttyp = dir.ledger === 'sales' ? 'S' : 'P';
  const { code: cbtype, desc: cbtypeDesc } = await resolveCbtype(
    trx,
    txn.cbtype,
    dir.receiptOrPayment,
  );
  // Payment-method string written to stran.st_custref / ptran.pt_supref /
  // anoml.ax_comment / ntran.nt_trnref. Snapshot e.g. 'BACS' / 'Cheque
  // Receipt'. Legacy passes the cbtype description through (opera_sql_
  // import.py:2458, :3306). Slice to 20 to match column width.
  const paymentMethod = cbtypeDesc.slice(0, 20);
  const at_type = AT_TYPE_FOR_ACTION[txn.action]!;
  const now = nowParts();
  const { period, year } = await getPeriodForDate(trx, txn.date);

  const party =
    dir.ledger === 'sales'
      ? await loadCustomerInfo(trx, txn.matchedAccount, defaults.sl_control)
      : await loadSupplierInfo(trx, txn.matchedAccount, defaults.pl_control);

  const absAmount = Math.abs(Number(txn.amount));
  const signedPence =
    dir.direction === 'in' ? pence(absAmount) : -pence(absAmount);

  const entryNumber = await incrementAtypeEntry(trx, cbtype);
  const aentryId = await getNextId(trx, 'aentry');
  const journal = await getNextJournal(trx, 1);
  const atranId = await getNextId(trx, 'atran');
  const ledgerId = await getNextId(
    trx,
    dir.ledger === 'sales' ? 'stran' : 'ptran',
  );
  const sharedUnique = generateOperaUniqueId();
  const fingerprint = generateImportFingerprint(
    txn.name || txn.memo || party.name,
    txn.amount,
    txn.date,
  );

  // 1. aentry (single-line entry, complete=1 always for line-by-line imports)
  const reference = (txn.reference ?? '').slice(0, 20) || party.name.slice(0, 20);
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
      aentryId,
      bankCode,
      cbtype,
      entryNumber,
      txn.date,
      reference,
      signedPence,
      now.date,
      now.time.slice(0, 8),
      txn.memo.slice(0, 40),
      now.iso,
      now.iso,
    ],
  );

  // 2. atran
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
      at_type,
      txn.date,
      txn.date,
      signedPence,
      party.account,
      party.name.slice(0, 35),
      txn.memo.slice(0, 35),
      sharedUnique,
      // at_refer = operator's bank reference (Opera's stran/ptran browse
      // shows this column). Pre-port TS stamped the BKIMP fingerprint
      // here, which clobbered the user-visible reference. Duplicate
      // detection keys off bank/date/amount/at_type — at_refer was
      // never load-bearing for dup checking. Audit 2026-05-14.
      reference.slice(0, 20),
      txn.memo.slice(0, 200),
      now.iso,
      now.iso,
    ],
  );

  // 3. Ledger row (stran for sales, ptran for purchases) — pounds
  if (dir.ledger === 'sales') {
    // stran: receipts stored negative (reduce balance); refunds positive (increase)
    const stValue = dir.direction === 'in' ? -absAmount : absAmount;
    const stType = dir.direction === 'in' ? 'R' : 'F'; // R=receipt, F=refund
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
        party.account,
        txn.date,
        reference,
        // st_custref: payment-method description from atype (e.g. 'BACS',
        // 'Cheque Receipt'). Pre-port TS wrote ''. Legacy opera_sql_
        // import.py:2458 writes `{payment_method[:20]}`. Snapshot
        // cashbook_sales_receipt_-_bacs_*.json: st_custref='BACS'.
        paymentMethod,
        stType,
        stValue,
        stValue,
        txn.date,
        txn.memo.slice(0, 200),
        txn.date,
        cbtype,
        entryNumber,
        sharedUnique,
        party.region.slice(0, 3),
        party.terr.slice(0, 3),
        party.type.slice(0, 3),
        party.account,
        txn.date,
        txn.date,
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
      [stValue, party.account],
    );
  } else {
    // ptran sign convention (purchase ledger):
    //   payment:  pt_trvalue = -amount (negative) — reduces balance owed
    //   refund:   pt_trvalue = +amount (positive) — increases balance owed
    // Faithful to legacy opera_sql_import.py:3443 (`{-amount_pounds}` for
    // purchase_payment) and to the canonical snapshot row in
    // transaction-library/opera_se/purchase_ledger_purchase_payment_bacs_...json
    // (added_rows[0].pt_trvalue = -599.0 for a £599 payment).
    //
    // The corresponding pname.pn_currbal UPDATE below uses `+ ptValue`
    // (i.e. adds the signed value) — matching legacy `pn_currbal - amount`
    // because ptValue is already negative for a payment.
    const ptValue = dir.direction === 'out' ? -absAmount : absAmount;
    const ptType = dir.direction === 'out' ? 'P' : 'F';
    // ptran INSERT — 44 columns matching the canonical purchase_payment
    // row in `~/opera-knowledge-ref/.../transaction-library/opera_se/
    // purchase_ledger_purchase_payment_bacs_20260401_144136.json`.
    // Every column name and literal default comes from that snapshot's
    // added_rows[0]; allocation-touched fields (pt_paid, pt_payflag,
    // pt_trbal) take their INSERT-time value from the same snapshot's
    // modified_rows[0].changes.<col>.before. See design doc:
    // docs/superpowers/specs/2026-05-14-faithful-ptran-insert-design.md
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
        ledgerId,        // id
        party.account,   // pt_account
        txn.date,        // pt_trdate
        reference,       // pt_trref
        paymentMethod,   // pt_supref (legacy: payment method from cbtype)
        ptType,          // pt_trtype ('P' or 'F')
        ptValue,         // pt_trvalue
        ptValue,         // pt_trbal (= pt_trvalue at INSERT — full unallocated balance)
        txn.date,        // pt_crdate
        cbtype,          // pt_cbtype
        entryNumber,     // pt_entry
        sharedUnique,    // pt_unique
        txn.date,        // pt_nlpdate
        now.iso,         // datecreated
        now.iso,         // datemodified
      ],
    );
    await trx.raw(
      `UPDATE pname WITH (ROWLOCK)
       SET pn_currbal = ISNULL(pn_currbal, 0) + ?,
           pn_nextpay = ISNULL(pn_nextpay, 0) + 1,
           datemodified = GETDATE()
       WHERE RTRIM(pn_account) = ?`,
      [ptValue, party.account],
    );
  }

  // 4. nbank balance update — signed pounds (in for receipts, out for payments)
  const bankDeltaPounds = dir.direction === 'in' ? absAmount : -absAmount;
  await updateNbankBalance(trx, bankCode, bankDeltaPounds);

  // 5. ntran debit/credit pair + nacnt updates + njmemo — GATED on
  // decision.postToNominal. When RTU is OFF (or the decision builder
  // chose batch-transfer for any other reason), skip ntran/nacnt and
  // anoml will carry ax_done=' ' so the nightly NL-transfer job picks
  // the entry up later. Matches legacy opera_sql_import.py:2334.
  const bankNtranValue = bankDeltaPounds;
  const controlValue = -bankNtranValue;
  if (decision.postToNominal) {
    const bankType =
      (await getNacntType(trx, bankCode)) ??
      ({ na_type: 'B ', na_subt: 'BC' } as NacntType);
    const controlType =
      (await getNacntType(trx, party.controlAccount)) ??
      ({ na_type: 'B ', na_subt: 'BB' } as NacntType);

    const ntranIdStart = await getNextId(trx, 'ntran', 2);
    // nt_pstid: distinct unique ID per ntran leg. Legacy generates
    // multiple unique IDs from OperaUniqueIdGenerator (opera_sql_import.py:
    // 2253).
    const ntranPstidBank = generateOperaUniqueId();
    const ntranPstidControl = generateOperaUniqueId();
    const ntranComment = ((txn.memo || reference) || '').padEnd(50).slice(0, 50);
    // nt_trnref: party-name + payment-method + (RT) marker. Legacy:
    //   f"{party_name[:30]:<30}{payment_method:<10}(RT)     "
    const ntranTrnref = (
      party.name.slice(0, 30).padEnd(30) +
      cbtypeDesc.slice(0, 10).padEnd(10) +
      '(RT)     '
    ).slice(0, 50);

    // Bank leg (debit when receipt, credit when payment)
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
        '        ', '${ntPosttyp}', 0, ?, 0,
        0, 0, 0, 0, 0,
        0, ?, ?, 1
      )`,
      [
        ntranIdStart,
        bankCode,
        bankType.na_type,
        bankType.na_subt,
        journal,
        ntranComment,
        ntranTrnref,
        txn.date,
        bankNtranValue,
        year,
        period,
        ntranPstidBank,
        now.iso,
        now.iso,
      ],
    );
    await updateNacntBalance(trx, bankCode, bankNtranValue, { period, year });

    // Control leg (opposite sign)
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
        '        ', '${ntPosttyp}', 0, ?, 0,
        0, 0, 0, 0, 0,
        0, ?, ?, 1
      )`,
      [
        ntranIdStart + 1,
        party.controlAccount,
        controlType.na_type,
        controlType.na_subt,
        journal,
        ntranComment,
        ntranTrnref,
        txn.date,
        controlValue,
        year,
        period,
        ntranPstidControl,
        now.iso,
        now.iso,
      ],
    );
    await updateNacntBalance(trx, party.controlAccount, controlValue, {
      period,
      year,
    });
    await insertNjmemo(trx, journal, 'Cashbook Ledger Transfer (RT)');
  }

  // 6. anoml debit/credit pair (transfer file)
  const anomlIdStart = await getNextId(trx, 'anoml', 2);
  // ax_comment: party-name + payment-method suffix. Legacy:
  //   f"{customer_name[:30]:<30}{payment_method}"
  // Snapshot e.g. 'Adams Light Engineering Ltd   BACS'. Pre-port TS
  // hardcoded 'BankImport' suffix.
  const anomlComment = (
    party.name.slice(0, 30).padEnd(30) + paymentMethod
  ).slice(0, 40);
  // ax_done: 'Y' if posted to NL (decision.postToNominal=true) else
  // ' ' (pending nightly NL transfer). Faithful port of legacy
  // done_flag = posting_decision.transfer_file_done_flag.
  const doneFlag = decision.transferFileDoneFlag;
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
      anomlIdStart,
      bankCode,
      txn.date,
      bankNtranValue,
      reference,
      anomlComment,
      doneFlag,
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
      ?, ?, '    ', '${axSource}', ?, ?, ?,
      ?, ?, '   ', 0, 0, 0, 0,
      'I', ?, '        ', '        ', ?, ?,
      ?, ?, 1
    )`,
    [
      anomlIdStart + 1,
      party.controlAccount,
      txn.date,
      controlValue,
      reference,
      anomlComment,
      doneFlag,
      sharedUnique,
      journal,
      txn.date,
      now.iso,
      now.iso,
    ],
  );

  // --- Phase A verification (in-trx, NOLOCK reads of our own writes) ---
  // Throws PostingVerificationError on mismatch → trx rolls back.
  await assertAentryAtran(trx, {
    entryNumber,
    bankAccount: bankCode,
    expectedSignedPence: signedPence,
    expectedAtType: at_type,
    expectedDate: txn.date,
    expectedReferPrefix: reference.slice(0, 20),
  });
  await assertLedgerRow(trx, {
    ledger: dir.ledger,
    entryNumber,
    cbtype,
    account: party.account,
    expectedValuePounds:
      dir.ledger === 'sales'
        ? // stran: receipts negative, refunds positive (reduces / increases customer balance)
          dir.direction === 'in' ? -absAmount : absAmount
        : // ptran: payments negative, refunds positive (reduces / increases supplier balance)
          dir.direction === 'out' ? -absAmount : absAmount,
  });
  // Only verify ntran pair if we actually wrote one. When postToNominal
  // is false (RTU=OFF), the entry lives in anoml only awaiting nightly
  // NL transfer — there's nothing to balance-check on ntran.
  if (decision.postToNominal) {
    await assertBalancedPair(trx, {
      table: 'ntran',
      journal,
      expectedCount: 2,
      entryNumber,
    });
  }
  await assertBalancedPair(trx, {
    table: 'anoml',
    journal,
    expectedCount: 2,
    entryNumber,
  });

  return { entry_number: entryNumber, fingerprint };
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
  const { trx, bankCode, txn, decision } = args;
  if (!txn.matchedAccount) {
    throw new Error('Missing nominal account for nominal entry');
  }
  const isReceipt = txn.action === 'nominal_receipt';
  const { code: cbtype, desc: cbtypeDesc } = await resolveCbtype(
    trx,
    txn.cbtype,
    isReceipt ? 'R' : 'P',
  );
  const paymentMethod = cbtypeDesc.slice(0, 20);
  const at_type = AT_TYPE_FOR_ACTION[txn.action]!;
  const now = nowParts();
  const { period, year } = await getPeriodForDate(trx, txn.date);

  const absAmount = Math.abs(Number(txn.amount));
  const signedPence = isReceipt ? pence(absAmount) : -pence(absAmount);

  // --- VAT lookup (legacy opera_sql_import.py:3741-3758) ---
  // Payments use input/purchase VAT codes ('P'); receipts use output/
  // sales ('S'). Failure (lookup error or unknown code) is non-fatal:
  // hasVat stays false and we post the legacy 1-atran / 2-anoml flow.
  const vatType: 'P' | 'S' = isReceipt ? 'S' : 'P';
  const vatLookup = txn.vatCode
    ? await getVatRateForCode(trx, txn.vatCode, vatType, txn.date)
    : null;
  const hasVat = !!(
    vatLookup &&
    vatLookup.rate > 0 &&
    vatLookup.nominal &&
    txn.vatCode
  );
  // gross/net/vat in POUNDS (atran/anoml signed-pence done at INSERT
  // time). Formula matches legacy line 3756:
  //   vat = round(gross * rate / (100 + rate), 2)
  //   net = gross - vat
  const vatPounds = hasVat
    ? Math.round(((absAmount * vatLookup!.rate) / (100 + vatLookup!.rate)) * 100) /
      100
    : 0;
  const netPounds = hasVat ? Math.round((absAmount - vatPounds) * 100) / 100 : absAmount;
  const vatNominalAccount = hasVat ? vatLookup!.nominal : '';

  const entryNumber = await incrementAtypeEntry(trx, cbtype);
  const aentryId = await getNextId(trx, 'aentry');
  const journal = await getNextJournal(trx, 1);
  // atran allocation: 2 IDs when VAT-split, else 1. Matches legacy
  // multi-ID allocation pattern (opera_sql_import.py:3826).
  const atranIdStart = await getNextId(trx, 'atran', hasVat ? 2 : 1);
  const atranIdNet = atranIdStart;
  const atranIdVat = hasVat ? atranIdStart + 1 : null;
  const sharedUnique = generateOperaUniqueId();
  // When VAT splits the atran, each leg gets its own ax_unique to match
  // its corresponding anoml row (legacy:3848,3877 + 4050,4067,4085).
  const sharedUniqueVat = hasVat ? generateOperaUniqueId() : null;
  const fingerprint = generateImportFingerprint(
    txn.name || txn.memo || txn.matchedAccount,
    txn.amount,
    txn.date,
  );

  const reference = (txn.reference ?? '').slice(0, 20) || (txn.name ?? '').slice(0, 20);

  // For atran at_name and anoml ax_comment, legacy reads the nominal
  // account description from nacnt (opera_sql_import.py:3656). Only
  // looked up on the VAT branch — non-VAT flow preserves existing
  // behaviour (uses txn.name).
  const nominalName = hasVat ? await loadNominalName(trx, txn.matchedAccount) : '';

  // 1. aentry
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
      aentryId,
      bankCode,
      cbtype,
      entryNumber,
      txn.date,
      reference,
      signedPence,
      now.date,
      now.time.slice(0, 8),
      txn.memo.slice(0, 40),
      now.iso,
      now.iso,
    ],
  );

  // 2. atran — single row (no VAT) OR two rows (NET + VAT split).
  if (!hasVat) {
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
        atranIdNet,
        bankCode,
        cbtype,
        entryNumber,
        at_type,
        txn.date,
        txn.date,
        signedPence,
        txn.matchedAccount,
        (txn.name || '').slice(0, 35),
        txn.memo.slice(0, 35),
        sharedUnique,
        reference.slice(0, 20),
        txn.memo.slice(0, 200),
        now.iso,
        now.iso,
      ],
    );
  } else {
    // VAT-split atran. Legacy opera_sql_import.py:3818-3883.
    // Line 1 = NET amount to nominal_account (at_cntr='    ').
    // Line 2 = VAT amount to vat_nominal_account (at_cntr='   1',
    //          marking the second analysis line — matches Opera
    //          snapshot row id=17744 in cashbook_nominal_payment
    //          _20260401_135214.json).
    const netSignedPence = isReceipt ? pence(netPounds) : -pence(netPounds);
    const vatSignedPence = isReceipt ? pence(vatPounds) : -pence(vatPounds);

    // atran row 1 — NET to nominal_account. Legacy:3829-3854.
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
        atranIdNet,
        bankCode,
        cbtype,
        entryNumber,
        at_type,
        txn.date,
        txn.date,
        netSignedPence,
        txn.matchedAccount,
        nominalName.slice(0, 35),
        txn.memo.slice(0, 35),
        sharedUnique,
        reference.slice(0, 20),
        txn.memo.slice(0, 200),
        now.iso,
        now.iso,
      ],
    );

    // atran row 2 — VAT to vat_nominal_account (at_cntr='   1').
    // Legacy:3858-3883.
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
        ?, ?, '   1', ?, ?, 'BANK_IMP',
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
        atranIdVat!,
        bankCode,
        cbtype,
        entryNumber,
        at_type,
        txn.date,
        txn.date,
        vatSignedPence,
        vatNominalAccount,
        `${nominalName.slice(0, 31)} VAT`.slice(0, 35),
        txn.memo.slice(0, 35),
        sharedUniqueVat!,
        reference.slice(0, 20),
        txn.memo.slice(0, 200),
        now.iso,
        now.iso,
      ],
    );
  }

  // 3. nbank balance update
  const bankDeltaPounds = isReceipt ? absAmount : -absAmount;
  await updateNbankBalance(trx, bankCode, bankDeltaPounds);

  // 4. ntran debit/credit pair (bank vs nominal) — GATED on
  // decision.postToNominal. RTU=OFF → skip. With VAT, this is 3 legs:
  // bank (GROSS), nominal (NET), vat_nominal (VAT). Legacy
  // opera_sql_import.py:3936-4021.
  // Direction:
  //   payment → bank=-gross (credit), nominal=+net (debit),
  //             vat=+vat (debit/input-tax)
  //   receipt → bank=+gross (debit),  nominal=-net (credit),
  //             vat=-vat (credit/output-tax)
  const nominalNtranValue = isReceipt ? -netPounds : netPounds;
  const vatNtranValue = isReceipt ? -vatPounds : vatPounds;
  if (decision.postToNominal) {
    const bankType = (await getNacntType(trx, bankCode)) ?? ({ na_type: 'B ', na_subt: 'BC' } as NacntType);
    const nominalType = (await getNacntType(trx, txn.matchedAccount)) ?? ({ na_type: 'P ', na_subt: 'PA' } as NacntType);
    const ntranCount = hasVat ? 3 : 2;
    const ntranIdStart = await getNextId(trx, 'ntran', ntranCount);
    // Distinct nt_pstid per leg, matching legacy multi-ID allocation.
    const ntranPstidBank = generateOperaUniqueId();
    const ntranPstidNominal = generateOperaUniqueId();
    const ntranPstidVat = hasVat ? generateOperaUniqueId() : null;
    const ntranComment = ((txn.memo || reference) || '').padEnd(50).slice(0, 50);
    const ntranTrnref = (
      (txn.name || '').slice(0, 30).padEnd(30) +
      cbtypeDesc.slice(0, 10).padEnd(10) +
      '(RT)     '
    ).slice(0, 50);

    // Bank leg (GROSS — same regardless of VAT split). Legacy:3947-3968.
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
        '        ', 'S', 0, ?, 0,
        0, 0, 0, 0, 0,
        0, ?, ?, 1
      )`,
      [
        ntranIdStart,
        bankCode,
        bankType.na_type,
        bankType.na_subt,
        journal,
        ntranComment,
        ntranTrnref,
        txn.date,
        bankDeltaPounds,
        year,
        period,
        ntranPstidBank,
        now.iso,
        now.iso,
      ],
    );
    await updateNacntBalance(trx, bankCode, bankDeltaPounds, { period, year });

    // Nominal leg (NET when VAT, GROSS otherwise — value is the
    // opposite sign of the bank leg). Legacy:3972-3993.
    const nominalLegValue = hasVat ? nominalNtranValue : -bankDeltaPounds;
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
        '        ', 'S', 0, ?, 0,
        0, 0, 0, 0, 0,
        0, ?, ?, 1
      )`,
      [
        ntranIdStart + 1,
        txn.matchedAccount,
        nominalType.na_type,
        nominalType.na_subt,
        journal,
        ntranComment,
        ntranTrnref,
        txn.date,
        nominalLegValue,
        year,
        period,
        ntranPstidNominal,
        now.iso,
        now.iso,
      ],
    );
    await updateNacntBalance(trx, txn.matchedAccount, nominalLegValue, {
      period,
      year,
    });

    // VAT-nominal leg (only when VAT applies). Legacy:3999-4021.
    if (hasVat) {
      const vatAcctType =
        (await getNacntType(trx, vatNominalAccount)) ?? ({ na_type: 'B ', na_subt: 'BB' } as NacntType);
      const ntranVatComment = `${ntranComment.trim()} VAT`.slice(0, 50).padEnd(50);
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
          '        ', 'S', 0, ?, 0,
          0, 0, 0, 0, 0,
          0, ?, ?, 1
        )`,
        [
          ntranIdStart + 2,
          vatNominalAccount,
          vatAcctType.na_type,
          vatAcctType.na_subt,
          journal,
          ntranVatComment,
          ntranTrnref,
          txn.date,
          vatNtranValue,
          year,
          period,
          ntranPstidVat!,
          now.iso,
          now.iso,
        ],
      );
      await updateNacntBalance(trx, vatNominalAccount, vatNtranValue, {
        period,
        year,
      });
    }
    await insertNjmemo(trx, journal, isReceipt ? 'Nominal Receipt' : 'Nominal Payment');
  }

  // 5. anoml debit/credit pair (or triplet with VAT). Legacy
  // opera_sql_import.py:4030-4089. ax_fcrate=1.0 and ax_fcdec=2.0 per
  // import_nominal_entry anoml; audit 2026-05-14 found TS was writing
  // 0,0. With VAT, 3 rows: bank (GROSS), nominal (NET), vat (VAT).
  const anomlCount = hasVat ? 3 : 2;
  const anomlIdStart = await getNextId(trx, 'anoml', anomlCount);
  // ax_comment: party-name + payment-method (no 'BankImport' suffix).
  const anomlComment = (
    (txn.name || '').slice(0, 30).padEnd(30) + paymentMethod
  ).slice(0, 40);
  const doneFlag = decision.transferFileDoneFlag;
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
      anomlIdStart,
      bankCode,
      txn.date,
      bankDeltaPounds,
      reference,
      anomlComment,
      doneFlag,
      sharedUnique,
      journal,
      txn.date,
      now.iso,
      now.iso,
    ],
  );
  // Nominal-leg anoml: NET when VAT, GROSS-opposite otherwise.
  const anomlNominalValue = hasVat ? nominalNtranValue : -bankDeltaPounds;
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
      anomlIdStart + 1,
      txn.matchedAccount,
      txn.date,
      anomlNominalValue,
      reference,
      anomlComment,
      doneFlag,
      sharedUnique,
      journal,
      txn.date,
      now.iso,
      now.iso,
    ],
  );
  // VAT-leg anoml — only when VAT applies. Faithful port of legacy
  // opera_sql_import.py:4073-4089. Column order + literal defaults
  // copied from Opera snapshot
  // cashbook_nominal_payment_20260401_135214.json (anoml row id=26119,
  // the VAT-nominal row): ax_ncntr='    ', ax_source='A', ax_fcurr='   ',
  // ax_fvalue=pence, ax_fcrate=1.0, ax_fcmult=0, ax_fcdec=2.0,
  // ax_srcco='I', ax_project='        ', ax_job='        '. ax_unique
  // matches the corresponding VAT atran row.
  if (hasVat) {
    const anomlVatFvalue = Math.round(vatNtranValue * 100);
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
        anomlIdStart + 2,
        vatNominalAccount,
        txn.date,
        vatNtranValue,
        reference,
        `${anomlComment.trim().slice(0, 36)} VAT`.slice(0, 40),
        doneFlag,
        anomlVatFvalue,
        sharedUniqueVat!,
        journal,
        txn.date,
        now.iso,
        now.iso,
      ],
    );
  }

  // 6. nvat — VAT-return tracking record. Faithful port of legacy
  // opera_sql_import.py:4129-4144. Always written when VAT applies,
  // independent of decision.postToNominal (legacy doesn't gate it).
  if (hasVat) {
    const nvVattype = isReceipt ? 'S' : 'P';
    const nvatRowId = await getNextId(trx, 'nvat');
    const nvatComment = `${txn.memo.slice(0, 36)} VAT`.slice(0, 40);
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
        txn.date,
        txn.date,
        txn.date,
        reference,
        nvVattype,
        netPounds,
        vatPounds,
        nvVattype,
        (txn.vatCode ?? '').trim(),
        vatLookup!.rate,
        nvatComment,
        now.iso,
        now.iso,
      ],
    );
  }

  // --- Phase A verification (in-trx) ---
  // assertAentryAtran joins aentry+atran on (ae_entry, ae_acnt) and
  // expects exactly one row. With VAT we have 2 atran rows both keyed
  // to the same bank account, so the JOIN returns 2 — that's not a
  // duplicate, it's the split. Skip the helper for has_vat and rely
  // on the balanced-pair counts below to catch any miswrites.
  // (Verifier signature constraint forbids extending it.)
  if (!hasVat) {
    await assertAentryAtran(trx, {
      entryNumber,
      bankAccount: bankCode,
      expectedSignedPence: signedPence,
      expectedAtType: at_type,
      expectedDate: txn.date,
      expectedReferPrefix: reference.slice(0, 20),
    });
  }
  if (decision.postToNominal) {
    await assertBalancedPair(trx, {
      table: 'ntran',
      journal,
      expectedCount: hasVat ? 3 : 2,
      entryNumber,
    });
  }
  await assertBalancedPair(trx, {
    table: 'anoml',
    journal,
    expectedCount: hasVat ? 3 : 2,
    entryNumber,
  });
  return { entry_number: entryNumber, fingerprint };
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
// This is the new entry posting primitive. It will eventually do the
// full aentry + per-line atran / stran-ptran / ntran / anoml / VAT
// inserts and run entry-level verification — that's task 4. In this
// transitional commit it does only the simple cases:
//   - lines.length === 1 → translate back to PreparedTransaction and
//     delegate to the existing postOneTransaction / postNominalEntry,
//     proving the new entry shape can express what those need.
//   - lines.length > 1 → throw a clear "not yet implemented" error so
//     no caller silently ships through this code path before task 4.
//
// postOneTransaction and postNominalEntry remain the source of truth
// for the SQL inserts until tasks 5-6 invert the dependency direction.
// ---------------------------------------------------------------------

export async function postOperaCashbookEntry(
  args: PostEntryArgs,
): Promise<PostEntryResult> {
  const { trx, bankCode, header, lines, defaults, decision } = args;
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error(
      `postOperaCashbookEntry: lines array must have ≥1 entry (got ${lines?.length ?? 0})`,
    );
  }
  for (const ln of lines) {
    if (!ln.atAccount || !ln.atAccount.trim()) {
      throw new Error(
        `postOperaCashbookEntry: every line needs atAccount (line ${lines.indexOf(ln) + 1} has '${ln.atAccount}')`,
      );
    }
  }

  // Transitional: multi-line is the focus of task 4. Throw clearly
  // rather than letting a half-built path corrupt Opera.
  if (lines.length > 1) {
    throw new Error(
      'postOperaCashbookEntry: multi-line support not yet implemented — pending task 4',
    );
  }

  // Single-line path: translate the unified shape back to
  // PreparedTransaction and delegate to the existing post* functions.
  // Tasks 5-6 will invert this direction.
  const ln = lines[0]!;
  const absAmount = ln.absPence / 100;
  const isReceipt =
    header.action === 'sales_receipt' ||
    header.action === 'purchase_refund' ||
    header.action === 'nominal_receipt';
  const signedAmount = isReceipt ? absAmount : -absAmount;
  const prepared: PreparedTransaction = {
    index: 1,
    date: header.date,
    amount: signedAmount,
    name: header.name,
    memo: header.memo || ln.comment || header.comment,
    action: header.action,
    matchedAccount: ln.atAccount,
    cbtype: header.cbtype,
    reference: ln.reference || header.reference,
    vatCode: ln.vatCode,
    netAmount: ln.netOverride,
  };

  if (header.action === 'nominal_payment' || header.action === 'nominal_receipt') {
    return postNominalEntry({ trx, bankCode, txn: prepared, defaults, decision });
  }
  return postOneTransaction({ trx, bankCode, txn: prepared, defaults, decision });
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

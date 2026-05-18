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
import { type CheckTransactionInput } from './duplicate-detection.js';
import type { ImportPostingExecutor, PdfExtractionResult } from './import-from-pdf.js';
import { type PeriodPostingDecision } from './period-posting-decision.js';
export type TxnAction = 'sales_receipt' | 'purchase_payment' | 'sales_refund' | 'purchase_refund' | 'nominal_payment' | 'nominal_receipt' | 'bank_transfer' | 'skip' | 'defer' | string;
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
    defaults: {
        sl_control: string;
        pl_control: string;
    };
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
declare function nowParts(): {
    date: string;
    time: string;
    iso: string;
};
declare function pence(amountPounds: number): number;
declare function dateAsYmd(input: string | Date | null | undefined): string;
interface CbtypeInfo {
    code: string;
    desc: string;
}
declare function resolveCbtype(trx: Knex, preferred: string | null, ayType: 'R' | 'P' | 'T'): Promise<CbtypeInfo>;
interface BankInfo {
    code: string;
    description: string;
    sortCode: string;
    accountNumber: string;
}
declare function loadBankInfo(trx: Knex, bankCode: string): Promise<BankInfo>;
interface PostOneArgs {
    trx: Knex;
    bankCode: string;
    txn: PreparedTransaction;
    defaults: {
        sl_control: string;
        pl_control: string;
    };
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
declare function postOneTransaction(args: PostOneArgs): Promise<{
    entry_number: string;
    fingerprint: string;
}>;
declare function postNominalEntry(args: PostOneArgs): Promise<{
    entry_number: string;
    fingerprint: string;
}>;
export declare function postOperaCashbookEntry(args: PostEntryArgs): Promise<PostEntryResult>;
export declare const bankImportPostingExecutor: ImportPostingExecutor;
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
export { postOneTransaction as _postOneTransaction_internal, postNominalEntry as _postNominalEntry_internal, pence as _pence_internal, nowParts as _nowParts_internal, dateAsYmd as _dateAsYmd_internal, resolveCbtype as _resolveCbtype_internal, loadBankInfo as _loadBankInfo_internal, };
export type { PreparedTransaction as _PreparedTransaction_internal };
//# sourceMappingURL=import-posting-executor.d.ts.map
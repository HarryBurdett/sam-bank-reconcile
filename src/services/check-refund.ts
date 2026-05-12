/**
 * Refund detection — check for an unallocated credit note / overpayment
 * that explains a bank transaction.
 *
 * Faithful ports of:
 *   - `_check_customer_refund` (sql_rag/bank_import.py:1136-1165)
 *   - `_check_purchase_refund` (sql_rag/bank_import.py:1167-1196)
 *
 * Why this matters: the legacy matcher uses these helpers to decide
 * whether a payment that matched a customer is actually a refund
 * (because the customer has an unallocated credit note in stran), and
 * whether a receipt that matched a supplier is actually a refund
 * (unallocated credit in ptran). Without this, the matcher would
 * classify the Systems Cloud payment we saw earlier as `sales_refund`
 * with no underlying credit note — which is wrong.
 *
 * Sign convention (Opera SE & Opera 3 both):
 *   - Sales Ledger (stran): credit notes have st_trtype IN ('C','R')
 *     and st_trbal < 0 (negative balance = available credit)
 *   - Purchase Ledger (ptran): credit notes have pt_trtype IN ('C','P')
 *     and pt_trbal > 0 (positive balance = available credit)
 *
 * Implementation note: query uses Knex builder + parameterised `ABS(?)`
 * sort so it works across MSSQL (Opera SE) and FoxPro (Opera 3) drivers
 * — neither needs `WITH (NOLOCK)` for correctness; legacy uses it as a
 * read-perf optimisation that the SAM port can recreate per-driver if
 * needed.
 */
import type { Knex } from 'knex';

export interface RefundCandidate {
  ref: string;
  type: string;
  value: number;
  balance: number;
  date: string | null;
}

export interface RefundCheckResult {
  is_refund: boolean;
  /** The credit note / overpayment ref found. */
  credit_note_ref: string;
  /** Absolute pounds the credit note has available. */
  credit_note_amount: number;
  /** All candidates considered, best-match first. */
  candidates: RefundCandidate[];
}

const EMPTY_RESULT: RefundCheckResult = {
  is_refund: false,
  credit_note_ref: '',
  credit_note_amount: 0,
  candidates: [],
};

function normaliseDate(d: unknown): string | null {
  if (!d) return null;
  if (d instanceof Date) {
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
  return String(d).slice(0, 10);
}

/**
 * Customer refund: payment OUT matched a customer — look for an
 * unallocated credit note / overpayment in stran that explains it.
 *
 * @param amountPounds positive absolute amount of the payment.
 */
export async function checkCustomerRefund(
  operaDb: Knex,
  customerCode: string,
  amountPounds: number,
): Promise<RefundCheckResult> {
  const code = (customerCode ?? '').trim();
  const amt = Math.abs(Number(amountPounds));
  if (!code || !Number.isFinite(amt) || amt <= 0) return EMPTY_RESULT;

  try {
    const rows = (await operaDb('stran')
      .select(
        'st_unique',
        'st_trtype',
        'st_trvalue',
        'st_trbal',
        'st_trdate',
        'st_trref',
      )
      .whereRaw('RTRIM(st_account) = ?', [code])
      .whereIn('st_trtype', ['C', 'R'])
      .andWhere('st_trbal', '<', 0)
      .orderByRaw('ABS(ABS(st_trbal) - ?) ASC', [amt])
      .limit(5)) as unknown as Array<{
      st_unique: string | null;
      st_trtype: string;
      st_trvalue: number;
      st_trbal: number;
      st_trdate: string | Date | null;
      st_trref: string | null;
    }>;

    if (!rows.length) return EMPTY_RESULT;

    const candidates: RefundCandidate[] = rows.map((r) => ({
      ref: (r.st_trref ?? '').trim(),
      type: (r.st_trtype ?? '').trim(),
      value: Number(r.st_trvalue ?? 0),
      balance: Number(r.st_trbal ?? 0),
      date: normaliseDate(r.st_trdate),
    }));
    const best = candidates[0]!;
    return {
      is_refund: true,
      credit_note_ref: best.ref,
      credit_note_amount: Math.abs(best.balance),
      candidates,
    };
  } catch {
    return EMPTY_RESULT;
  }
}

/**
 * Supplier refund: receipt IN matched a supplier — look for an
 * unallocated credit note / overpayment in ptran that explains it.
 *
 * @param amountPounds positive absolute amount of the receipt.
 */
export async function checkPurchaseRefund(
  operaDb: Knex,
  supplierCode: string,
  amountPounds: number,
): Promise<RefundCheckResult> {
  const code = (supplierCode ?? '').trim();
  const amt = Math.abs(Number(amountPounds));
  if (!code || !Number.isFinite(amt) || amt <= 0) return EMPTY_RESULT;

  try {
    const rows = (await operaDb('ptran')
      .select(
        'pt_unique',
        'pt_trtype',
        'pt_trvalue',
        'pt_trbal',
        'pt_trdate',
        'pt_trref',
      )
      .whereRaw('RTRIM(pt_account) = ?', [code])
      .whereIn('pt_trtype', ['C', 'P'])
      .andWhere('pt_trbal', '>', 0)
      .orderByRaw('ABS(pt_trbal - ?) ASC', [amt])
      .limit(5)) as unknown as Array<{
      pt_unique: string | null;
      pt_trtype: string;
      pt_trvalue: number;
      pt_trbal: number;
      pt_trdate: string | Date | null;
      pt_trref: string | null;
    }>;

    if (!rows.length) return EMPTY_RESULT;

    const candidates: RefundCandidate[] = rows.map((r) => ({
      ref: (r.pt_trref ?? '').trim(),
      type: (r.pt_trtype ?? '').trim(),
      value: Number(r.pt_trvalue ?? 0),
      balance: Number(r.pt_trbal ?? 0),
      date: normaliseDate(r.pt_trdate),
    }));
    const best = candidates[0]!;
    return {
      is_refund: true,
      credit_note_ref: best.ref,
      credit_note_amount: Math.abs(best.balance),
      candidates,
    };
  } catch {
    return EMPTY_RESULT;
  }
}

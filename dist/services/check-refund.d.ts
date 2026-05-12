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
/**
 * Customer refund: payment OUT matched a customer — look for an
 * unallocated credit note / overpayment in stran that explains it.
 *
 * @param amountPounds positive absolute amount of the payment.
 */
export declare function checkCustomerRefund(operaDb: Knex, customerCode: string, amountPounds: number): Promise<RefundCheckResult>;
/**
 * Supplier refund: receipt IN matched a supplier — look for an
 * unallocated credit note / overpayment in ptran that explains it.
 *
 * @param amountPounds positive absolute amount of the receipt.
 */
export declare function checkPurchaseRefund(operaDb: Knex, supplierCode: string, amountPounds: number): Promise<RefundCheckResult>;
//# sourceMappingURL=check-refund.d.ts.map
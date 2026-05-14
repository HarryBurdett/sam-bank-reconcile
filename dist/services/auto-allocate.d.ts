/**
 * Auto-allocate a freshly-posted bank receipt or payment to outstanding
 * customer/supplier invoices.
 *
 * Faithful port of:
 *   - sql_rag/opera_sql_import.py:auto_allocate_receipt
 *   - sql_rag/opera_sql_import.py:auto_allocate_payment
 *
 * Called from the import-posting executor immediately after a
 * sales_receipt / purchase_payment row commits to atran. Walks
 * outstanding invoices on the matched ledger account and writes
 * salloc/palloc rows + flips st_paid/pt_paid on the invoices.
 *
 * Allocation rules — applied in order. The first one that fires wins:
 *
 *   Rule 0 (skipped here): GoCardless payment_request invoice lookup.
 *     This branch is only relevant to the gocardless plugin's
 *     receipts; PDF/email imports never carry a gc_payment_id, so we
 *     don't port it.
 *
 *   Rule 1: Invoice reference(s) in the description (e.g. "INV26241").
 *     If the matched invoice balances total exactly to the receipt
 *     amount, allocate to those invoices.
 *
 *   Rule 2: Receipt clears the whole account.
 *     If the receipt amount equals the total outstanding balance AND
 *     there is at least one invoice, allocate to all outstanding
 *     invoices (single-invoice match counts as a special case).
 *
 *   Otherwise: return success=false with a message — caller leaves the
 *   receipt on-account in stran/ptran for manual allocation later.
 */
import type { Knex } from 'knex';
interface InvoiceAllocation {
    ref: string;
    custref: string;
    amount: number;
    full_allocation: boolean;
    unique: string;
    stran_id: number;
}
export interface AutoAllocateResult {
    success: boolean;
    allocated_amount: number;
    allocations: InvoiceAllocation[];
    message: string;
    receipt_fully_allocated?: boolean;
    allocation_method?: string;
}
/**
 * Pluggable lookup for Rule 0 (GoCardless payment-request invoice
 * refs). When set, the receipt allocator consults this hook with the
 * supplied gc_payment_id and uses the returned invoice references as
 * the primary allocation target. The default standalone wiring leaves
 * this unset; the GoCardless plugin can inject its own implementation.
 */
export interface PaymentRequestInvoiceLookup {
    (gcPaymentId: string): Promise<string[] | null>;
}
/**
 * Allocate a posted receipt against outstanding customer invoices.
 * Faithful port of auto_allocate_receipt (opera_sql_import.py:7017).
 */
export declare function autoAllocateReceipt(args: {
    trx: Knex;
    customerAccount: string;
    receiptRef: string;
    receiptAmount: number;
    allocationDate: string;
    bankAccount: string;
    description?: string | null;
    /** Optional GoCardless payment ID — when provided alongside a
     *  paymentRequestLookup, Rule 0 fires and the invoice_refs from
     *  the payment request become the allocation target. Matches
     *  opera_sql_import.py:7025. */
    gcPaymentId?: string | null;
    /** Lookup hook for Rule 0. When omitted, Rule 0 is skipped and the
     *  allocator falls through to Rule 1 / Rule 2 as the SAM standalone
     *  has always done. */
    paymentRequestLookup?: PaymentRequestInvoiceLookup | null;
}): Promise<AutoAllocateResult>;
/**
 * Allocate a posted supplier payment against outstanding supplier
 * invoices. Faithful port of auto_allocate_payment
 * (opera_sql_import.py:7427). Same shape as autoAllocateReceipt but
 * against ptran/palloc/pname.
 */
export declare function autoAllocatePayment(args: {
    trx: Knex;
    supplierAccount: string;
    paymentRef: string;
    paymentAmount: number;
    allocationDate: string;
    bankAccount: string;
    description?: string | null;
}): Promise<AutoAllocateResult>;
export {};
//# sourceMappingURL=auto-allocate.d.ts.map
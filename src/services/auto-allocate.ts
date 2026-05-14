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
import { getNextId } from '../_shared/index.js';

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

function fmtNow(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Allocate a posted receipt against outstanding customer invoices.
 * Faithful port of auto_allocate_receipt (opera_sql_import.py:7017).
 */
export async function autoAllocateReceipt(args: {
  trx: Knex;
  customerAccount: string;
  receiptRef: string;
  receiptAmount: number;
  allocationDate: string;
  bankAccount: string;
  description?: string | null;
}): Promise<AutoAllocateResult> {
  const {
    trx,
    customerAccount,
    receiptRef,
    receiptAmount,
    allocationDate,
    bankAccount,
    description = '',
  } = args;

  const result: AutoAllocateResult = {
    success: false,
    allocated_amount: 0,
    allocations: [],
    message: '',
  };

  try {
    // Locate the receipt row (st_trtype='R', open balance). Multiple
    // receipts can share a reference within a batch — pick the one
    // whose magnitude is closest to the expected amount (legacy
    // ORDER BY ABS(ABS(st_trbal) - amount) ASC, line 7080).
    const receiptRows = (await trx.raw(
      `SELECT id, st_trref, st_trvalue, st_trbal, st_paid, st_custref, st_unique
       FROM stran WITH (NOLOCK)
       WHERE st_account = ?
         AND RTRIM(st_trref) = ?
         AND st_trtype = 'R'
         AND st_trbal < 0
       ORDER BY ABS(ABS(st_trbal) - ?) ASC`,
      [customerAccount, receiptRef, receiptAmount],
    )) as unknown as Array<{
      id: number;
      st_trref: string;
      st_trvalue: number;
      st_trbal: number;
      st_paid: string | null;
      st_custref: string | null;
      st_unique: string | null;
    }>;

    if (!Array.isArray(receiptRows) || receiptRows.length === 0) {
      result.message = `Receipt ${receiptRef} not found or already allocated`;
      return result;
    }

    const receipt = receiptRows[0]!;
    const receiptBalance = Math.abs(Number(receipt.st_trbal));
    const receiptUnique = (receipt.st_unique ?? '').trim();
    const receiptStranId = Number(receipt.id);

    if (receiptBalance <= 0) {
      result.message = 'Receipt already fully allocated';
      return result;
    }

    // Outstanding invoices on this customer account.
    const invoiceRows = (await trx.raw(
      `SELECT id, st_trref, st_trvalue, st_trbal, st_custref, st_trdate, st_unique
       FROM stran WITH (NOLOCK)
       WHERE st_account = ?
         AND st_trtype = 'I'
         AND st_trbal > 0
       ORDER BY st_trdate ASC, st_trref ASC`,
      [customerAccount],
    )) as unknown as Array<{
      id: number;
      st_trref: string;
      st_trvalue: number;
      st_trbal: number;
      st_custref: string | null;
      st_trdate: string | Date | null;
      st_unique: string | null;
    }>;

    if (!Array.isArray(invoiceRows) || invoiceRows.length === 0) {
      result.message = 'No outstanding invoices found for customer';
      return result;
    }

    const totalOutstanding = round2(
      invoiceRows.reduce((s, r) => s + Number(r.st_trbal), 0),
    );
    const receiptRounded = round2(receiptAmount);

    let invoicesToAllocate: InvoiceAllocation[] = [];
    let allocationMethod: string | null = null;

    // RULE 1: invoice reference in description.
    let invMatches: string[] = [];
    if (description) {
      const m = description.toUpperCase().match(/INV\d+/g);
      if (m) invMatches = m;
    }
    if (invMatches.length > 0) {
      for (const invRef of invMatches) {
        for (const inv of invoiceRows) {
          if ((inv.st_trref ?? '').trim().toUpperCase() === invRef) {
            const invBalance = Number(inv.st_trbal);
            if (invBalance > 0) {
              invoicesToAllocate.push({
                ref: (inv.st_trref ?? '').trim(),
                custref: (inv.st_custref ?? '').trim(),
                amount: invBalance,
                full_allocation: true,
                unique: (inv.st_unique ?? '').trim(),
                stran_id: Number(inv.id),
              });
            }
            break;
          }
        }
      }
      if (invoicesToAllocate.length > 0) {
        const totalInvoiceBalance = round2(
          invoicesToAllocate.reduce((s, a) => s + a.amount, 0),
        );
        if (receiptRounded === totalInvoiceBalance) {
          allocationMethod = 'invoice_reference';
        } else {
          const detail = invoicesToAllocate
            .map((a) => `${a.ref} (£${a.amount.toFixed(2)})`)
            .join(', ');
          result.message =
            `Invoice reference(s) found but amounts do not match: ` +
            `receipt £${receiptRounded.toFixed(
              2,
            )} vs invoice total £${totalInvoiceBalance.toFixed(2)}. Found: ${detail}`;
          return result;
        }
      }
    }

    // RULE 2: receipt clears the whole account.
    if (!allocationMethod) {
      const invoiceCount = invoiceRows.length;
      if (receiptRounded === totalOutstanding && invoiceCount >= 1) {
        invoicesToAllocate = invoiceRows
          .filter((inv) => Number(inv.st_trbal) > 0)
          .map((inv) => ({
            ref: (inv.st_trref ?? '').trim(),
            custref: (inv.st_custref ?? '').trim(),
            amount: Number(inv.st_trbal),
            full_allocation: true,
            unique: (inv.st_unique ?? '').trim(),
            stran_id: Number(inv.id),
          }));
        allocationMethod = invoiceCount >= 2 ? 'clears_account' : 'single_invoice_match';
      } else {
        result.message =
          invMatches.length > 0
            ? `Invoice reference(s) ${invMatches.join(',')} not found in outstanding invoices`
            : `Cannot auto-allocate: no invoice reference in description and receipt £${receiptRounded.toFixed(
                2,
              )} does not clear account total £${totalOutstanding.toFixed(2)}`;
        return result;
      }
    }

    // Execute the allocation. We assume the caller already opened a
    // trx, so we just write inside it (no inner BEGIN/COMMIT).
    const totalToAllocate = receiptAmount;
    const receiptFullyAllocated = true;
    const allocDateStr = allocationDate.slice(0, 10);
    const nowStr = fmtNow();

    const payflagRows = (await trx.raw(
      `SELECT ISNULL(MAX(al_payflag), 0) AS max_pf FROM salloc WITH (UPDLOCK, ROWLOCK)
       WHERE al_account = ?`,
      [customerAccount],
    )) as unknown as Array<{ max_pf?: number }>;
    const nextPayflag =
      (Array.isArray(payflagRows) && payflagRows[0]?.max_pf
        ? Number(payflagRows[0].max_pf)
        : 0) + 1;

    const newReceiptBal = receiptBalance - totalToAllocate;
    const receiptPaidFlag = receiptFullyAllocated ? 'A' : ' ';

    await trx.raw(
      `UPDATE stran WITH (ROWLOCK)
       SET st_trbal = ?,
           st_paid = ?,
           st_payday = ${receiptFullyAllocated ? '?' : 'NULL'},
           st_payflag = ?,
           datemodified = ?
       WHERE st_account = ?
         AND RTRIM(st_trref) = ?
         AND st_trtype = 'R'
         AND RTRIM(st_unique) = ?`,
      receiptFullyAllocated
        ? [
            -newReceiptBal,
            receiptPaidFlag,
            allocDateStr,
            nextPayflag,
            nowStr,
            customerAccount,
            receiptRef,
            receiptUnique,
          ]
        : [
            -newReceiptBal,
            receiptPaidFlag,
            nextPayflag,
            nowStr,
            customerAccount,
            receiptRef,
            receiptUnique,
          ],
    );

    if (receiptFullyAllocated) {
      const sallocId = await getNextId(trx, 'salloc');
      const allocRef2 =
        allocationMethod === 'invoice_reference'
          ? 'AUTO:INV_REF'
          : 'AUTO:CLR_ACCT';
      const receiptTrdate =
        typeof receipt.st_trbal === 'number' ? allocDateStr : allocDateStr;
      await trx.raw(
        `INSERT INTO salloc (
           id, al_account, al_date, al_ref1, al_ref2, al_type, al_val,
           al_payind, al_payflag, al_payday, al_fcurr, al_fval, al_fdec,
           al_advind, al_acnt, al_cntr, al_preprd, al_unique, al_adjsv,
           datecreated, datemodified, state
         ) VALUES (?, ?, ?, ?, ?, 'R', ?, 'A', ?, ?, '   ', 0, 0,
                   0, ?, '    ', 0, ?, 0, ?, ?, 1)`,
        [
          sallocId,
          customerAccount,
          receiptTrdate,
          receiptRef,
          allocRef2,
          -receiptBalance,
          nextPayflag,
          allocDateStr,
          bankAccount,
          receiptStranId,
          nowStr,
          nowStr,
        ],
      );
    }

    for (const alloc of invoicesToAllocate) {
      const invCurrent = (await trx.raw(
        `SELECT st_trbal, st_trdate FROM stran WITH (NOLOCK)
         WHERE st_account = ?
           AND RTRIM(st_trref) = ?
           AND st_trtype = 'I'`,
        [customerAccount, alloc.ref],
      )) as unknown as Array<{ st_trbal: number; st_trdate: string | Date | null }>;
      if (!Array.isArray(invCurrent) || invCurrent.length === 0) continue;
      const row = invCurrent[0]!;
      const newInvBal = Number(row.st_trbal) - alloc.amount;
      const invDate =
        row.st_trdate instanceof Date
          ? row.st_trdate.toISOString().slice(0, 10)
          : typeof row.st_trdate === 'string'
            ? row.st_trdate.slice(0, 10)
            : allocDateStr;
      const invPaid = newInvBal < 0.01 ? 'P' : ' ';
      const setLastrec = newInvBal < 0.01 ? `, st_lastrec = ?` : '';

      const updateBindings: Array<string | number> = [
        newInvBal,
        invPaid,
      ];
      if (newInvBal < 0.01) updateBindings.push(allocDateStr);
      updateBindings.push(nextPayflag, nowStr, customerAccount, alloc.ref);

      // Build UPDATE without st_lastrec when not setting it.
      await trx.raw(
        `UPDATE stran WITH (ROWLOCK)
         SET st_trbal = ?,
             st_paid = ?,
             st_payday = ${newInvBal < 0.01 ? '?' : 'NULL'},
             st_payflag = ?${setLastrec},
             datemodified = ?
         WHERE st_account = ?
           AND RTRIM(st_trref) = ?
           AND st_trtype = 'I'`,
        newInvBal < 0.01
          ? [
              newInvBal,
              invPaid,
              allocDateStr,
              nextPayflag,
              invDate,
              nowStr,
              customerAccount,
              alloc.ref,
            ]
          : [
              newInvBal,
              invPaid,
              nextPayflag,
              nowStr,
              customerAccount,
              alloc.ref,
            ],
      );

      if (newInvBal < 0.01) {
        const sallocInvId = await getNextId(trx, 'salloc');
        await trx.raw(
          `INSERT INTO salloc (
             id, al_account, al_date, al_ref1, al_ref2, al_type, al_val,
             al_payind, al_payflag, al_payday, al_fcurr, al_fval, al_fdec,
             al_advind, al_acnt, al_cntr, al_preprd, al_unique, al_adjsv,
             datecreated, datemodified, state
           ) VALUES (?, ?, ?, ?, ?, 'I', ?, 'A', ?, ?, '   ', 0, 0,
                     0, ?, '    ', 0, ?, 0, ?, ?, 1)`,
          [
            sallocInvId,
            customerAccount,
            invDate,
            alloc.ref,
            alloc.custref.slice(0, 20),
            alloc.amount,
            nextPayflag,
            allocDateStr,
            bankAccount,
            alloc.stran_id,
            nowStr,
            nowStr,
          ],
        );
      }
    }

    await trx.raw(
      `UPDATE sname WITH (ROWLOCK)
       SET sn_lastrec = ?, datemodified = ?
       WHERE RTRIM(sn_account) = ?`,
      [allocDateStr, nowStr, customerAccount],
    );

    result.success = true;
    result.allocated_amount = totalToAllocate;
    result.allocations = invoicesToAllocate;
    result.receipt_fully_allocated = receiptFullyAllocated;
    result.allocation_method = allocationMethod ?? undefined;
    result.message =
      allocationMethod === 'invoice_reference'
        ? `Allocated £${totalToAllocate.toFixed(2)} to ${invoicesToAllocate.length} invoice(s) by reference`
        : `Allocated £${totalToAllocate.toFixed(2)} to ${invoicesToAllocate.length} invoice(s) - clears account`;
    return result;
  } catch (err) {
    result.message = `Allocation failed: ${
      err instanceof Error ? err.message : String(err)
    }`;
    return result;
  }
}

/**
 * Allocate a posted supplier payment against outstanding supplier
 * invoices. Faithful port of auto_allocate_payment
 * (opera_sql_import.py:7427). Same shape as autoAllocateReceipt but
 * against ptran/palloc/pname.
 */
export async function autoAllocatePayment(args: {
  trx: Knex;
  supplierAccount: string;
  paymentRef: string;
  paymentAmount: number;
  allocationDate: string;
  bankAccount: string;
  description?: string | null;
}): Promise<AutoAllocateResult> {
  const {
    trx,
    supplierAccount,
    paymentRef,
    paymentAmount,
    allocationDate,
    bankAccount,
    description = '',
  } = args;

  const result: AutoAllocateResult = {
    success: false,
    allocated_amount: 0,
    allocations: [],
    message: '',
  };

  try {
    const paymentRows = (await trx.raw(
      `SELECT id, pt_trref, pt_trvalue, pt_trbal, pt_paid, pt_supref, pt_unique
       FROM ptran WITH (NOLOCK)
       WHERE pt_account = ?
         AND RTRIM(pt_trref) = ?
         AND pt_trtype = 'P'
         AND pt_trbal < 0`,
      [supplierAccount, paymentRef],
    )) as unknown as Array<{
      id: number;
      pt_trref: string;
      pt_trvalue: number;
      pt_trbal: number;
      pt_paid: string | null;
      pt_supref: string | null;
      pt_unique: string | null;
    }>;

    if (!Array.isArray(paymentRows) || paymentRows.length === 0) {
      result.message = `Payment ${paymentRef} not found or already allocated`;
      return result;
    }
    const payment = paymentRows[0]!;
    const paymentBalance = Math.abs(Number(payment.pt_trbal));
    const paymentUnique = (payment.pt_unique ?? '').trim();
    const paymentPtranId = Number(payment.id);
    if (paymentBalance <= 0) {
      result.message = 'Payment already fully allocated';
      return result;
    }

    const invoiceRows = (await trx.raw(
      `SELECT id, pt_trref, pt_trvalue, pt_trbal, pt_supref, pt_trdate, pt_unique
       FROM ptran WITH (NOLOCK)
       WHERE pt_account = ?
         AND pt_trtype = 'I'
         AND pt_trbal > 0
       ORDER BY pt_trdate ASC, pt_trref ASC`,
      [supplierAccount],
    )) as unknown as Array<{
      id: number;
      pt_trref: string;
      pt_trvalue: number;
      pt_trbal: number;
      pt_supref: string | null;
      pt_trdate: string | Date | null;
      pt_unique: string | null;
    }>;
    if (!Array.isArray(invoiceRows) || invoiceRows.length === 0) {
      result.message = 'No outstanding invoices found for supplier';
      return result;
    }

    const totalOutstanding = round2(
      invoiceRows.reduce((s, r) => s + Number(r.pt_trbal), 0),
    );
    const paymentRounded = round2(paymentAmount);

    let invoicesToAllocate: InvoiceAllocation[] = [];
    let allocationMethod: string | null = null;

    let invMatches: string[] = [];
    if (description) {
      const matches = description
        .toUpperCase()
        .match(/(?:PI|INV|PINV|P\/INV)[\s-]?\d+/g);
      if (matches) invMatches = matches;
      if (invMatches.length === 0) {
        for (const inv of invoiceRows) {
          const sup = (inv.pt_supref ?? '').trim();
          if (sup && description.toUpperCase().includes(sup.toUpperCase())) {
            invMatches.push(sup);
          }
        }
      }
    }
    if (invMatches.length > 0) {
      for (const invRefRaw of invMatches) {
        const cleanWanted = invRefRaw.toUpperCase().replace(/[\s-]/g, '');
        for (const inv of invoiceRows) {
          const trref = (inv.pt_trref ?? '').trim().toUpperCase();
          const supref = (inv.pt_supref ?? '').trim().toUpperCase();
          const trrefClean = trref.replace(/[\s-]/g, '');
          const suprefClean = supref.replace(/[\s-]/g, '');
          if (
            cleanWanted === trrefClean ||
            cleanWanted === suprefClean ||
            invRefRaw.toUpperCase() === supref
          ) {
            const invBalance = Number(inv.pt_trbal);
            if (invBalance > 0) {
              invoicesToAllocate.push({
                ref: (inv.pt_trref ?? '').trim(),
                custref: (inv.pt_supref ?? '').trim(),
                amount: invBalance,
                full_allocation: true,
                unique: (inv.pt_unique ?? '').trim(),
                stran_id: Number(inv.id),
              });
            }
            break;
          }
        }
      }
      if (invoicesToAllocate.length > 0) {
        const totalInvoiceBalance = round2(
          invoicesToAllocate.reduce((s, a) => s + a.amount, 0),
        );
        if (paymentRounded === totalInvoiceBalance) {
          allocationMethod = 'invoice_reference';
        } else {
          result.message =
            `Invoice reference(s) found but amounts do not match: ` +
            `payment £${paymentRounded.toFixed(
              2,
            )} vs invoice total £${totalInvoiceBalance.toFixed(2)}`;
          return result;
        }
      }
    }

    if (!allocationMethod) {
      const invoiceCount = invoiceRows.length;
      if (paymentRounded === totalOutstanding && invoiceCount >= 1) {
        invoicesToAllocate = invoiceRows
          .filter((inv) => Number(inv.pt_trbal) > 0)
          .map((inv) => ({
            ref: (inv.pt_trref ?? '').trim(),
            custref: (inv.pt_supref ?? '').trim(),
            amount: Number(inv.pt_trbal),
            full_allocation: true,
            unique: (inv.pt_unique ?? '').trim(),
            stran_id: Number(inv.id),
          }));
        allocationMethod = invoiceCount >= 2 ? 'clears_account' : 'single_invoice_match';
      } else {
        result.message =
          invMatches.length > 0
            ? `Invoice reference(s) ${invMatches.join(',')} not found in outstanding invoices`
            : `Cannot auto-allocate: no invoice reference in description and payment £${paymentRounded.toFixed(
                2,
              )} does not clear account total £${totalOutstanding.toFixed(2)}`;
        return result;
      }
    }

    const totalToAllocate = paymentAmount;
    const paymentFullyAllocated = true;
    const allocDateStr = allocationDate.slice(0, 10);
    const nowStr = fmtNow();

    const payflagRows = (await trx.raw(
      `SELECT ISNULL(MAX(al_payflag), 0) AS max_pf FROM palloc WITH (UPDLOCK, ROWLOCK)
       WHERE al_account = ?`,
      [supplierAccount],
    )) as unknown as Array<{ max_pf?: number }>;
    const nextPayflag =
      (Array.isArray(payflagRows) && payflagRows[0]?.max_pf
        ? Number(payflagRows[0].max_pf)
        : 0) + 1;

    const newPaymentBal = paymentBalance - totalToAllocate;
    const paymentPaidFlag = paymentFullyAllocated ? 'A' : ' ';

    await trx.raw(
      `UPDATE ptran WITH (ROWLOCK)
       SET pt_trbal = ?,
           pt_paid = ?,
           pt_payday = ${paymentFullyAllocated ? '?' : 'NULL'},
           pt_payflag = ?,
           datemodified = ?
       WHERE pt_account = ?
         AND RTRIM(pt_trref) = ?
         AND pt_trtype = 'P'
         AND RTRIM(pt_unique) = ?`,
      paymentFullyAllocated
        ? [
            -newPaymentBal,
            paymentPaidFlag,
            allocDateStr,
            nextPayflag,
            nowStr,
            supplierAccount,
            paymentRef,
            paymentUnique,
          ]
        : [
            -newPaymentBal,
            paymentPaidFlag,
            nextPayflag,
            nowStr,
            supplierAccount,
            paymentRef,
            paymentUnique,
          ],
    );

    if (paymentFullyAllocated) {
      const pallocId = await getNextId(trx, 'palloc');
      const allocRef2 =
        allocationMethod === 'invoice_reference'
          ? 'AUTO:INV_REF'
          : 'AUTO:CLR_ACCT';
      await trx.raw(
        `INSERT INTO palloc (
           id, al_account, al_date, al_ref1, al_ref2, al_type, al_val,
           al_payind, al_payflag, al_payday, al_fcurr, al_fval, al_fdec,
           al_advind, al_acnt, al_cntr, al_preprd, al_unique, al_adjsv,
           datecreated, datemodified, state
         ) VALUES (?, ?, ?, ?, ?, 'P', ?, 'A', ?, ?, '   ', 0, 0,
                   0, ?, '    ', 0, ?, 0, ?, ?, 1)`,
        [
          pallocId,
          supplierAccount,
          allocDateStr,
          paymentRef,
          allocRef2,
          -paymentBalance,
          nextPayflag,
          allocDateStr,
          bankAccount,
          paymentPtranId,
          nowStr,
          nowStr,
        ],
      );
    }

    for (const alloc of invoicesToAllocate) {
      const invCurrent = (await trx.raw(
        `SELECT pt_trbal, pt_trdate FROM ptran WITH (NOLOCK)
         WHERE pt_account = ?
           AND RTRIM(pt_trref) = ?
           AND pt_trtype = 'I'`,
        [supplierAccount, alloc.ref],
      )) as unknown as Array<{ pt_trbal: number; pt_trdate: string | Date | null }>;
      if (!Array.isArray(invCurrent) || invCurrent.length === 0) continue;
      const row = invCurrent[0]!;
      const newInvBal = Number(row.pt_trbal) - alloc.amount;
      const invDate =
        row.pt_trdate instanceof Date
          ? row.pt_trdate.toISOString().slice(0, 10)
          : typeof row.pt_trdate === 'string'
            ? row.pt_trdate.slice(0, 10)
            : allocDateStr;
      const invPaid = newInvBal < 0.01 ? 'P' : ' ';
      const setLastpay = newInvBal < 0.01 ? `, pt_lastpay = ?` : '';

      await trx.raw(
        `UPDATE ptran WITH (ROWLOCK)
         SET pt_trbal = ?,
             pt_paid = ?,
             pt_payday = ${newInvBal < 0.01 ? '?' : 'NULL'},
             pt_payflag = ?${setLastpay},
             datemodified = ?
         WHERE pt_account = ?
           AND RTRIM(pt_trref) = ?
           AND pt_trtype = 'I'`,
        newInvBal < 0.01
          ? [
              newInvBal,
              invPaid,
              allocDateStr,
              nextPayflag,
              invDate,
              nowStr,
              supplierAccount,
              alloc.ref,
            ]
          : [
              newInvBal,
              invPaid,
              nextPayflag,
              nowStr,
              supplierAccount,
              alloc.ref,
            ],
      );

      if (newInvBal < 0.01) {
        const pallocInvId = await getNextId(trx, 'palloc');
        await trx.raw(
          `INSERT INTO palloc (
             id, al_account, al_date, al_ref1, al_ref2, al_type, al_val,
             al_payind, al_payflag, al_payday, al_fcurr, al_fval, al_fdec,
             al_advind, al_acnt, al_cntr, al_preprd, al_unique, al_adjsv,
             datecreated, datemodified, state
           ) VALUES (?, ?, ?, ?, ?, 'I', ?, 'A', ?, ?, '   ', 0, 0,
                     0, ?, '    ', 0, ?, 0, ?, ?, 1)`,
          [
            pallocInvId,
            supplierAccount,
            invDate,
            alloc.ref,
            alloc.custref.slice(0, 20),
            alloc.amount,
            nextPayflag,
            allocDateStr,
            bankAccount,
            alloc.stran_id,
            nowStr,
            nowStr,
          ],
        );
      }
    }

    await trx.raw(
      `UPDATE pname WITH (ROWLOCK)
       SET pn_lastpay = ?, datemodified = ?
       WHERE RTRIM(pn_account) = ?`,
      [allocDateStr, nowStr, supplierAccount],
    );

    result.success = true;
    result.allocated_amount = totalToAllocate;
    result.allocations = invoicesToAllocate;
    result.receipt_fully_allocated = paymentFullyAllocated;
    result.allocation_method = allocationMethod ?? undefined;
    result.message =
      allocationMethod === 'invoice_reference'
        ? `Allocated £${totalToAllocate.toFixed(2)} to ${invoicesToAllocate.length} invoice(s) by reference`
        : `Allocated £${totalToAllocate.toFixed(2)} to ${invoicesToAllocate.length} invoice(s) - clears account`;
    return result;
  } catch (err) {
    result.message = `Allocation failed: ${
      err instanceof Error ? err.message : String(err)
    }`;
    return result;
  }
}

import { getNextId } from '../_shared/index.js';
function fmtNow() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function round2(n) {
    return Math.round(n * 100) / 100;
}
/**
 * Allocate a posted receipt against outstanding customer invoices.
 * Faithful port of auto_allocate_receipt (opera_sql_import.py:7017).
 */
export async function autoAllocateReceipt(args) {
    const { trx, customerAccount, receiptRef, receiptAmount, allocationDate, bankAccount, description = '', gcPaymentId, paymentRequestLookup, } = args;
    const result = {
        success: false,
        allocated_amount: 0,
        allocations: [],
        message: '',
    };
    // NB: do NOT wrap the body in try/catch. DB-level errors mid-
    // allocation (salloc INSERT failure, deadlock, FK violation,
    // ROWLOCK timeout) MUST propagate to abort the enclosing trx.
    // Soft "no allocation target" answers below return success:false
    // explicitly without throwing — those are the legitimate
    // non-error outcomes. Audit 2026-05-15: pre-port TS wrapped the
    // body in try/catch which converted DB errors into warnings and
    // let the receipt commit without the allocation, decrementing
    // sname.sn_currbal but leaving stran unallocated.
    {
        // Locate the receipt row (st_trtype='R', open balance). Multiple
        // receipts can share a reference within a batch — pick the one
        // whose magnitude is closest to the expected amount (legacy
        // ORDER BY ABS(ABS(st_trbal) - amount) ASC, line 7080).
        const receiptRows = (await trx.raw(`SELECT id, st_trref, st_trvalue, st_trbal, st_paid, st_custref, st_unique
       FROM stran WITH (NOLOCK)
       WHERE st_account = ?
         AND RTRIM(st_trref) = ?
         AND st_trtype = 'R'
         AND st_trbal < 0
       ORDER BY ABS(ABS(st_trbal) - ?) ASC`, [customerAccount, receiptRef, receiptAmount]));
        if (!Array.isArray(receiptRows) || receiptRows.length === 0) {
            result.message = `Receipt ${receiptRef} not found or already allocated`;
            return result;
        }
        const receipt = receiptRows[0];
        const receiptBalance = Math.abs(Number(receipt.st_trbal));
        const receiptUnique = (receipt.st_unique ?? '').trim();
        const receiptStranId = Number(receipt.id);
        if (receiptBalance <= 0) {
            result.message = 'Receipt already fully allocated';
            return result;
        }
        // Outstanding invoices on this customer account.
        const invoiceRows = (await trx.raw(`SELECT id, st_trref, st_trvalue, st_trbal, st_custref, st_trdate, st_unique
       FROM stran WITH (NOLOCK)
       WHERE st_account = ?
         AND st_trtype = 'I'
         AND st_trbal > 0
       ORDER BY st_trdate ASC, st_trref ASC`, [customerAccount]));
        if (!Array.isArray(invoiceRows) || invoiceRows.length === 0) {
            result.message = 'No outstanding invoices found for customer';
            return result;
        }
        const totalOutstanding = round2(invoiceRows.reduce((s, r) => s + Number(r.st_trbal), 0));
        const receiptRounded = round2(receiptAmount);
        let invoicesToAllocate = [];
        let allocationMethod = null;
        let receiptFullyAllocatedRule0 = true;
        // RULE 0: GoCardless payment-request invoice lookup.
        // Faithful port of opera_sql_import.py:7120-7189. When the caller
        // raised a payment request against specific invoices, those refs
        // are the precise allocation target. Each invoice is rechecked
        // against current stran state so anything already paid manually
        // is excluded.
        if (gcPaymentId && paymentRequestLookup) {
            try {
                const prInvoiceRefs = await paymentRequestLookup(gcPaymentId);
                if (Array.isArray(prInvoiceRefs) && prInvoiceRefs.length > 0) {
                    const prInvoicesToAllocate = [];
                    const skippedInvoices = [];
                    for (const wantedRef of prInvoiceRefs) {
                        const wantedUpper = wantedRef.trim().toUpperCase();
                        let found = false;
                        for (const inv of invoiceRows) {
                            if ((inv.st_trref ?? '').trim().toUpperCase() === wantedUpper) {
                                const invBalance = Number(inv.st_trbal);
                                if (invBalance > 0.005) {
                                    prInvoicesToAllocate.push({
                                        ref: (inv.st_trref ?? '').trim(),
                                        custref: (inv.st_custref ?? '').trim(),
                                        amount: invBalance,
                                        full_allocation: true,
                                        unique: (inv.st_unique ?? '').trim(),
                                        stran_id: Number(inv.id),
                                    });
                                }
                                else {
                                    skippedInvoices.push(`${wantedRef} (already paid)`);
                                }
                                found = true;
                                break;
                            }
                        }
                        if (!found)
                            skippedInvoices.push(`${wantedRef} (not found/outstanding)`);
                    }
                    if (prInvoicesToAllocate.length > 0) {
                        const totalPrInvoiceBalance = round2(prInvoicesToAllocate.reduce((s, a) => s + a.amount, 0));
                        if (receiptRounded >= totalPrInvoiceBalance) {
                            // Receipt covers all outstanding invoices from the request;
                            // any excess stays on account (receipt NOT fully allocated
                            // to invoices — opera_sql_import.py:7266-7268).
                            invoicesToAllocate = prInvoicesToAllocate;
                            allocationMethod = 'payment_request';
                            if (receiptRounded > totalPrInvoiceBalance) {
                                receiptFullyAllocatedRule0 = false;
                            }
                        }
                        else {
                            // Receipt is less than outstanding invoices — allocate
                            // oldest first up to the receipt amount (partial path
                            // at opera_sql_import.py:7170-7182).
                            let remaining = receiptRounded;
                            for (const inv of prInvoicesToAllocate) {
                                if (remaining <= 0.005)
                                    break;
                                const allocAmt = Math.min(inv.amount, remaining);
                                inv.amount = allocAmt;
                                inv.full_allocation = Math.abs(allocAmt - inv.amount) < 0.01;
                                remaining -= allocAmt;
                            }
                            invoicesToAllocate = prInvoicesToAllocate.filter((a) => a.amount > 0.005);
                            allocationMethod = 'payment_request';
                        }
                    }
                    // All invoices already paid → fall through to Rule 1/2.
                }
            }
            catch (rule0Err) {
                // eslint-disable-next-line no-console
                console.warn(`[bank-reconcile] auto-allocate Rule 0 lookup failed for ${gcPaymentId}: ${rule0Err instanceof Error ? rule0Err.message : String(rule0Err)}`);
                // Fall through to existing rules.
            }
        }
        // RULE 1: invoice reference in description (skipped if Rule 0 fired).
        let invMatches = [];
        if (description) {
            const m = description.toUpperCase().match(/INV\d+/g);
            if (m)
                invMatches = m;
        }
        if (!allocationMethod && invMatches.length > 0) {
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
                const totalInvoiceBalance = round2(invoicesToAllocate.reduce((s, a) => s + a.amount, 0));
                if (receiptRounded === totalInvoiceBalance) {
                    allocationMethod = 'invoice_reference';
                }
                else {
                    const detail = invoicesToAllocate
                        .map((a) => `${a.ref} (£${a.amount.toFixed(2)})`)
                        .join(', ');
                    result.message =
                        `Invoice reference(s) found but amounts do not match: ` +
                            `receipt £${receiptRounded.toFixed(2)} vs invoice total £${totalInvoiceBalance.toFixed(2)}. Found: ${detail}`;
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
            }
            else {
                result.message =
                    invMatches.length > 0
                        ? `Invoice reference(s) ${invMatches.join(',')} not found in outstanding invoices`
                        : `Cannot auto-allocate: no invoice reference in description and receipt £${receiptRounded.toFixed(2)} does not clear account total £${totalOutstanding.toFixed(2)}`;
                return result;
            }
        }
        // Execute the allocation. We assume the caller already opened a
        // trx, so we just write inside it (no inner BEGIN/COMMIT).
        //
        // For Rule 0 (payment_request) where the receipt exceeds the
        // total invoice balance, legacy allocates ONLY the invoice total
        // and leaves the remainder on account
        // (opera_sql_import.py:7266-7271).
        const totalInvoiceAmountRule0 = round2(invoicesToAllocate.reduce((s, a) => s + a.amount, 0));
        const totalToAllocate = allocationMethod === 'payment_request' && !receiptFullyAllocatedRule0
            ? totalInvoiceAmountRule0
            : receiptAmount;
        const receiptFullyAllocated = allocationMethod === 'payment_request' ? receiptFullyAllocatedRule0 : true;
        const allocDateStr = allocationDate.slice(0, 10);
        const nowStr = fmtNow();
        const payflagRows = (await trx.raw(`SELECT ISNULL(MAX(al_payflag), 0) AS max_pf FROM salloc WITH (UPDLOCK, ROWLOCK)
       WHERE al_account = ?`, [customerAccount]));
        const nextPayflag = (Array.isArray(payflagRows) && payflagRows[0]?.max_pf
            ? Number(payflagRows[0].max_pf)
            : 0) + 1;
        const newReceiptBal = receiptBalance - totalToAllocate;
        const receiptPaidFlag = receiptFullyAllocated ? 'A' : ' ';
        await trx.raw(`UPDATE stran WITH (ROWLOCK)
       SET st_trbal = ?,
           st_paid = ?,
           st_payday = ${receiptFullyAllocated ? '?' : 'NULL'},
           st_payflag = ?,
           datemodified = ?
       WHERE st_account = ?
         AND RTRIM(st_trref) = ?
         AND st_trtype = 'R'
         AND RTRIM(st_unique) = ?`, receiptFullyAllocated
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
            ]);
        if (receiptFullyAllocated) {
            const sallocId = await getNextId(trx, 'salloc');
            const allocRef2 = allocationMethod === 'payment_request'
                ? 'AUTO:GC_REQ'
                : allocationMethod === 'invoice_reference'
                    ? 'AUTO:INV_REF'
                    : 'AUTO:CLR_ACCT';
            const receiptTrdate = typeof receipt.st_trbal === 'number' ? allocDateStr : allocDateStr;
            await trx.raw(`INSERT INTO salloc (
           id, al_account, al_date, al_ref1, al_ref2, al_type, al_val,
           al_payind, al_payflag, al_payday, al_fcurr, al_fval, al_fdec,
           al_advind, al_acnt, al_cntr, al_preprd, al_unique, al_adjsv,
           datecreated, datemodified, state
         ) VALUES (?, ?, ?, ?, ?, 'R', ?, 'A', ?, ?, '   ', 0, 0,
                   0, ?, '    ', 0, ?, 0, ?, ?, 1)`, [
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
            ]);
        }
        for (const alloc of invoicesToAllocate) {
            const invCurrent = (await trx.raw(`SELECT st_trbal, st_trdate FROM stran WITH (NOLOCK)
         WHERE st_account = ?
           AND RTRIM(st_trref) = ?
           AND st_trtype = 'I'`, [customerAccount, alloc.ref]));
            if (!Array.isArray(invCurrent) || invCurrent.length === 0)
                continue;
            const row = invCurrent[0];
            const newInvBal = Number(row.st_trbal) - alloc.amount;
            const invDate = row.st_trdate instanceof Date
                ? row.st_trdate.toISOString().slice(0, 10)
                : typeof row.st_trdate === 'string'
                    ? row.st_trdate.slice(0, 10)
                    : allocDateStr;
            const invPaid = newInvBal < 0.01 ? 'P' : ' ';
            const setLastrec = newInvBal < 0.01 ? `, st_lastrec = ?` : '';
            const updateBindings = [
                newInvBal,
                invPaid,
            ];
            if (newInvBal < 0.01)
                updateBindings.push(allocDateStr);
            updateBindings.push(nextPayflag, nowStr, customerAccount, alloc.ref);
            // Build UPDATE without st_lastrec when not setting it.
            await trx.raw(`UPDATE stran WITH (ROWLOCK)
         SET st_trbal = ?,
             st_paid = ?,
             st_payday = ${newInvBal < 0.01 ? '?' : 'NULL'},
             st_payflag = ?${setLastrec},
             datemodified = ?
         WHERE st_account = ?
           AND RTRIM(st_trref) = ?
           AND st_trtype = 'I'`, newInvBal < 0.01
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
                ]);
            if (newInvBal < 0.01) {
                const sallocInvId = await getNextId(trx, 'salloc');
                await trx.raw(`INSERT INTO salloc (
             id, al_account, al_date, al_ref1, al_ref2, al_type, al_val,
             al_payind, al_payflag, al_payday, al_fcurr, al_fval, al_fdec,
             al_advind, al_acnt, al_cntr, al_preprd, al_unique, al_adjsv,
             datecreated, datemodified, state
           ) VALUES (?, ?, ?, ?, ?, 'I', ?, 'A', ?, ?, '   ', 0, 0,
                     0, ?, '    ', 0, ?, 0, ?, ?, 1)`, [
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
                ]);
            }
        }
        await trx.raw(`UPDATE sname WITH (ROWLOCK)
       SET sn_lastrec = ?, datemodified = ?
       WHERE RTRIM(sn_account) = ?`, [allocDateStr, nowStr, customerAccount]);
        result.success = true;
        result.allocated_amount = totalToAllocate;
        result.allocations = invoicesToAllocate;
        result.receipt_fully_allocated = receiptFullyAllocated;
        result.allocation_method = allocationMethod ?? undefined;
        result.message =
            allocationMethod === 'payment_request'
                ? `Allocated £${totalToAllocate.toFixed(2)} to ${invoicesToAllocate.length} invoice(s) from payment request`
                : allocationMethod === 'invoice_reference'
                    ? `Allocated £${totalToAllocate.toFixed(2)} to ${invoicesToAllocate.length} invoice(s) by reference`
                    : `Allocated £${totalToAllocate.toFixed(2)} to ${invoicesToAllocate.length} invoice(s) - clears account`;
        return result;
    }
}
/**
 * Allocate a posted supplier payment against outstanding supplier
 * invoices. Faithful port of auto_allocate_payment
 * (opera_sql_import.py:7427). Same shape as autoAllocateReceipt but
 * against ptran/palloc/pname.
 */
export async function autoAllocatePayment(args) {
    const { trx, supplierAccount, paymentRef, paymentAmount, allocationDate, bankAccount, description = '', } = args;
    const result = {
        success: false,
        allocated_amount: 0,
        allocations: [],
        message: '',
    };
    // See autoAllocateReceipt above — same atomicity reasoning. Soft
    // "no allocation target" paths return success:false explicitly;
    // DB-level errors propagate to abort the trx.
    {
        const paymentRows = (await trx.raw(`SELECT id, pt_trref, pt_trvalue, pt_trbal, pt_paid, pt_supref, pt_unique
       FROM ptran WITH (NOLOCK)
       WHERE pt_account = ?
         AND RTRIM(pt_trref) = ?
         AND pt_trtype = 'P'
         AND pt_trbal < 0`, [supplierAccount, paymentRef]));
        if (!Array.isArray(paymentRows) || paymentRows.length === 0) {
            result.message = `Payment ${paymentRef} not found or already allocated`;
            return result;
        }
        const payment = paymentRows[0];
        const paymentBalance = Math.abs(Number(payment.pt_trbal));
        const paymentUnique = (payment.pt_unique ?? '').trim();
        const paymentPtranId = Number(payment.id);
        if (paymentBalance <= 0) {
            result.message = 'Payment already fully allocated';
            return result;
        }
        const invoiceRows = (await trx.raw(`SELECT id, pt_trref, pt_trvalue, pt_trbal, pt_supref, pt_trdate, pt_unique
       FROM ptran WITH (NOLOCK)
       WHERE pt_account = ?
         AND pt_trtype = 'I'
         AND pt_trbal > 0
       ORDER BY pt_trdate ASC, pt_trref ASC`, [supplierAccount]));
        if (!Array.isArray(invoiceRows) || invoiceRows.length === 0) {
            result.message = 'No outstanding invoices found for supplier';
            return result;
        }
        const totalOutstanding = round2(invoiceRows.reduce((s, r) => s + Number(r.pt_trbal), 0));
        const paymentRounded = round2(paymentAmount);
        let invoicesToAllocate = [];
        let allocationMethod = null;
        let invMatches = [];
        if (description) {
            const matches = description
                .toUpperCase()
                .match(/(?:PI|INV|PINV|P\/INV)[\s-]?\d+/g);
            if (matches)
                invMatches = matches;
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
                    if (cleanWanted === trrefClean ||
                        cleanWanted === suprefClean ||
                        invRefRaw.toUpperCase() === supref) {
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
                const totalInvoiceBalance = round2(invoicesToAllocate.reduce((s, a) => s + a.amount, 0));
                if (paymentRounded === totalInvoiceBalance) {
                    allocationMethod = 'invoice_reference';
                }
                else {
                    result.message =
                        `Invoice reference(s) found but amounts do not match: ` +
                            `payment £${paymentRounded.toFixed(2)} vs invoice total £${totalInvoiceBalance.toFixed(2)}`;
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
            }
            else {
                result.message =
                    invMatches.length > 0
                        ? `Invoice reference(s) ${invMatches.join(',')} not found in outstanding invoices`
                        : `Cannot auto-allocate: no invoice reference in description and payment £${paymentRounded.toFixed(2)} does not clear account total £${totalOutstanding.toFixed(2)}`;
                return result;
            }
        }
        const totalToAllocate = paymentAmount;
        const paymentFullyAllocated = true;
        const allocDateStr = allocationDate.slice(0, 10);
        const nowStr = fmtNow();
        const payflagRows = (await trx.raw(`SELECT ISNULL(MAX(al_payflag), 0) AS max_pf FROM palloc WITH (UPDLOCK, ROWLOCK)
       WHERE al_account = ?`, [supplierAccount]));
        const nextPayflag = (Array.isArray(payflagRows) && payflagRows[0]?.max_pf
            ? Number(payflagRows[0].max_pf)
            : 0) + 1;
        const newPaymentBal = paymentBalance - totalToAllocate;
        const paymentPaidFlag = paymentFullyAllocated ? 'A' : ' ';
        await trx.raw(`UPDATE ptran WITH (ROWLOCK)
       SET pt_trbal = ?,
           pt_paid = ?,
           pt_payday = ${paymentFullyAllocated ? '?' : 'NULL'},
           pt_payflag = ?,
           datemodified = ?
       WHERE pt_account = ?
         AND RTRIM(pt_trref) = ?
         AND pt_trtype = 'P'
         AND RTRIM(pt_unique) = ?`, paymentFullyAllocated
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
            ]);
        if (paymentFullyAllocated) {
            const pallocId = await getNextId(trx, 'palloc');
            const allocRef2 = allocationMethod === 'invoice_reference'
                ? 'AUTO:INV_REF'
                : 'AUTO:CLR_ACCT';
            await trx.raw(`INSERT INTO palloc (
           id, al_account, al_date, al_ref1, al_ref2, al_type, al_val,
           al_payind, al_payflag, al_payday, al_fcurr, al_fval, al_fdec,
           al_advind, al_acnt, al_cntr, al_preprd, al_unique, al_adjsv,
           datecreated, datemodified, state
         ) VALUES (?, ?, ?, ?, ?, 'P', ?, 'A', ?, ?, '   ', 0, 0,
                   0, ?, '    ', 0, ?, 0, ?, ?, 1)`, [
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
            ]);
        }
        for (const alloc of invoicesToAllocate) {
            const invCurrent = (await trx.raw(`SELECT pt_trbal, pt_trdate FROM ptran WITH (NOLOCK)
         WHERE pt_account = ?
           AND RTRIM(pt_trref) = ?
           AND pt_trtype = 'I'`, [supplierAccount, alloc.ref]));
            if (!Array.isArray(invCurrent) || invCurrent.length === 0)
                continue;
            const row = invCurrent[0];
            const newInvBal = Number(row.pt_trbal) - alloc.amount;
            const invDate = row.pt_trdate instanceof Date
                ? row.pt_trdate.toISOString().slice(0, 10)
                : typeof row.pt_trdate === 'string'
                    ? row.pt_trdate.slice(0, 10)
                    : allocDateStr;
            const invPaid = newInvBal < 0.01 ? 'P' : ' ';
            // pt_lastpay: legacy sets this UNCONDITIONALLY on every
            // allocation (full or partial). Pre-port TS only set it on full
            // payment, so partially-allocated supplier invoices kept a stale
            // pt_lastpay and Opera's aged-creditor reports lost the latest
            // pay date. Audit 2026-05-14 HIGH.
            // Source: opera_sql_import.py:7694 (`pt_lastpay_clause =
            // f", pt_lastpay = '{inv_date}'"` — no full-paid gate).
            await trx.raw(`UPDATE ptran WITH (ROWLOCK)
         SET pt_trbal = ?,
             pt_paid = ?,
             pt_payday = ${newInvBal < 0.01 ? '?' : 'NULL'},
             pt_payflag = ?,
             pt_lastpay = ?,
             datemodified = ?
         WHERE pt_account = ?
           AND RTRIM(pt_trref) = ?
           AND pt_trtype = 'I'`, newInvBal < 0.01
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
                    invDate,
                    nowStr,
                    supplierAccount,
                    alloc.ref,
                ]);
            if (newInvBal < 0.01) {
                const pallocInvId = await getNextId(trx, 'palloc');
                await trx.raw(`INSERT INTO palloc (
             id, al_account, al_date, al_ref1, al_ref2, al_type, al_val,
             al_payind, al_payflag, al_payday, al_fcurr, al_fval, al_fdec,
             al_advind, al_acnt, al_cntr, al_preprd, al_unique, al_adjsv,
             datecreated, datemodified, state
           ) VALUES (?, ?, ?, ?, ?, 'I', ?, 'A', ?, ?, '   ', 0, 0,
                     0, ?, '    ', 0, ?, 0, ?, ?, 1)`, [
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
                ]);
            }
        }
        await trx.raw(`UPDATE pname WITH (ROWLOCK)
       SET pn_lastpay = ?, datemodified = ?
       WHERE RTRIM(pn_account) = ?`, [allocDateStr, nowStr, supplierAccount]);
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
    }
}
//# sourceMappingURL=auto-allocate.js.map
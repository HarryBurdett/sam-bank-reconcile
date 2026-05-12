const EMPTY_RESULT = {
    is_refund: false,
    credit_note_ref: '',
    credit_note_amount: 0,
    candidates: [],
};
function normaliseDate(d) {
    if (!d)
        return null;
    if (d instanceof Date) {
        if (Number.isNaN(d.getTime()))
            return null;
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
export async function checkCustomerRefund(operaDb, customerCode, amountPounds) {
    const code = (customerCode ?? '').trim();
    const amt = Math.abs(Number(amountPounds));
    if (!code || !Number.isFinite(amt) || amt <= 0)
        return EMPTY_RESULT;
    try {
        const rows = (await operaDb('stran')
            .select('st_unique', 'st_trtype', 'st_trvalue', 'st_trbal', 'st_trdate', 'st_trref')
            .whereRaw('RTRIM(st_account) = ?', [code])
            .whereIn('st_trtype', ['C', 'R'])
            .andWhere('st_trbal', '<', 0)
            .orderByRaw('ABS(ABS(st_trbal) - ?) ASC', [amt])
            .limit(5));
        if (!rows.length)
            return EMPTY_RESULT;
        const candidates = rows.map((r) => ({
            ref: (r.st_trref ?? '').trim(),
            type: (r.st_trtype ?? '').trim(),
            value: Number(r.st_trvalue ?? 0),
            balance: Number(r.st_trbal ?? 0),
            date: normaliseDate(r.st_trdate),
        }));
        const best = candidates[0];
        return {
            is_refund: true,
            credit_note_ref: best.ref,
            credit_note_amount: Math.abs(best.balance),
            candidates,
        };
    }
    catch {
        return EMPTY_RESULT;
    }
}
/**
 * Supplier refund: receipt IN matched a supplier — look for an
 * unallocated credit note / overpayment in ptran that explains it.
 *
 * @param amountPounds positive absolute amount of the receipt.
 */
export async function checkPurchaseRefund(operaDb, supplierCode, amountPounds) {
    const code = (supplierCode ?? '').trim();
    const amt = Math.abs(Number(amountPounds));
    if (!code || !Number.isFinite(amt) || amt <= 0)
        return EMPTY_RESULT;
    try {
        const rows = (await operaDb('ptran')
            .select('pt_unique', 'pt_trtype', 'pt_trvalue', 'pt_trbal', 'pt_trdate', 'pt_trref')
            .whereRaw('RTRIM(pt_account) = ?', [code])
            .whereIn('pt_trtype', ['C', 'P'])
            .andWhere('pt_trbal', '>', 0)
            .orderByRaw('ABS(pt_trbal - ?) ASC', [amt])
            .limit(5));
        if (!rows.length)
            return EMPTY_RESULT;
        const candidates = rows.map((r) => ({
            ref: (r.pt_trref ?? '').trim(),
            type: (r.pt_trtype ?? '').trim(),
            value: Number(r.pt_trvalue ?? 0),
            balance: Number(r.pt_trbal ?? 0),
            date: normaliseDate(r.pt_trdate),
        }));
        const best = candidates[0];
        return {
            is_refund: true,
            credit_note_ref: best.ref,
            credit_note_amount: Math.abs(best.balance),
            candidates,
        };
    }
    catch {
        return EMPTY_RESULT;
    }
}
//# sourceMappingURL=check-refund.js.map
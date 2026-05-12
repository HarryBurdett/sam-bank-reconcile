import { generateImportFingerprint, } from './duplicate-detection.js';
import { getControlAccounts, getNacntType, getNextId, getNextJournal, getPeriodForDate, generateOperaUniqueId, incrementAtypeEntry, insertNjmemo, updateNacntBalance, updateNbankBalance, } from '../_shared/index.js';
const AT_TYPE_FOR_ACTION = {
    sales_receipt: 4,
    purchase_payment: 5,
    sales_refund: 3,
    purchase_refund: 6,
    nominal_payment: 1,
    nominal_receipt: 2,
    bank_transfer: 8,
};
function nowParts() {
    const now = new Date();
    const pad = (n) => n.toString().padStart(2, '0');
    const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    return { date, time, iso: `${date} ${time}` };
}
function pence(amountPounds) {
    return Math.round(amountPounds * 100);
}
function dateAsYmd(input) {
    if (!input)
        return new Date().toISOString().slice(0, 10);
    if (input instanceof Date)
        return input.toISOString().slice(0, 10);
    return String(input).slice(0, 10);
}
async function resolveCbtype(trx, preferred, receiptOrPayment) {
    if (preferred) {
        const rows = (await trx.raw(`SELECT TOP 1 1 AS x FROM atype WITH (NOLOCK)
       WHERE RTRIM(ay_cbtype) = ? AND ay_type = ?`, [preferred, receiptOrPayment]));
        if (Array.isArray(rows) && rows.length > 0)
            return preferred;
        throw new Error(`cbtype '${preferred}' not found as ay_type='${receiptOrPayment}' in atype`);
    }
    const rows = (await trx.raw(`SELECT TOP 1 RTRIM(ay_cbtype) AS ay_cbtype FROM atype WITH (NOLOCK)
     WHERE ay_type = ?`, [receiptOrPayment]));
    if (!Array.isArray(rows) || rows.length === 0 || !rows[0]?.ay_cbtype) {
        throw new Error(`No ${receiptOrPayment === 'R' ? 'receipt' : 'payment'} type found in atype`);
    }
    return (rows[0].ay_cbtype ?? '').toString().trim();
}
async function loadCustomerInfo(trx, customerAccount, defaultControl) {
    const rows = (await trx.raw(`SELECT TOP 1 sn_name, sn_region, sn_terrtry, sn_custype
     FROM sname WITH (NOLOCK)
     WHERE RTRIM(sn_account) = ?`, [customerAccount]));
    if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error(`Customer account '${customerAccount}' not found in sname`);
    }
    const r = rows[0];
    let control = defaultControl;
    try {
        const ctlRows = (await trx.raw(`SELECT RTRIM(ISNULL(sp.sc_dbtctrl, '')) AS control_account
       FROM sname s WITH (NOLOCK)
       LEFT JOIN sprfls sp WITH (NOLOCK) ON RTRIM(s.sn_cprfl) = RTRIM(sp.sc_code)
       WHERE RTRIM(s.sn_account) = ?`, [customerAccount]));
        if (Array.isArray(ctlRows) && ctlRows.length > 0) {
            const ctl = (ctlRows[0]?.control_account ?? '').trim();
            if (ctl)
                control = ctl;
        }
    }
    catch {
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
async function loadSupplierInfo(trx, supplierAccount, defaultControl) {
    const rows = (await trx.raw(`SELECT TOP 1 pn_name, pn_region, pn_terrtry, pn_custype
     FROM pname WITH (NOLOCK)
     WHERE RTRIM(pn_account) = ?`, [supplierAccount]));
    if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error(`Supplier account '${supplierAccount}' not found in pname`);
    }
    const r = rows[0];
    let control = defaultControl;
    try {
        const ctlRows = (await trx.raw(`SELECT RTRIM(ISNULL(pp.pc_crdctrl, '')) AS control_account
       FROM pname p WITH (NOLOCK)
       LEFT JOIN pprfls pp WITH (NOLOCK) ON RTRIM(p.pn_cprfl) = RTRIM(pp.pp_code)
       WHERE RTRIM(p.pn_account) = ?`, [supplierAccount]));
        if (Array.isArray(ctlRows) && ctlRows.length > 0) {
            const ctl = (ctlRows[0]?.control_account ?? '').trim();
            if (ctl)
                control = ctl;
        }
    }
    catch {
        // fall through
    }
    return {
        account: supplierAccount,
        name: (r.pn_name ?? '').trim(),
        region: (r.pn_region ?? '').trim() || 'K',
        terr: (r.pn_terrtry ?? '').trim() || '001',
        type: (r.pn_custype ?? '').trim() || 'DD1',
        controlAccount: control,
    };
}
function deriveTxnDirection(action) {
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
async function postOneTransaction(args) {
    const { trx, bankCode, txn, defaults } = args;
    if (!txn.matchedAccount) {
        throw new Error(`Missing matched_account for ${txn.action}`);
    }
    const dir = deriveTxnDirection(txn.action);
    const cbtype = await resolveCbtype(trx, txn.cbtype, dir.receiptOrPayment);
    const at_type = AT_TYPE_FOR_ACTION[txn.action];
    const now = nowParts();
    const { period, year } = await getPeriodForDate(trx, txn.date);
    const party = dir.ledger === 'sales'
        ? await loadCustomerInfo(trx, txn.matchedAccount, defaults.sl_control)
        : await loadSupplierInfo(trx, txn.matchedAccount, defaults.pl_control);
    const absAmount = Math.abs(Number(txn.amount));
    const signedPence = dir.direction === 'in' ? pence(absAmount) : -pence(absAmount);
    const entryNumber = await incrementAtypeEntry(trx, cbtype);
    const aentryId = await getNextId(trx, 'aentry');
    const journal = await getNextJournal(trx, 1);
    const atranId = await getNextId(trx, 'atran');
    const ledgerId = await getNextId(trx, dir.ledger === 'sales' ? 'stran' : 'ptran');
    const sharedUnique = generateOperaUniqueId();
    const fingerprint = generateImportFingerprint(txn.name || txn.memo || party.name, txn.amount, txn.date);
    // 1. aentry (single-line entry, complete=1 always for line-by-line imports)
    const reference = (txn.reference ?? '').slice(0, 20) || party.name.slice(0, 20);
    await trx.raw(`INSERT INTO aentry (
      id, ae_acnt, ae_cntr, ae_cbtype, ae_entry, ae_reclnum,
      ae_lstdate, ae_frstat, ae_tostat, ae_statln, ae_entref,
      ae_value, ae_recbal, ae_remove, ae_tmpstat, ae_complet,
      ae_postgrp, sq_crdate, sq_crtime, sq_cruser, ae_comment,
      ae_payid, ae_batchid, ae_brwptr, datecreated, datemodified, state
    ) VALUES (
      ?, ?, '    ', ?, ?, 0,
      ?, 0, 0, 0, ?,
      ?, 0, 0, 0, 1,
      0, ?, ?, 'BANK_IMPORT', ?,
      0, 0, '  ', ?, ?, 1
    )`, [
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
    ]);
    // 2. atran
    await trx.raw(`INSERT INTO atran (
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
    )`, [
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
        fingerprint.slice(0, 20),
        txn.memo.slice(0, 200),
        now.iso,
        now.iso,
    ]);
    // 3. Ledger row (stran for sales, ptran for purchases) — pounds
    if (dir.ledger === 'sales') {
        // stran: receipts stored negative (reduce balance); refunds positive (increase)
        const stValue = dir.direction === 'in' ? -absAmount : absAmount;
        const stType = dir.direction === 'in' ? 'R' : 'F'; // R=receipt, F=refund
        await trx.raw(`INSERT INTO stran (
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
        ?, ?, ?, ?, '', ?,
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
      )`, [
            ledgerId,
            party.account,
            txn.date,
            reference,
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
        ]);
        await trx.raw(`UPDATE sname WITH (ROWLOCK)
       SET sn_currbal = ISNULL(sn_currbal, 0) + ?,
           sn_nextpay = ISNULL(sn_nextpay, 0) + 1,
           datemodified = GETDATE()
       WHERE RTRIM(sn_account) = ?`, [stValue, party.account]);
    }
    else {
        // ptran: payments stored positive (reduce balance owed to supplier);
        // refunds negative
        const ptValue = dir.direction === 'out' ? absAmount : -absAmount;
        const ptType = dir.direction === 'out' ? 'P' : 'F';
        await trx.raw(`INSERT INTO ptran (
        id, pt_account, pt_trdate, pt_trref, pt_supref, pt_trtype,
        pt_trvalue, pt_vatval, pt_trbal, pt_paid, pt_crdate,
        pt_memo, pt_cbtype, pt_entry, pt_unique, pt_region,
        pt_terr, pt_type, pt_dueday, pt_fcurr, pt_fcrate,
        pt_fcdec, pt_fcval, pt_fcbal, pt_fcmult,
        pt_nlpdate, datecreated, datemodified, state
      ) VALUES (
        ?, ?, ?, ?, '', ?,
        ?, 0, ?, ' ', ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, '   ', 0,
        0, 0, 0, 0,
        ?, ?, ?, 1
      )`, [
            ledgerId,
            party.account,
            txn.date,
            reference,
            ptType,
            ptValue,
            ptValue,
            txn.date,
            txn.memo.slice(0, 200),
            cbtype,
            entryNumber,
            sharedUnique,
            party.region.slice(0, 3),
            party.terr.slice(0, 3),
            party.type.slice(0, 3),
            txn.date,
            txn.date,
            now.iso,
            now.iso,
        ]);
        await trx.raw(`UPDATE pname WITH (ROWLOCK)
       SET pn_currbal = ISNULL(pn_currbal, 0) + ?,
           pn_nextpay = ISNULL(pn_nextpay, 0) + 1,
           datemodified = GETDATE()
       WHERE RTRIM(pn_account) = ?`, [ptValue, party.account]);
    }
    // 4. nbank balance update — signed pounds (in for receipts, out for payments)
    const bankDeltaPounds = dir.direction === 'in' ? absAmount : -absAmount;
    await updateNbankBalance(trx, bankCode, bankDeltaPounds);
    // 5. ntran debit/credit pair + nacnt updates + njmemo
    const bankType = (await getNacntType(trx, bankCode)) ??
        { na_type: 'B ', na_subt: 'BC' };
    const controlType = (await getNacntType(trx, party.controlAccount)) ??
        { na_type: 'B ', na_subt: 'BB' };
    const ntranIdStart = await getNextId(trx, 'ntran', 2);
    const ntranComment = txn.memo.padEnd(50).slice(0, 50);
    const ntranTrnref = (party.name.slice(0, 30).padEnd(30) +
        (dir.direction === 'in' ? 'Bank Receipt        ' : 'Bank Payment        ')).slice(0, 50);
    // Bank leg (debit when receipt, credit when payment)
    const bankNtranValue = bankDeltaPounds;
    await trx.raw(`INSERT INTO ntran (
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
    )`, [
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
        sharedUnique,
        now.iso,
        now.iso,
    ]);
    await updateNacntBalance(trx, bankCode, bankNtranValue, { period, year });
    // Control leg (opposite sign)
    const controlValue = -bankNtranValue;
    await trx.raw(`INSERT INTO ntran (
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
    )`, [
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
        sharedUnique,
        now.iso,
        now.iso,
    ]);
    await updateNacntBalance(trx, party.controlAccount, controlValue, {
        period,
        year,
    });
    await insertNjmemo(trx, journal, 'Cashbook Ledger Transfer (RT)');
    // 6. anoml debit/credit pair (transfer file)
    const anomlIdStart = await getNextId(trx, 'anoml', 2);
    const anomlComment = (party.name.slice(0, 30).padEnd(30) + 'BankImport').slice(0, 40);
    await trx.raw(`INSERT INTO anoml (
      id, ax_nacnt, ax_ncntr, ax_source, ax_date, ax_value, ax_tref,
      ax_comment, ax_done, ax_fcurr, ax_fvalue, ax_fcrate, ax_fcmult, ax_fcdec,
      ax_srcco, ax_unique, ax_project, ax_job, ax_jrnl, ax_nlpdate,
      datecreated, datemodified, state
    ) VALUES (
      ?, ?, '    ', 'A', ?, ?, ?,
      ?, 'Y', '   ', 0, 0, 0, 0,
      'I', ?, '        ', '        ', ?, ?,
      ?, ?, 1
    )`, [
        anomlIdStart,
        bankCode,
        txn.date,
        bankNtranValue,
        reference,
        anomlComment,
        sharedUnique,
        journal,
        txn.date,
        now.iso,
        now.iso,
    ]);
    await trx.raw(`INSERT INTO anoml (
      id, ax_nacnt, ax_ncntr, ax_source, ax_date, ax_value, ax_tref,
      ax_comment, ax_done, ax_fcurr, ax_fvalue, ax_fcrate, ax_fcmult, ax_fcdec,
      ax_srcco, ax_unique, ax_project, ax_job, ax_jrnl, ax_nlpdate,
      datecreated, datemodified, state
    ) VALUES (
      ?, ?, '    ', 'A', ?, ?, ?,
      ?, 'Y', '   ', 0, 0, 0, 0,
      'I', ?, '        ', '        ', ?, ?,
      ?, ?, 1
    )`, [
        anomlIdStart + 1,
        party.controlAccount,
        txn.date,
        controlValue,
        reference,
        anomlComment,
        sharedUnique,
        journal,
        txn.date,
        now.iso,
        now.iso,
    ]);
    return { entry_number: entryNumber, fingerprint };
}
// ---------------------------------------------------------------------
// Nominal entry (at_type=1 payment, at_type=2 receipt)
// ---------------------------------------------------------------------
async function postNominalEntry(args) {
    const { trx, bankCode, txn } = args;
    if (!txn.matchedAccount) {
        throw new Error('Missing nominal account for nominal entry');
    }
    const isReceipt = txn.action === 'nominal_receipt';
    const cbtype = await resolveCbtype(trx, txn.cbtype, isReceipt ? 'R' : 'P');
    const at_type = AT_TYPE_FOR_ACTION[txn.action];
    const now = nowParts();
    const { period, year } = await getPeriodForDate(trx, txn.date);
    const absAmount = Math.abs(Number(txn.amount));
    const signedPence = isReceipt ? pence(absAmount) : -pence(absAmount);
    const entryNumber = await incrementAtypeEntry(trx, cbtype);
    const aentryId = await getNextId(trx, 'aentry');
    const journal = await getNextJournal(trx, 1);
    const atranId = await getNextId(trx, 'atran');
    const sharedUnique = generateOperaUniqueId();
    const fingerprint = generateImportFingerprint(txn.name || txn.memo || txn.matchedAccount, txn.amount, txn.date);
    const reference = (txn.reference ?? '').slice(0, 20) || (txn.name ?? '').slice(0, 20);
    // 1. aentry
    await trx.raw(`INSERT INTO aentry (
      id, ae_acnt, ae_cntr, ae_cbtype, ae_entry, ae_reclnum,
      ae_lstdate, ae_frstat, ae_tostat, ae_statln, ae_entref,
      ae_value, ae_recbal, ae_remove, ae_tmpstat, ae_complet,
      ae_postgrp, sq_crdate, sq_crtime, sq_cruser, ae_comment,
      ae_payid, ae_batchid, ae_brwptr, datecreated, datemodified, state
    ) VALUES (
      ?, ?, '    ', ?, ?, 0,
      ?, 0, 0, 0, ?,
      ?, 0, 0, 0, 1,
      0, ?, ?, 'BANK_IMPORT', ?,
      0, 0, '  ', ?, ?, 1
    )`, [
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
    ]);
    // 2. atran
    await trx.raw(`INSERT INTO atran (
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
    )`, [
        atranId,
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
        fingerprint.slice(0, 20),
        txn.memo.slice(0, 200),
        now.iso,
        now.iso,
    ]);
    // 3. nbank balance update
    const bankDeltaPounds = isReceipt ? absAmount : -absAmount;
    await updateNbankBalance(trx, bankCode, bankDeltaPounds);
    // 4. ntran debit/credit pair (bank vs nominal)
    const bankType = (await getNacntType(trx, bankCode)) ?? { na_type: 'B ', na_subt: 'BC' };
    const nominalType = (await getNacntType(trx, txn.matchedAccount)) ?? { na_type: 'P ', na_subt: 'PA' };
    const ntranIdStart = await getNextId(trx, 'ntran', 2);
    const ntranComment = txn.memo.padEnd(50).slice(0, 50);
    const ntranTrnref = ((txn.name || '').slice(0, 30).padEnd(30) + (isReceipt ? 'Nominal Receipt     ' : 'Nominal Payment     ')).slice(0, 50);
    // Bank leg
    await trx.raw(`INSERT INTO ntran (
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
    )`, [
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
        sharedUnique,
        now.iso,
        now.iso,
    ]);
    await updateNacntBalance(trx, bankCode, bankDeltaPounds, { period, year });
    // Nominal leg (opposite)
    await trx.raw(`INSERT INTO ntran (
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
    )`, [
        ntranIdStart + 1,
        txn.matchedAccount,
        nominalType.na_type,
        nominalType.na_subt,
        journal,
        ntranComment,
        ntranTrnref,
        txn.date,
        -bankDeltaPounds,
        year,
        period,
        sharedUnique,
        now.iso,
        now.iso,
    ]);
    await updateNacntBalance(trx, txn.matchedAccount, -bankDeltaPounds, {
        period,
        year,
    });
    await insertNjmemo(trx, journal, isReceipt ? 'Nominal Receipt' : 'Nominal Payment');
    // 5. anoml debit/credit pair
    const anomlIdStart = await getNextId(trx, 'anoml', 2);
    const anomlComment = ((txn.name || '').slice(0, 30).padEnd(30) + 'BankImport').slice(0, 40);
    await trx.raw(`INSERT INTO anoml (
      id, ax_nacnt, ax_ncntr, ax_source, ax_date, ax_value, ax_tref,
      ax_comment, ax_done, ax_fcurr, ax_fvalue, ax_fcrate, ax_fcmult, ax_fcdec,
      ax_srcco, ax_unique, ax_project, ax_job, ax_jrnl, ax_nlpdate,
      datecreated, datemodified, state
    ) VALUES (
      ?, ?, '    ', 'A', ?, ?, ?,
      ?, 'Y', '   ', 0, 0, 0, 0,
      'I', ?, '        ', '        ', ?, ?,
      ?, ?, 1
    )`, [
        anomlIdStart,
        bankCode,
        txn.date,
        bankDeltaPounds,
        reference,
        anomlComment,
        sharedUnique,
        journal,
        txn.date,
        now.iso,
        now.iso,
    ]);
    await trx.raw(`INSERT INTO anoml (
      id, ax_nacnt, ax_ncntr, ax_source, ax_date, ax_value, ax_tref,
      ax_comment, ax_done, ax_fcurr, ax_fvalue, ax_fcrate, ax_fcmult, ax_fcdec,
      ax_srcco, ax_unique, ax_project, ax_job, ax_jrnl, ax_nlpdate,
      datecreated, datemodified, state
    ) VALUES (
      ?, ?, '    ', 'A', ?, ?, ?,
      ?, 'Y', '   ', 0, 0, 0, 0,
      'I', ?, '        ', '        ', ?, ?,
      ?, ?, 1
    )`, [
        anomlIdStart + 1,
        txn.matchedAccount,
        txn.date,
        -bankDeltaPounds,
        reference,
        anomlComment,
        sharedUnique,
        journal,
        txn.date,
        now.iso,
        now.iso,
    ]);
    return { entry_number: entryNumber, fingerprint };
}
// ---------------------------------------------------------------------
// Bank transfer (at_type=8) — paired aentry/atran on source + dest
// ---------------------------------------------------------------------
async function postBankTransfer(args) {
    const { trx, bankCode, txn } = args;
    if (!txn.matchedAccount) {
        throw new Error('Missing destination bank for bank_transfer');
    }
    // Direction: negative amount = paying out (source = current bank);
    // positive amount = receiving (source = other bank, dest = current).
    const sourceBank = txn.amount < 0 ? bankCode : txn.matchedAccount;
    const destBank = txn.amount < 0 ? txn.matchedAccount : bankCode;
    const absAmount = Math.abs(Number(txn.amount));
    const cbtypeOut = await resolveCbtype(trx, txn.cbtype, 'P');
    const cbtypeIn = await resolveCbtype(trx, txn.cbtype, 'R');
    const now = nowParts();
    const { period, year } = await getPeriodForDate(trx, txn.date);
    const sharedUnique = generateOperaUniqueId();
    const journal = await getNextJournal(trx, 1);
    const fingerprint = generateImportFingerprint(`Transfer ${sourceBank}->${destBank}`, txn.amount, txn.date);
    const reference = (txn.reference ?? '').slice(0, 20) || `TRF-${destBank}`;
    // Source side: aentry + atran (negative)
    const entryOut = await incrementAtypeEntry(trx, cbtypeOut);
    const aentryOutId = await getNextId(trx, 'aentry');
    const atranOutId = await getNextId(trx, 'atran');
    await trx.raw(`INSERT INTO aentry (
      id, ae_acnt, ae_cntr, ae_cbtype, ae_entry, ae_reclnum,
      ae_lstdate, ae_frstat, ae_tostat, ae_statln, ae_entref,
      ae_value, ae_recbal, ae_remove, ae_tmpstat, ae_complet,
      ae_postgrp, sq_crdate, sq_crtime, sq_cruser, ae_comment,
      ae_payid, ae_batchid, ae_brwptr, datecreated, datemodified, state
    ) VALUES (
      ?, ?, '    ', ?, ?, 0,
      ?, 0, 0, 0, ?,
      ?, 0, 0, 0, 1,
      0, ?, ?, 'BANK_IMPORT', 'Bank transfer',
      0, 0, '  ', ?, ?, 1
    )`, [
        aentryOutId,
        sourceBank,
        cbtypeOut,
        entryOut,
        txn.date,
        reference,
        -pence(absAmount),
        now.date,
        now.time.slice(0, 8),
        now.iso,
        now.iso,
    ]);
    await trx.raw(`INSERT INTO atran (
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
    )`, [
        atranOutId,
        sourceBank,
        cbtypeOut,
        entryOut,
        txn.date,
        txn.date,
        -pence(absAmount),
        destBank,
        `Transfer to ${destBank}`.slice(0, 35),
        txn.memo.slice(0, 35),
        sharedUnique,
        fingerprint.slice(0, 20),
        txn.memo.slice(0, 200),
        now.iso,
        now.iso,
    ]);
    // Destination side: aentry + atran (positive)
    const entryIn = await incrementAtypeEntry(trx, cbtypeIn);
    const aentryInId = await getNextId(trx, 'aentry');
    const atranInId = await getNextId(trx, 'atran');
    await trx.raw(`INSERT INTO aentry (
      id, ae_acnt, ae_cntr, ae_cbtype, ae_entry, ae_reclnum,
      ae_lstdate, ae_frstat, ae_tostat, ae_statln, ae_entref,
      ae_value, ae_recbal, ae_remove, ae_tmpstat, ae_complet,
      ae_postgrp, sq_crdate, sq_crtime, sq_cruser, ae_comment,
      ae_payid, ae_batchid, ae_brwptr, datecreated, datemodified, state
    ) VALUES (
      ?, ?, '    ', ?, ?, 0,
      ?, 0, 0, 0, ?,
      ?, 0, 0, 0, 1,
      0, ?, ?, 'BANK_IMPORT', 'Bank transfer',
      0, 0, '  ', ?, ?, 1
    )`, [
        aentryInId,
        destBank,
        cbtypeIn,
        entryIn,
        txn.date,
        reference,
        pence(absAmount),
        now.date,
        now.time.slice(0, 8),
        now.iso,
        now.iso,
    ]);
    await trx.raw(`INSERT INTO atran (
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
    )`, [
        atranInId,
        destBank,
        cbtypeIn,
        entryIn,
        txn.date,
        txn.date,
        pence(absAmount),
        sourceBank,
        `Transfer from ${sourceBank}`.slice(0, 35),
        txn.memo.slice(0, 35),
        sharedUnique,
        fingerprint.slice(0, 20),
        txn.memo.slice(0, 200),
        now.iso,
        now.iso,
    ]);
    // Both nbank balance updates
    await updateNbankBalance(trx, sourceBank, -absAmount);
    await updateNbankBalance(trx, destBank, absAmount);
    // Both ntran legs (bank-to-bank: source credit, dest debit) + nacnt
    const sourceType = (await getNacntType(trx, sourceBank)) ?? { na_type: 'B ', na_subt: 'BC' };
    const destType = (await getNacntType(trx, destBank)) ?? { na_type: 'B ', na_subt: 'BC' };
    const ntranIdStart = await getNextId(trx, 'ntran', 2);
    const ntranComment = `Transfer ${sourceBank}->${destBank}`.padEnd(50).slice(0, 50);
    const ntranTrnref = `Bank Transfer`.padEnd(50).slice(0, 50);
    // Source CREDIT (negative)
    await trx.raw(`INSERT INTO ntran (
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
      '', 'BANK_IMP', 'T', ?, ?,
      ?, ?, ?, ?, 0,
      0, 0, '   ', 0, 0,
      0, 0, 'I', '', '        ',
      '        ', 'T', 0, ?, 0,
      0, 0, 0, 0, 0,
      0, ?, ?, 1
    )`, [
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
        sharedUnique,
        now.iso,
        now.iso,
    ]);
    await updateNacntBalance(trx, sourceBank, -absAmount, { period, year });
    // Dest DEBIT (positive)
    await trx.raw(`INSERT INTO ntran (
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
      '', 'BANK_IMP', 'T', ?, ?,
      ?, ?, ?, ?, 0,
      0, 0, '   ', 0, 0,
      0, 0, 'I', '', '        ',
      '        ', 'T', 0, ?, 0,
      0, 0, 0, 0, 0,
      0, ?, ?, 1
    )`, [
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
        sharedUnique,
        now.iso,
        now.iso,
    ]);
    await updateNacntBalance(trx, destBank, absAmount, { period, year });
    await insertNjmemo(trx, journal, 'Bank Transfer');
    // anoml pair
    const anomlIdStart = await getNextId(trx, 'anoml', 2);
    await trx.raw(`INSERT INTO anoml (
      id, ax_nacnt, ax_ncntr, ax_source, ax_date, ax_value, ax_tref,
      ax_comment, ax_done, ax_fcurr, ax_fvalue, ax_fcrate, ax_fcmult, ax_fcdec,
      ax_srcco, ax_unique, ax_project, ax_job, ax_jrnl, ax_nlpdate,
      datecreated, datemodified, state
    ) VALUES (
      ?, ?, '    ', 'A', ?, ?, ?,
      ?, 'Y', '   ', 0, 0, 0, 0,
      'I', ?, '        ', '        ', ?, ?,
      ?, ?, 1
    )`, [
        anomlIdStart,
        sourceBank,
        txn.date,
        -absAmount,
        reference,
        `Transfer to ${destBank}`.slice(0, 50),
        sharedUnique,
        journal,
        txn.date,
        now.iso,
        now.iso,
    ]);
    await trx.raw(`INSERT INTO anoml (
      id, ax_nacnt, ax_ncntr, ax_source, ax_date, ax_value, ax_tref,
      ax_comment, ax_done, ax_fcurr, ax_fvalue, ax_fcrate, ax_fcmult, ax_fcdec,
      ax_srcco, ax_unique, ax_project, ax_job, ax_jrnl, ax_nlpdate,
      datecreated, datemodified, state
    ) VALUES (
      ?, ?, '    ', 'A', ?, ?, ?,
      ?, 'Y', '   ', 0, 0, 0, 0,
      'I', ?, '        ', '        ', ?, ?,
      ?, ?, 1
    )`, [
        anomlIdStart + 1,
        destBank,
        txn.date,
        absAmount,
        reference,
        `Transfer from ${sourceBank}`.slice(0, 50),
        sharedUnique,
        journal,
        txn.date,
        now.iso,
        now.iso,
    ]);
    return { entry_number: entryOut, fingerprint };
}
// ---------------------------------------------------------------------
// Public executor
// ---------------------------------------------------------------------
export const bankImportPostingExecutor = {
    async postBankImport({ operaDb, bankCode, statementInfo, transactions, overrides: _overrides, // applied upstream by the route layer
    selectedRows, autoAllocate: _autoAllocate, // follow-up port
    autoReconcile: _autoReconcile, // follow-up port
     }) {
        const errors = [];
        const warnings = [];
        const posted_lines = [];
        let imported = 0;
        let failed = 0;
        let skipped = 0;
        let controlAccounts;
        try {
            controlAccounts = await getControlAccounts(operaDb);
        }
        catch (err) {
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
        for (let i = 0; i < transactions.length; i++) {
            const t = transactions[i];
            if (selected && !selected.has(i + 1) && !selected.has(i)) {
                skipped += 1;
                continue;
            }
            const action = t.action ?? 'skip';
            if (action === 'skip' || action === 'defer') {
                skipped += 1;
                continue;
            }
            if (!AT_TYPE_FOR_ACTION[action]) {
                warnings.push(`Row ${i + 1}: unknown action '${action}'. Skipped.`);
                skipped += 1;
                continue;
            }
            const matchedAccount = (t.matched_account ??
                null) ||
                (t.manual_account ??
                    null);
            const prepared = {
                index: i + 1,
                date: dateAsYmd(t.date),
                amount: Number(t.amount ?? 0),
                name: t.name ?? '',
                memo: t.memo ?? '',
                action,
                matchedAccount: matchedAccount ?? null,
                cbtype: t.cbtype ?? null,
                reference: t.reference ?? null,
            };
            try {
                let entryNumber = null;
                await operaDb.transaction(async (trx) => {
                    let result;
                    if (action === 'nominal_payment' || action === 'nominal_receipt') {
                        result = await postNominalEntry({ trx, bankCode, txn: prepared, defaults });
                    }
                    else if (action === 'bank_transfer') {
                        result = await postBankTransfer({ trx, bankCode, txn: prepared, defaults });
                    }
                    else {
                        result = await postOneTransaction({ trx, bankCode, txn: prepared, defaults });
                    }
                    entryNumber = result.entry_number;
                });
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
                        at_type: AT_TYPE_FOR_ACTION[action],
                    });
                }
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                errors.push(`Row ${i + 1}: ${msg}`);
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
//# sourceMappingURL=import-posting-executor.js.map
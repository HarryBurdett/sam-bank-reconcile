const STATUS_FIELD = {
    NL: 'ncd_nlstat',
    SL: 'ncd_slstat',
    PL: 'ncd_plstat',
    ST: 'ncd_ststat',
    WG: 'ncd_wgstat',
    FA: 'ncd_fastat',
};
async function readSeqcoBit(operaDb, column) {
    try {
        const rows = (await operaDb.raw(`SELECT ${column} AS v
       FROM Opera3SESystem.dbo.seqco WITH (NOLOCK)
       WHERE co_code = RIGHT(DB_NAME(), 1)`));
        if (Array.isArray(rows) && rows.length > 0 && rows[0]?.v != null) {
            return Boolean(rows[0].v);
        }
    }
    catch {
        // table not visible — fall through to null
    }
    return null;
}
export async function isRealTimeUpdateEnabled(operaDb) {
    const v = await readSeqcoBit(operaDb, 'co_rtupdnl');
    // Safe migration default: assume RTU=ON when unreadable. This
    // preserves today's behaviour (ntran always written). Legacy
    // defaults to OFF, but flipping that default would silently disable
    // ntran writes for every install where Opera3SESystem isn't
    // accessible.
    return v ?? true;
}
export async function isOpenPeriodAccountingEnabled(operaDb) {
    const v = await readSeqcoBit(operaDb, 'co_opanl');
    if (v != null)
        return v;
    // Fallback: nparm.np_opawarn (older SQL SE)
    try {
        const rows = (await operaDb.raw(`SELECT TOP 1 np_opawarn AS v FROM nparm WITH (NOLOCK)`));
        if (Array.isArray(rows) && rows.length > 0 && rows[0]?.v != null) {
            return Boolean(rows[0].v);
        }
    }
    catch {
        // ignore
    }
    // Legacy default = OFF.
    return false;
}
export async function getCurrentPeriodInfo(operaDb) {
    try {
        const rows = (await operaDb.raw(`SELECT TOP 1 np_year, np_perno, np_periods FROM nparm WITH (NOLOCK)`));
        if (Array.isArray(rows) && rows.length > 0) {
            const r = rows[0];
            return {
                year: r.np_year != null ? Number(r.np_year) : null,
                period: r.np_perno != null ? Number(r.np_perno) : null,
                periods: r.np_periods != null ? Number(r.np_periods) : 12,
            };
        }
    }
    catch {
        // ignore
    }
    return { year: null, period: null, periods: 12 };
}
export async function getPeriodStatus(operaDb, year, period, ledgerType) {
    const col = STATUS_FIELD[ledgerType];
    try {
        const rows = (await operaDb.raw(`SELECT ${col} AS status
       FROM nclndd WITH (NOLOCK)
       WHERE ncd_year = ? AND ncd_period = ?`, [year, period]));
        if (Array.isArray(rows) && rows.length > 0 && rows[0]?.status != null) {
            return Number(rows[0].status);
        }
    }
    catch {
        // ignore
    }
    return null;
}
/**
 * Look up financial period+year for a date from nclndd, with calendar-
 * month fallback. Mirrors the existing inline helper in the executor
 * but is exposed here so the decision builder can self-contain.
 */
async function getPeriodForDate(operaDb, postDate) {
    try {
        // Column names are ncd_stdate / ncd_endate (NOT ncd_strdate /
        // ncd_enddate — that was a typo in this file that made every
        // period lookup throw and silently fall back to calendar month).
        // Source: opera_config.py:541-546 and period-validation.ts:104.
        const rows = (await operaDb.raw(`SELECT TOP 1 ncd_year AS year, ncd_period AS period
       FROM nclndd WITH (NOLOCK)
       WHERE ncd_stdate <= ? AND ncd_endate >= ?`, [postDate, postDate]));
        if (Array.isArray(rows) &&
            rows.length > 0 &&
            rows[0]?.year != null &&
            rows[0]?.period != null) {
            return { year: Number(rows[0].year), period: Number(rows[0].period) };
        }
    }
    catch {
        // ignore
    }
    // Calendar-month fallback.
    const d = new Date(postDate);
    return { year: d.getUTCFullYear(), period: d.getUTCMonth() + 1 };
}
/**
 * Full decision orchestrator. Faithful port of get_period_posting_decision
 * (opera_config.py:848).
 */
export async function getPeriodPostingDecision(operaDb, postDate, ledgerType = 'NL') {
    const { year: txnYear, period: txnPeriod } = await getPeriodForDate(operaDb, postDate);
    const current = await getCurrentPeriodInfo(operaDb);
    const opa = await isOpenPeriodAccountingEnabled(operaDb);
    const rtu = await isRealTimeUpdateEnabled(operaDb);
    if (current.year == null || current.period == null) {
        return {
            canPost: true,
            postToNominal: false,
            postToTransferFile: true,
            transferFileDoneFlag: ' ',
            transactionYear: txnYear,
            transactionPeriod: txnPeriod,
        };
    }
    // Step 1: OPA period gating
    if (opa) {
        const nlStatus = await getPeriodStatus(operaDb, txnYear, txnPeriod, 'NL');
        if (nlStatus == null) {
            return {
                canPost: false,
                postToNominal: false,
                postToTransferFile: false,
                transferFileDoneFlag: ' ',
                errorMessage: `Period ${txnPeriod}/${txnYear} not found in calendar (nclndd)`,
                currentYear: current.year,
                currentPeriod: current.period,
                transactionYear: txnYear,
                transactionPeriod: txnPeriod,
            };
        }
        if (nlStatus !== 0) {
            const desc = nlStatus === 2 ? 'closed' : 'blocked';
            return {
                canPost: false,
                postToNominal: false,
                postToTransferFile: false,
                transferFileDoneFlag: ' ',
                errorMessage: `Period ${txnPeriod}/${txnYear} is ${desc} for NL — all ledgers blocked`,
                currentYear: current.year,
                currentPeriod: current.period,
                transactionYear: txnYear,
                transactionPeriod: txnPeriod,
            };
        }
        if (ledgerType !== 'NL') {
            const subStatus = await getPeriodStatus(operaDb, txnYear, txnPeriod, ledgerType);
            if (subStatus == null) {
                return {
                    canPost: false,
                    postToNominal: false,
                    postToTransferFile: false,
                    transferFileDoneFlag: ' ',
                    errorMessage: `Period ${txnPeriod}/${txnYear} not found in calendar for ${ledgerType}`,
                    currentYear: current.year,
                    currentPeriod: current.period,
                    transactionYear: txnYear,
                    transactionPeriod: txnPeriod,
                };
            }
            if (subStatus !== 0) {
                const desc = subStatus === 2 ? 'closed' : 'blocked';
                return {
                    canPost: false,
                    postToNominal: false,
                    postToTransferFile: false,
                    transferFileDoneFlag: ' ',
                    errorMessage: `Period ${txnPeriod}/${txnYear} is ${desc} for ${ledgerType}`,
                    currentYear: current.year,
                    currentPeriod: current.period,
                    transactionYear: txnYear,
                    transactionPeriod: txnPeriod,
                };
            }
        }
    }
    else {
        // OPA OFF — only current period allowed.
        if (txnYear !== current.year || txnPeriod !== current.period) {
            return {
                canPost: false,
                postToNominal: false,
                postToTransferFile: false,
                transferFileDoneFlag: ' ',
                errorMessage: `Period ${txnPeriod}/${txnYear} is blocked. ` +
                    `Current period is ${current.period}/${current.year}. ` +
                    `Open Period Accounting is disabled.`,
                currentYear: current.year,
                currentPeriod: current.period,
                transactionYear: txnYear,
                transactionPeriod: txnPeriod,
            };
        }
    }
    // Step 2: RTU gating
    if (!rtu) {
        return {
            canPost: true,
            postToNominal: false,
            postToTransferFile: true,
            transferFileDoneFlag: ' ',
            currentYear: current.year,
            currentPeriod: current.period,
            transactionYear: txnYear,
            transactionPeriod: txnPeriod,
        };
    }
    // Step 3: RTU ON — check period vs current
    if (txnYear > current.year ||
        (txnYear === current.year && txnPeriod >= current.period)) {
        return {
            canPost: true,
            postToNominal: true,
            postToTransferFile: true,
            transferFileDoneFlag: 'Y',
            currentYear: current.year,
            currentPeriod: current.period,
            transactionYear: txnYear,
            transactionPeriod: txnPeriod,
        };
    }
    if (txnYear === current.year) {
        // Backdated to earlier open period within current year — still post.
        return {
            canPost: true,
            postToNominal: true,
            postToTransferFile: true,
            transferFileDoneFlag: 'Y',
            currentYear: current.year,
            currentPeriod: current.period,
            transactionYear: txnYear,
            transactionPeriod: txnPeriod,
        };
    }
    // Prior financial year — reject.
    return {
        canPost: false,
        postToNominal: false,
        postToTransferFile: false,
        transferFileDoneFlag: ' ',
        errorMessage: `Transaction date falls in prior year ${txnYear} (current year ${current.year}) — change posting date to current year`,
        currentYear: current.year,
        currentPeriod: current.period,
        transactionYear: txnYear,
        transactionPeriod: txnPeriod,
    };
}
//# sourceMappingURL=period-posting-decision.js.map
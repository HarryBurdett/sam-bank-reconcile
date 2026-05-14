export class PostingVerificationError extends Error {
    entryNumber;
    phase;
    constructor(message, opts) {
        super(message);
        this.name = 'PostingVerificationError';
        this.entryNumber = opts.entryNumber;
        this.phase = opts.phase;
    }
}
function isPlainErr(e) {
    return e instanceof Error ? e.message : String(e);
}
// ---------------------------------------------------------------------
// In-trx assertions (Phase A)
// ---------------------------------------------------------------------
/**
 * Assert that the matching aentry + atran rows exist for an entry
 * number on a bank, and that the cashbook-side values match what
 * we wrote.
 *
 * Joins by `ae_entry = at_entry AND ae_acnt = at_acnt` — the
 * cashbook primary key. Mismatch on count, value, or fingerprint
 * throws.
 */
export async function assertAentryAtran(trx, opts) {
    let rows;
    try {
        rows = (await trx.raw(`SELECT
         a.ae_value AS ae_value,
         t.at_value AS at_value,
         t.at_pstdate AS at_pstdate,
         t.at_type AS at_type,
         RTRIM(t.at_refer) AS at_refer
       FROM aentry a WITH (NOLOCK)
       JOIN atran t WITH (NOLOCK)
         ON t.at_entry = a.ae_entry AND t.at_acnt = a.ae_acnt
       WHERE RTRIM(a.ae_entry) = ?
         AND RTRIM(a.ae_acnt) = ?`, [opts.entryNumber, opts.bankAccount]));
    }
    catch (err) {
        throw new PostingVerificationError(`aentry+atran in-trx verify query failed for ${opts.entryNumber}: ${isPlainErr(err)}`, { entryNumber: opts.entryNumber, phase: 'in-trx' });
    }
    if (!Array.isArray(rows) || rows.length === 0) {
        throw new PostingVerificationError(`aentry+atran missing after INSERT (entry=${opts.entryNumber}, bank=${opts.bankAccount}) — possible silent trigger discard`, { entryNumber: opts.entryNumber, phase: 'in-trx' });
    }
    // We expect exactly one cashbook+nominal row per atran row. Multiple
    // matches would mean an unexpected duplicate INSERT — fail loud.
    if (rows.length > 1) {
        throw new PostingVerificationError(`aentry+atran matched ${rows.length} rows for entry=${opts.entryNumber} — expected 1`, { entryNumber: opts.entryNumber, phase: 'in-trx' });
    }
    const r = rows[0];
    const ae = Number(r.ae_value ?? NaN);
    const at = Number(r.at_value ?? NaN);
    if (!Number.isFinite(ae) || ae !== opts.expectedSignedPence) {
        throw new PostingVerificationError(`aentry.ae_value mismatch for ${opts.entryNumber}: stored=${ae} expected=${opts.expectedSignedPence}`, { entryNumber: opts.entryNumber, phase: 'in-trx' });
    }
    if (!Number.isFinite(at) || at !== opts.expectedSignedPence) {
        throw new PostingVerificationError(`atran.at_value mismatch for ${opts.entryNumber}: stored=${at} expected=${opts.expectedSignedPence}`, { entryNumber: opts.entryNumber, phase: 'in-trx' });
    }
    if (Number(r.at_type) !== opts.expectedAtType) {
        throw new PostingVerificationError(`atran.at_type mismatch for ${opts.entryNumber}: stored=${r.at_type} expected=${opts.expectedAtType}`, { entryNumber: opts.entryNumber, phase: 'in-trx' });
    }
    const storedDate = r.at_pstdate instanceof Date
        ? r.at_pstdate.toISOString().slice(0, 10)
        : typeof r.at_pstdate === 'string'
            ? r.at_pstdate.slice(0, 10)
            : null;
    if (storedDate !== opts.expectedDate) {
        throw new PostingVerificationError(`atran.at_pstdate mismatch for ${opts.entryNumber}: stored=${storedDate} expected=${opts.expectedDate}`, { entryNumber: opts.entryNumber, phase: 'in-trx' });
    }
    if (opts.expectedReferPrefix &&
        (r.at_refer ?? '').trim() !== opts.expectedReferPrefix.trim()) {
        throw new PostingVerificationError(`atran.at_refer mismatch for ${opts.entryNumber}: stored="${r.at_refer}" expected="${opts.expectedReferPrefix}"`, { entryNumber: opts.entryNumber, phase: 'in-trx' });
    }
}
/**
 * Assert that exactly one ledger row (stran for sales, ptran for
 * purchases) was written for the entry, and the value matches.
 *
 * stran/ptran use `<table>_entry` + `<table>_cbtype` to link back
 * to aentry/atran.
 */
export async function assertLedgerRow(trx, opts) {
    const table = opts.ledger === 'sales' ? 'stran' : 'ptran';
    const valueCol = opts.ledger === 'sales' ? 'st_trvalue' : 'pt_trvalue';
    const entryCol = opts.ledger === 'sales' ? 'st_entry' : 'pt_entry';
    const cbCol = opts.ledger === 'sales' ? 'st_cbtype' : 'pt_cbtype';
    const acctCol = opts.ledger === 'sales' ? 'st_account' : 'pt_account';
    let rows;
    try {
        rows = (await trx.raw(`SELECT ${valueCol} AS v FROM ${table} WITH (NOLOCK)
       WHERE RTRIM(${entryCol}) = ?
         AND RTRIM(${cbCol}) = ?
         AND RTRIM(${acctCol}) = ?`, [opts.entryNumber, opts.cbtype, opts.account]));
    }
    catch (err) {
        throw new PostingVerificationError(`${table} in-trx verify query failed for ${opts.entryNumber}: ${isPlainErr(err)}`, { entryNumber: opts.entryNumber, phase: 'in-trx' });
    }
    if (!Array.isArray(rows) || rows.length !== 1) {
        throw new PostingVerificationError(`${table} row count mismatch for entry=${opts.entryNumber}, acct=${opts.account}: got ${rows?.length ?? 0}, expected 1`, { entryNumber: opts.entryNumber, phase: 'in-trx' });
    }
    const stored = Number(rows[0].v ?? NaN);
    // Pounds tolerance: 0.5p to absorb float storage rounding.
    if (!Number.isFinite(stored) ||
        Math.abs(stored - opts.expectedValuePounds) > 0.005) {
        throw new PostingVerificationError(`${table}.${valueCol} mismatch for ${opts.entryNumber}: stored=${stored} expected=${opts.expectedValuePounds}`, { entryNumber: opts.entryNumber, phase: 'in-trx' });
    }
}
/**
 * Assert that a debit/credit pair was written and sums to zero,
 * looking up by the shared unique id we generated for the posting.
 *
 * Used for ntran (general-ledger journal pair) and anoml (transfer
 * file pair). Both should always have count=expectedCount AND
 * sum-of-value=0.
 */
export async function assertBalancedPair(trx, opts) {
    const uniqueCol = opts.table === 'ntran' ? 'nt_pstid' : 'ax_unique';
    const valueCol = opts.table === 'ntran' ? 'nt_value' : 'ax_value';
    let rows;
    try {
        rows = (await trx.raw(`SELECT COUNT(*) AS cnt, SUM(${valueCol}) AS total
       FROM ${opts.table} WITH (NOLOCK)
       WHERE RTRIM(${uniqueCol}) = ?`, [opts.sharedUnique]));
    }
    catch (err) {
        throw new PostingVerificationError(`${opts.table} in-trx verify query failed for ${opts.entryNumber}: ${isPlainErr(err)}`, { entryNumber: opts.entryNumber, phase: 'in-trx' });
    }
    const cnt = Number(rows?.[0]?.cnt ?? 0);
    const total = Number(rows?.[0]?.total ?? NaN);
    if (cnt !== opts.expectedCount) {
        throw new PostingVerificationError(`${opts.table} pair count mismatch for ${opts.entryNumber}: got ${cnt}, expected ${opts.expectedCount} (unique=${opts.sharedUnique})`, { entryNumber: opts.entryNumber, phase: 'in-trx' });
    }
    if (!Number.isFinite(total) || Math.abs(total) > 0.005) {
        throw new PostingVerificationError(`${opts.table} pair does not balance for ${opts.entryNumber}: sum=${total} (unique=${opts.sharedUnique})`, { entryNumber: opts.entryNumber, phase: 'in-trx' });
    }
}
// ---------------------------------------------------------------------
// Post-commit verification (Phase C)
// ---------------------------------------------------------------------
/**
 * After the trx commits, re-read the aentry row from a fresh pool
 * connection (separate session) to confirm the COMMIT was visible
 * outside our trx. If the row is missing or its value differs from
 * what we sent, the post-commit visibility check has failed — the
 * caller must surface a hard operator-action error rather than
 * silently retrying.
 *
 * Uses NOLOCK + a short LOCK_TIMEOUT as belt-and-braces. NOLOCK
 * shouldn't acquire locks anyway; the timeout caps any pathological
 * case where it tries.
 */
export async function verifyAentryCommitted(operaDb, opts) {
    try {
        // Set a small lock timeout for safety. If somehow the read does
        // try to acquire a lock, we'd rather fail-loud than hang.
        await operaDb.raw('SET LOCK_TIMEOUT 1000');
        const rows = (await operaDb.raw(`SELECT TOP 1
         a.ae_value AS ae_value,
         t.at_value AS at_value,
         RTRIM(a.ae_acnt) AS acnt
       FROM aentry a WITH (NOLOCK)
       JOIN atran t WITH (NOLOCK)
         ON t.at_entry = a.ae_entry AND t.at_acnt = a.ae_acnt
       WHERE RTRIM(a.ae_entry) = ?
         AND RTRIM(a.ae_acnt) = ?`, [opts.entryNumber, opts.bankAccount]));
        if (!Array.isArray(rows) || rows.length === 0) {
            return {
                verified: false,
                reason: `aentry+atran not visible from fresh session (entry=${opts.entryNumber}, bank=${opts.bankAccount})`,
            };
        }
        const r = rows[0];
        const ae = Number(r.ae_value ?? NaN);
        const at = Number(r.at_value ?? NaN);
        if (!Number.isFinite(ae) || ae !== opts.expectedSignedPence) {
            return {
                verified: false,
                reason: `aentry.ae_value mismatch in post-commit read: stored=${ae} expected=${opts.expectedSignedPence}`,
            };
        }
        if (!Number.isFinite(at) || at !== opts.expectedSignedPence) {
            return {
                verified: false,
                reason: `atran.at_value mismatch in post-commit read: stored=${at} expected=${opts.expectedSignedPence}`,
            };
        }
        return { verified: true };
    }
    catch (err) {
        return {
            verified: false,
            reason: `post-commit verify query failed: ${isPlainErr(err)}`,
        };
    }
}
//# sourceMappingURL=post-write-verify.js.map
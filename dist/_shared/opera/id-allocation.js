/**
 * Allocate the next journal number(s) from nparm.np_nexjrnl.
 *
 * Returns the FIRST allocated journal number; caller uses
 * `first..first+count-1`. Defaults `count=1`.
 *
 * UPDLOCK + ROWLOCK on the read prevents concurrent allocation.
 */
export async function getNextJournal(trx, count = 1) {
    const rows = (await trx.raw(`SELECT np_nexjrnl FROM nparm WITH (UPDLOCK, ROWLOCK)`));
    const next = Array.isArray(rows) && rows[0] && rows[0].np_nexjrnl != null
        ? Number(rows[0].np_nexjrnl)
        : 1;
    await trx.raw(`UPDATE nparm WITH (ROWLOCK) SET np_nexjrnl = ?`, [next + count]);
    return next;
}
/**
 * Allocate the next id(s) from the nextid table for a given table.
 *
 * Opera maintains a `nextid` table with a row per table holding the
 * next available `id` value. Throws if no row exists for `tablename`
 * (Opera SE only — Opera 3 doesn't have nextid).
 */
export async function getNextId(trx, tablename, count = 1) {
    const rows = (await trx.raw(`SELECT nextid FROM nextid WITH (UPDLOCK, ROWLOCK)
     WHERE RTRIM(tablename) = ?`, [tablename]));
    if (!Array.isArray(rows) || rows.length === 0 || rows[0]?.nextid == null) {
        throw new Error(`No nextid row found for table '${tablename}'`);
    }
    const next = Number(rows[0].nextid);
    await trx.raw(`UPDATE nextid WITH (ROWLOCK)
     SET nextid = ?, datemodified = GETDATE()
     WHERE RTRIM(tablename) = ?`, [next + count, tablename]);
    return next;
}
/**
 * Allocate the next aentry number for a cashbook type.
 *
 * Reads ay_entry from atype with UPDLOCK, then verifies the entry
 * doesn't already exist in aentry (defensive check — Opera can write
 * entries directly, leaving atype's counter behind). Walks the
 * counter forward until an unused number is found, up to 100
 * attempts.
 *
 * The atype.ay_entry field is updated to one PAST the allocated
 * number, ready for the next caller.
 *
 * Format is `{cbtype}{N:08d}` — e.g. cbtype='P1' → 'P100008024'.
 *
 * Throws if the cbtype isn't in atype, or if 100 sequential entries
 * are already taken (extremely unlikely; signals corrupted state).
 */
export async function incrementAtypeEntry(trx, cbtype) {
    const rows = (await trx.raw(`SELECT ay_entry FROM atype WITH (UPDLOCK, ROWLOCK)
     WHERE RTRIM(ay_cbtype) = ?`, [cbtype]));
    if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error(`Type code '${cbtype}' not found in atype`);
    }
    const initial = (rows[0]?.ay_entry ?? '').toString().trim();
    const fallback = `${cbtype}${'0'.padStart(8, '0')}`;
    let current = initial || fallback;
    const prefixLen = cbtype.length;
    let entryNum;
    try {
        entryNum = Number.parseInt(current.slice(prefixLen), 10);
        if (!Number.isFinite(entryNum))
            entryNum = 0;
    }
    catch {
        entryNum = 0;
    }
    // Defensive forward-walk: skip past any already-existing entries.
    let skipped = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const existsRows = (await trx.raw(`SELECT 1 AS x FROM aentry WITH (NOLOCK)
       WHERE RTRIM(ae_cbtype) = ? AND RTRIM(ae_entry) = ?`, [cbtype, current]));
        if (!Array.isArray(existsRows) || existsRows.length === 0) {
            break; // unused — we can claim it
        }
        skipped++;
        if (skipped > 100) {
            throw new Error(`Unable to find unused entry number for cbtype '${cbtype}' after 100 attempts`);
        }
        entryNum++;
        current = `${cbtype}${entryNum.toString().padStart(8, '0')}`;
    }
    const nextEntry = `${cbtype}${(entryNum + 1).toString().padStart(8, '0')}`;
    await trx.raw(`UPDATE atype WITH (ROWLOCK)
     SET ay_entry = ?, datemodified = GETDATE()
     WHERE RTRIM(ay_cbtype) = ?`, [nextEntry, cbtype]);
    return current;
}
//# sourceMappingURL=id-allocation.js.map
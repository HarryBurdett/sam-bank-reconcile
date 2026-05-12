/**
 * Opera id allocation primitives — sequence counters used by every
 * posting flow.
 *
 * Faithful ports of the methods on `OperaSQLImport`:
 *   - _get_next_journal     → getNextJournal()
 *     allocates from nparm.np_nexjrnl
 *   - _get_next_id          → getNextId()
 *     allocates from nextid table (used for stran/ptran/atran/ntran ids)
 *   - increment_atype_entry → incrementAtypeEntry()
 *     allocates the next aentry number from atype.ay_entry, with the
 *     defensive duplicate-check that walks the counter forward when
 *     it gets out of sync with aentry
 *
 * All three are designed to be called WITHIN an open transaction so
 * UPDLOCK + ROWLOCK on the SELECT prevents two concurrent posters
 * picking the same number. The first argument is therefore a
 * `Knex.Transaction` (alias `trx: Knex`) rather than a raw db handle.
 *
 * Per CLAUDE.md mandatory locking rules: NEVER use MAX(...)+1 to
 * allocate a sequence. ALWAYS allocate via these helpers.
 */
import type { Knex } from 'knex';
/**
 * Allocate the next journal number(s) from nparm.np_nexjrnl.
 *
 * Returns the FIRST allocated journal number; caller uses
 * `first..first+count-1`. Defaults `count=1`.
 *
 * UPDLOCK + ROWLOCK on the read prevents concurrent allocation.
 */
export declare function getNextJournal(trx: Knex, count?: number): Promise<number>;
/**
 * Allocate the next id(s) from the nextid table for a given table.
 *
 * Opera maintains a `nextid` table with a row per table holding the
 * next available `id` value. Throws if no row exists for `tablename`
 * (Opera SE only — Opera 3 doesn't have nextid).
 */
export declare function getNextId(trx: Knex, tablename: string, count?: number): Promise<number>;
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
export declare function incrementAtypeEntry(trx: Knex, cbtype: string): Promise<string>;
//# sourceMappingURL=id-allocation.d.ts.map
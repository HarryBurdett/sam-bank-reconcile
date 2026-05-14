/**
 * Post-write verification helpers.
 *
 * Two-phase verification of a multi-table Opera posting:
 *
 *   (A) `assert*` helpers run INSIDE the trx that just did the
 *       INSERTs. They use `WITH (NOLOCK)` so they take no shared
 *       locks (within our own session, NOLOCK still reads our own
 *       uncommitted inserts — see SQL Server isolation semantics).
 *       A mismatch throws `PostingVerificationError`, which the
 *       caller rethrows — Knex's transaction wrapper rolls the
 *       INSERTs back, so no half-posted row ever lands.
 *
 *   (C) `verifyAentryCommitted` runs AFTER the trx commits. It
 *       grabs a fresh pool connection and re-reads the aentry +
 *       atran row by primary key with NOLOCK. If 0 rows or wrong
 *       values are returned, the post-commit visibility check has
 *       failed — caller surfaces a hard operator-action error
 *       ("posted but verification could not confirm — check
 *       Opera manually before re-running").
 *
 * Lock surface: zero new locks. NOLOCK is used throughout
 * specifically so concurrent Opera UI activity is never blocked
 * by our verification step. Concurrency safety for the actual
 * writes is handled elsewhere — `incrementAtypeEntry` serialises
 * the entry-number allocator with UPDLOCK+ROWLOCK on atype, and
 * balance updates use UPDLOCK+ROWLOCK with additive UPDATE.
 */
import type { Knex } from 'knex';
export declare class PostingVerificationError extends Error {
    readonly entryNumber: string | null;
    readonly phase: 'in-trx' | 'post-commit';
    constructor(message: string, opts: {
        entryNumber: string | null;
        phase: 'in-trx' | 'post-commit';
    });
}
/**
 * Assert that the matching aentry + atran rows exist for an entry
 * number on a bank, and that the cashbook-side values match what
 * we wrote.
 *
 * Joins by `ae_entry = at_entry AND ae_acnt = at_acnt` — the
 * cashbook primary key. Mismatch on count, value, or fingerprint
 * throws.
 */
export declare function assertAentryAtran(trx: Knex, opts: {
    entryNumber: string;
    bankAccount: string;
    expectedSignedPence: number;
    expectedAtType: number;
    expectedDate: string;
    expectedReferPrefix?: string;
}): Promise<void>;
/**
 * Assert that exactly one ledger row (stran for sales, ptran for
 * purchases) was written for the entry, and the value matches.
 *
 * stran/ptran use `<table>_entry` + `<table>_cbtype` to link back
 * to aentry/atran.
 */
export declare function assertLedgerRow(trx: Knex, opts: {
    ledger: 'sales' | 'purchase';
    entryNumber: string;
    cbtype: string;
    account: string;
    expectedValuePounds: number;
}): Promise<void>;
/**
 * Assert that a debit/credit pair was written and sums to zero,
 * looking up by the shared unique id we generated for the posting.
 *
 * Used for ntran (general-ledger journal pair) and anoml (transfer
 * file pair). Both should always have count=expectedCount AND
 * sum-of-value=0.
 */
export declare function assertBalancedPair(trx: Knex, opts: {
    table: 'ntran' | 'anoml';
    sharedUnique: string;
    expectedCount: number;
    entryNumber: string;
}): Promise<void>;
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
export declare function verifyAentryCommitted(operaDb: Knex, opts: {
    entryNumber: string;
    bankAccount: string;
    expectedSignedPence: number;
}): Promise<{
    verified: true;
} | {
    verified: false;
    reason: string;
}>;
//# sourceMappingURL=post-write-verify.d.ts.map
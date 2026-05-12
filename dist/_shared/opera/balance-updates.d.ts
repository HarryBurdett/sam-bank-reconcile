/**
 * Opera balance-update primitives — keep aggregate balances in sync
 * with transaction-level postings.
 *
 * Faithful ports of:
 *   - update_nbank_balance  → updateNbankBalance()
 *   - _get_nacnt_type       → getNacntType()
 *   - update_nacnt_balance  → updateNacntBalance() (with nsubt/ntype/nhist)
 *
 * Per CLAUDE.md "complete data updates": every ntran INSERT MUST be
 * accompanied by an updateNacntBalance() call (also handles nhist
 * automatically). Every cashbook-affecting post MUST call
 * updateNbankBalance(). Skipping these causes control-account
 * mismatches and audit failures.
 *
 * Always called WITHIN an open MSSQL transaction. ROWLOCK on writes,
 * NOLOCK on the type lookup.
 */
import type { Knex } from 'knex';
/**
 * Update nbank.nk_curbal after posting cashbook transactions.
 *
 * @param amountPounds positive = receipt (increases balance),
 *                     negative = payment (decreases balance).
 *                     Stored in pence internally.
 *
 * Throws when the bank account isn't found in nbank — caller is in a
 * transaction and the throw forces a rollback rather than commit
 * with an out-of-sync bank balance.
 *
 * Implementation note: uses Knex's query builder `.update()` which
 * returns the actual rowsAffected as a number on every Knex driver
 * (mssql/tedious, sqlite, foxpro etc.). Using `trx.raw(UPDATE ...)`
 * here would silently return 0 on MSSQL because tedious doesn't
 * surface rowsAffected for raw statements — that bit us before.
 */
export declare function updateNbankBalance(trx: Knex, bankAccount: string, amountPounds: number): Promise<void>;
export interface NacntType {
    na_type: string;
    na_subt: string;
}
export declare function getNacntType(trx: Knex, account: string): Promise<NacntType | null>;
export interface UpdateNacntBalanceOptions {
    /** Posting period (1..24). Outside that range is silently skipped
     *  (matches Python's `logger.warning + return`). */
    period: number;
    /** Financial year — required for nhist write (passed through). */
    year: number;
}
/**
 * Update nacnt + nhist + nsubt + ntype after posting an ntran row.
 *
 * Sign convention:
 *   value > 0  → DEBIT  (na_ptddr/na_ytddr += value)
 *   value < 0  → CREDIT (na_ptdcr/na_ytdcr += abs(value))
 *   period column (na_balc01..24) ALWAYS += value (signed net)
 *
 * Throws when nacnt update affects 0 rows — that means the account
 * isn't in nacnt, which would silently leak balance drift.
 *
 * NB: the nhist write follows Opera's convention of storing nh_ptdcr
 * as a NEGATIVE number (vs nacnt's positive magnitudes). Don't
 * "correct" that — Opera's reports rely on the negative sign.
 *
 * Caller is responsible for being inside a transaction.
 */
export declare function updateNacntBalance(trx: Knex, account: string, value: number, opts: UpdateNacntBalanceOptions): Promise<void>;
/**
 * Insert a journal memo record into njmemo for a nominal ledger posting.
 *
 * Faithful port of `_insert_njmemo` (opera_sql_import.py:709-741).
 * Opera creates an njmemo record for each journal number when posting
 * to the nominal ledger. nj_memo uses a sentinel pattern with chr(255)
 * surrounds; nj_txtrep holds the human-readable description (truncated
 * to 60 chars).
 *
 * Allocates the njmemo id via getNextId('njmemo').
 */
export declare function insertNjmemo(trx: Knex, journalNumber: number, description: string): Promise<void>;
//# sourceMappingURL=balance-updates.d.ts.map
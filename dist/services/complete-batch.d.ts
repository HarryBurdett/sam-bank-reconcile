/**
 * Complete an incomplete cashbook batch by posting to the nominal ledger.
 *
 * Faithful port of `complete_batch_posting`
 * (sql_rag/opera_sql_import.py:8809-9019) + the wrapping endpoint
 * `complete_batch` (apps/bank_reconcile/api/routes.py:849-891).
 *
 * Flow:
 *   1. Validate aentry exists and ae_complet=0
 *   2. Look up unposted anoml records (ax_done='N') by joining via
 *      atran's at_unique
 *   3. If none: just set ae_complet=1 (the entry was probably already
 *      transferred or had no NL impact)
 *   4. Else, in a single transaction:
 *      - allocate next journal number (getNextJournal)
 *      - for each anoml row:
 *          * lookup nacnt type/subtype
 *          * INSERT ntran with the journal number, transfer-from-T
 *            posttype, generated nt_pstid
 *          * call updateNacntBalance (includes nhist + nsubt + ntype)
 *          * track bank delta if posting to bank account
 *          * mark anoml row ax_done='Y' + ax_jrnl=journal
 *      - if bank delta != 0: updateNbankBalance
 *      - if any ntran created: insertNjmemo for the batch journal
 *      - UPDATE aentry SET ae_complet=1
 *
 * Locking: bank-level import lock + ROWLOCK on every write. Single
 * MSSQL transaction so a failure rolls back the whole batch.
 *
 * SQL injection guard: bank_code + entry_number validated at the
 * route boundary.
 */
import type { Knex } from 'knex';
export interface CompleteBatchInput {
    bankCode: string;
    entryNumber: string;
}
export interface CompleteBatchResponse {
    success: boolean;
    message?: string;
    entry_number?: string;
    details?: string[];
    errors?: string[];
    error?: string;
}
export declare function completeBatch(appDb: Knex, operaDb: Knex, input: CompleteBatchInput): Promise<CompleteBatchResponse>;
//# sourceMappingURL=complete-batch.d.ts.map
/**
 * Persist defer / partial-rec decisions for a bank statement WITHOUT
 * requiring the user to click the green Import button.
 *
 * Faithful port of `persist_bank_import_decisions`
 * (apps/bank_reconcile/api/routes.py:3406-3565).
 *
 * Background (from the Python docstring):
 *   Sequential Statement Gating works off two records — a
 *   bank_statement_imports row (source of has_import_record) and
 *   deferred_transactions rows (source of deferred_count). Without
 *   this endpoint the rows were only written when the user clicked
 *   Import. For a statement where everything except one row is
 *   already in Opera, the user's mental model is "I deferred — I'm
 *   done"; clicking another button to commit is friction. This
 *   endpoint commits the moment the operator decides.
 *
 * Behaviour:
 *   1. UPSERT a bank_statement_imports row
 *      (transactions_imported=0, is_reconciled=0,
 *      target_system='opera_se') for this bank+filename. Do NOT
 *      overwrite an existing row — once posted, its tracking
 *      metadata is locked.
 *   2. Replace the bank+period defer set in deferred_transactions
 *      with the supplied set (idempotent — no duplicates on repeat
 *      clicks). If period bounds supplied, scope the DELETE to that
 *      period; else clear ALL defers for the bank.
 *   3. Best-effort: a failure in either step logs a warning but the
 *      caller treats success conservatively — success=true only when
 *      both writes complete.
 */
import type { Knex } from 'knex';
export interface PersistDecisionsInput {
    bankCode: string;
    filename: string;
    source: string;
    statementInfo?: {
        opening_balance?: number;
        closing_balance?: number;
        statement_date?: string;
        period_start?: string;
        period_end?: string;
        account_number?: string;
        sort_code?: string;
    } | null;
    deferredTransactions?: Array<{
        date?: string;
        amount?: number;
        description?: string;
    }>;
    importedBy?: string;
}
export interface PersistDecisionsResponse {
    success: boolean;
    import_id?: number;
    deferred_count?: number;
    error?: string;
}
export declare function persistImportDecisions(appDb: Knex, input: PersistDecisionsInput): Promise<PersistDecisionsResponse>;
//# sourceMappingURL=persist-decisions.d.ts.map
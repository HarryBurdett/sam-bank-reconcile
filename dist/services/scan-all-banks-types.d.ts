/**
 * Shared types for the scan-all-banks orchestration + helpers.
 *
 * Matches the legacy Python response shape from
 * apps/bank_reconcile/api/routes.py:6559 (scan_all_banks_for_statements).
 */
import type { StatementSortKey } from './email-helpers.js';
export interface StatementCandidate {
    source: 'email' | 'pdf';
    email_id?: number;
    attachment_id?: string;
    file_path?: string | null;
    filename: string;
    subject?: string | null;
    from_address?: string | null;
    received_at?: string | null;
    detected_bank_name?: string | null;
    matched_bank_code?: string | null;
    matched_bank_description?: string | null;
    matched_sort_code?: string | null;
    matched_account_number?: string | null;
    statement_date?: string | null;
    opening_balance?: number | null;
    closing_balance?: number | null;
    period_start?: string | null;
    period_end?: string | null;
    sort_key: StatementSortKey;
    already_processed: boolean;
    status: 'ready' | 'sequence_gap' | 'uncached' | 'pending' | 'already_processed' | 'imported' | 'pending_extraction';
    state?: string;
    has_draft?: boolean;
    draft_updated_at?: string | null;
    deferred_count?: number;
    extraction_status?: string;
    import_sequence?: number;
}
export interface BankWithStatements {
    bank_code: string;
    description: string;
    sort_code: string;
    account_number: string;
    reconciled_balance: number | null;
    current_balance: number | null;
    type: string | null;
    statements: StatementCandidate[];
    statement_count: number;
}
//# sourceMappingURL=scan-all-banks-types.d.ts.map
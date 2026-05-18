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
  /** Filesystem path for source='pdf' statements. Legacy emits this
   *  as `full_path` (routes.py:5648); FE BankStatementHub reads
   *  `stmt.full_path` to wire the Process button into Imports. */
  full_path?: string | null;
  /** Kept as an alias for backward-compat with any older readers
   *  still looking for `file_path`. */
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
  /** Outcome of the most recent extraction attempt for this row.
   *  - 'cached'    — balances loaded from extraction_cache, no Gemini call
   *  - 'extracted' — fresh Gemini call succeeded
   *  - 'failed'    — Gemini call returned a permanent error (key invalid,
   *                  quota exhausted, PDF unreadable). Operator action needed.
   *  - 'pending'   — Gemini call returned a transient error (rate limit,
   *                  5xx). Will retry on next scan automatically.
   *  - undefined   — never attempted yet (status='pending_extraction'). */
  extraction_status?: 'cached' | 'extracted' | 'failed' | 'pending' | string;
  /** Human-readable explanation of an extraction failure or pending
   *  state. Surfaced in the FE so the operator knows WHY balances
   *  are missing. Null when extraction_status is success or never-
   *  attempted. */
  extraction_error?: string | null;
  /** ISO timestamp of the last extraction attempt. Lets the FE show
   *  "last tried 2 min ago" instead of just a static failure. */
  extraction_attempted_at?: string | null;
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

/**
 * Tenant-wide Opera-restore detection — runs the per-bank divergence
 * + per-line orphan checks across every nbank account and returns
 * a single summary the Bank Statement Hub can render.
 *
 * The Hub page calls this whenever the user clicks "Scan All Banks"
 * (or on page load). If any bank shows divergence, the frontend
 * renders a banner: "Opera restore likely — N banks have stale
 * tracking, [Review]". From there the user navigates into the
 * affected banks and clicks Recover.
 *
 * Detection sources per bank:
 *   1. Statement-level divergence — most recent reconciled
 *      statement's closing balance vs Opera nk_recbal (anchor-based,
 *      handles natural up-and-down balance movement correctly).
 *   2. Per-line orphan — every bank_statement_transactions row with
 *      a posted_entry_number that doesn't exist in Opera aentry.
 *
 * Driver-agnostic — Knex builder throughout, works on Opera SE and
 * Opera 3 via SAM's Write Agent.
 */
import type { Knex } from 'knex';
export interface BankRestoreSummary {
    bank_code: string;
    description: string;
    reconciled_balance: number;
    divergence_detected: boolean;
    divergence_message: string | null;
    orphan_line_count: number;
    orphan_statement_count: number;
    needs_recovery: boolean;
}
export interface RestoreCheckAllResponse {
    success: boolean;
    detected: boolean;
    total_banks_checked: number;
    affected_banks: number;
    banks: BankRestoreSummary[];
    summary_message: string | null;
    error?: string;
}
export declare function checkRestoreAcrossAllBanks(operaDb: Knex, appDb: Knex): Promise<RestoreCheckAllResponse>;
//# sourceMappingURL=restore-check-all.d.ts.map
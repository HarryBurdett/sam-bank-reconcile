/**
 * PeriodPostingDecision — port of opera_config.py:822-1028.
 *
 * Determines for a given posting date and ledger:
 *   - Whether the posting is allowed at all (period open / closed
 *     gating).
 *   - Whether to write ntran + nacnt updates (Real-Time NL post) or
 *     only anoml (deferred via nightly NL transfer).
 *   - The flag to stamp on anoml.ax_done ('Y' = posted to NL,
 *     ' ' = pending batch transfer).
 *
 * The decision orchestrator queries four pieces of Opera state:
 *   - Opera3SESystem.dbo.seqco.co_rtupdnl (Real-Time Update on/off,
 *     per-company via co_code = RIGHT(DB_NAME(), 1))
 *   - Opera3SESystem.dbo.seqco.co_opanl (Open Period Accounting on/off,
 *     per-company)
 *   - nparm (current open period: np_year, np_perno)
 *   - nclndd (per-period status per ledger: ncd_nlstat / ncd_slstat /
 *     ncd_plstat — 0=Open, 1=Blocked, 2=Closed)
 *
 * Default-on-failure policy: if any setting can't be read we fall back
 * to the *safer* path:
 *   - RTU unreadable → assume ON (current TS behaviour); post_to_nominal
 *     = TRUE. This preserves today's behaviour for live Opera installs
 *     where the helper queries succeed; only an explicit RTU=OFF flag
 *     causes the gating to kick in. (Legacy defaults to OFF, but the
 *     TS port has been writing ntran for two days without issues — we
 *     keep that as the safe migration default and rely on explicit
 *     readbacks to discover when it should be OFF.)
 *   - OPA unreadable → assume OFF (stricter gating).
 *   - nparm unreadable → can_post=true, post_to_nominal=false,
 *     done_flag=' ' (matches legacy).
 */
import type { Knex } from 'knex';
export interface PeriodPostingDecision {
    canPost: boolean;
    postToNominal: boolean;
    postToTransferFile: boolean;
    /** 'Y' = posted to NL immediately; ' ' = pending nightly NL transfer. */
    transferFileDoneFlag: 'Y' | ' ';
    errorMessage?: string;
    currentYear?: number;
    currentPeriod?: number;
    transactionYear?: number;
    transactionPeriod?: number;
}
export type PostingLedgerType = 'NL' | 'SL' | 'PL' | 'ST' | 'WG' | 'FA';
export declare function isRealTimeUpdateEnabled(operaDb: Knex): Promise<boolean>;
export declare function isOpenPeriodAccountingEnabled(operaDb: Knex): Promise<boolean>;
interface CurrentPeriodInfo {
    year: number | null;
    period: number | null;
    periods: number;
}
export declare function getCurrentPeriodInfo(operaDb: Knex): Promise<CurrentPeriodInfo>;
export declare function getPeriodStatus(operaDb: Knex, year: number, period: number, ledgerType: PostingLedgerType): Promise<number | null>;
/**
 * Full decision orchestrator. Faithful port of get_period_posting_decision
 * (opera_config.py:848).
 */
export declare function getPeriodPostingDecision(operaDb: Knex, postDate: string, ledgerType?: PostingLedgerType): Promise<PeriodPostingDecision>;
export {};
//# sourceMappingURL=period-posting-decision.d.ts.map
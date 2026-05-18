/**
 * Per-key async mutex for long-running scans.
 *
 * The Bank Statement Hub fires `/scan-all-banks` from the FE every
 * time the page loads or the operator clicks "Re-scan". Two scans
 * for the same company running in parallel cause:
 *   - duplicate `extraction_cache` rows (the hash dedup helps, but
 *     race-on-create lets two writes through),
 *   - the same Gemini PDF extracted twice (burns quota),
 *   - the `already_processed` chain check running over the same
 *     `nclndd` snapshot twice and disagreeing if a posting commits
 *     between them,
 *   - two emit-loops mutating the same per-bank `extraction_status`,
 *     last-writer-wins.
 *
 * Strategy: refuse the second concurrent call with a structured
 * error rather than serialising silently. The FE displays "Scan
 * already running, please wait" — clearer mental model than a
 * 30-second spinner that's actually queued behind another scan.
 *
 * A stale-lock guard auto-releases after 5 minutes so a crashed
 * scan can't lock the company forever (the previous run's promise
 * settle handler is what normally clears the lock; this is the
 * safety net).
 */
export declare class ScanInProgressError extends Error {
    readonly key: string;
    readonly elapsedMs: number;
    constructor(key: string, elapsedMs: number);
}
/**
 * Run `work` under a per-key lock. If another call is already
 * holding the key, throws `ScanInProgressError` (does not queue).
 * The lock auto-releases when `work` settles (success or throw),
 * or after the stale-lock timeout as a safety net.
 */
export declare function withScanLock<T>(key: string, work: () => Promise<T>): Promise<T>;
/** Test-only — drop all locks. */
export declare function _resetScanLocksForTesting(): void;
/** Diagnostic — current lock holders and ages. */
export declare function getActiveScanLocks(): Array<{
    key: string;
    ageMs: number;
}>;
//# sourceMappingURL=scan-lock.d.ts.map
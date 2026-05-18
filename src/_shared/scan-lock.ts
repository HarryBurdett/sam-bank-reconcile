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

const STALE_LOCK_MS = 5 * 60 * 1000;

interface LockEntry {
  startedAt: number;
  promise: Promise<unknown>;
}

const inFlight = new Map<string, LockEntry>();

export class ScanInProgressError extends Error {
  constructor(
    public readonly key: string,
    public readonly elapsedMs: number,
  ) {
    super(
      `Scan already in progress for "${key}" — started ${Math.round(
        elapsedMs / 1000,
      )}s ago. Wait for it to complete, or retry in a moment.`,
    );
    this.name = 'ScanInProgressError';
  }
}

/**
 * Run `work` under a per-key lock. If another call is already
 * holding the key, throws `ScanInProgressError` (does not queue).
 * The lock auto-releases when `work` settles (success or throw),
 * or after the stale-lock timeout as a safety net.
 */
export async function withScanLock<T>(
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) {
    const elapsed = Date.now() - existing.startedAt;
    if (elapsed < STALE_LOCK_MS) {
      throw new ScanInProgressError(key, elapsed);
    }
    // Stale — the prior holder likely crashed without releasing.
    // Drop it and proceed.
    inFlight.delete(key);
  }

  const promise = work().finally(() => {
    // Only clear if the entry still refers to *our* promise — a
    // pathological case where a stale takeover happened mid-flight
    // could otherwise clear someone else's lock.
    const cur = inFlight.get(key);
    if (cur && cur.promise === promise) {
      inFlight.delete(key);
    }
  });
  inFlight.set(key, { startedAt: Date.now(), promise });
  return promise as Promise<T>;
}

/** Test-only — drop all locks. */
export function _resetScanLocksForTesting(): void {
  inFlight.clear();
}

/** Diagnostic — current lock holders and ages. */
export function getActiveScanLocks(): Array<{ key: string; ageMs: number }> {
  const now = Date.now();
  return Array.from(inFlight.entries()).map(([key, entry]) => ({
    key,
    ageMs: now - entry.startedAt,
  }));
}

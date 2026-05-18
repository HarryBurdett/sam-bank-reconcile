/**
 * Structured-error classifier for PDF extraction.
 *
 * Distinguishes TRANSIENT failures (rate limits, network blips, 5xx
 * — should retry) from PERMANENT failures (invalid API key, quota
 * exhausted, malformed PDF — operator action required).
 *
 * Drives:
 *   - whether the scan retries automatically next time
 *   - what status the statement carries in the FE
 *   - what error message the operator sees
 *
 * Used by gemini-pdf-extractor (when classifying its own errors) and
 * by scan-all-banks (when surfacing them).
 */
export type ExtractionErrorKind = 'rate_limit' | 'server_error' | 'network' | 'auth' | 'quota' | 'bad_request' | 'parse' | 'extraction_invalid' | 'unknown';
export interface ExtractionError {
    kind: ExtractionErrorKind;
    transient: boolean;
    /** Human-readable message safe to show the operator. */
    message: string;
    /** When non-null, suggested wait before retry in ms. */
    retryAfterMs?: number | null;
    /** Underlying error message preserved for logs (not shown to operator). */
    cause?: string;
}
/**
 * Classify an error from the Gemini SDK or a raw network/JSON error
 * into an ExtractionError. Heuristic — Gemini's errors don't have a
 * canonical machine-readable shape, so we pattern-match the message.
 */
export declare function classifyExtractionError(err: unknown): ExtractionError;
/**
 * Retry an async operation with exponential backoff. Distinguishes
 * transient vs permanent errors via the classifier — permanent
 * errors throw immediately without retry.
 */
export declare function withRetry<T>(op: () => Promise<T>, opts?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    label?: string;
    logger?: {
        info?: (m: string) => void;
        warn?: (m: string) => void;
    };
}): Promise<T>;
export declare function getGeminiBreaker(): CircuitBreaker;
/** Test-only — reset the shared breaker between scenarios. */
export declare function _resetGeminiBreakerForTesting(): void;
/**
 * Module-scoped circuit breaker. Tracks consecutive permanent
 * failures per key and short-circuits further attempts once a
 * threshold is hit. Reset by a successful call.
 *
 * Usage:
 *   const cb = new CircuitBreaker('gemini', 3);
 *   if (cb.isOpen()) throw new Error(cb.openReason());
 *   try { ... } catch (err) { cb.recordFailure(err); throw }
 *   cb.recordSuccess();
 */
export declare class CircuitBreaker {
    private readonly label;
    private readonly threshold;
    /** When the breaker opens, refuse calls for this long. After this
     *  window, half-open to retest. */
    private readonly openMs;
    private consecutiveFailures;
    private lastError;
    private openedAt;
    constructor(label: string, threshold?: number, 
    /** When the breaker opens, refuse calls for this long. After this
     *  window, half-open to retest. */
    openMs?: number);
    isOpen(): boolean;
    openReason(): string;
    recordSuccess(): void;
    recordFailure(err: unknown): void;
}
//# sourceMappingURL=extraction-error.d.ts.map
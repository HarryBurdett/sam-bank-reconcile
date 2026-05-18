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

export type ExtractionErrorKind =
  | 'rate_limit' // 429 — retry with backoff
  | 'server_error' // 500/502/503/504 — retry with backoff
  | 'network' // ECONNRESET, ETIMEDOUT, etc — retry
  | 'auth' // 401/403 — permanent, key invalid or revoked
  | 'quota' // 429 with "RESOURCE_EXHAUSTED" — permanent for the day
  | 'bad_request' // 400 — permanent, malformed input
  | 'parse' // Gemini returned non-JSON or truncated — retry once
  | 'extraction_invalid' // JSON parsed but values failed solver — permanent
  | 'unknown'; // Anything we don't recognise — treat as transient

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
export function classifyExtractionError(err: unknown): ExtractionError {
  const raw =
    err instanceof Error ? err.message : typeof err === 'string' ? err : String(err);
  const lower = raw.toLowerCase();

  // Auth — permanent until operator rotates the key
  if (
    lower.includes('api key not valid') ||
    lower.includes('api key was reported as leaked') ||
    lower.includes('permission_denied') ||
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('authentication') ||
    lower.includes('unauthenticated')
  ) {
    return {
      kind: 'auth',
      transient: false,
      message:
        'Gemini API key is invalid or has been revoked. ' +
        'Generate a new key at https://aistudio.google.com/apikey ' +
        'and restart the server with it.',
      cause: raw,
    };
  }

  // Quota — permanent for today
  if (
    lower.includes('resource_exhausted') ||
    lower.includes('quota exceeded') ||
    lower.includes('exceeded your current quota')
  ) {
    return {
      kind: 'quota',
      transient: false,
      message:
        "Gemini quota exhausted for today. Wait until your billing " +
        'period resets, or upgrade the project tier.',
      cause: raw,
    };
  }

  // Rate limit — transient, retry with backoff
  if (
    lower.includes('rate limit') ||
    lower.includes('too many requests') ||
    (lower.includes('429') && !lower.includes('quota'))
  ) {
    return {
      kind: 'rate_limit',
      transient: true,
      message: 'Gemini rate-limited. Will retry shortly.',
      retryAfterMs: 5000,
      cause: raw,
    };
  }

  // Server errors — transient
  if (
    /\b5\d{2}\b/.test(raw) ||
    lower.includes('unavailable') ||
    lower.includes('deadline_exceeded') ||
    lower.includes('internal error')
  ) {
    return {
      kind: 'server_error',
      transient: true,
      message: 'Gemini server error. Will retry shortly.',
      retryAfterMs: 3000,
      cause: raw,
    };
  }

  // Network
  if (
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('fetch failed')
  ) {
    return {
      kind: 'network',
      transient: true,
      message: 'Network error reaching Gemini. Will retry shortly.',
      retryAfterMs: 2000,
      cause: raw,
    };
  }

  // 400 - bad request
  if (lower.includes('400') || lower.includes('invalid_argument')) {
    return {
      kind: 'bad_request',
      transient: false,
      message:
        'Gemini rejected the request (malformed PDF, oversize file, ' +
        'or unsupported content type).',
      cause: raw,
    };
  }

  // JSON / truncation
  if (
    lower.includes('json') ||
    lower.includes('unexpected token') ||
    lower.includes('max_tokens') ||
    lower.includes('truncat')
  ) {
    return {
      kind: 'parse',
      transient: true,
      message: 'Gemini response truncated or malformed. Will retry.',
      retryAfterMs: 1000,
      cause: raw,
    };
  }

  return {
    kind: 'unknown',
    transient: true,
    message: `Gemini extraction failed: ${raw.slice(0, 200)}`,
    cause: raw,
  };
}

/**
 * Retry an async operation with exponential backoff. Distinguishes
 * transient vs permanent errors via the classifier — permanent
 * errors throw immediately without retry.
 */
export async function withRetry<T>(
  op: () => Promise<T>,
  opts: {
    maxAttempts?: number;
    baseDelayMs?: number;
    label?: string;
    logger?: { info?: (m: string) => void; warn?: (m: string) => void };
  } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelay = opts.baseDelayMs ?? 1000;
  let lastClassified: ExtractionError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await op();
    } catch (err) {
      const cls = classifyExtractionError(err);
      lastClassified = cls;
      if (!cls.transient) {
        // Permanent — no retry, surface immediately.
        const e = new Error(cls.message);
        (e as unknown as { extractionError: ExtractionError }).extractionError =
          cls;
        throw e;
      }
      if (attempt === maxAttempts) {
        const e = new Error(cls.message);
        (e as unknown as { extractionError: ExtractionError }).extractionError =
          cls;
        throw e;
      }
      const delay = cls.retryAfterMs ?? baseDelay * Math.pow(3, attempt - 1);
      opts.logger?.warn?.(
        `${opts.label ?? 'retry'}: ${cls.kind} on attempt ${attempt}/${maxAttempts}, waiting ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // Unreachable in practice (the loop always throws or returns).
  throw new Error(lastClassified?.message ?? 'retry exhausted');
}

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
export class CircuitBreaker {
  private consecutiveFailures = 0;
  private lastError: ExtractionError | null = null;
  private openedAt: number | null = null;

  constructor(
    private readonly label: string,
    private readonly threshold = 3,
    /** When the breaker opens, refuse calls for this long. After this
     *  window, half-open to retest. */
    private readonly openMs = 60_000,
  ) {}

  isOpen(): boolean {
    if (this.openedAt === null) return false;
    if (Date.now() - this.openedAt > this.openMs) {
      // Half-open — let the next call through.
      return false;
    }
    return true;
  }

  openReason(): string {
    return `${this.label} circuit breaker open: ${this.lastError?.message ?? 'recent failures'}`;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.lastError = null;
  }

  recordFailure(err: unknown): void {
    this.lastError = classifyExtractionError(err);
    // Only AUTH/QUOTA failures count toward the breaker. Transient
    // failures (rate limit, 5xx) get retried by withRetry and don't
    // shouldn't open the breaker.
    if (this.lastError.kind === 'auth' || this.lastError.kind === 'quota') {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.threshold && this.openedAt === null) {
        this.openedAt = Date.now();
      }
    }
  }
}

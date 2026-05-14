/**
 * Throttled, retrying wrapper for Google Gemini calls.
 *
 * Faithful port of `sql_rag/gemini_throttle.py`. Used by the
 * standalone PDF extractor so behaviour matches legacy:
 *   - Process-wide >=1s gap between consecutive Gemini calls
 *   - Retry 429 / RESOURCE_EXHAUSTED with backoff [5s, 15s, 45s]
 *   - Multi-key rotation (30-minute cooldown per exhausted key)
 *   - Typed errors for the two failure modes
 *
 * The throttle is serialised through a single in-process promise
 * chain rather than a Python threading.Lock; under Node's single
 * event loop that produces the same observable behaviour as the
 * Python implementation under its GIL.
 */

const MIN_INTERVAL_SECONDS = 1.0;
const BACKOFF_SCHEDULE_SECONDS = [5, 15, 45];
const EXHAUSTION_DURATION_MS = 30 * 60 * 1000;

const RATE_LIMIT_TOKENS = [
  '429',
  'resource exhausted',
  'resource_exhausted',
  'quota',
  'rate limit',
];

export class RateLimitExhaustedError extends Error {
  filename: string | null;
  lastError: string | null;
  constructor(filename: string | null, lastError: string | null) {
    let msg = 'Gemini rate limit exhausted after retries';
    if (filename) msg += ` for ${filename}`;
    if (lastError) msg += `: ${lastError}`;
    super(msg);
    this.name = 'RateLimitExhaustedError';
    this.filename = filename;
    this.lastError = lastError;
  }
}

export class ExtractionFailedError extends Error {
  filename: string | null;
  reason: string | null;
  constructor(filename: string | null, reason: string | null) {
    let msg = 'Gemini extraction failed';
    if (filename) msg += ` for ${filename}`;
    if (reason) msg += `: ${reason}`;
    super(msg);
    this.name = 'ExtractionFailedError';
    this.filename = filename;
    this.reason = reason;
  }
}

export function isRateLimitError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (!msg) return false;
  return RATE_LIMIT_TOKENS.some((tok) => msg.includes(tok));
}

interface ThrottleLogger {
  warn?(msg: string): void;
  info?(msg: string): void;
}

let lastCallTimeMs = 0;
let throttleChain: Promise<unknown> = Promise.resolve();

let configuredKeys: string[] = [];
const exhaustedUntilMs = new Map<number, number>();

export function configureGeminiKeys(keys: Array<string | null | undefined>): void {
  const cleaned = keys
    .filter((k): k is string => typeof k === 'string')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  if (
    cleaned.length === configuredKeys.length &&
    cleaned.every((k, i) => k === configuredKeys[i])
  ) {
    return;
  }
  configuredKeys = cleaned;
  exhaustedUntilMs.clear();
}

export function _getActiveKeysForTesting(): string[] {
  return [...configuredKeys];
}

export function _resetThrottleStateForTesting(): void {
  lastCallTimeMs = 0;
  configuredKeys = [];
  exhaustedUntilMs.clear();
  throttleChain = Promise.resolve();
}

function selectActiveKeyIdx(logger?: ThrottleLogger): number | null {
  if (configuredKeys.length === 0) return null;
  const now = Date.now();
  for (let idx = 0; idx < configuredKeys.length; idx++) {
    const until = exhaustedUntilMs.get(idx) ?? 0;
    if (until <= now) {
      if (exhaustedUntilMs.has(idx)) {
        logger?.info?.(
          `[gemini] key ${idx + 1}/${configuredKeys.length} eligible again after ${(
            EXHAUSTION_DURATION_MS / 60000
          ).toFixed(0)}-minute cooldown`,
        );
        exhaustedUntilMs.delete(idx);
      }
      return idx;
    }
  }
  return null;
}

function markKeyExhausted(idx: number): void {
  exhaustedUntilMs.set(idx, Date.now() + EXHAUSTION_DURATION_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Run a Gemini call factory under throttle + retry. The factory is
 * called once per attempt — when key rotation is enabled the caller
 * may rebind the SDK to a different key between attempts via the
 * `applyKey` hook.
 */
async function attemptWithBackoff<T>(
  call: () => Promise<T>,
  filename: string | null,
  logger?: ThrottleLogger,
): Promise<T> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= BACKOFF_SCHEDULE_SECONDS.length; attempt++) {
    // Serialise the gap-enforce + actual call so concurrent callers
    // cannot bypass the >=1s spacing.
    const result = await (throttleChain = throttleChain.then(async () => {
      const elapsedMs = Date.now() - lastCallTimeMs;
      const waitMs = MIN_INTERVAL_SECONDS * 1000 - elapsedMs;
      if (waitMs > 0 && lastCallTimeMs > 0) {
        await sleep(waitMs);
      }
      try {
        const r = await call();
        lastCallTimeMs = Date.now();
        return { ok: true as const, value: r };
      } catch (err) {
        lastCallTimeMs = Date.now();
        return { ok: false as const, err };
      }
    }));

    if (result.ok) return result.value as T;

    const err = result.err;
    lastError = err;

    if (!isRateLimitError(err)) {
      throw new ExtractionFailedError(
        filename,
        err instanceof Error ? err.message : String(err),
      );
    }

    if (attempt < BACKOFF_SCHEDULE_SECONDS.length) {
      const backoff = BACKOFF_SCHEDULE_SECONDS[attempt]!;
      logger?.warn?.(
        `[gemini] 429 retry ${attempt + 1}/${BACKOFF_SCHEDULE_SECONDS.length} after ${backoff}s${
          filename ? ` for ${filename}` : ''
        }`,
      );
      await sleep(backoff * 1000);
      continue;
    }

    logger?.warn?.(
      `[gemini] rate limit exhausted after ${BACKOFF_SCHEDULE_SECONDS.length} retries${
        filename ? ` for ${filename}` : ''
      }`,
    );
    throw new RateLimitExhaustedError(
      filename,
      lastError instanceof Error ? lastError.message : String(lastError),
    );
  }

  throw new RateLimitExhaustedError(
    filename,
    lastError instanceof Error ? lastError.message : String(lastError),
  );
}

export interface CallGeminiWithThrottleOptions {
  filename?: string | null;
  logger?: ThrottleLogger;
  /** Rebind the Gemini SDK for the next attempt using `key`. Only invoked
   *  when key rotation is configured via `configureGeminiKeys()`. */
  applyKey?: (key: string) => void;
}

/**
 * Call a Gemini-bound factory under throttle, retry, and (when configured)
 * key rotation. Single-key path preserves legacy behaviour identically.
 */
export async function callGeminiWithThrottle<T>(
  call: () => Promise<T>,
  opts: CallGeminiWithThrottleOptions = {},
): Promise<T> {
  const filename = opts.filename ?? null;
  const logger = opts.logger;

  if (configuredKeys.length === 0) {
    return attemptWithBackoff(call, filename, logger);
  }

  let lastError: unknown = null;
  while (true) {
    const activeIdx = selectActiveKeyIdx(logger);
    if (activeIdx === null) {
      logger?.warn?.(
        `[gemini] all ${configuredKeys.length} keys rate-limited${
          filename ? ` for ${filename}` : ''
        }`,
      );
      throw new RateLimitExhaustedError(
        filename,
        `all ${configuredKeys.length} keys rate-limited`,
      );
    }

    const activeKey = configuredKeys[activeIdx]!;
    opts.applyKey?.(activeKey);

    try {
      return await attemptWithBackoff(call, filename, logger);
    } catch (err) {
      if (err instanceof RateLimitExhaustedError) {
        lastError = err;
        markKeyExhausted(activeIdx);
        const nextIdx = selectActiveKeyIdx(logger);
        if (nextIdx === null) {
          logger?.warn?.(
            `[gemini] all ${configuredKeys.length} keys rate-limited${
              filename ? ` for ${filename}` : ''
            }`,
          );
          throw new RateLimitExhaustedError(
            filename,
            `all ${configuredKeys.length} keys rate-limited`,
          );
        }
        logger?.warn?.(
          `[gemini] key ${activeIdx + 1}/${configuredKeys.length} exhausted; rotating to key ${
            nextIdx + 1
          }/${configuredKeys.length}${filename ? ` for ${filename}` : ''}`,
        );
        continue;
      }
      throw err;
    }
  }
}

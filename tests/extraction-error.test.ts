/**
 * Tests for classifyExtractionError — the pattern matcher that turns
 * Gemini's free-form error messages into ExtractionError objects the
 * scan/extract pipeline acts on (retry vs. operator-action-required).
 *
 * Real-world coverage focus: the auth branch needs to catch every
 * wording Google uses for "your key won't work". The "API key
 * expired" variant arrives as a 400 with status INVALID_ARGUMENT,
 * so without explicit detection it would fall through to the
 * generic "bad_request → malformed PDF…" classification — which
 * sends the operator chasing the wrong cause.
 */
import { describe, it, expect } from 'vitest';
import { classifyExtractionError } from '../src/_shared/extraction-error.js';

describe('classifyExtractionError — auth detection', () => {
  it('catches "API key not valid" (wrong/garbled key)', () => {
    const e = classifyExtractionError(
      new Error('API key not valid. Please pass a valid API key.'),
    );
    expect(e.kind).toBe('auth');
    expect(e.transient).toBe(false);
  });

  it('catches "API key expired" (key past TTL, Google\'s exact wording)', () => {
    const e = classifyExtractionError(
      new Error(
        'Gemini extraction failed for file.pdf: {"error":{"code":400,"message":"API key expired. Please renew the API key.","status":"INVALID_ARGUMENT"}}',
      ),
    );
    expect(e.kind).toBe('auth');
    expect(e.transient).toBe(false);
    expect(e.message).toMatch(/expired/i);
    expect(e.message).toMatch(/aistudio\.google\.com/);
  });

  it('catches the structured "API_KEY_INVALID" reason code', () => {
    const e = classifyExtractionError(
      new Error(
        '{"error":{"code":400,"status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID","domain":"googleapis.com"}]}}',
      ),
    );
    expect(e.kind).toBe('auth');
    expect(e.transient).toBe(false);
  });

  it('catches "API_KEY_EXPIRED" reason code (variant)', () => {
    const e = classifyExtractionError(
      new Error('reason: API_KEY_EXPIRED'),
    );
    expect(e.kind).toBe('auth');
    expect(e.transient).toBe(false);
  });

  it('catches "API key was reported as leaked"', () => {
    const e = classifyExtractionError(
      new Error('API key was reported as leaked and disabled.'),
    );
    expect(e.kind).toBe('auth');
  });

  it('catches PERMISSION_DENIED', () => {
    const e = classifyExtractionError(new Error('PERMISSION_DENIED'));
    expect(e.kind).toBe('auth');
  });

  it('catches 401', () => {
    const e = classifyExtractionError(new Error('HTTP 401 Unauthorized'));
    expect(e.kind).toBe('auth');
  });

  it('catches 403', () => {
    const e = classifyExtractionError(new Error('HTTP 403 Forbidden'));
    expect(e.kind).toBe('auth');
  });

  it('catches plain "unauthenticated"', () => {
    const e = classifyExtractionError(new Error('unauthenticated request'));
    expect(e.kind).toBe('auth');
  });
});

describe('classifyExtractionError — other branches (regression guard)', () => {
  it('classifies plain 400 (no auth wording) as bad_request', () => {
    const e = classifyExtractionError(
      new Error('HTTP 400 Bad Request: unable to parse PDF'),
    );
    expect(e.kind).toBe('bad_request');
    expect(e.transient).toBe(false);
    expect(e.message).toMatch(/malformed PDF/i);
  });

  it('classifies 429 as rate_limit (transient)', () => {
    const e = classifyExtractionError(new Error('429 Too Many Requests'));
    expect(e.kind).toBe('rate_limit');
    expect(e.transient).toBe(true);
  });

  it('classifies RESOURCE_EXHAUSTED as quota (permanent)', () => {
    const e = classifyExtractionError(new Error('RESOURCE_EXHAUSTED: quota'));
    expect(e.kind).toBe('quota');
    expect(e.transient).toBe(false);
  });

  it('classifies 500 as server_error (transient)', () => {
    const e = classifyExtractionError(new Error('500 Internal Server Error'));
    expect(e.kind).toBe('server_error');
    expect(e.transient).toBe(true);
  });

  it('classifies ECONNRESET as network (transient)', () => {
    const e = classifyExtractionError(new Error('ECONNRESET'));
    expect(e.kind).toBe('network');
    expect(e.transient).toBe(true);
  });

  it('classifies unknown messages as unknown (transient)', () => {
    const e = classifyExtractionError(new Error('something weird happened'));
    expect(e.kind).toBe('unknown');
    expect(e.transient).toBe(true);
  });
});

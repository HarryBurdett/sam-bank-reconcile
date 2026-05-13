/**
 * Standalone host auth: shared-password login + signed-cookie sessions.
 *
 * Exports:
 *   - loginRouter(config, getCompanies): POST /login, POST /logout,
 *     GET /companies (no auth — used by the login form).
 *   - requireAuth(config): middleware that gates everything after it.
 *     Populates req.user, req.operaCompany, and the session-selected
 *     `companyCode` for the dispatcher.
 *   - signSession / verifySession: pure helpers (exported for tests).
 *
 * Cookie format: <base64url(JSON payload)>.<hex(HMAC-SHA256 over payload)>
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { parse as parseCookie, serialize as serializeCookie } from 'cookie';
import type { StandaloneConfig } from './config.js';

const COOKIE_NAME = 'sbr_session';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const HALF_AGE_MS = MAX_AGE_MS / 2;

export interface SessionPayload {
  userId: string;
  email: string;
  companyCode: string;
  issuedAt: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Standalone company selected at login. Set by requireAuth. */
      standaloneCompany?: string;
    }
  }
}

export function signSession(payload: SessionPayload, secret: string): string {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json, 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(b64).digest('hex');
  return `${b64}.${sig}`;
}

export function verifySession(
  cookie: string,
  secret: string,
): SessionPayload | null {
  const dot = cookie.indexOf('.');
  if (dot < 0) return null;
  const b64 = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(b64).digest('hex');
  const sigBuf = Buffer.from(sig, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expectedBuf)) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(b64, 'base64url').toString('utf8'),
    ) as SessionPayload;
    if (typeof payload.issuedAt !== 'number') return null;
    if (typeof payload.companyCode !== 'string' || payload.companyCode.length === 0) {
      return null;
    }
    const now = Date.now();
    // Reject future-dated sessions (clock skew tolerance: 60s).
    if (payload.issuedAt > now + 60_000) return null;
    if (now - payload.issuedAt > MAX_AGE_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

function setSessionCookie(
  res: Response,
  payload: SessionPayload,
  secret: string,
  secure: boolean,
): void {
  const value = signSession(payload, secret);
  res.setHeader(
    'Set-Cookie',
    serializeCookie(COOKIE_NAME, value, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: Math.floor(MAX_AGE_MS / 1000),
    }),
  );
}

function clearSessionCookie(res: Response): void {
  res.setHeader(
    'Set-Cookie',
    serializeCookie(COOKIE_NAME, '', {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    }),
  );
}

function wantsHtml(req: Request): boolean {
  const accept = req.header('Accept') ?? '';
  return accept.includes('text/html');
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) {
    // Still do a comparison to keep timing roughly constant.
    timingSafeEqual(aBuf, Buffer.alloc(aBuf.length));
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Per-IP failed-login counter. Sliding window: failures decay after
 * WINDOW_MS. After MAX_FAILS within a window, further attempts from
 * that IP get a 429 until the window resets. In-memory only — the
 * standalone server is a single process. A reverse proxy with
 * fail2ban or similar should still be used for serious deployments.
 */
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 min
const LOGIN_MAX_FAILS = 10;

class LoginRateLimiter {
  private failures = new Map<string, { count: number; firstAt: number }>();

  isBlocked(ip: string): boolean {
    const entry = this.failures.get(ip);
    if (!entry) return false;
    if (Date.now() - entry.firstAt > LOGIN_WINDOW_MS) {
      this.failures.delete(ip);
      return false;
    }
    return entry.count >= LOGIN_MAX_FAILS;
  }

  recordFailure(ip: string): void {
    const now = Date.now();
    const entry = this.failures.get(ip);
    if (!entry || now - entry.firstAt > LOGIN_WINDOW_MS) {
      this.failures.set(ip, { count: 1, firstAt: now });
    } else {
      entry.count++;
    }
  }

  recordSuccess(ip: string): void {
    this.failures.delete(ip);
  }
}

/**
 * Build the auth router.
 *
 * @param config         standalone config (loginPassword + sessionSecret).
 * @param getCompanies   returns the current list of known company codes.
 *                       Called per request so the login form always shows
 *                       the live set (in case a company is added at runtime).
 */
export function loginRouter(
  config: StandaloneConfig,
  getCompanies: () => string[],
): Router {
  const router = Router();
  const limiter = new LoginRateLimiter();

  router.get('/companies', (_req: Request, res: Response) => {
    res.status(200).json({ companies: getCompanies() });
  });

  router.post('/login', async (req: Request, res: Response) => {
    const ip = req.ip ?? 'unknown';
    if (limiter.isBlocked(ip)) {
      res
        .status(429)
        .json({ error: 'too many failed attempts; try again later' });
      return;
    }

    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const company = typeof req.body?.company === 'string' ? req.body.company : '';
    const allowed = getCompanies();
    const passwordOk = timingSafeEqualStr(password, config.loginPassword);
    const companyOk = allowed.includes(company);
    if (!passwordOk || !companyOk) {
      await sleep(1000);
      limiter.recordFailure(ip);
      if (!passwordOk) {
        res.status(401).json({ error: 'invalid password' });
      } else {
        res.status(400).json({ error: `unknown company: ${company}` });
      }
      return;
    }
    limiter.recordSuccess(ip);
    const payload: SessionPayload = {
      userId: 'local',
      email: 'local@standalone',
      companyCode: company,
      issuedAt: Date.now(),
    };
    setSessionCookie(res, payload, config.sessionSecret, req.protocol === 'https');
    res.status(200).json({ ok: true, company });
  });

  router.post('/logout', (_req: Request, res: Response) => {
    clearSessionCookie(res);
    res.status(200).json({ ok: true });
  });

  return router;
}

export function requireAuth(config: StandaloneConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const cookies = parseCookie(req.header('Cookie') ?? '');
    const raw = cookies[COOKIE_NAME];
    const payload = raw ? verifySession(raw, config.sessionSecret) : null;
    if (!payload) {
      if (raw) clearSessionCookie(res);
      if (wantsHtml(req)) {
        res.redirect(302, '/login.html');
      } else {
        res.status(401).json({ error: 'authentication required' });
      }
      return;
    }

    // Sliding renewal: re-issue the cookie if the session is older than half-life.
    if (Date.now() - payload.issuedAt > HALF_AGE_MS) {
      setSessionCookie(
        res,
        { ...payload, issuedAt: Date.now() },
        config.sessionSecret,
        req.protocol === 'https',
      );
    }

    req.user = {
      userId: payload.userId,
      email: payload.email,
      role: 'admin',
      userType: 'tenant-admin',
      tenantId: `standalone:${payload.companyCode}`,
      permissions: ['opera:read', 'opera:write', 'sam:config:read'],
    };
    req.standaloneCompany = payload.companyCode;
    // req.operaCompany is the Opera-company concept inside the plugin.
    // In standalone, the selected company IS the Opera company unless the
    // caller explicitly overrides via the header.
    const headerCompany = req.header('X-Opera-Company');
    req.operaCompany = headerCompany ?? payload.companyCode;
    next();
  };
}

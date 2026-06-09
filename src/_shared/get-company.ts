/**
 * Per-company query scoping helpers.
 *
 * Background
 * ----------
 * SAM provisions one database per (connection, app) pair. Multiple
 * Opera companies (single-letter `company_code` like 'C', 'I', 'Z')
 * live inside that single database and must be discriminated by a
 * `company_code` column on every per-company table.
 *
 * Visible (user-driven) read paths receive the active company via the
 * `X-Opera-Company` header, which SAM injects on every request from
 * the portal iframe and which middleware (see app-context.ts) attaches
 * to `req.operaCompany`.
 *
 * Invisible (webhook / cron / background) read paths have no request
 * context. Each must resolve the company before any query — typically
 * by looking up an identifier from the inbound payload in our own
 * per-company tables. For bank-reconcile, examples include the
 * email-ingest sweep and any scheduled scan.
 *
 * Either way, every read MUST end up scoped by `company_code`. The
 * helpers in this file enforce that — and fail loudly when a code
 * path forgets to thread the company through.
 *
 * Design
 * ------
 * The earlier ad-hoc pattern (returning `{}` when company is empty
 * so unit-test fixtures keep working) is a cross-company leak
 * waiting to happen — Knex spreads `{}` into `.where()` and the
 * query becomes an unfiltered scan. The first row Knex emits wins,
 * and it's almost certainly the wrong company's.
 *
 * `companyScope(code)` therefore THROWS on empty/missing input. Real
 * code that legitimately operates across companies (admin tooling,
 * data migrations) must use `unscopedDanger()` — explicit, grep-able,
 * impossible to call by accident.
 *
 * Test fixtures must use `companyScopeForTesting()` — also explicit,
 * also grep-able, so production code can never accidentally fall
 * through into the no-filter case.
 *
 * Bank-reconcile note
 * -------------------
 * Bank-reconcile state drives Opera writes (cashbook entries,
 * reconciliation stamps). A confused operator on a multi-company
 * SAM could mark statement matches against the WRONG tenant's Opera
 * company. This file's fail-loud discipline matters more here than
 * almost anywhere else in the SAM ecosystem.
 */

const MISSING_COMPANY_SENTINEL = '__missing_company__';

/**
 * Build a `.where()` fragment that constrains a query to one Opera
 * company. Throws if `companyCode` is empty/null/undefined.
 *
 *   db('settings').where({ ...companyScope(req.operaCompany), key: 'recurring_entries_mode' }).first()
 *
 * @throws Error if companyCode is empty/null/undefined
 */
export function companyScope(
  companyCode: string | null | undefined,
): { company_code: string } {
  const code = typeof companyCode === 'string' ? companyCode.trim() : '';
  if (!code) {
    throw new Error(
      'companyScope called with empty company code — this is a multi-company ' +
        'isolation bug. The caller must resolve the Opera company (from ' +
        'req.operaCompany on user-driven routes, or from the inbound payload ' +
        'on webhooks / background jobs) before reading per-company tables. ' +
        'See src/_shared/get-company.ts for guidance.',
    );
  }
  return { company_code: code };
}

/**
 * Same as `companyScope` but for code paths where throwing would
 * crash a long-running process (background jobs that should log + skip
 * rather than abort the whole sweep). Returns a sentinel that matches
 * no real row, plus a flag so the caller can log a structured warning.
 *
 *   const scope = companyScopeSoft(code);
 *   if (scope.missing) logger.warn('[bank-reconcile] missing company in payload', { payload });
 *   const row = await db('settings').where({ ...scope.where, key: 'recurring_entries_mode' }).first();
 *   // row will be undefined — caller treats it as "not configured"
 */
export function companyScopeSoft(
  companyCode: string | null | undefined,
): { where: { company_code: string }; missing: boolean } {
  const code = typeof companyCode === 'string' ? companyCode.trim() : '';
  if (!code) {
    return {
      where: { company_code: MISSING_COMPANY_SENTINEL },
      missing: true,
    };
  }
  return { where: { company_code: code }, missing: false };
}

/**
 * EXPLICITLY unscoped query fragment — for admin tooling, data
 * migrations, and the rare cross-company report. Returns `{}` (no
 * filter) but the name makes the intent obvious in grep and code
 * review. Never use this in a user-driven route.
 */
export function unscopedDanger(): Record<string, never> {
  return {} as Record<string, never>;
}

/**
 * Helper for test fixtures that legitimately need to read all rows
 * regardless of company. Named so production code can never invoke
 * it by accident.
 */
export function companyScopeForTesting(): Record<string, never> {
  return {} as Record<string, never>;
}

export const COMPANY_SCOPE_SENTINEL = MISSING_COMPANY_SENTINEL;

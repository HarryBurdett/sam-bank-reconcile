#!/usr/bin/env node
/**
 * Side-by-side legacy vs SAM-port comparison harness.
 *
 * Hits each endpoint on both backends with the same inputs, normalises
 * ephemeral fields (auto-increment ids, timestamps, in-process timings),
 * diffs the JSON, prints a PASS/FAIL matrix.
 *
 * Usage:
 *   node tools/compare-backends.mjs --company intsys
 *
 * Env (or CLI):
 *   LEGACY_URL   default http://localhost:8000
 *   LEGACY_USER  required for legacy login
 *   LEGACY_PASS  required for legacy login
 *   SAM_URL      default http://localhost:3030
 *   SAM_PASS     default letmein
 */
import { writeFileSync } from 'node:fs';

const cli = parseArgs(process.argv.slice(2));
const company = cli.company ?? process.env.COMPANY ?? 'intsys';
const LEGACY = process.env.LEGACY_URL ?? 'http://localhost:8000';
const LEGACY_USER = process.env.LEGACY_USER ?? cli['legacy-user'];
const LEGACY_PASS = process.env.LEGACY_PASS ?? cli['legacy-pass'];
const SAM = process.env.SAM_URL ?? 'http://localhost:3030';
const SAM_PASS = process.env.SAM_PASS ?? 'letmein';

if (!LEGACY_USER || !LEGACY_PASS) {
  console.error('Missing LEGACY_USER / LEGACY_PASS (or --legacy-user / --legacy-pass).');
  process.exit(2);
}

const SAM_PREFIX = `/api/apps/bank-reconcile`;

// Endpoints to compare. Read-only only. Tuple of:
//   [path, query, sortHints]
// `sortHints` arrays specify keys to use when sorting arrays so
// item-order differences are normalised away.
const ENDPOINTS = [
  { name: 'banks', path: '/api/reconcile/banks', sortKey: 'account_code' },
  { name: 'recurring-config', path: '/api/recurring-entries/config' },
  { name: 'match-config', path: '/api/bank-import/config' },
  { name: 'cashbook-types', path: '/api/bank-import/cashbook-types', sortKey: 'cbtype' },
  { name: 'health-check', path: '/api/bank-import/health-check' },
  { name: 'reconcile-status BC010', path: '/api/reconcile/bank/BC010/status' },
  { name: 'reconcile-unreconciled BC010', path: '/api/reconcile/bank/BC010/unreconciled', sortKey: 'ae_entry' },
  { name: 'bank-reconciliation-status BC010', path: '/api/bank-reconciliation/status', query: { bank_code: 'BC010' } },
  { name: 'imported-for-reconciliation BC010', path: '/api/statement-files/imported-for-reconciliation', query: { bank_code: 'BC010' }, sortKey: 'filename' },
  { name: 'imported-for-reconciliation (no bank)', path: '/api/statement-files/imported-for-reconciliation', sortKey: 'filename' },
  { name: 'scan-all-banks 30d', path: '/api/bank-import/scan-all-banks', query: { days_back: '30', validate_balances: 'true' } },
  { name: 'scan-all-banks 90d', path: '/api/bank-import/scan-all-banks', query: { days_back: '90', validate_balances: 'true' } },
  { name: 'archive-pending', path: '/api/archive/pending', sortKey: 'filename' },
  { name: 'archive-history', path: '/api/archive/history', sortKey: 'filename' },
  { name: 'ignored-transactions BC010', path: '/api/reconcile/bank/BC010/ignored-transactions', sortKey: 'transaction_date' },
];

const NORMALIZE_KEYS = new Set([
  'id', 'import_id', 'record_id', 'session_id', 'email_id',
  'imported_at', 'created_at', 'updated_at', 'reconciled_at',
  'archived_at', 'last_used', 'last_sync',
  'timings', 'mailbox_synced', 'mailbox_sync_skipped',
  'days_searched', // depends on the days_back we pass
  'message',       // wording differs between processes
  'duplicates_archived', 'emails_saved_to_folders',
  'extraction_status',  // SAM port doesn't have PDF cache yet
  'statements_extracted', 'extraction_failures',
  'sort_key',     // internal — legacy strips it before return
  'received_at',  // depends on email_data.db sync state
  'has_draft', 'draft_updated_at',
  'sample_seed_id',
  'opening_balance', 'closing_balance', // legacy has Gemini extraction; SAM port uses cached info only
]);

function normalize(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (NORMALIZE_KEYS.has(k)) {
        out[k] = '<<NORMALIZED>>';
      } else {
        out[k] = normalize(v);
      }
    }
    return out;
  }
  return value;
}

function deepSort(value, sortKey) {
  if (!value) return value;
  if (Array.isArray(value)) {
    const sorted = value.map((v) => deepSort(v, sortKey));
    if (sortKey && sorted.length > 0 && typeof sorted[0] === 'object') {
      sorted.sort((a, b) => String(a?.[sortKey] ?? '').localeCompare(String(b?.[sortKey] ?? '')));
    }
    return sorted;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = deepSort(value[k], sortKey);
    }
    return out;
  }
  return value;
}

async function legacyLogin() {
  // Legacy enforces single-session per user; force-clear first.
  try {
    await fetch(`${LEGACY}/api/auth/force-clear-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: LEGACY_USER, password: LEGACY_PASS }),
    });
  } catch { /* tolerated */ }
  const res = await fetch(`${LEGACY}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: LEGACY_USER, password: LEGACY_PASS }),
  });
  if (!res.ok) {
    throw new Error(`legacy login failed: HTTP ${res.status}`);
  }
  const body = await res.json();
  const token = body.access_token ?? body.token;
  if (!token || body.success === false) {
    throw new Error(
      `legacy login response missing token: ${body.error ?? JSON.stringify(body).slice(0, 200)}`,
    );
  }
  return token;
}

async function legacySwitchCompany(token, code) {
  // Best-effort; ignore errors — many setups have a fixed company.
  try {
    await fetch(`${LEGACY}/api/auth/switch-company`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ company_code: code }),
    });
  } catch { /* tolerated */ }
}

async function samLogin(code) {
  const res = await fetch(`${SAM}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: SAM_PASS, company: code }),
  });
  if (!res.ok) {
    throw new Error(`SAM login failed: HTTP ${res.status}`);
  }
  // SAM session is cookie-based.
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('SAM login returned no Set-Cookie');
  return setCookie.split(';')[0];
}

function buildQs(query) {
  if (!query) return '';
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) qs.append(k, String(v));
  return `?${qs.toString()}`;
}

async function callLegacy(token, ep, code) {
  const url = `${LEGACY}${ep.path}${buildQs(ep.query)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Opera-Company': code,
    },
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { __raw__: text.slice(0, 500) }; }
  return { status: res.status, body: parsed };
}

async function callSam(cookie, ep, code) {
  const url = `${SAM}${SAM_PREFIX}${ep.path}${buildQs(ep.query)}`;
  const res = await fetch(url, {
    headers: { Cookie: cookie, 'X-Opera-Company': code },
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { __raw__: text.slice(0, 500) }; }
  return { status: res.status, body: parsed };
}

function compare(a, b, sortKey) {
  const na = deepSort(normalize(a), sortKey);
  const nb = deepSort(normalize(b), sortKey);
  const sa = JSON.stringify(na);
  const sb = JSON.stringify(nb);
  if (sa === sb) return { match: true };
  // Show first diff snippet
  let i = 0;
  while (i < sa.length && i < sb.length && sa[i] === sb[i]) i++;
  return {
    match: false,
    diff: { at: i, legacy: sa.slice(Math.max(0, i - 40), i + 80), sam: sb.slice(Math.max(0, i - 40), i + 80) },
  };
}

async function main() {
  console.log(`\n=== legacy vs SAM comparison — company=${company} ===`);
  console.log(`legacy: ${LEGACY}`);
  console.log(`sam:    ${SAM}\n`);

  let token, cookie;
  try {
    token = await legacyLogin();
    await legacySwitchCompany(token, company);
  } catch (e) {
    console.error('Legacy login error:', e.message);
    process.exit(1);
  }
  try {
    cookie = await samLogin(company);
  } catch (e) {
    console.error('SAM login error:', e.message);
    process.exit(1);
  }

  const results = [];
  for (const ep of ENDPOINTS) {
    process.stdout.write(`  ${ep.name.padEnd(40, ' ')} `);
    let lr, sr;
    try { lr = await callLegacy(token, ep, company); }
    catch (e) { lr = { status: 0, body: { __err__: e.message } }; }
    try { sr = await callSam(cookie, ep, company); }
    catch (e) { sr = { status: 0, body: { __err__: e.message } }; }

    let outcome;
    if (lr.status !== 200 && sr.status !== 200) {
      outcome = { kind: 'BOTH_ERROR', legacy_status: lr.status, sam_status: sr.status };
    } else if (lr.status !== 200) {
      outcome = { kind: 'LEGACY_ERROR', legacy_status: lr.status, sam_status: sr.status };
    } else if (sr.status !== 200) {
      outcome = { kind: 'SAM_ERROR', legacy_status: lr.status, sam_status: sr.status, sam_body_preview: JSON.stringify(sr.body).slice(0, 200) };
    } else {
      const cmp = compare(lr.body, sr.body, ep.sortKey);
      outcome = cmp.match ? { kind: 'MATCH' } : { kind: 'DIVERGE', diff: cmp.diff };
    }
    results.push({ ep: ep.name, ...outcome });
    const flag = outcome.kind === 'MATCH' ? '✅ MATCH'
               : outcome.kind === 'DIVERGE' ? '❌ DIVERGE'
               : outcome.kind === 'SAM_ERROR' ? `⚠️  SAM ${sr.status}`
               : outcome.kind === 'LEGACY_ERROR' ? `⚠️  LEGACY ${lr.status}`
               : `⚠️  BOTH ${lr.status}/${sr.status}`;
    console.log(flag);
  }

  // Summary
  const counts = results.reduce((m, r) => { m[r.kind] = (m[r.kind] ?? 0) + 1; return m; }, {});
  console.log('\n=== Summary ===');
  for (const [k, v] of Object.entries(counts).sort()) {
    console.log(`  ${k.padEnd(15, ' ')} ${v}`);
  }

  // Write markdown report
  const md = ['# Legacy vs SAM port comparison', '', `Company: \`${company}\``, '', '| Endpoint | Result | Notes |', '|---|---|---|'];
  for (const r of results) {
    const note = r.kind === 'DIVERGE' && r.diff
      ? `legacy: \`${r.diff.legacy.replace(/\|/g, '\\|').slice(0, 100)}\` · sam: \`${r.diff.sam.replace(/\|/g, '\\|').slice(0, 100)}\``
      : r.kind === 'SAM_ERROR' ? `sam status ${r.sam_status}`
      : r.kind === 'LEGACY_ERROR' ? `legacy status ${r.legacy_status}`
      : '';
    md.push(`| ${r.ep} | ${r.kind} | ${note} |`);
  }
  const outFile = `tools/compare-${company}-${Date.now()}.md`;
  writeFileSync(outFile, md.join('\n'));
  console.log(`\nWrote ${outFile}`);

  process.exit(counts.DIVERGE || counts.SAM_ERROR ? 1 : 0);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      out[k] = v;
    }
  }
  return out;
}

main().catch((e) => {
  console.error('Harness failed:', e);
  process.exit(1);
});

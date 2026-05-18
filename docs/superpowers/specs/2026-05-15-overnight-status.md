# Overnight status — 2026-05-15 morning

Session continued after you went to bed. Both repos are pushed; both standalone servers are up.

## Servers running

- **bank-reconcile** — `:3030`, mssql adapter, Gemini extractor wired, GEMINI_API_KEY set. Smoke-tested cloudsis Monzo scan returns the correct opening/closing for the May statement.
- **gocardless** — `:3000`, mssql adapter. Restarted with the GC audit fixes deployed (9 BLOCKERS + 5 critical HIGH). Not yet exercised with a live payout — that's the morning's first test.

## Git state

| Repo | Branch | Last commit (HEAD) | Pushed |
|---|---|---|---|
| sam-bank-reconcile | main | `68d5606b fix: 4 more HIGH defects from audit pass 2` | ✓ |
| sam-gocardless | main | `2ab28d2 feat: full GoCardless audit fixes — 9 BLOCKERS + 5 critical HIGH` | ✓ |

## What landed in the overnight push

### sam-bank-reconcile

The big commit `06b6aac7` covers everything from yesterday's audits + brainstorming. Highlights:

- **Constraint-based balance solver** (new). Format-agnostic derivation of opening/closing — gathers every fact (labelled, summary arithmetic, forward chain post-/pre-txn, backward chain, external reconciled), cross-validates, picks the value with the most independent constraint support. Replaces the brittle "Interpretation A / B then fall back to first-real" logic. Tested live: Monzo May-14 now correctly extracts opening=£82,557.56 (matching Opera's reconciled balance exactly), closing=£11,146.95, with 2 savings-pot phantoms rejected.
- **PeriodPostingDecision** plumbed into all three post functions (postOneTransaction, postNominalEntry, postBankTransfer). Reads RTU + OPA + nclndd period status before every posting. `ax_done` flag now comes from the decision (not hardcoded `'Y'`).
- **VAT split** in postNominalEntry: 2 atran + 3 ntran + 3 anoml + nvat when `vat_code` resolves to rate>0. Non-VAT path byte-identical.
- **Bank-transfer flow rewritten**: single 'T' cbtype, distinct nt_pstid per leg, source atran embeds dest sort/account/name, ax_fvalue populated.
- **Chain-check filter** (already_processed detection): closing-matches-reconciled-opening OR opening-below-reconciled, faithful port of legacy `check_chain_complete`.
- **Eager extraction** on scan: up to 8 pending PDFs per bank extracted inline (Gemini), cached to `extraction_cache` so re-scans hit the fast path. Email + folder sources both supported.
- **Date-extraction fix** for filenames containing two YYYY-MM-DD dates (Monzo `_2026-04-01-2026-04-30_2944.pdf` no longer parses as `04-JAN-2026`).
- **View button endpoints** added (`/api/file/view` + `/api/email/messages/:emailId/attachments/:attachmentId/view`).
- **Verifier** switched ntran/anoml pair lookup from `sharedUnique` to journal-based (since legacy allocates distinct pstids per leg).
- **FE override pipeline** at all 3 matchedOverrides sites now echoes `nominal_code`/`vat_code`/`project_code`/`department_code`/`bank_transfer_details` through to BE.

The follow-on commit `68d5606b` is 4 more HIGH defects from audit pass 2:

- `pt_lastpay` set unconditionally on partial allocations (was full-pay only).
- Period-overlap fallback to txn min/max when statement has no explicit period range.
- Period-overlap excludes `resumeImportId` so a resume doesn't trigger overlap against itself.
- `total_receipts` / `total_payments` filter strictly by Opera `at_type` (4 = sales_receipt, 5 = purchase_payment) — was lumping all positives/negatives.
- Resume auto-reconcile now includes prior batch's entries so reconcile marks the whole statement, not just the latest sliver.

Design spec at `docs/superpowers/specs/2026-05-14-statement-balance-derivation-design.md` — committed.

### sam-gocardless

Commit `2ab28d2` from the implementation agent:

- **All 9 BLOCKERS**: PostingDecision wired, done_flag from decision (not hardcoded), fees flow writes anoml legs (was missing), dest-transfer writes anoml pair (was missing), nt_trtype='A' on bank-transfer ntran (was 'T'), distinct nt_pstid per leg, source atran embeds dest sort/account/name, supplier-dropdown SQL columns verified against live Opera SE, executeWithDeadlockRetry wraps the batch trx.
- **5 critical HIGH**: isPayoutImported targetSystem filter, skipPayout includes payout_id/fx_amount/payment_count/source, orphan detection parameterised LIKE, bank-transfer nt_cmnt/nt_trnref 50-char padded `(RT)` format, inputBy threaded through router/import-batch/executor (was hardcoded `'GOCARDLS'` everywhere).

## What's still on the list for the morning

### Deferred — Phase 2 of the balance solver (spec already approved)

The solver runs on every extraction and works without these, but they were in the design and aren't built yet:

- **Format-profile library** — per-bank-signature SQLite table in the per-app DB. Caches detected balance semantics + txn order + summary-field availability. On every statement the cached profile is used as a hint but the constraint check stays mandatory. New banks auto-populate.
- **FE error surface** for solver disagreement — when the solver returns `{ok: false}` (multiple high-confidence candidates conflict, or no candidate validates), the FE should show "Statement balances don't reconcile — review required" with the candidate values listed, rather than the current silent fallback to the AI's opening/closing. The solver already returns the structured result; only the FE display needs wiring.

### Lower-priority audit items not addressed tonight

From the bank-rec audit pass 2 — all HIGH but cosmetic or audit-trail rather than data-integrity:

- Email-import path doesn't thread `importedBy` / `companyCode` / `paymentRequestLookup` (every email-sourced statement records `imported_by='system'`).
- `imported_transactions` response shape drops `account` / `action` / `name` / `memo` / `allocation_result` — FE loses some per-row badges.
- Deferred-row audit runs AFTER lock acquired; legacy runs BEFORE.
- Auto-reconcile `statementNumber` fallback uses local-TZ `new Date()` — should be UTC.
- `errors` returned as `string[]` instead of `{row, error}` dicts; per-row error overlays on the FE are weaker as a result.

From the GoCardless audit — the agent skipped these as lower-impact:

- `journalCount` allocation when `!completeBatch` allocates only 1 journal.
- Fees uniques use `generateOperaUniqueId()` ×2 instead of slicing from a single `generateMultiple(N)` block.
- HIGH audit-trail items (`at_inputby` `'GOCARDLS'` literal in the few sites the agent skipped). Note: most were threaded in the agent's first pass.

### Live-testing checklist for the morning

1. **Cloudsis Monzo** — Process the May statement. Confirm the 2 sales receipts + 4 purchase payments (or whatever it has) post cleanly to Opera and Phase A/C verification passes.
2. **Intsys Barclays** — Repeat your earlier successful flow to confirm nothing regressed.
3. **GoCardless** — Pull payouts on cloudsis or intsys, post a batch, watch the GC fee + destination-transfer legs both emit anoml rows now (the BLOCKER fix is unverified in production).
4. **VAT-split** — Untested. A nominal_payment with a vat_code (e.g. S20) should produce 2 atran / 3 ntran / 3 anoml / 1 nvat. Pick a test invoice when convenient.

## Quick reference

- Bank-rec server logs: `/tmp/bankrec-stdout.log`, `/tmp/bankrec-stderr.log`
- GC server logs: `/tmp/gc-stdout.log`, `/tmp/gc-stderr.log`
- Solver design: `docs/superpowers/specs/2026-05-14-statement-balance-derivation-design.md`
- Last bank-rec audit pass 2 report: `/tmp/bank-rec-audit-pass2.md`
- Last gocardless audit report: `/tmp/gocardless-audit-report.md`

Restart command for the bank-rec server (in `.claude/launch.json`):
```sh
cd /Users/maccb/sam-Bankrec/repo && LOGIN_PASSWORD=letmein PORT=3030 \
  OPERA_ADAPTER=mssql OPERA_SQL_HOST=172.17.172.99 OPERA_SQL_PORT=1433 \
  OPERA_SQL_USER=n8n OPERA_SQL_PASSWORD=possible \
  OPERA_SQL_TRUST_CERT=true OPERA_SQL_ENCRYPT=false \
  GEMINI_API_KEY=<set-from-your-secret-store> \
  npx tsx standalone/server.ts
```

GC server restart:
```sh
cd /Users/maccb/sam-gocardless && LOGIN_PASSWORD=letmein PORT=3000 \
  OPERA_ADAPTER=mssql OPERA_SQL_HOST=172.17.172.99 OPERA_SQL_PORT=1433 \
  OPERA_SQL_USER=n8n OPERA_SQL_PASSWORD=possible \
  OPERA_SQL_TRUST_CERT=true OPERA_SQL_ENCRYPT=false \
  npx tsx standalone/server.ts
```

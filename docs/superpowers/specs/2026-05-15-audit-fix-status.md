# Audit fix status — 2026-05-15

Triple-pronged deep audit run tonight on both apps for commercial-release readiness. All three reports live in `/tmp/`:

- `/tmp/posting-integrity-audit.md` — 2 BROKEN, 6 WEAK, 7 SOUND
- `/tmp/restore-recovery-audit.md` — 2 CRITICAL, 4 HIGH, 3 MEDIUM, 2 LOW
- `/tmp/out-of-sequence-audit.md` — 3 GAP, 4 PARTIAL, 3 COVERED

## Fixed + pushed

### Bank-rec (`sam-Bankrec`)

| Severity | Item | Fix | Commit |
|---|---|---|---|
| BLOCKER | Auto-allocate atomicity — receipt commits but allocation silently fails | Removed both layers of error-swallowing try/catch in `auto-allocate.ts` and the executor wrapper. DB errors now propagate and abort the trx. Soft "no allocation target" answers continue to return `success:false` without throwing. | `5aa70973` |
| GAP-1 | `scan-all-banks` discards `openingUnblocksChain` with `void openingUnblocksChain;` | Wired the callback into `checkChainComplete`. 3rd statement in a chain where the middle is imported-but-not-reconciled now flows through correctly. | `5aa70973` |
| GAP-3 | `mark-reconciled` accumulates `nk_recbal` silently — drift when a statement is skipped | Added drift alert: when the new `nk_recbal` doesn't match the statement's closing balance, emit a warning to the operator (legacy silently logged only). Accumulation behaviour itself preserved for legacy parity. | this commit |
| (user-facing) | Every transaction showing £0.00 in the FE preview (Gemini returns null `money_in`/`money_out` on Monzo single-amount-column format) | Added pre-solver derivation step in `gemini-pdf-extractor`: when all amounts are null but balances + summary are present, derive signed amount from consecutive balance differences along the chain (tries both within-day orderings, picks whichever terminates at labelled closing). Bank-format-agnostic. | `30640629` |
| (plumbing) | `preview-from-email` route 503'd because it required `ctx.llm` AND `ctx.bankEmailAttachments`; standalone wires `bankPdfExtractor` not `llm` | Route now accepts either `llm` or `bankPdfExtractor`, brings the email-preview handler in line with the PDF-preview handler. | `726eb614` |

### GoCardless (`sam-gocardless`)

| Severity | Item | Fix | Commit |
|---|---|---|---|
| BLOCKER | `recordImportHistory` swallowed errors with `console.warn` — Opera batch commits, audit row fails, next attempt re-posts the whole batch | Retry 3× with backoff, then throw. Caller now returns a structured failure with an explicit "Manual reconciliation REQUIRED" message. The operator can see + act on a half-committed batch instead of unknowingly re-posting it. | `b419420` |
| CRITICAL | `archive-email` rows (`imported_by='ARCHIVE'`) falsely detected as orphans — Recover wipes archive history | Orphan filter in `restore-recovery.ts` now excludes ARCHIVE alongside MANUAL-*. | `b419420` |
| CRITICAL | `MANUAL-*` skipped payouts unrecoverable after real Opera restore — idempotency gate blocked re-import forever | `isPayoutImported` / `isReferenceImported` now exclude MANUAL-* + ARCHIVE rows. These represent operator "don't import" decisions, not actual imports; operators can change their mind and re-import without manually purging the SAM-side row. | `b419420` |

## Deferred — GAP-2: server-side next-in-sequence enforcement

The FE `isNextToProcess` gate is enforceable on the BE too — any non-current statement should be rejected unless the operator explicitly opts out. The audit recommendation is sound but the implementation is non-trivial:

- Requires loading the same tracking-data (`reconciled_opening_balances`, `imported_pending_closings`) that `scan-all-banks` builds, plus the bank's current `nk_recbal`, in the import endpoint.
- Decision needed: hard-reject? warn? require `skip_overlap_check=true` flag for override?
- Risk: a poorly chosen rule could break legitimate "skip this statement intentionally" workflows.

Existing defences cover most accidental misuse: period-overlap check (now with fallback to txn min/max dates + `exclude_import_id`), closed-year check, closed-period check (`PeriodPostingDecision`), and the cashbook duplicate-check at the row level. The remaining hole is "scripted client uploads an out-of-sequence statement that doesn't have overlapping period or closed-year violations" — narrow.

Recommended approach for the morning: implement as a SOFT check that returns a `warnings` entry on out-of-sequence imports but doesn't reject by default. Only HARD-reject when a new request flag `enforce_sequence: true` is set. That way UI-driven flows (where the FE already enforces) are unaffected, scripted misuse is flagged, and operators who explicitly want strict mode can opt in.

## WEAK items — not blockers but worth noting

From the posting integrity audit:

- VAT-split path skips `assertAentryAtran` and never asserts individual NET/VAT pence (Property 3) — coverage is preserved by the 3-leg balanced-pair count check, but a stricter assertion would be cheap.
- Phase C failures in bank-rec still let the audit row record "imported" (Property 4) — failure is logged but doesn't propagate to the operator-visible result.
- Cross-process serialisation has no Opera-side `sp_getapplock` (Property 8) — two SAM hosts on the same Opera DB can race on the same bank.
- No end-of-trx `nbank` vs `atran` consistency assertion (Property 10) — drift would only surface if an operator notices.
- `updateNhist` find-or-create can race two concurrent INSERTs (Property 15).
- GC fees nominal account isn't validated against `nacnt` upfront (Property 11) — late, opaque error if misconfigured.

## Other audit items not addressed tonight

From the restore-recovery audit:

- HIGH: Cross-tenant lock contention is broken — `import_locks` lives in per-app SAM DB; two SAM tenants writing to the same Opera SQL Server's BC010 don't serialise despite the docblock claiming they do. GoCardless lock is in-process Map only.
- HIGH: GC orphan detection only checks `aentry WHERE ae_value > 0` (receipt leg). A half-restore that wipes the fees aentry but keeps the receipts is silently undetected.
- HIGH: bank-rec `bank_statement_transactions.posted_entry_number` audit stamp is written via separate `appDb.update()` AFTER the Opera trx commits. A SAM crash between commit and stamp leaves a re-run double-post window.
- MEDIUM/LOW items in the same report.

## Live state

- Bank-rec server: `:3030`, restarted with all fixes.
- GoCardless server: `:3000`, restarted with all fixes.

## Suggested live-test sequence in the morning

1. **Cloudsis Monzo** — re-run the May statement scan, confirm real amounts visible (not £0.00). Process the next-in-sequence statement, confirm Opera entries are correct.
2. **Auto-allocate atomicity** — process a sales receipt that should allocate against an existing invoice. Confirm both the receipt and allocation rows land together (or both roll back on error). Pick a customer where you can deliberately corrupt the allocation (e.g. by manually locking the salloc row) to test the abort path.
3. **GC restore-recovery** — simulate a partial Opera restore (delete a payout's atran rows manually) and run "fetch payouts" — confirm orphan banner appears for the right payout, MANUAL-* + ARCHIVE rows are NOT falsely orphaned.
4. **GC idempotency under audit-row failure** — temporarily make `gocardless_imports` read-only (or break the DB connection) and try to import a payout. Confirm the new "Manual reconciliation REQUIRED" error appears instead of silent re-post on next attempt.
5. **Chain advance through imported-but-not-reconciled** — import statement A, don't reconcile. Scan, confirm statement B is still visible as the next-in-sequence (not flagged `already_processed`).

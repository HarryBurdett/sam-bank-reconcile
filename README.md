# bank-reconcile (SAM plugin)

Bank statement reconciliation against Pegasus Opera SE / Opera 3.
The Python implementation lives at `apps/bank_reconcile/` in the
parent repo; this is the SAM port (TypeScript backend + React UMD
frontend).

## What it does

Five-stage operator workflow:

1. **Select** — pick a bank account; see Opera's reconciled balance
2. **Review & match** — AI-extract transactions from a statement PDF
   (or scan inbox); auto-match against Opera cashbook entries with
   fuzzy + pattern-learning rules
3. **Import** — post matched + manually-assigned transactions to
   Opera. Optional auto-allocate to invoices.
4. **Reconcile** — assign statement line numbers, mirror PDF order
5. **Complete** — close the statement when difference is £0.00

See [marketing/manuals/manual-bank-reconciliation.md](../../marketing/manuals/manual-bank-reconciliation.md)
for the user-facing walkthrough.

## What SAM provides

This plugin is a thin port — every endpoint maps 1:1 to a Python
route. The SAM runtime injects:

| ctx field | Required? | Purpose |
| --- | --- | --- |
| `db.app` | yes | Per-app DB for aliases, patterns, history (Postgres in prod, SQLite in tests) |
| `db.getCompanyDb(code)` | yes | Knex pool for the Opera company in the request header |
| `operaType` | yes | `'opera-se'` or `'opera-3'` — selects SQL or FoxPro dialect |
| `logger` | yes | Standard logger interface |
| `llm` | yes | Used for PDF vision extraction; falls back to 503 on import-from-pdf if missing |
| `emailIngest` | optional | When wired plus `config.mailboxes`, the built-in mailbox adapter activates |
| `email` | optional | Statement email send-out (responses to suppliers, etc.) |

## Built-in defaults

The plugin ships sensible defaults the SAM team can override by
attaching custom adapters to `ctx`:

| Default | Override key on ctx | Activates when |
| --- | --- | --- |
| [defaultMultiformatParser](src/services/default-multiformat-parser.ts) — CSV/OFX/QIF/MT940 parsing | `multiformatParser` | always |
| [defaultFileStorage](src/services/default-file-storage.ts) — filesystem with `archive/YYYY-MM/` layout | `fileStorage` | `config.bankStatementRoot` set |
| [defaultPdfContentReader](src/services/default-pdf-content-reader.ts) — `fs.readFile` with optional rootDir guard | `pdfContentReader` | always |
| [defaultBankPdfExtractor](src/services/default-bank-pdf-extractor.ts) — wraps `ctx.llm` with Claude vision prompt | `bankPdfExtractor` | `ctx.llm` available |
| [defaultEmailIngestAdapter](src/services/default-email-ingest.ts) — wraps `ctx.emailIngest` for `BankMailboxAdapter` + `EmailAttachmentProvider` | `bankMailboxAdapter`, `bankEmailAttachments` | `ctx.emailIngest` available, `config.mailboxes` non-empty |

## Required `ctx.config` keys

| Key | Type | Purpose |
| --- | --- | --- |
| `bankStatementRoot` | string | Filesystem root the default fileStorage adapter watches. Subfolders: `bank-statements/`, `bank-statements/archive/YYYY-MM/`. |
| `mailboxes` | string[] | Mailbox addresses to claim via `ctx.emailIngest.claimMailbox`. Required if you want the built-in email-ingest default. |

Optional: a custom `bankReconciledKeyStore` on ctx supplies the set
of (email_id, attachment_id) tuples already reconciled — the SAM
team typically wires this against per-app DB.

## Routes

The plugin exposes ~140 endpoints. Each Python `/api/...` URL has a
1:1 SAM equivalent at the same path; each `/api/opera3/...` URL is
served by a path-rewrite middleware that strips the `/opera3` prefix
(see `src/router.ts` near the top).

Check live with:

```sh
curl -s -H 'X-Opera-Company: ABC' http://localhost:PORT/api/bank-reconcile/status
```

## Database

| Folder | Purpose |
| --- | --- |
| `db/migrations/` | 12 Knex migrations, run by SAM at plugin install. Smoke-tested against in-memory SQLite by `tests/migrations.test.ts`. |

`vitest run tests/migrations.test.ts` runs every migration on a
fresh SQLite db — generic Knex schema methods work both there and
in production Postgres, so this catches dialect-agnostic bugs.

## Tests

```sh
npm test               # vitest run — 434 tests, all green
npm run lint           # tsc --noEmit
```

Service tests use chained-builder Knex mocks. Migration tests use
real SQLite. Endpoint tests run the deterministic services in
isolation — the router/HTTP layer is exercised only by the
`opera3-mirror` test.

## Frontend

The full 5,400-line page from the legacy frontend lives at
[`frontend/src/BankStatementReconcile.tsx`](frontend/src/BankStatementReconcile.tsx),
mounted by `BankReconcile.tsx` inside a `QueryClientProvider`.
`api-shim.ts` adapts SAM's `context.api.fetch` to the axios-style
`apiClient` the legacy page expects.

```sh
cd frontend
npm install
npm run build       # UMD bundle in dist/index.js + dist/style.css
```

The bundle is loaded by SAM's AppLoader; the `bank-reconcile-app`
className wrapper isolates Tailwind utilities from the host CSS.

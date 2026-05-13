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

## Standalone mode

The repo ships with a self-hosted Express server (`standalone/`) that runs the plugin without SAM. It supports **multiple companies** — each a top-level subdirectory under `DATA_ROOT` with its own SQLite, its own bank-reconcile settings, and (optionally) its own Opera database mapping. The company is picked at login.

### Quick start (no Opera, settings-only)

```sh
npm install
npm run build                              # builds dist/ + frontend/dist/
mkdir -p data/main                          # one or more company dirs
LOGIN_PASSWORD=<choose-a-strong-one> npm run start
```

Open `http://localhost:3000`, pick a company from the dropdown, log in. With `OPERA_ADAPTER=noop` (default), the UI can manage folder settings, recurring-entry mode, aliases, patterns, etc. — but anything that needs to talk to Opera (reconciliation, statement posting, cashbook lookups) will surface a clear error.

### With an Opera connection (opera-se / MSSQL)

```sh
LOGIN_PASSWORD=<password> \
OPERA_ADAPTER=mssql \
OPERA_SQL_HOST=<sql-server-ip-or-hostname> \
OPERA_SQL_USER=<user> \
OPERA_SQL_PASSWORD=<password> \
OPERA_SQL_TRUST_CERT=true \
OPERA_SQL_ENCRYPT=false \
npm run start
```

Each company needs an `opera.json` at `<DATA_ROOT>/<code>/opera.json`:

```json
{ "database": "Opera3SECompany00I", "operaVersion": "SE" }
```

The plugin's `getCompanyDb(code)` then returns a Knex pool against that database. Bank reconciliation, statement posting, and cashbook lookups all work against the real Opera SE schema.

### Migrating from the legacy Python `apps/bank_reconcile/`

Set `LEGACY_DATA_ROOT` to the legacy `data/` directory. On first boot of each company, the standalone host:

1. Auto-discovers companies from `LEGACY_DATA_ROOT/<code>/bank_reconcile/` and creates a stub `<DATA_ROOT>/<code>/` for each.
2. Seeds the new `settings` table from `<LEGACY_DATA_ROOT>/<code>/core/company_settings.json`:
   - `bank_statements_base_folder` + `bank_statements_archive_folder` → `folder_settings`.
   - `recurring_entries_mode` → `recurring_entries_mode`.
3. Seeds `<DATA_ROOT>/<code>/opera.json` from `<LEGACY_DATA_ROOT>/../companies/<code>.json` (or `LEGACY_COMPANIES_DIR` if set).
4. Seeds `settings.email_provider` from the first enabled row in `<LEGACY_DATA_ROOT>/<code>/core/email_data.db.email_providers` (legacy `name` + `provider_type` + `config_json` collapse into one JSON blob).
5. Copies rows from the legacy per-company SQLite files into the new `bank-reconcile.sqlite`:
   - `bank_aliases.db` → `bank_import_aliases`, `repeat_entry_aliases`, `match_config`, `duplicate_overrides`, `ai_suggestions`.
   - `bank_patterns.db` → `bank_import_patterns`.
   - `deferred_transactions.db` → `deferred_transactions`.

   The PDF extraction cache (`pdf_extraction_cache.db`) and runtime import locks (`import_locks.db`) are intentionally skipped — the cache rebuilds itself and stale locks shouldn't survive a migration.

All of this is idempotent — each step is a no-op once the destination has data.

### Settings page (`/settings.html`)

A host-level admin page (sibling to the plugin UI) exposes per-company configuration. Two cards:

- **Opera mapping** — edits `<DATA_ROOT>/<code>/opera.json`. Save calls `PUT /auth/system-info`; the MSSQL adapter drops the pool and rebuilds against the new database/version on the next request, no restart needed.
- **Email account** — edits the per-company `settings.email_provider` row via `PUT /auth/email-config`. IMAP is wired today (Microsoft Graph / Gmail entries are reserved for future iterations). The "Trust invalid TLS certificate" checkbox plumbs through to `tls.rejectUnauthorized = false`; needed for LAN servers whose certs don't list the IP as a SAN.

A small "Settings · Logout" chip at the top-right of the main app links to it.

### IMAP mailbox adapter

The standalone host wires a node IMAP adapter onto every company's `AppContext` so the plugin's `/scan-emails`, `/preview-from-email`, and `/fetch-emails-to-folder` routes work without a SAM `ctx.emailIngest` provider.

- Reads `settings.email_provider` on every call — saves via the Settings UI take effect on the next scan, no restart.
- INBOX only, default `days_back=30` from the plugin's query (we don't impose a tighter cap here).
- `emailId` in the plugin's API is the IMAP UID; `attachmentId` is the MIME part identifier from the bodystructure.
- Connections aren't pooled — each call opens/closes. Fine for an interactive workflow; if scans become a hot path we can add per-company keepalive.
- TLS verification is loose by default (`allow_invalid_cert=true`) — matches the legacy Python `imaplib` behaviour and unblocks LAN IMAP. Tighten it from Settings if you're pointing at a public provider.

Limitations:
- Only the IMAP provider type is implemented. The settings schema has slots for `microsoft` and `gmail` because the legacy `email_providers.provider_type` supported them, but those branches throw "only IMAP wired" today.
- `bankReconciledKeyStore` returns empty sets — every candidate that scan-emails finds is shown as "not yet reconciled". A future iteration can query `bank_statement_imports` to dedupe by `(email_id, attachment_id)`.

### All env vars

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATA_ROOT` | `./data` | Parent dir for per-company SQLite files |
| `LEGACY_DATA_ROOT` | _unset_ | Legacy `data/<company>/bank_reconcile/` directory; enables auto-discovery + migration |
| `LEGACY_COMPANIES_DIR` | `<LEGACY_DATA_ROOT>/../companies` | Source of legacy `<code>.json` files for seeding `opera.json` |
| `LOGIN_PASSWORD` | _required_ | Shared password for the login form |
| `SESSION_SECRET` | auto-generated to `<DATA_ROOT>/.session-secret` | Cookie signing key |
| `OPERA_ADAPTER` | `noop` | `noop`, `mssql`, `opera3`, or `composite` |
| `OPERA_SQL_HOST` | _required when `mssql`/`composite`_ | Opera SQL server host |
| `OPERA_SQL_PORT` | `1433` | Opera SQL server port |
| `OPERA_SQL_USER` | _required when `mssql`/`composite`_ | SQL Server username |
| `OPERA_SQL_PASSWORD` | _required when `mssql`/`composite`_ | SQL Server password |
| `OPERA_SQL_TRUST_CERT` | `true` | Trust the server's TLS cert (Opera SE typically uses a self-signed cert) |
| `OPERA_SQL_ENCRYPT` | `true` | TLS-encrypt the connection. Set `false` for IP-only Opera servers (tedious rejects IP as TLS ServerName) |
| `OPERA3_AGENT_URL` | _unset_ | Reserved — URL of the future opera-3 read/write agent (HTTP service that wraps VFP/FoxPro DBF access). The bundled opera-3 adapter is a scaffold; agent integration is pending. |
| `OPERA3_AGENT_KEY` | _unset_ | Reserved — shared secret for the opera-3 agent service. |
| `OPERA3_DATA_PATH` | _unset_ | Reserved — local mount of the Opera 3 SMB share, if the future agent reads files directly. |
| `TRUST_PROXY` | `loopback, linklocal, uniquelocal` | Passed verbatim to Express's `app.set('trust proxy', …)` |

### Adapter modes

| Mode | What it does | Use it when |
|---|---|---|
| `noop` | Returns null for every `getCompanyDb()` call. Plugin's Opera-backed endpoints surface "Opera not connected" errors; everything that's `db.app`-only (folder settings, aliases, patterns, deferred transactions) still works. | You're configuring settings or porting data, no live Opera connection needed. |
| `mssql` | Per-company Knex pool against Opera SQL Server. Companies whose `opera.json` has `operaVersion: "3"` are skipped. | Everything you have is on Opera SE. |
| `opera3` | Scaffold for Opera 3 (VFP/FoxPro) access via an external agent service. Not yet implemented — returns null with a warn log. | Reserved for future opera-3 integration. |
| `composite` | Routes per-company: SE → MSSQL pool, 3 → opera-3 agent. | Mixed deployment where some companies are Opera SE and others are Opera 3. |

Per-company `operaVersion` is set via the **Settings → System connection** panel ("Edit Opera mapping") or by directly editing `<DATA_ROOT>/<company>/opera.json`. The change takes effect immediately — no restart required.

### Behind a reverse proxy

If the standalone server sits behind a TLS-terminating reverse proxy on a public IP (Caddy, Nginx, Cloudflare with a public backend), the default `TRUST_PROXY` value will not match the proxy's source address, so `req.protocol` stays `http` and session cookies will not carry the `Secure` flag. Set `TRUST_PROXY` to a value that Express recognises (e.g. `1` to trust the first hop, or a CIDR like `10.0.0.0/8`). See [the Express docs on `trust proxy`](https://expressjs.com/en/guide/behind-proxies.html).

### Relationship to SAM

`src/`, `frontend/`, `db/migrations/`, and `manifest.json` are unchanged from upstream — SAM continues to consume this repo as a plugin without any adapter shim. The `standalone/` directory is sibling-only and never imported by `dist/index.js`. When merged into SAM, the standalone host becomes inert (SAM provides its own per-tenant `AppContext`); the Opera adapter you configure here continues to work because the adapter interface is the same shape SAM expects.

⚠️ The standalone host has no TLS, no rate limiting, and no IP allowlist beyond per-IP login throttling. Put a reverse proxy in front of it for anything beyond a private network.

## Dev host

For local frontend work without a real Opera connection or login flow:

```sh
npm install
npm run build        # at least once, to populate frontend/dist/
npm run dev          # http://localhost:3000 (in-memory SQLite, no auth)
```

The dev host injects a stub user, no company, and an in-memory SQLite for `db.app`. Use it to iterate on the frontend; anything that hits Opera will fail with a clear error.

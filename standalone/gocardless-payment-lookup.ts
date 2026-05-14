/**
 * GoCardless payment-request invoice lookup adapter.
 *
 * Faithful port of `GoCardlessPaymentsDB.get_payment_request_by_payment_id`
 * (sql_rag/gocardless_payments.py:743). When the gocardless plugin
 * stored a payment request with invoice_refs, this returns those refs
 * so the bank-reconcile auto-allocator can apply Rule 0 (precise
 * allocation to the requested invoices).
 *
 * Storage convention: the gocardless plugin owns its own SQLite at
 * `<legacyDataRoot>/<company>/gocardless/gocardless_payments.db`,
 * with table `gocardless_payment_requests` and column
 * `invoice_refs` (JSON-encoded array of strings).
 *
 * This adapter opens that file read-only if present and degrades to
 * "no lookup" if the file is missing — preserves today's standalone
 * behaviour and lets the rule kick in automatically the moment the
 * gocardless plugin runs alongside.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import knex from 'knex';
import type { Knex } from 'knex';
import type { AppLogger } from '../src/app-context.js';
import type { PaymentRequestInvoiceLookup } from '../src/services/auto-allocate.js';

export interface GoCardlessLookupOptions {
  companyCode: string;
  /** Directory roots to probe for the gocardless DB, in priority order.
   *  Typically [`<dataRoot>/<company>/gocardless`,
   *  `<legacyDataRoot>/<company>/gocardless`]. */
  searchRoots: string[];
  logger?: AppLogger;
}

const GC_DB_BASENAME = 'gocardless_payments.db';

function resolveDbPath(opts: GoCardlessLookupOptions): string | null {
  for (const root of opts.searchRoots) {
    if (!root) continue;
    const candidate = path.join(root, GC_DB_BASENAME);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function buildGoCardlessPaymentLookup(
  opts: GoCardlessLookupOptions,
): PaymentRequestInvoiceLookup | null {
  const dbPath = resolveDbPath(opts);
  if (!dbPath) {
    opts.logger?.debug?.(
      `[${opts.companyCode}] gocardless_payments.db not found in any search root — Rule 0 lookup disabled`,
    );
    return null;
  }
  // One read-only connection per company, reused across calls.
  let conn: Knex | null = null;
  const open = (): Knex => {
    if (conn) return conn;
    conn = knex({
      client: 'sqlite3',
      connection: { filename: dbPath, flags: ['OPEN_READONLY'] },
      useNullAsDefault: true,
      pool: { min: 0, max: 1 },
    });
    return conn;
  };
  opts.logger?.info(
    `[${opts.companyCode}] gocardless payment-request lookup wired (${dbPath})`,
  );

  return async (gcPaymentId: string): Promise<string[] | null> => {
    if (!gcPaymentId) return null;
    try {
      const db = open();
      const row = (await db('gocardless_payment_requests')
        .where({ payment_id: gcPaymentId })
        .select('invoice_refs')
        .first()) as { invoice_refs?: string | null } | undefined;
      const raw = row?.invoice_refs ?? null;
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed.filter((s): s is string => typeof s === 'string');
        }
      } catch {
        // invoice_refs stored as comma-separated rather than JSON —
        // tolerated, matches legacy permissive parse.
        return raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      }
      return null;
    } catch (err) {
      opts.logger?.warn(
        `[${opts.companyCode}] gocardless payment lookup failed for ${gcPaymentId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  };
}

/**
 * Bank-import pattern learner.
 *
 * Faithful port of `BankPatternLearner.learn_pattern` +
 * `normalize_description` (sql_rag/bank_patterns.py:126, 187).
 *
 * Each time the operator commits an override during a bank-statement
 * import (e.g. matching "DD VODAFONE PLC 2024-04-15" → account
 * "VODA001"), this writes/updates a row in `bank_import_patterns`
 * keyed by the normalised description. Subsequent imports with the
 * same normalised description can be auto-matched without re-asking
 * the operator. UPSERT semantics: existing row → increment times_used
 * and refresh last_used; new row → INSERT.
 *
 * Storage: per-app SQLite `bank_import_patterns` table (migration
 * 014 extends the SAM-original schema with the legacy columns).
 *
 * Wired from import-from-pdf.ts after a successful posting batch
 * (faithful port of routes.py:4584-4606).
 */
import type { Knex } from 'knex';

/**
 * Normalise a bank description for matching. Strips common bank
 * prefixes (DD/BACS/FP/...), reference numbers, dates, and company-
 * suffixes. Faithful port of bank_patterns.py:126.
 */
export function normalizeDescription(description: string | null | undefined): string {
  if (!description) return '';
  let text = description.toUpperCase();

  const prefixes = [
    /^DD\s+/,
    /^DIRECT DEBIT\s+/,
    /^BACS\s+/,
    /^FASTER PAYMENT\s+/,
    /^FP\s+/,
    /^FPI\s+/,
    /^FPO\s+/,
    /^BGC\s+/,
    /^BANK GIRO CREDIT\s+/,
    /^CHQ\s+/,
    /^CHEQUE\s+/,
    /^TFR\s+/,
    /^TRANSFER\s+/,
    /^S\/O\s+/,
    /^STANDING ORDER\s+/,
    /^POS\s+/,
    /^CARD\s+/,
    /^VISA\s+/,
    /^MASTERCARD\s+/,
  ];
  for (const p of prefixes) text = text.replace(p, '');

  // Reference numbers (XX123456, long numerics, REF: ...).
  text = text.replace(/\b[A-Z]{2,3}\d{6,}\b/g, '');
  text = text.replace(/\b\d{6,}\b/g, '');
  text = text.replace(/\bREF[:\s]*\S+/gi, '');

  // Dates in various formats.
  text = text.replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, '');
  text = text.replace(
    /\b\d{1,2}\s+(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s*\d{0,4}\b/gi,
    '',
  );

  // Common suffixes.
  text = text.replace(/\bLTD\.?\b/gi, '');
  text = text.replace(/\bLIMITED\b/gi, '');
  text = text.replace(/\bPLC\.?\b/gi, '');
  text = text.replace(/\b& CO\.?\b/gi, '');

  return text.replace(/\s+/g, ' ').trim();
}

export interface LearnPatternInput {
  companyCode: string;
  description: string;
  transactionType: string;
  accountCode: string;
  accountName?: string | null;
  ledgerType: string;
  vatCode?: string | null;
  nominalCode?: string | null;
  netAmount?: number | null;
}

/**
 * Learn or refresh a pattern. Returns true on success, false on
 * failure (e.g. empty normalised description). Failures are logged
 * but never thrown so the import flow isn't blocked by a learner
 * hiccup — matches legacy bank_patterns.py:252-256.
 */
export async function learnPattern(
  appDb: Knex,
  input: LearnPatternInput,
): Promise<boolean> {
  const normalized = normalizeDescription(input.description);
  if (!normalized) return false;
  const now = new Date().toISOString();

  try {
    // Attempt UPDATE first — matches legacy upsert semantics.
    const updated = (await appDb('bank_import_patterns')
      .where({
        company_code: input.companyCode,
        description_normalized: normalized,
      })
      .update({
        transaction_type: input.transactionType,
        account_code: input.accountCode,
        account_name: input.accountName ?? null,
        ledger_type: input.ledgerType,
        vat_code: input.vatCode ?? null,
        nominal_code: input.nominalCode ?? null,
        net_amount_typical:
          input.netAmount !== undefined && input.netAmount !== null
            ? input.netAmount
            : appDb.raw('net_amount_typical'),
        times_used: appDb.raw('COALESCE(times_used, 0) + 1'),
        last_used: now,
      })) as unknown as number;

    if (!updated) {
      // `pattern` is a NOT NULL legacy column kept for backward compat.
      // The active match key is `description_normalized` (unique index
      // (company_code, description_normalized)); we duplicate the same
      // value into `pattern` to satisfy the constraint.
      await appDb('bank_import_patterns').insert({
        pattern: normalized,
        company_code: input.companyCode,
        description_raw: input.description,
        description_normalized: normalized,
        transaction_type: input.transactionType,
        account_code: input.accountCode,
        account_name: input.accountName ?? null,
        ledger_type: input.ledgerType,
        vat_code: input.vatCode ?? null,
        nominal_code: input.nominalCode ?? null,
        net_amount_typical: input.netAmount ?? null,
        times_used: 1,
        first_used: now,
        last_used: now,
      });
    }
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[bank-reconcile] learn_pattern failed for '${normalized}': ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

/**
 * Alias correction learning — record operator corrections to bank-name
 * → Opera-account matching, and store negative examples to avoid
 * future false positives.
 *
 * Faithful port of `BankAliasManager.record_correction` and
 * `_save_negative_example` (sql_rag/bank_aliases.py:728-813), plus
 * the wrapping endpoint `record_correction`
 * (apps/bank_reconcile/api/routes.py:2845-2895).
 *
 * On a successful correction:
 *   1. INSERT a row in `alias_corrections` for audit.
 *   2. Save (or upsert) the correct mapping as an alias with max
 *      confidence (1.0) in `bank_import_aliases`.
 *   3. INSERT (or IGNORE on conflict) a negative example in
 *      `negative_aliases` so the matcher knows NOT to match
 *      bank_name to wrong_account again.
 *
 * Wrap step 1+2+3 in a single transaction so a failure in step 3
 * doesn't leave a half-recorded correction.
 */
import type { Knex } from 'knex';
import { companyScope } from '../_shared/get-company.js';

export type LedgerType = 'S' | 'C';

export interface RecordCorrectionInput {
  bank_name: string;
  wrong_account: string;
  correct_account: string;
  ledger_type: string; // case-insensitive 'S' | 'C'
  account_name?: string | null;
  corrected_by?: string;
}

export interface RecordCorrectionResponse {
  success: boolean;
  message?: string;
  error?: string;
}

const DIRECTION_FOR_LEDGER: Record<LedgerType, string> = {
  S: 'payment', // Supplier → outgoing payment
  C: 'receipt', // Customer → incoming receipt
};

const MATCH_TYPE_FOR_LEDGER: Record<LedgerType, string> = {
  S: 'supplier',
  C: 'customer',
};

export async function recordCorrection(
  appDb: Knex,
  companyCode: string,
  input: RecordCorrectionInput,
): Promise<RecordCorrectionResponse> {
  const bankName = (input.bank_name ?? '').trim();
  const wrongAccount = (input.wrong_account ?? '').trim();
  const correctAccount = (input.correct_account ?? '').trim();
  const ledgerRaw = (input.ledger_type ?? '').trim().toUpperCase();
  const correctedBy = (input.corrected_by ?? 'USER').trim() || 'USER';

  if (!bankName || !wrongAccount || !correctAccount) {
    return {
      success: false,
      error: 'bank_name, wrong_account, and correct_account are required',
    };
  }
  if (ledgerRaw !== 'S' && ledgerRaw !== 'C') {
    return {
      success: false,
      error: "ledger_type must be 'S' (supplier) or 'C' (customer)",
    };
  }
  const ledger = ledgerRaw as LedgerType;
  const scope = companyScope(companyCode);

  try {
    await appDb.transaction(async (trx) => {
      // 1. Audit log
      await trx('alias_corrections').insert({
        ...scope,
        bank_name: bankName,
        wrong_account: wrongAccount,
        correct_account: correctAccount,
        ledger_type: ledger,
        corrected_by: correctedBy,
      });

      // 2. Upsert positive alias with confidence=1.0. The primary
      //    alias table is bank_import_aliases (per migration 001) —
      //    keyed by (bank_code, payee_pattern). We don't have a
      //    bank_code at this layer (correction is bank-agnostic in
      //    the Python code) so use '*' as a wildcard bank_code.
      const existing = (await trx('bank_import_aliases')
        .where({
          ...scope,
          bank_code: '*',
          payee_pattern: bankName,
          match_type: MATCH_TYPE_FOR_LEDGER[ledger],
        })
        .first()) as { id: number } | undefined;

      if (existing) {
        await trx('bank_import_aliases')
          .where({ ...scope, id: existing.id })
          .update({
            opera_account: correctAccount,
            confidence: 1.0,
            direction: DIRECTION_FOR_LEDGER[ledger],
            updated_at: trx.fn.now(),
          });
      } else {
        await trx('bank_import_aliases').insert({
          ...scope,
          bank_code: '*',
          payee_pattern: bankName,
          match_type: MATCH_TYPE_FOR_LEDGER[ledger],
          opera_account: correctAccount,
          confidence: 1.0,
          direction: DIRECTION_FOR_LEDGER[ledger],
          match_count: 0,
        });
      }

      // 3. Negative example. Migration 020 made the UNIQUE composite
      //    (company_code, bank_name, wrong_account); on conflict, skip
      //    silently (matches Python's INSERT OR IGNORE).
      const negKey = bankName.toUpperCase();
      const negExisting = (await trx('negative_aliases')
        .where({ ...scope, bank_name: negKey, wrong_account: wrongAccount })
        .first()) as { id: number } | undefined;
      if (!negExisting) {
        await trx('negative_aliases').insert({
          ...scope,
          bank_name: negKey,
          wrong_account: wrongAccount,
        });
      }
    });

    return {
      success: true,
      message: `Correction recorded: '${bankName}' -> ${correctAccount}`,
    };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------
// isNegativeMatch — used by the matcher to avoid known-wrong mappings
// ---------------------------------------------------------------------

export async function isNegativeMatch(
  appDb: Knex,
  companyCode: string,
  bankName: string,
  account: string,
): Promise<boolean> {
  const key = (bankName ?? '').trim().toUpperCase();
  const acct = (account ?? '').trim();
  if (!key || !acct) return false;
  const scope = companyScope(companyCode);
  try {
    const row = (await appDb('negative_aliases')
      .where({ ...scope, bank_name: key, wrong_account: acct })
      .first()) as { id: number } | undefined;
    return !!row;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
// listCorrections — audit-trail UI
// ---------------------------------------------------------------------

export interface ListCorrectionsOptions {
  bankName?: string | null;
  correctAccount?: string | null;
  limit?: number;
}

export interface CorrectionEntry {
  id: number;
  bank_name: string;
  wrong_account: string;
  correct_account: string;
  ledger_type: LedgerType;
  corrected_by: string;
  created_at: string;
}

export interface ListCorrectionsResponse {
  success: boolean;
  entries: CorrectionEntry[];
  count: number;
  error?: string;
}

function dateToIso(d: Date | string | null): string {
  if (!d) return '';
  if (d instanceof Date) {
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString();
  }
  return String(d);
}

export async function listCorrections(
  appDb: Knex,
  companyCode: string,
  opts: ListCorrectionsOptions = {},
): Promise<ListCorrectionsResponse> {
  const scope = companyScope(companyCode);
  try {
    const limit = opts.limit ?? 200;
    let query = appDb('alias_corrections')
      .where(scope)
      .orderBy('created_at', 'desc')
      .limit(limit);
    if (opts.bankName) {
      query = query.where({ bank_name: opts.bankName });
    }
    if (opts.correctAccount) {
      query = query.where({ correct_account: opts.correctAccount });
    }
    const rows = (await query) as unknown as Array<{
      id: number;
      bank_name: string;
      wrong_account: string | null;
      correct_account: string | null;
      ledger_type: string | null;
      corrected_by: string | null;
      created_at: Date | string;
    }>;
    const entries: CorrectionEntry[] = rows.map((r) => ({
      id: r.id,
      bank_name: r.bank_name,
      wrong_account: r.wrong_account ?? '',
      correct_account: r.correct_account ?? '',
      ledger_type: ((r.ledger_type ?? 'C') as LedgerType),
      corrected_by: r.corrected_by ?? '',
      created_at: dateToIso(r.created_at),
    }));
    return { success: true, entries, count: entries.length };
  } catch (err: any) {
    return {
      success: false,
      entries: [],
      count: 0,
      error: err?.message ?? String(err),
    };
  }
}

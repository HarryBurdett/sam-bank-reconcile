/**
 * Repeat-entry maintenance for the bank-import flow.
 *
 * Faithful port of:
 *   - update_repeat_entry_date (apps/bank_reconcile/api/routes.py:5320-5419)
 *
 * Updates ae_nxtpost on arhead so the operator can sync a repeat
 * entry's next posting date with the actual bank transaction date,
 * then run Opera's "Repeat Entries" routine to post.
 *
 * Optional alias-save: when statement_name is supplied, save a
 * repeat-entry alias in `repeat_entry_aliases` (per-app DB) so future
 * imports auto-match this bank statement description to this repeat
 * entry. Best-effort — alias-save failure doesn't fail the whole
 * operation.
 *
 * SQL injection guard: bank_code + entry_ref validated at the route
 * boundary via the shared validators.
 */
import type { Knex } from 'knex';
import {
  validateBankCode,
  validateEntryNumber,
  SqlInputValidationError,
} from '../_shared/index.js';
import { withImportLock, ImportLockError } from './import-lock.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface UpdateRepeatEntryDateInput {
  bankCode: string;
  entryRef: string;
  newDate: string;
  /** Optional bank-statement description to record as alias. */
  statementName?: string | null;
}

export interface UpdateRepeatEntryDateResponse {
  success: boolean;
  message?: string;
  entry_ref?: string;
  old_date?: string | null;
  new_date?: string;
  alias_saved?: boolean;
  error?: string;
}

// ---------------------------------------------------------------------
// listRepeatEntries — read-only debug list
// ---------------------------------------------------------------------

export interface RepeatEntry {
  entry_ref: string;
  description: string;
  next_post_date: string | null;
  frequency: string;
  every: number;
  posted_count: number;
  total_posts: number;
  status: 'Active' | 'Completed';
  amount_pence: number;
  amount_pounds: number;
  account: string;
  cb_type: string;
}

export interface ListRepeatEntriesResponse {
  success: boolean;
  bank_code: string;
  repeat_entries: RepeatEntry[];
  count: number;
  message?: string;
  error?: string;
}

export async function listRepeatEntries(
  operaDb: Knex,
  bankCode: string,
): Promise<ListRepeatEntriesResponse> {
  let bc: string;
  try {
    bc = validateBankCode(bankCode);
  } catch (e) {
    if (e instanceof SqlInputValidationError) {
      return {
        success: false,
        bank_code: bankCode,
        repeat_entries: [],
        count: 0,
        error: e.message,
      };
    }
    throw e;
  }

  try {
    const rows = (await operaDb.raw(
      `SELECT
         h.ae_entry, h.ae_desc, h.ae_nxtpost, h.ae_freq, h.ae_every,
         h.ae_posted, h.ae_topost, h.ae_type,
         l.at_value, l.at_account, l.at_cbtype, l.at_comment,
         CASE WHEN h.ae_topost = 0 OR h.ae_posted < h.ae_topost
              THEN 'Active'
              ELSE 'Completed'
         END AS status
       FROM arhead h WITH (NOLOCK)
       JOIN arline l WITH (NOLOCK)
         ON h.ae_entry = l.at_entry AND h.ae_acnt = l.at_acnt
       WHERE RTRIM(h.ae_acnt) = ?
       ORDER BY h.ae_nxtpost DESC`,
      [bc],
    )) as unknown as Array<{
      ae_entry: string | null;
      ae_desc: string | null;
      ae_nxtpost: Date | string | null;
      ae_freq: string | null;
      ae_every: number | null;
      ae_posted: number | null;
      ae_topost: number | null;
      at_value: number | null;
      at_account: string | null;
      at_cbtype: string | null;
      at_comment: string | null;
      status: string;
    }>;

    if (!Array.isArray(rows) || rows.length === 0) {
      return {
        success: true,
        bank_code: bc,
        repeat_entries: [],
        count: 0,
        message: `No repeat entries found for bank ${bc}`,
      };
    }

    const entries: RepeatEntry[] = rows.map((r) => {
      const amountPence = Number(r.at_value ?? 0);
      const status: 'Active' | 'Completed' =
        r.status === 'Completed' ? 'Completed' : 'Active';
      const nextPost =
        r.ae_nxtpost instanceof Date
          ? r.ae_nxtpost.toISOString().slice(0, 10)
          : r.ae_nxtpost
            ? String(r.ae_nxtpost).slice(0, 10)
            : null;
      return {
        entry_ref: (r.ae_entry ?? '').toString().trim(),
        description:
          (r.ae_desc ?? '').toString().trim() ||
          (r.at_comment ?? '').toString().trim(),
        next_post_date: nextPost,
        frequency: r.ae_freq ?? '',
        every: Number(r.ae_every ?? 1),
        posted_count: Number(r.ae_posted ?? 0),
        total_posts: Number(r.ae_topost ?? 0),
        status,
        amount_pence: amountPence,
        amount_pounds: Math.abs(amountPence) / 100,
        account: (r.at_account ?? '').toString().trim(),
        cb_type: (r.at_cbtype ?? '').toString().trim(),
      };
    });

    return {
      success: true,
      bank_code: bc,
      repeat_entries: entries,
      count: entries.length,
    };
  } catch (err: any) {
    return {
      success: false,
      bank_code: bc,
      repeat_entries: [],
      count: 0,
      error: err?.message ?? String(err),
    };
  }
}

export async function updateRepeatEntryDate(
  appDb: Knex,
  operaDb: Knex,
  input: UpdateRepeatEntryDateInput,
): Promise<UpdateRepeatEntryDateResponse> {
  let bankCode: string;
  let entryRef: string;
  try {
    bankCode = validateBankCode(input.bankCode);
    entryRef = validateEntryNumber(input.entryRef);
  } catch (e) {
    if (e instanceof SqlInputValidationError) {
      return { success: false, error: e.message };
    }
    throw e;
  }

  const newDate = (input.newDate ?? '').trim();
  if (!DATE_RE.test(newDate)) {
    return {
      success: false,
      error: `Invalid date format: ${newDate}. Expected YYYY-MM-DD`,
    };
  }

  try {
    return await withImportLock(
      appDb,
      bankCode,
      { locked_by: 'api', endpoint: 'update-repeat-entry-date' },
      async () => {
        // Verify the entry exists
        const verifyRows = (await operaDb.raw(
          `SELECT ae_entry, ae_desc, ae_nxtpost
           FROM arhead WITH (NOLOCK)
           WHERE RTRIM(ae_entry) = ?
             AND RTRIM(ae_acnt) = ?`,
          [entryRef, bankCode],
        )) as unknown as Array<{
          ae_entry: string;
          ae_desc: string | null;
          ae_nxtpost: Date | string | null;
        }>;

        const existing = Array.isArray(verifyRows) ? verifyRows[0] : undefined;
        if (!existing) {
          return {
            success: false,
            error: `Repeat entry '${entryRef}' not found for bank '${bankCode}'`,
          };
        }

        const oldDate =
          existing.ae_nxtpost instanceof Date
            ? existing.ae_nxtpost.toISOString().slice(0, 10)
            : existing.ae_nxtpost
              ? String(existing.ae_nxtpost).slice(0, 10)
              : null;
        const description = (existing.ae_desc ?? '').toString().trim();

        // UPDATE arhead with audit fields — query-builder form so
        // rowsAffected is driver-agnostic (mssql/foxpro/sqlite).
        const rowsAffected = Number(
          await operaDb('arhead')
            .whereRaw('RTRIM(ae_entry) = ?', [entryRef])
            .andWhereRaw('RTRIM(ae_acnt) = ?', [bankCode])
            .update({
              ae_nxtpost: newDate,
              sq_amdate: operaDb.raw('CONVERT(varchar(10), GETDATE(), 23)'),
              sq_amtime: operaDb.raw('CONVERT(varchar(8), GETDATE(), 108)'),
              sq_amuser: 'BANKIMP',
            }),
        );
        if (rowsAffected === 0) {
          return {
            success: false,
            error: 'No rows updated - entry may have been modified',
          };
        }

        // Best-effort alias save
        let aliasSaved = false;
        const statementName = (input.statementName ?? '').trim();
        if (statementName) {
          try {
            const existingAlias = (await appDb('repeat_entry_aliases')
              .where({ bank_code: bankCode, memo_pattern: statementName })
              .first()) as { id: number } | undefined;
            if (existingAlias) {
              await appDb('repeat_entry_aliases')
                .where({ id: existingAlias.id })
                .update({
                  opera_repeat_ref: entryRef,
                  // description not in this table — keep schema simple
                });
              aliasSaved = true;
            } else {
              await appDb('repeat_entry_aliases').insert({
                bank_code: bankCode,
                memo_pattern: statementName,
                opera_repeat_ref: entryRef,
              });
              aliasSaved = true;
            }
          } catch {
            // best-effort — alias save failure doesn't fail the operation
          }
        }

        return {
          success: true,
          message: `Updated '${description}' next posting date to ${newDate}`,
          entry_ref: entryRef,
          old_date: oldDate,
          new_date: newDate,
          alias_saved: aliasSaved,
        };
      },
    );
  } catch (err: any) {
    if (err instanceof ImportLockError) {
      return { success: false, error: err.message };
    }
    return { success: false, error: err?.message ?? String(err) };
  }
}

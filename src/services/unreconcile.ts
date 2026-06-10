/**
 * Reverse a previously-reconciled batch.
 *
 * Faithful port of `unreconcile_entries` in
 * `apps/bank_reconcile/api/routes.py:981-1143`.
 *
 * Resets EVERY per-aentry rec field (ae_reclnum, ae_recdate, ae_recbal,
 * ae_statln, ae_frstat, ae_tostat, ae_tmpstat) for the supplied entry
 * numbers, then walks back to determine the prior batch's stamped
 * state and updates nbank to revert to it. If no entries remain
 * reconciled on this bank, nbank gets a fresh-bank reset.
 *
 * Locking:
 *   - Bank-level import lock acquired via withImportLock so Opera
 *     desktop concurrency is preserved
 *   - Single MSSQL transaction wraps both UPDATEs; rollback on error
 *   - Both UPDATEs use ROWLOCK per CLAUDE.md
 *
 * SQL injection guard:
 *   - bank_code validated by validateBankCode at the route boundary
 *   - Each entry number validated by validateEntryNumber
 *
 * Notes vs Python:
 *   - Python builds a single f-string IN (...) clause with the
 *     pre-validated entries. We use parameter binding (each entry
 *     becomes a `?` placeholder) which is strictly safer and matches
 *     the validators' belt-and-braces approach.
 */
import type { Knex } from 'knex';
import {
  validateBankCode,
  validateEntryNumber,
  SqlInputValidationError,
} from '../_shared/index.js';
import { withImportLock, ImportLockError } from './import-lock.js';

export interface UnreconcileInput {
  bankCode: string;
  entryNumbers: string[];
}

export interface UnreconcileResponse {
  success: boolean;
  message?: string;
  entries_unreconciled?: number;
  new_reconciled_balance?: number;
  error?: string;
}

interface PriorRow {
  lststno: number | null;
  lstrecdate: Date | string | null;
  reclnum: number | null;
  statln: number | null;
  recbal: number | null;
}

export async function unreconcileEntries(
  appDb: Knex,
  companyCode: string,
  operaDb: Knex,
  input: UnreconcileInput,
): Promise<UnreconcileResponse> {
  // SQL injection guard at the route boundary — same protection as
  // Python's validate_bank_code + validate_entry_number.
  let bankCode: string;
  let entryNumbers: string[];
  try {
    bankCode = validateBankCode(input.bankCode);
    entryNumbers = (input.entryNumbers ?? []).map(validateEntryNumber);
  } catch (e) {
    if (e instanceof SqlInputValidationError) {
      return { success: false, error: e.message };
    }
    throw e;
  }

  if (entryNumbers.length === 0) {
    return { success: false, error: 'entry_numbers is required (non-empty)' };
  }

  try {
    return await withImportLock(
      appDb,
      companyCode,
      bankCode,
      { locked_by: 'api', endpoint: 'unreconcile' },
      async () => {
        return operaDb.transaction(async (trx) => {
          // Stage A — reset per-aentry rec fields with ROWLOCK.
          // Query-builder form so rowsAffected is real on every driver.
          const rowsAffected = Number(
            await trx('aentry')
              .where('ae_acnt', bankCode)
              .whereIn('ae_entry', entryNumbers)
              .andWhere('ae_reclnum', '>', 0)
              .update({
                ae_reclnum: 0,
                ae_recdate: null,
                ae_recbal: 0,
                ae_statln: 0,
                ae_frstat: 0,
                ae_tostat: 0,
                ae_tmpstat: 0,
                datemodified: trx.raw('GETDATE()'),
              }),
          );

          // Recalculate the bank's reconciled total. Open-items rule:
          // exclude ae_remove=1 entries. Returns POUNDS even though
          // aentry stores pence — same as Python's coercion.
          const recalcRows = (await trx.raw(
            `SELECT COALESCE(SUM(ae_value), 0) AS reconciled_total
             FROM aentry WITH (NOLOCK)
             WHERE ae_acnt = ?
               AND ae_reclnum > 0
               AND ae_remove = 0`,
            [bankCode],
          )) as unknown as Array<{ reconciled_total: number | string | null }>;
          const newRecTotalPence = Number(
            recalcRows?.[0]?.reconciled_total ?? 0,
          );

          // Walk back to the prior batch's stamped state.
          const priorRows = (await trx.raw(
            `SELECT TOP 1
                ae_frstat   AS lststno,
                ae_recdate  AS lstrecdate,
                ae_reclnum  AS reclnum,
                ae_statln   AS statln,
                ae_recbal   AS recbal
             FROM aentry WITH (NOLOCK)
             WHERE ae_acnt = ?
               AND ae_reclnum > 0
               AND ae_remove = 0
             ORDER BY ae_frstat DESC, ae_recdate DESC, ae_statln DESC`,
            [bankCode],
          )) as unknown as PriorRow[];
          const prior = Array.isArray(priorRows) ? priorRows[0] : undefined;

          // Stage B — reset every nbank rec field, not just nk_recbal.
          if (prior) {
            const priorLststno = Number(prior.lststno ?? 0);
            const priorReclnum = Number(prior.reclnum ?? 0);
            const priorStatln = Number(prior.statln ?? 0);
            const priorRecdate = prior.lstrecdate;

            await trx.raw(
              `UPDATE nbank WITH (ROWLOCK)
               SET nk_recbal   = ?,
                   nk_reccfwd  = 0,
                   nk_lststno  = ?,
                   nk_lstrecl  = ?,
                   nk_reclnum  = ?,
                   nk_recldte  = ?,
                   nk_recstfr  = 0,
                   nk_recstto  = 0,
                   nk_recstdt  = NULL,
                   nk_recstln  = ?,
                   datemodified = GETDATE()
               WHERE RTRIM(nk_acnt) = ?`,
              [
                Math.trunc(newRecTotalPence),
                priorLststno,
                priorReclnum + 1,
                priorReclnum + 1,
                priorRecdate ?? null,
                priorStatln,
                bankCode,
              ],
            );
          } else {
            // Fresh-bank reset — every batch reversed.
            await trx.raw(
              `UPDATE nbank WITH (ROWLOCK)
               SET nk_recbal   = 0,
                   nk_reccfwd  = 0,
                   nk_lststno  = 0,
                   nk_lstrecl  = 1,
                   nk_reclnum  = 1,
                   nk_recldte  = NULL,
                   nk_recstfr  = 0,
                   nk_recstto  = 0,
                   nk_recstdt  = NULL,
                   nk_recstln  = 0,
                   datemodified = GETDATE()
               WHERE RTRIM(nk_acnt) = ?`,
              [bankCode],
            );
          }

          return {
            success: true,
            message: `Unreconciled ${rowsAffected} entries`,
            entries_unreconciled: rowsAffected,
            // aentry is in pence; nk_recbal display in pounds.
            new_reconciled_balance: newRecTotalPence / 100,
          };
        });
      },
    );
  } catch (err: any) {
    if (err instanceof ImportLockError) {
      return { success: false, error: err.message };
    }
    return { success: false, error: err?.message ?? String(err) };
  }
}

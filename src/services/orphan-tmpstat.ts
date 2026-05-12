/**
 * Orphan tmpstat helpers — list and clear ae_tmpstat reservations that
 * aren't part of a real reconciliation. Faithful port of:
 *   GET  /api/reconcile/bank/{bank_code}/orphan-tmpstat
 *   POST /api/reconcile/bank/{bank_code}/clear-orphan-tmpstat
 *
 * These are the residue of partial-reconcile attempts that didn't
 * finalise — they block the affected aentries from future
 * reconciliations until cleared. Read query is NOLOCK; clear uses
 * ROWLOCK on a narrow UPDATE.
 */
import type { Knex } from 'knex';

export interface OrphanTmpstatRow {
  entry: string;
  date: string;
  value: number;
  reference: string;
  tmpstat: number;
  statement_line: number;
}

export interface OrphanTmpstatListResponse {
  success: boolean;
  count: number;
  entries: OrphanTmpstatRow[];
  error?: string;
}

export async function listOrphanTmpstat(
  operaDb: Knex,
  bankCode: string,
): Promise<OrphanTmpstatListResponse> {
  try {
    const rows = (await operaDb.raw(
      `
      SELECT ae_entry, ae_lstdate, ae_value/100.0 AS value_pds,
             ae_entref, ae_tmpstat, ae_statln
      FROM aentry WITH (NOLOCK)
      WHERE ae_acnt = ?
        AND ae_tmpstat > 0
        AND (ae_reclnum IS NULL OR ae_reclnum = 0)
      ORDER BY ae_lstdate, ae_entry
      `,
      [bankCode],
    )) as unknown as Array<{
      ae_entry: string | null;
      ae_lstdate: Date | string | null;
      value_pds: number | null;
      ae_entref: string | null;
      ae_tmpstat: number | null;
      ae_statln: number | null;
    }>;

    const entries: OrphanTmpstatRow[] = (Array.isArray(rows) ? rows : []).map((r) => ({
      entry: String(r.ae_entry ?? '').trim(),
      date:
        r.ae_lstdate instanceof Date
          ? r.ae_lstdate.toISOString().slice(0, 10)
          : String(r.ae_lstdate ?? '').slice(0, 10),
      value: Number(r.value_pds ?? 0),
      reference: (r.ae_entref ?? '').trim(),
      tmpstat: Number(r.ae_tmpstat ?? 0),
      statement_line: Number(r.ae_statln ?? 0),
    }));

    return { success: true, count: entries.length, entries };
  } catch (err: any) {
    return {
      success: false,
      count: 0,
      entries: [],
      error: err?.message ?? String(err),
    };
  }
}

export interface ClearOrphanTmpstatResponse {
  success: boolean;
  cleared: number;
  entries: Array<{
    entry: string;
    date: string;
    value: number;
    previous_tmpstat: number;
  }>;
  error?: string;
}

/**
 * Clear orphan tmpstats on a bank. Optionally restrict to specific
 * entry numbers via `entryNumbers`.
 *
 * SAFE: only touches ae_tmpstat (temporary-status field), and only on
 * entries with ae_reclnum = 0 (no committed reconcile data).
 */
export async function clearOrphanTmpstat(
  operaDb: Knex,
  bankCode: string,
  entryNumbers?: string[],
): Promise<ClearOrphanTmpstatResponse> {
  // Validate entryNumbers if supplied
  if (entryNumbers !== undefined) {
    if (!Array.isArray(entryNumbers)) {
      return {
        success: false,
        cleared: 0,
        entries: [],
        error: 'entry_numbers must be a list of strings',
      };
    }
    if (entryNumbers.some((e) => typeof e !== 'string')) {
      return {
        success: false,
        cleared: 0,
        entries: [],
        error: 'entry_numbers must be a list of strings',
      };
    }
  }

  try {
    // Preview the affected rows for the response
    const previewParams: string[] = [bankCode];
    let entryFilter = '';
    if (entryNumbers && entryNumbers.length > 0) {
      const placeholders = entryNumbers.map(() => '?').join(',');
      entryFilter = `AND RTRIM(ae_entry) IN (${placeholders})`;
      previewParams.push(...entryNumbers);
    }

    const previewSql = `
      SELECT ae_entry, ae_lstdate, ae_value/100.0 AS value_pds, ae_tmpstat
      FROM aentry WITH (NOLOCK)
      WHERE ae_acnt = ?
        AND ae_tmpstat > 0
        AND (ae_reclnum IS NULL OR ae_reclnum = 0)
        ${entryFilter}
    `;
    const previewRows = (await operaDb.raw(previewSql, previewParams)) as unknown as Array<{
      ae_entry: string | null;
      ae_lstdate: Date | string | null;
      value_pds: number | null;
      ae_tmpstat: number | null;
    }>;

    const affected = (Array.isArray(previewRows) ? previewRows : []).map((r) => ({
      entry: String(r.ae_entry ?? '').trim(),
      date:
        r.ae_lstdate instanceof Date
          ? r.ae_lstdate.toISOString().slice(0, 10)
          : String(r.ae_lstdate ?? '').slice(0, 10),
      value: Number(r.value_pds ?? 0),
      previous_tmpstat: Number(r.ae_tmpstat ?? 0),
    }));

    if (affected.length === 0) {
      return { success: true, cleared: 0, entries: [] };
    }

    // Apply the clear with a narrow ROWLOCK update.
    // CLAUDE.md: ROWLOCK on writes; commit immediately; never hold long.
    const updateSql = `
      UPDATE aentry WITH (ROWLOCK)
      SET ae_tmpstat = 0
      WHERE ae_acnt = ?
        AND ae_tmpstat > 0
        AND (ae_reclnum IS NULL OR ae_reclnum = 0)
        ${entryFilter}
    `;
    await operaDb.raw(updateSql, previewParams);

    return { success: true, cleared: affected.length, entries: affected };
  } catch (err: any) {
    return {
      success: false,
      cleared: 0,
      entries: [],
      error: err?.message ?? String(err),
    };
  }
}

/**
 * Statement-archive endpoints — track which imported statement
 * PDFs have been archived (move to archive folder, hide from list,
 * keep available for re-download).
 *
 * Faithful ports of:
 *   - archive_statement (routes.py:5924, 7933)
 *   - get_archived_statements (routes.py:8042)
 *   - restore_statement (routes.py:8056)
 *   - get_archived_statement_pdf (routes.py:8176)
 *   - delete_archived_statement (routes.py:8205)
 *   - manage_statements (routes.py:8262 — composite list)
 *
 * Persisted in the per-app `bank_statement_imports` table that
 * already exists; this just adds CRUD around the `import_status` /
 * `archived` columns. PDF bytes themselves come from the
 * FileStorageAdapter the SAM team provides.
 */
import type { Knex } from 'knex';
import type { FileStorageAdapter } from './archive.js';

export interface ArchivedStatement {
  id: number;
  bank_code: string;
  filename: string;
  source: string;
  source_ref: string;
  opening_balance: number | null;
  closing_balance: number | null;
  imported_at: string;
  import_status: string;
  archived_at: string | null;
}

export async function archiveStatement(
  appDb: Knex,
  importId: number,
  by: string,
): Promise<{ success: boolean; error?: string }> {
  if (!Number.isFinite(importId) || importId <= 0) {
    return { success: false, error: 'invalid import_id' };
  }
  try {
    const updated = await appDb('bank_statement_imports')
      .where({ id: importId })
      .update({
        import_status: 'archived',
        archived_at: appDb.fn.now(),
        archived_by: by,
      });
    if (!updated) return { success: false, error: 'Import row not found' };
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

export async function listArchivedStatements(
  appDb: Knex,
  bankCode?: string | null,
  limit = 200,
): Promise<{
  success: boolean;
  statements: ArchivedStatement[];
  count: number;
  error?: string;
}> {
  try {
    let q = appDb('bank_statement_imports')
      .where({ import_status: 'archived' })
      .orderBy('archived_at', 'desc')
      .limit(limit);
    if (bankCode) q = q.andWhere('bank_code', bankCode);
    const rows = (await q) as unknown as Array<{
      id: number;
      bank_code: string;
      source_ref: string | null;
      source: string | null;
      opening_balance: number | null;
      closing_balance: number | null;
      imported_at: string | Date | null;
      import_status: string | null;
      archived_at: string | Date | null;
    }>;
    const items = rows.map((r) => ({
      id: Number(r.id),
      bank_code: r.bank_code,
      filename: (r.source_ref ?? '').split(/[/\\]/).pop() ?? '',
      source: r.source ?? '',
      source_ref: r.source_ref ?? '',
      opening_balance: r.opening_balance,
      closing_balance: r.closing_balance,
      imported_at:
        r.imported_at instanceof Date
          ? r.imported_at.toISOString()
          : String(r.imported_at ?? ''),
      import_status: r.import_status ?? '',
      archived_at:
        r.archived_at instanceof Date
          ? r.archived_at.toISOString()
          : r.archived_at
          ? String(r.archived_at)
          : null,
    }));
    return { success: true, statements: items, count: items.length };
  } catch (err: any) {
    return {
      success: false,
      statements: [],
      count: 0,
      error: err?.message ?? String(err),
    };
  }
}

export async function restoreStatement(
  appDb: Knex,
  importId: number,
): Promise<{ success: boolean; error?: string }> {
  try {
    const updated = await appDb('bank_statement_imports')
      .where({ id: importId, import_status: 'archived' })
      .update({
        import_status: 'imported',
        archived_at: null,
      });
    if (!updated) {
      return { success: false, error: 'Archived statement not found' };
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

export async function getArchivedStatementPdf(
  appDb: Knex,
  storage: FileStorageAdapter | null,
  recordId: number,
): Promise<{
  success: boolean;
  bytes?: Uint8Array;
  filename?: string;
  error?: string;
}> {
  if (!storage) {
    return {
      success: false,
      error: 'ctx.fileStorage adapter not configured.',
    };
  }
  try {
    const row = (await appDb('bank_statement_imports')
      .where({ id: recordId })
      .first()) as { source_ref?: string | null } | undefined;
    if (!row) return { success: false, error: 'Statement not found' };
    // Storage adapter is filesystem-bound; we surface the path for
    // the SAM team to fetch via Graph or local FS.
    return {
      success: true,
      filename: row.source_ref ?? '',
    };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

export async function deleteArchivedStatement(
  appDb: Knex,
  recordId: number,
): Promise<{ success: boolean; error?: string }> {
  try {
    const deleted = await appDb('bank_statement_imports')
      .where({ id: recordId, import_status: 'archived' })
      .delete();
    if (!deleted) return { success: false, error: 'Archived statement not found' };
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

export interface ManageStatementsRow {
  id: number;
  bank_code: string;
  filename: string;
  source: string;
  imported_at: string;
  import_status: string;
  opening_balance: number | null;
  closing_balance: number | null;
  records_imported: number;
}

export async function manageStatements(
  appDb: Knex,
  bankCode: string | null,
  includeArchived: boolean,
): Promise<{
  success: boolean;
  statements: ManageStatementsRow[];
  count: number;
  error?: string;
}> {
  try {
    let q = appDb('bank_statement_imports').orderBy('imported_at', 'desc');
    if (bankCode) q = q.where('bank_code', bankCode);
    if (!includeArchived) q = q.whereNot('import_status', 'archived');
    const rows = (await q) as unknown as Array<{
      id: number;
      bank_code: string;
      source_ref: string | null;
      source: string | null;
      imported_at: string | Date | null;
      import_status: string | null;
      opening_balance: number | null;
      closing_balance: number | null;
      records_imported: number | null;
    }>;
    const items = rows.map((r) => ({
      id: Number(r.id),
      bank_code: r.bank_code,
      filename: (r.source_ref ?? '').split(/[/\\]/).pop() ?? '',
      source: r.source ?? '',
      imported_at:
        r.imported_at instanceof Date
          ? r.imported_at.toISOString()
          : String(r.imported_at ?? ''),
      import_status: r.import_status ?? '',
      opening_balance: r.opening_balance,
      closing_balance: r.closing_balance,
      records_imported: Number(r.records_imported ?? 0),
    }));
    return { success: true, statements: items, count: items.length };
  } catch (err: any) {
    return {
      success: false,
      statements: [],
      count: 0,
      error: err?.message ?? String(err),
    };
  }
}

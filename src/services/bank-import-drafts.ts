/**
 * Bank-import drafts — save/load/delete work-in-progress state.
 *
 * Faithful port of `EmailStorage.save_import_draft / load_import_draft
 * / delete_import_draft / get_draft_statement_keys` in
 * `api/email/storage.py:2724-2870`, plus the wrapping endpoints in
 * `apps/bank_reconcile/api/routes.py:3297-3416`.
 *
 * Used by the multi-stage bank-statement reconciliation UI: the user
 * can preview a statement, edit matched assignments, then close the
 * tab; on return the draft is loaded so they continue where they left
 * off. Identifying key is (bank_code, source, email_id, attachment_id,
 * pdf_hash, filename).
 *
 * preview_data + user_edits are stored as JSON strings (mirrors Python
 * which serialises them with json.dumps before writing to SQLite).
 */
import type { Knex } from 'knex';

export interface DraftKey {
  bankCode: string;
  source: string; // 'email' | 'file'
  emailId?: number | string | null;
  attachmentId?: string | null;
  pdfHash?: string | null;
  filename?: string | null;
}

export interface SaveDraftInput extends DraftKey {
  filename: string; // required for save
  previewData: unknown; // any JSON-serialisable value
  userEdits: unknown;
  targetSystem?: string;
}

export interface SaveDraftResponse {
  success: boolean;
  draft_id?: number;
  error?: string;
}

export interface LoadedDraft {
  id: number;
  preview_data: unknown;
  user_edits: unknown;
  updated_at: string;
}

export interface LoadDraftResponse {
  success: boolean;
  has_draft?: boolean;
  draft?: LoadedDraft;
  error?: string;
}

export interface DeleteDraftResponse {
  success: boolean;
  deleted?: boolean;
  error?: string;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function normaliseKey(k: DraftKey): {
  bank_code: string;
  source: string;
  email_id: string;
  attachment_id: string;
  pdf_hash: string;
  filename: string;
} {
  return {
    bank_code: (k.bankCode ?? '').trim(),
    source: (k.source ?? '').trim(),
    email_id: k.emailId == null ? '' : String(k.emailId),
    attachment_id: (k.attachmentId ?? '').trim(),
    pdf_hash: (k.pdfHash ?? '').trim(),
    filename: (k.filename ?? '').trim(),
  };
}

function safeStringify(value: unknown): string {
  if (value === undefined || value === null) return '{}';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

function safeParse<T = unknown>(value: unknown, fallback: T): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------
// save
// ---------------------------------------------------------------------

export async function saveImportDraft(
  appDb: Knex,
  input: SaveDraftInput,
): Promise<SaveDraftResponse> {
  const key = normaliseKey(input);
  if (!key.bank_code || !key.source || !key.filename) {
    return {
      success: false,
      error: 'bank_code, source, and filename are required',
    };
  }
  try {
    const previewJson = safeStringify(input.previewData);
    const editsJson = safeStringify(input.userEdits);
    const targetSystem = input.targetSystem ?? 'opera_se';

    // Upsert by composite key — MSSQL doesn't have ON CONFLICT, so do
    // an existence-check + UPDATE / INSERT pair.
    const existing = (await appDb('bank_import_drafts')
      .where(key)
      .first()) as { id: number } | undefined;

    if (existing) {
      await appDb('bank_import_drafts').where({ id: existing.id }).update({
        preview_data: previewJson,
        user_edits: editsJson,
        target_system: targetSystem,
        updated_at: appDb.fn.now(),
      });
      return { success: true, draft_id: existing.id };
    }

    const inserted = await appDb('bank_import_drafts')
      .insert({
        ...key,
        preview_data: previewJson,
        user_edits: editsJson,
        target_system: targetSystem,
      })
      .returning('id');

    const newId =
      Array.isArray(inserted) && inserted.length > 0
        ? typeof inserted[0] === 'object'
          ? (inserted[0] as { id: number }).id
          : Number(inserted[0])
        : 0;
    return { success: true, draft_id: newId };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------
// load
// ---------------------------------------------------------------------

interface DraftRow {
  id: number;
  preview_data: string | null;
  user_edits: string | null;
  updated_at: Date | string;
}

export async function loadImportDraft(
  appDb: Knex,
  input: DraftKey,
): Promise<LoadDraftResponse> {
  const key = normaliseKey({ ...input, filename: input.filename ?? '' });
  if (!key.bank_code || !key.source) {
    return {
      success: false,
      error: 'bank_code and source are required',
    };
  }
  try {
    let query = appDb('bank_import_drafts').where({
      bank_code: key.bank_code,
      source: key.source,
    });

    // Python only adds the optional filters when their input is not None,
    // so a `null` from the caller means "match any value". Mirror that.
    if (input.emailId !== undefined && input.emailId !== null) {
      query = query.andWhere('email_id', String(input.emailId));
    }
    if (input.attachmentId !== undefined && input.attachmentId !== null) {
      query = query.andWhere('attachment_id', input.attachmentId);
    }
    if (input.pdfHash !== undefined && input.pdfHash !== null) {
      query = query.andWhere('pdf_hash', input.pdfHash);
    }
    if (input.filename !== undefined && input.filename !== null) {
      query = query.andWhere('filename', input.filename);
    }

    const rows = (await query
      .orderBy('updated_at', 'desc')
      .limit(1)
      .select('id', 'preview_data', 'user_edits', 'updated_at')) as unknown as DraftRow[];

    if (!Array.isArray(rows) || rows.length === 0) {
      return { success: true, has_draft: false };
    }
    const row = rows[0]!;
    const updatedAt =
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : String(row.updated_at);
    return {
      success: true,
      has_draft: true,
      draft: {
        id: row.id,
        preview_data: safeParse(row.preview_data, {}),
        user_edits: safeParse(row.user_edits, {}),
        updated_at: updatedAt,
      },
    };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------

export async function deleteImportDraft(
  appDb: Knex,
  input: DraftKey,
): Promise<DeleteDraftResponse> {
  const key = normaliseKey({ ...input, filename: input.filename ?? '' });
  if (!key.bank_code || !key.source) {
    return {
      success: false,
      error: 'bank_code and source are required',
    };
  }
  try {
    let query = appDb('bank_import_drafts').where({
      bank_code: key.bank_code,
      source: key.source,
    });
    if (input.emailId !== undefined && input.emailId !== null) {
      query = query.andWhere('email_id', String(input.emailId));
    }
    if (input.attachmentId !== undefined && input.attachmentId !== null) {
      query = query.andWhere('attachment_id', input.attachmentId);
    }
    if (input.pdfHash !== undefined && input.pdfHash !== null) {
      query = query.andWhere('pdf_hash', input.pdfHash);
    }
    if (input.filename !== undefined && input.filename !== null) {
      query = query.andWhere('filename', input.filename);
    }
    const rowCount = await query.delete();
    return { success: true, deleted: Number(rowCount) > 0 };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

// ---------------------------------------------------------------------
// get_draft_statement_keys (used by statement-list UIs to mark "in progress")
// ---------------------------------------------------------------------

export interface DraftStatementKey {
  source: string;
  email_id: string;
  attachment_id: string;
  pdf_hash: string;
  filename: string;
  updated_at: string;
}

export async function getDraftStatementKeys(
  appDb: Knex,
  bankCode: string,
): Promise<DraftStatementKey[]> {
  if (!bankCode) return [];
  try {
    const rows = (await appDb('bank_import_drafts')
      .where({ bank_code: bankCode })
      .orderBy('updated_at', 'desc')
      .select(
        'source',
        'email_id',
        'attachment_id',
        'pdf_hash',
        'filename',
        'updated_at',
      )) as unknown as Array<{
      source: string | null;
      email_id: string | null;
      attachment_id: string | null;
      pdf_hash: string | null;
      filename: string | null;
      updated_at: Date | string;
    }>;

    return rows.map((r) => ({
      source: r.source ?? '',
      email_id: r.email_id ?? '',
      attachment_id: r.attachment_id ?? '',
      pdf_hash: r.pdf_hash ?? '',
      filename: r.filename ?? '',
      updated_at:
        r.updated_at instanceof Date
          ? r.updated_at.toISOString()
          : String(r.updated_at),
    }));
  } catch {
    return [];
  }
}

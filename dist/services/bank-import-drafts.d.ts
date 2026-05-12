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
    source: string;
    emailId?: number | string | null;
    attachmentId?: string | null;
    pdfHash?: string | null;
    filename?: string | null;
}
export interface SaveDraftInput extends DraftKey {
    filename: string;
    previewData: unknown;
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
export declare function saveImportDraft(appDb: Knex, input: SaveDraftInput): Promise<SaveDraftResponse>;
export declare function loadImportDraft(appDb: Knex, input: DraftKey): Promise<LoadDraftResponse>;
export declare function deleteImportDraft(appDb: Knex, input: DraftKey): Promise<DeleteDraftResponse>;
export interface DraftStatementKey {
    source: string;
    email_id: string;
    attachment_id: string;
    pdf_hash: string;
    filename: string;
    updated_at: string;
}
export declare function getDraftStatementKeys(appDb: Knex, bankCode: string): Promise<DraftStatementKey[]>;
//# sourceMappingURL=bank-import-drafts.d.ts.map
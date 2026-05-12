// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function normaliseKey(k) {
    return {
        bank_code: (k.bankCode ?? '').trim(),
        source: (k.source ?? '').trim(),
        email_id: k.emailId == null ? '' : String(k.emailId),
        attachment_id: (k.attachmentId ?? '').trim(),
        pdf_hash: (k.pdfHash ?? '').trim(),
        filename: (k.filename ?? '').trim(),
    };
}
function safeStringify(value) {
    if (value === undefined || value === null)
        return '{}';
    if (typeof value === 'string')
        return value;
    try {
        return JSON.stringify(value);
    }
    catch {
        return '{}';
    }
}
function safeParse(value, fallback) {
    if (value === undefined || value === null)
        return fallback;
    if (typeof value !== 'string')
        return value;
    try {
        return JSON.parse(value);
    }
    catch {
        return fallback;
    }
}
// ---------------------------------------------------------------------
// save
// ---------------------------------------------------------------------
export async function saveImportDraft(appDb, input) {
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
            .first());
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
        const newId = Array.isArray(inserted) && inserted.length > 0
            ? typeof inserted[0] === 'object'
                ? inserted[0].id
                : Number(inserted[0])
            : 0;
        return { success: true, draft_id: newId };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
export async function loadImportDraft(appDb, input) {
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
            .select('id', 'preview_data', 'user_edits', 'updated_at'));
        if (!Array.isArray(rows) || rows.length === 0) {
            return { success: true, has_draft: false };
        }
        const row = rows[0];
        const updatedAt = row.updated_at instanceof Date
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
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
// ---------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------
export async function deleteImportDraft(appDb, input) {
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
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
export async function getDraftStatementKeys(appDb, bankCode) {
    if (!bankCode)
        return [];
    try {
        const rows = (await appDb('bank_import_drafts')
            .where({ bank_code: bankCode })
            .orderBy('updated_at', 'desc')
            .select('source', 'email_id', 'attachment_id', 'pdf_hash', 'filename', 'updated_at'));
        return rows.map((r) => ({
            source: r.source ?? '',
            email_id: r.email_id ?? '',
            attachment_id: r.attachment_id ?? '',
            pdf_hash: r.pdf_hash ?? '',
            filename: r.filename ?? '',
            updated_at: r.updated_at instanceof Date
                ? r.updated_at.toISOString()
                : String(r.updated_at),
        }));
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=bank-import-drafts.js.map
export async function recordDuplicateOverride(appDb, input) {
    const transactionHash = (input.transactionHash ?? '').trim();
    const reason = (input.reason ?? '').trim();
    if (!transactionHash) {
        return { success: false, error: 'transaction_hash is required' };
    }
    if (!reason) {
        return { success: false, error: 'reason is required' };
    }
    try {
        // Mirror Python's INSERT OR REPLACE semantics: if a row exists for
        // this hash, update its reason + timestamp; otherwise insert. MSSQL
        // doesn't have INSERT OR REPLACE so we do an explicit
        // existence-check + update/insert pair.
        const existing = (await appDb('duplicate_overrides')
            .where({ transaction_hash: transactionHash })
            .first());
        if (existing) {
            await appDb('duplicate_overrides')
                .where({ id: existing.id })
                .update({
                override_reason: reason,
                user_code: input.userCode ?? null,
                created_at: appDb.fn.now(),
            });
        }
        else {
            await appDb('duplicate_overrides').insert({
                transaction_hash: transactionHash,
                override_reason: reason,
                user_code: input.userCode ?? null,
            });
        }
        return { success: true, message: 'Duplicate override recorded' };
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
export async function getDuplicateOverride(appDb, transactionHash) {
    if (!transactionHash)
        return null;
    try {
        const row = (await appDb('duplicate_overrides')
            .where({ transaction_hash: transactionHash })
            .first());
        return row ?? null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=duplicate-override.js.map
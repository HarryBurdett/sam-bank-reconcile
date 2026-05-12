export async function listCashbookTypes(operaDb, category = null) {
    try {
        let sql = `
      SELECT ay_cbtype, ay_desc, ay_type, ay_batched
      FROM atype WITH (NOLOCK)
    `;
        const params = [];
        if (category) {
            sql += ' WHERE RTRIM(ay_type) = ?';
            params.push(category);
        }
        sql += ' ORDER BY ay_type, ay_cbtype';
        const rows = (await operaDb.raw(sql, params));
        if (!Array.isArray(rows) || rows.length === 0) {
            return { success: true, types: [] };
        }
        const types = rows.map((r) => ({
            code: (r.ay_cbtype ?? '').trim(),
            description: (r.ay_desc ?? '').trim(),
            category: (r.ay_type ?? '').trim(),
            batched: !!r.ay_batched,
        }));
        return { success: true, types };
    }
    catch (err) {
        return {
            success: false,
            types: [],
            error: err?.message ?? String(err),
        };
    }
}
//# sourceMappingURL=cashbook-types.js.map
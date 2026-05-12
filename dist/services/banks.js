export async function listBanks(operaDb) {
    try {
        const rows = (await operaDb.raw(`
      SELECT nk_acnt AS account_code, RTRIM(nk_desc) AS description,
             nk_sort AS sort_code, nk_number AS account_number
      FROM nbank WITH (NOLOCK)
      ORDER BY nk_acnt
    `));
        const banks = (Array.isArray(rows) ? rows : []).map((b) => ({
            account_code: (b.account_code ?? '').trim(),
            description: (b.description ?? '').trim(),
            sort_code: (b.sort_code ?? '').trim(),
            account_number: (b.account_number ?? '').trim(),
        }));
        return { success: true, banks };
    }
    catch (err) {
        return { success: false, banks: [], error: err?.message ?? String(err) };
    }
}
//# sourceMappingURL=banks.js.map
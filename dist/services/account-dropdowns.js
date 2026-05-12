export async function getCustomersForDropdown(operaDb) {
    try {
        const rows = (await operaDb.raw(`
      SELECT
        RTRIM(sn_account) as code,
        RTRIM(sn_name) as name,
        RTRIM(ISNULL(sn_key1, '')) as search_key
      FROM sname WITH (NOLOCK)
      WHERE (sn_stop = 0 OR sn_stop IS NULL)
        AND (sn_dormant = 0 OR sn_dormant IS NULL)
      ORDER BY sn_account
    `));
        const accounts = (Array.isArray(rows) ? rows : []).map((r) => ({
            code: (r.code ?? '').trim(),
            name: (r.name ?? '').trim(),
            search_key: (r.search_key ?? '').trim(),
            display: `${(r.code ?? '').trim()} - ${(r.name ?? '').trim()}`,
        }));
        return { success: true, count: accounts.length, accounts };
    }
    catch (err) {
        return {
            success: false,
            count: 0,
            accounts: [],
            error: err?.message ?? String(err),
        };
    }
}
export async function getSuppliersForDropdown(operaDb) {
    try {
        const rows = (await operaDb.raw(`
      SELECT
        RTRIM(pn_account) as code,
        RTRIM(pn_name) as name,
        RTRIM(ISNULL(pn_payee, '')) as payee
      FROM pname WITH (NOLOCK)
      WHERE (pn_stop = 0 OR pn_stop IS NULL)
        AND (pn_dormant = 0 OR pn_dormant IS NULL)
      ORDER BY pn_account
    `));
        const accounts = (Array.isArray(rows) ? rows : []).map((r) => ({
            code: (r.code ?? '').trim(),
            name: (r.name ?? '').trim(),
            payee: (r.payee ?? '').trim(),
            display: `${(r.code ?? '').trim()} - ${(r.name ?? '').trim()}`,
        }));
        return { success: true, count: accounts.length, accounts };
    }
    catch (err) {
        return {
            success: false,
            count: 0,
            accounts: [],
            error: err?.message ?? String(err),
        };
    }
}
//# sourceMappingURL=account-dropdowns.js.map
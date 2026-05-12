const APP_NAME = 'bank_reconcile';
const MAX_ORPHANS_RETURNED = 50;
function deriveOverallHealthy(checks) {
    return checks.every((c) => c.passed || c.severity !== 'error');
}
function summarise(app, checks) {
    const errors = checks.filter((c) => !c.passed && c.severity === 'error').length;
    const warnings = checks.filter((c) => !c.passed && c.severity === 'warning').length;
    if (errors === 0 && warnings === 0)
        return `${app}: all checks passed`;
    return `${app}: ${errors} error(s), ${warnings} warning(s)`;
}
async function fetchValidCodes(operaDb, table, col) {
    try {
        const rows = (await operaDb.raw(`SELECT RTRIM(${col}) AS code FROM ${table} WITH (NOLOCK)`));
        const set = new Set();
        for (const row of Array.isArray(rows) ? rows : []) {
            const code = (row.code ?? '').trim();
            if (code)
                set.add(code);
        }
        return set;
    }
    catch {
        return new Set();
    }
}
async function checkBankAliases(appDb, validBankCodes, validCustomerCodes, validSupplierCodes) {
    const items = [];
    let rows;
    try {
        rows = (await appDb('bank_import_aliases').select('bank_name', 'account_code', 'ledger_type', 'bank_code'));
    }
    catch (err) {
        items.push({
            name: 'Bank aliases',
            description: `Could not read bank_import_aliases: ${err?.message ?? String(err)}`,
            passed: false,
            severity: 'error',
        });
        return items;
    }
    if (!rows.length) {
        items.push({
            name: 'Bank aliases',
            description: 'No aliases learned yet — nothing to check',
            passed: true,
            severity: 'info',
        });
        return items;
    }
    // Bank-code orphans
    const bankOrphans = [];
    let bankOrphanTotal = 0;
    for (const r of rows) {
        const bc = (r.bank_code ?? '').trim();
        if (bc && !validBankCodes.has(bc)) {
            bankOrphanTotal += 1;
            if (bankOrphans.length < MAX_ORPHANS_RETURNED) {
                bankOrphans.push({
                    bank_name: r.bank_name,
                    bank_code: bc,
                    reason: `bank_code '${bc}' not in Opera nbank`,
                });
            }
        }
    }
    items.push({
        name: 'Alias bank codes',
        description: 'Bank codes used in alias rows must exist in Opera nbank',
        passed: bankOrphanTotal === 0,
        total_checked: rows.length,
        orphan_count: bankOrphanTotal,
        orphans: bankOrphans,
        severity: 'warning',
    });
    // Customer orphans
    const custRows = rows.filter((r) => (r.ledger_type ?? '').toUpperCase() === 'C');
    const custOrphans = [];
    let custOrphanTotal = 0;
    for (const r of custRows) {
        const ac = (r.account_code ?? '').trim();
        if (ac && !validCustomerCodes.has(ac)) {
            custOrphanTotal += 1;
            if (custOrphans.length < MAX_ORPHANS_RETURNED) {
                custOrphans.push({
                    bank_name: r.bank_name,
                    account_code: ac,
                    reason: `customer '${ac}' not in Opera sname`,
                });
            }
        }
    }
    items.push({
        name: 'Alias customer codes',
        description: 'Customer codes (ledger_type C) in aliases must exist in Opera sname',
        passed: custOrphanTotal === 0,
        total_checked: custRows.length,
        orphan_count: custOrphanTotal,
        orphans: custOrphans,
        severity: 'warning',
    });
    // Supplier orphans
    const supRows = rows.filter((r) => (r.ledger_type ?? '').toUpperCase() === 'S');
    const supOrphans = [];
    let supOrphanTotal = 0;
    for (const r of supRows) {
        const ac = (r.account_code ?? '').trim();
        if (ac && !validSupplierCodes.has(ac)) {
            supOrphanTotal += 1;
            if (supOrphans.length < MAX_ORPHANS_RETURNED) {
                supOrphans.push({
                    bank_name: r.bank_name,
                    account_code: ac,
                    reason: `supplier '${ac}' not in Opera pname`,
                });
            }
        }
    }
    items.push({
        name: 'Alias supplier codes',
        description: 'Supplier codes (ledger_type S) in aliases must exist in Opera pname',
        passed: supOrphanTotal === 0,
        total_checked: supRows.length,
        orphan_count: supOrphanTotal,
        orphans: supOrphans,
        severity: 'warning',
    });
    return items;
}
async function checkBankPatterns(appDb, validCustomerCodes, validSupplierCodes, validNominalCodes) {
    let rows;
    try {
        rows = (await appDb('bank_import_patterns')
            .select('account_code', 'opera_account')
            .whereNotNull('account_code'));
    }
    catch {
        return [
            {
                name: 'Pattern learning',
                description: 'No learned patterns to check (or table missing — fine for new installs)',
                passed: true,
                severity: 'info',
            },
        ];
    }
    if (!rows.length) {
        return [
            {
                name: 'Pattern learning',
                description: 'No patterns learned yet — nothing to check',
                passed: true,
                severity: 'info',
            },
        ];
    }
    const orphans = [];
    let orphanTotal = 0;
    for (const r of rows) {
        const code = (r.account_code ?? '').trim();
        const ledger = (r.ledger_type ?? '').toUpperCase();
        if (!code)
            continue;
        const valid = (ledger === 'C' && validCustomerCodes.has(code)) ||
            (ledger === 'S' && validSupplierCodes.has(code)) ||
            (ledger === 'N' && validNominalCodes.has(code)) ||
            (!ledger &&
                (validCustomerCodes.has(code) ||
                    validSupplierCodes.has(code) ||
                    validNominalCodes.has(code)));
        if (!valid) {
            orphanTotal += 1;
            if (orphans.length < MAX_ORPHANS_RETURNED) {
                orphans.push({
                    account_code: code,
                    ledger_type: ledger || '(unset)',
                    reason: 'Account code not found in any Opera ledger',
                });
            }
        }
    }
    return [
        {
            name: 'Pattern learning',
            description: 'Learned-pattern account codes must exist in Opera ledgers',
            passed: orphanTotal === 0,
            total_checked: rows.length,
            orphan_count: orphanTotal,
            orphans,
            severity: 'warning',
        },
    ];
}
async function checkAuditBankCodes(appDb, validBankCodes) {
    let rows;
    try {
        rows = (await appDb('bank_statement_imports')
            .distinct('bank_code')
            .whereNotNull('bank_code'));
    }
    catch (err) {
        return {
            name: 'Statement import history',
            description: `Skipped — could not read bank_statement_imports (${err?.message ?? String(err)})`,
            passed: true,
            severity: 'info',
        };
    }
    if (!rows.length) {
        return {
            name: 'Statement import history',
            description: 'No statement-import history yet — nothing to check',
            passed: true,
            severity: 'info',
        };
    }
    const orphans = [];
    for (const r of rows) {
        const bc = (r.bank_code ?? '').trim();
        if (bc && !validBankCodes.has(bc)) {
            if (orphans.length < MAX_ORPHANS_RETURNED) {
                orphans.push({
                    bank_code: bc,
                    reason: `bank_code '${bc}' from import history not in current Opera nbank`,
                });
            }
        }
    }
    return {
        name: 'Statement import history',
        description: 'Bank codes in import history must still exist in Opera (for dedup)',
        passed: orphans.length === 0,
        total_checked: rows.length,
        orphan_count: orphans.length,
        orphans,
        severity: 'warning',
    };
}
function checkOperaCodesPresent(validBankCodes, validCustomerCodes, validSupplierCodes, validNominalCodes) {
    if (validBankCodes.size === 0 && validCustomerCodes.size === 0) {
        return {
            name: 'Opera connection',
            description: 'Opera returned no bank or customer codes — connection or schema broken',
            passed: false,
            severity: 'error',
        };
    }
    return {
        name: 'Opera connection',
        description: `Opera returned ${validBankCodes.size} banks, ${validCustomerCodes.size} customers, ` +
            `${validSupplierCodes.size} suppliers, ${validNominalCodes.size} nominal accounts`,
        passed: true,
        severity: 'info',
    };
}
export async function runHealthCheck(opts) {
    const checks = [];
    const validBankCodes = await fetchValidCodes(opts.operaDb, 'nbank', 'nk_acnt');
    const validCustomerCodes = await fetchValidCodes(opts.operaDb, 'sname', 'sn_account');
    const validSupplierCodes = await fetchValidCodes(opts.operaDb, 'pname', 'pn_account');
    const validNominalCodes = await fetchValidCodes(opts.operaDb, 'nacnt', 'na_acnt');
    if (opts.appDb) {
        checks.push(...(await checkBankAliases(opts.appDb, validBankCodes, validCustomerCodes, validSupplierCodes)));
        checks.push(...(await checkBankPatterns(opts.appDb, validCustomerCodes, validSupplierCodes, validNominalCodes)));
        checks.push(await checkAuditBankCodes(opts.appDb, validBankCodes));
    }
    else {
        checks.push({
            name: 'Bank aliases',
            description: 'Skipped — bank-reconcile app database not available for this tenant',
            passed: true,
            severity: 'info',
        });
    }
    checks.push(checkOperaCodesPresent(validBankCodes, validCustomerCodes, validSupplierCodes, validNominalCodes));
    return {
        app: APP_NAME,
        healthy: deriveOverallHealthy(checks),
        summary: summarise(APP_NAME, checks),
        checks,
        metadata: {
            checked_at: new Date().toISOString(),
            opera_bank_count: validBankCodes.size,
            opera_customer_count: validCustomerCodes.size,
            opera_supplier_count: validSupplierCodes.size,
            opera_nominal_count: validNominalCodes.size,
        },
    };
}
//# sourceMappingURL=health-check.js.map
export async function findExistingCycleRow(appDb, bankCode, periodStart) {
    if (!periodStart)
        return null;
    const row = (await appDb('bank_statement_imports')
        .select('id', 'is_reconciled', 'period_end', 'closing_balance')
        .where({ bank_code: bankCode, period_start: periodStart })
        .orderBy('id', 'desc')
        .first());
    if (!row)
        return null;
    return {
        id: Number(row.id),
        is_reconciled: Number(row.is_reconciled),
        period_end: row.period_end ? String(row.period_end) : null,
        closing_balance: row.closing_balance !== null && row.closing_balance !== undefined
            ? Number(row.closing_balance)
            : null,
    };
}
//# sourceMappingURL=cycle-row-lookup.js.map
import { markEntriesReconciled, } from './mark-reconciled.js';
import { getReconciliationStatus } from './reconciliation-status.js';
/**
 * Compute statement line numbers (ae_statln) for matched entries with
 * gap-aware spacing for unmatched lines that may be added later in
 * Opera. Pure function — exposed for unit testing.
 *
 * Faithful port of `calculate_statement_line_numbers`. Opera convention:
 * matched lines get 10, 20, 30... with gaps preserved for the
 * unmatched lines that fell before them on the statement.
 */
export function calculateStatementLineNumbers(totalLines, matchedPositions, unmatchedPositions) {
    const lineNumbers = new Map();
    const matchedSet = new Set(matchedPositions);
    const unmatchedSet = new Set(unmatchedPositions);
    let currentLine = 0;
    for (let pos = 1; pos <= totalLines; pos++) {
        if (!matchedSet.has(pos))
            continue;
        let unmatchedBefore = 0;
        for (const p of unmatchedSet) {
            if (p < pos)
                unmatchedBefore += 1;
        }
        let minLine = (unmatchedBefore + 1) * 10;
        if (currentLine >= minLine) {
            minLine = currentLine + 10;
        }
        lineNumbers.set(pos, minLine);
        currentLine = minLine;
    }
    return lineNumbers;
}
export async function completeReconciliation(operaDb, appDb, input) {
    const matchedEntries = input.matchedEntries ?? [];
    if (matchedEntries.length === 0) {
        return {
            success: false,
            errors: ['No entries to reconcile'],
            error: 'No entries to reconcile',
        };
    }
    // 1. Fetch current bank state
    const status = await getReconciliationStatus(operaDb, input.bankCode);
    if (!status.success) {
        return {
            success: false,
            errors: [status.error ?? 'Could not fetch reconciliation status'],
            error: status.error,
        };
    }
    const expectedOpening = Number(status.reconciled_balance ?? 0);
    // 2. Read aentry values for the matched entries
    const entryNumbers = matchedEntries
        .map((e) => (e.entry_number ?? '').toString().trim())
        .filter(Boolean);
    if (entryNumbers.length === 0) {
        return {
            success: false,
            errors: ['No valid entry numbers in matched_entries'],
            error: 'No valid entry numbers in matched_entries',
        };
    }
    const valueRows = (await operaDb('aentry')
        .where({ ae_acnt: input.bankCode })
        .whereIn('ae_entry', entryNumbers)
        .select('ae_entry', 'ae_value'));
    if (!valueRows || valueRows.length === 0) {
        return {
            success: false,
            errors: ['Could not find entries to reconcile'],
            error: 'Could not find entries to reconcile',
        };
    }
    // Period-bound guard on at_pstdate. Faithful port of
    // routes.py:10894 F12 — the canonical post date lives in
    // atran.at_pstdate (joined to aentry via at_entry+at_acnt).
    // ae_lstdate is bumped by ANY Opera operation so it's an
    // inconsistent gate vs the matcher and duplicate-check (both use
    // at_pstdate). Refuse to reconcile entries whose post date falls
    // outside the supplied period.
    if (input.periodStart && input.periodEnd) {
        try {
            const dateRows = (await operaDb.raw(`SELECT a.ae_entry AS ae_entry, MIN(t.at_pstdate) AS pstdate
         FROM aentry a WITH (NOLOCK)
         JOIN atran t WITH (NOLOCK)
           ON a.ae_acnt = t.at_acnt AND a.ae_entry = t.at_entry
         WHERE a.ae_acnt = ?
           AND RTRIM(a.ae_entry) IN (${entryNumbers.map(() => '?').join(',')})
         GROUP BY a.ae_entry`, [input.bankCode, ...entryNumbers]));
            const dateByEntry = new Map();
            if (Array.isArray(dateRows)) {
                for (const r of dateRows) {
                    const ent = (r.ae_entry ?? '').toString().trim();
                    const d = r.pstdate instanceof Date
                        ? r.pstdate.toISOString().slice(0, 10)
                        : typeof r.pstdate === 'string'
                            ? r.pstdate.slice(0, 10)
                            : null;
                    if (ent)
                        dateByEntry.set(ent, d);
                }
            }
            const outOfPeriod = [];
            for (const ent of entryNumbers) {
                const d = dateByEntry.get(ent);
                if (!d)
                    continue;
                if (d < input.periodStart || d > input.periodEnd) {
                    outOfPeriod.push(`${ent} (${d})`);
                }
            }
            if (outOfPeriod.length > 0) {
                const msg = `Entries outside statement period ${input.periodStart}..${input.periodEnd}: ` +
                    outOfPeriod.join(', ');
                return { success: false, errors: [msg], error: msg };
            }
        }
        catch (err) {
            // Tolerate query failures — matches legacy permissive behaviour
            // when the join can't run.
            // eslint-disable-next-line no-console
            console.warn(`[bank-reconcile] period-bound check failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    const totalValuePence = valueRows.reduce((sum, r) => sum + Number(r.ae_value ?? 0), 0);
    const totalValuePounds = totalValuePence / 100;
    const calculatedClosing = expectedOpening + totalValuePounds;
    // 3. Auto-detect partial when closing doesn't match (matches Python)
    let partial = !!input.partial;
    let partialAutoDetected = false;
    if (!partial &&
        Math.abs(calculatedClosing - input.closingBalance) >= 0.01) {
        partial = true;
        partialAutoDetected = true;
    }
    // 4. Gap-aware statement-line numbering
    const totalLines = (input.statementTransactions ?? []).length;
    const matchedPositions = matchedEntries.map((e) => Number(e.statement_line ?? 0));
    const unmatchedPositions = [];
    for (let i = 1; i <= totalLines; i++) {
        if (!matchedPositions.includes(i))
            unmatchedPositions.push(i);
    }
    const lineNumbers = calculateStatementLineNumbers(totalLines, matchedPositions, unmatchedPositions);
    const entriesWithLines = matchedEntries.map((e) => {
        const stmtPos = Number(e.statement_line ?? 0);
        const resolved = lineNumbers.get(stmtPos);
        return {
            entry_number: e.entry_number,
            statement_line: resolved ?? stmtPos * 10,
        };
    });
    // 5. Delegate to existing mark-reconciled flow
    const stmtDate = input.statementDate instanceof Date
        ? input.statementDate.toISOString().slice(0, 10)
        : (input.statementDate ?? null);
    const result = await markEntriesReconciled(appDb, operaDb, {
        bankCode: input.bankCode,
        entries: entriesWithLines,
        statementNumber: input.statementNumber,
        statementDate: stmtDate,
        reconciliationDate: new Date().toISOString().slice(0, 10),
        partial,
        closingBalance: input.closingBalance,
    });
    // 6. Enrich response
    if (result.success) {
        const details = [...(result.details ?? [])];
        if (partial) {
            details.push('Partial reconciliation - matched entries posted with line numbers. ' +
                'Complete remaining items in Opera Cashbook > Reconcile.');
        }
        else {
            details.push(`Closing balance validated: £${input.closingBalance.toFixed(2)}`);
        }
        return {
            ...result,
            details,
            entries_reconciled: result.records_reconciled ?? 0,
            partial,
            partial_auto_detected: partialAutoDetected || undefined,
            statement_number: input.statementNumber,
            statement_date: stmtDate ?? undefined,
            closing_balance: input.closingBalance,
        };
    }
    return {
        ...result,
        entries_reconciled: 0,
        partial,
        partial_auto_detected: partialAutoDetected || undefined,
        statement_number: input.statementNumber,
        statement_date: stmtDate ?? undefined,
        closing_balance: input.closingBalance,
    };
}
//# sourceMappingURL=complete-reconciliation.js.map
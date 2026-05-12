const PERIOD_GRACE_DAYS = 14;
function toDate(v) {
    if (!v)
        return null;
    if (v instanceof Date) {
        if (Number.isNaN(v.getTime()))
            return null;
        return v;
    }
    const s = String(v).slice(0, 10);
    const d = new Date(`${s}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
}
function isoDate(v) {
    if (!v)
        return '';
    if (v instanceof Date) {
        if (Number.isNaN(v.getTime()))
            return '';
        return v.toISOString().slice(0, 10);
    }
    return String(v).slice(0, 10);
}
function trim(s) {
    return (s ?? '').trim();
}
function round2(n) {
    return Math.round(n * 100) / 100;
}
function daysBetween(a, b) {
    const x = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
    const y = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
    return Math.abs(Math.round((x - y) / (1000 * 60 * 60 * 24)));
}
function addDays(d, days) {
    const out = new Date(d.getTime());
    out.setUTCDate(out.getUTCDate() + days);
    return out;
}
function dateOnlyIso(d) {
    return d.toISOString().slice(0, 10);
}
// ---------------------------------------------------------------------
// Confidence scoring
// ---------------------------------------------------------------------
function scoreFromDateProximity(daysDiff, descMatch) {
    if (daysDiff === 0 && descMatch)
        return 100;
    if (daysDiff === 0)
        return 95;
    if (daysDiff <= 1)
        return 90;
    if (daysDiff <= 7)
        return 85;
    if (daysDiff <= 30)
        return 75;
    if (daysDiff <= 90)
        return 65;
    return 55;
}
function descMatches(stmtDesc, entryComment) {
    const a = stmtDesc.trim().toLowerCase();
    const b = entryComment.trim().toLowerCase();
    if (!a || !b)
        return false;
    return a.slice(0, 20).length > 0 && (b.includes(a.slice(0, 20)) || a.includes(b.slice(0, 20)));
}
// ---------------------------------------------------------------------
// Service entry point
// ---------------------------------------------------------------------
export async function matchStatementToCashbook(operaDb, opts) {
    const dateToleranceDays = opts.dateToleranceDays ?? 45;
    const bankAccount = opts.bankAccount;
    const statementTransactions = opts.statementTransactions ?? [];
    const openYearStart = opts.openYearStart ?? null;
    const periodStart = toDate(opts.periodStart ?? null);
    const periodEnd = toDate(opts.periodEnd ?? null);
    const emptyResult = {
        success: true,
        auto_matched: [],
        suggested_matched: [],
        already_reconciled: [],
        unmatched_statement: [],
        unmatched_cashbook: [],
        summary: {
            total_statement_lines: statementTransactions.length,
            auto_matched_count: 0,
            suggested_matched_count: 0,
            already_reconciled_count: 0,
            unmatched_statement_count: 0,
            unmatched_cashbook_count: 0,
        },
    };
    if (!bankAccount) {
        return { ...emptyResult, success: false, error: 'bank_account is required' };
    }
    try {
        // 1. Build period filter
        let candidateQuery = operaDb('aentry')
            .where({ ae_acnt: bankAccount, ae_reclnum: 0, ae_remove: 0 });
        if (periodStart && periodEnd) {
            const winStart = dateOnlyIso(addDays(periodStart, -PERIOD_GRACE_DAYS));
            const winEnd = dateOnlyIso(addDays(periodEnd, PERIOD_GRACE_DAYS));
            candidateQuery = candidateQuery.whereBetween('ae_lstdate', [winStart, winEnd]);
        }
        else if (opts.onWarn) {
            opts.onWarn(`match_statement_to_cashbook: period bounds not provided for bank ${bankAccount} — falling back to unbounded candidate pool.`);
        }
        const rows = (await candidateQuery
            .orderBy([
            { column: 'ae_lstdate', order: 'asc' },
            { column: 'ae_entry', order: 'asc' },
        ])
            .select('ae_entry', operaDb.raw('ae_value / 100.0 AS amount_pounds'), 'ae_lstdate', 'ae_entref', 'ae_comment', 'ae_cbtype', 'ae_complet'));
        // 2. Build lookup structures
        const entriesByRef = new Map();
        const entriesByAmount = new Map();
        for (const e of rows ?? []) {
            const ref = trim(e.ae_entref).toUpperCase();
            const amount = round2(Number(e.amount_pounds ?? 0));
            if (ref) {
                const list = entriesByRef.get(ref) ?? [];
                list.push(e);
                entriesByRef.set(ref, list);
            }
            const al = entriesByAmount.get(amount) ?? [];
            al.push(e);
            entriesByAmount.set(amount, al);
        }
        const matchedEntryNums = new Set();
        const autoMatched = [];
        const suggestedMatched = [];
        let unmatchedStatement = [];
        // 3. Tier 1 + Tier 2 matching loop
        for (const stmt of statementTransactions ?? []) {
            const lineNum = stmt.line_number ?? 0;
            const stmtAmount = round2(Number(stmt.amount ?? 0));
            const stmtRef = trim(stmt.reference ?? null).toUpperCase();
            const stmtDesc = stmt.description ?? '';
            const stmtDate = toDate(stmt.date ?? null);
            let matchEntry = null;
            let matchConfidence = 0;
            let matched = false;
            // Tier 1: exact reference + amount
            if (stmtRef && entriesByRef.has(stmtRef)) {
                for (const entry of entriesByRef.get(stmtRef)) {
                    const entryNum = String(entry.ae_entry ?? '').trim();
                    if (matchedEntryNums.has(entryNum))
                        continue;
                    const entryAmount = round2(Number(entry.amount_pounds ?? 0));
                    if (Math.abs(entryAmount - stmtAmount) < 0.01) {
                        matchEntry = entry;
                        matchConfidence = 100;
                        matched = true;
                        break;
                    }
                }
            }
            // Tier 2: amount + closest date
            if (!matched && entriesByAmount.has(stmtAmount)) {
                let best = null;
                let bestDiff = null;
                for (const entry of entriesByAmount.get(stmtAmount)) {
                    const entryNum = String(entry.ae_entry ?? '').trim();
                    if (matchedEntryNums.has(entryNum))
                        continue;
                    const entryDate = toDate(entry.ae_lstdate);
                    if (!entryDate)
                        continue;
                    if (openYearStart && entryDate.getTime() < openYearStart.getTime())
                        continue;
                    if (!stmtDate) {
                        best = entry;
                        bestDiff = null;
                        break;
                    }
                    const dd = daysBetween(stmtDate, entryDate);
                    if (bestDiff === null || dd < bestDiff) {
                        best = entry;
                        bestDiff = dd;
                    }
                }
                if (best !== null) {
                    matchEntry = best;
                    const dd = bestDiff ?? 999;
                    matchConfidence = scoreFromDateProximity(dd, descMatches(stmtDesc, trim(best.ae_comment)));
                    matched = true;
                }
            }
            if (matched && matchEntry) {
                const entryNum = String(matchEntry.ae_entry ?? '').trim();
                matchedEntryNums.add(entryNum);
                const record = {
                    statement_line: lineNum,
                    statement_date: stmtDate ? dateOnlyIso(stmtDate) : null,
                    statement_amount: stmtAmount,
                    statement_reference: stmtRef,
                    statement_description: stmtDesc,
                    statement_balance: stmt.balance === null || stmt.balance === undefined
                        ? null
                        : Number(stmt.balance),
                    entry_number: entryNum,
                    entry_date: isoDate(matchEntry.ae_lstdate),
                    entry_amount: round2(Number(matchEntry.amount_pounds ?? 0)),
                    entry_reference: trim(matchEntry.ae_entref),
                    entry_description: trim(matchEntry.ae_comment),
                    confidence: matchConfidence,
                };
                if (matchConfidence >= 95) {
                    autoMatched.push(record);
                }
                else {
                    suggestedMatched.push(record);
                }
            }
            else {
                unmatchedStatement.push({
                    statement_line: lineNum,
                    statement_date: stmtDate ? dateOnlyIso(stmtDate) : null,
                    statement_amount: stmtAmount,
                    statement_reference: stmtRef,
                    statement_description: stmtDesc,
                    statement_balance: stmt.balance === null || stmt.balance === undefined
                        ? null
                        : Number(stmt.balance),
                });
            }
        }
        // 4. Cashbook-side unmatched
        const unmatchedCashbook = [];
        for (const e of rows ?? []) {
            const entryNum = String(e.ae_entry ?? '').trim();
            if (!matchedEntryNums.has(entryNum)) {
                unmatchedCashbook.push({
                    entry_number: entryNum,
                    entry_date: isoDate(e.ae_lstdate),
                    entry_amount: round2(Number(e.amount_pounds ?? 0)),
                    entry_reference: trim(e.ae_entref),
                    entry_description: trim(e.ae_comment),
                });
            }
        }
        // 5. Already-reconciled second pass (lifts ✓-eligible lines out of unmatched)
        const alreadyReconciled = [];
        if (unmatchedStatement.length > 0) {
            const stmtDates = (statementTransactions ?? [])
                .map((s) => toDate(s.date ?? null))
                .filter((d) => d !== null);
            if (stmtDates.length > 0) {
                let winStart;
                let winEnd;
                if (periodStart && periodEnd) {
                    winStart = dateOnlyIso(addDays(periodStart, -PERIOD_GRACE_DAYS));
                    winEnd = dateOnlyIso(addDays(periodEnd, PERIOD_GRACE_DAYS));
                }
                else {
                    const minD = new Date(Math.min(...stmtDates.map((d) => d.getTime())));
                    const maxD = new Date(Math.max(...stmtDates.map((d) => d.getTime())));
                    winStart = dateOnlyIso(addDays(minD, -dateToleranceDays));
                    winEnd = dateOnlyIso(addDays(maxD, dateToleranceDays));
                }
                const recRows = (await operaDb('aentry')
                    .where({ ae_acnt: bankAccount })
                    .andWhere('ae_reclnum', '>', 0)
                    .whereBetween('ae_lstdate', [winStart, winEnd])
                    .select('ae_entry', operaDb.raw('ae_value / 100.0 AS amount_pounds'), 'ae_lstdate', 'ae_entref', 'ae_comment', 'ae_cbtype', 'ae_reclnum', 'ae_recdate'));
                const recByAmount = new Map();
                for (const r of recRows ?? []) {
                    const amt = round2(Number(r.amount_pounds ?? 0));
                    const list = recByAmount.get(amt) ?? [];
                    list.push(r);
                    recByAmount.set(amt, list);
                }
                const stillUnmatched = [];
                const recUsed = new Set();
                for (const u of unmatchedStatement) {
                    const ua = round2(Number(u.statement_amount));
                    const candidates = recByAmount.get(ua) ?? [];
                    const uDate = u.statement_date
                        ? toDate(u.statement_date)
                        : null;
                    let best = null;
                    let bestDiff = null;
                    for (const c of candidates) {
                        const cEntry = String(c.ae_entry ?? '').trim();
                        if (recUsed.has(cEntry))
                            continue;
                        const cDate = toDate(c.ae_lstdate);
                        const dd = cDate && uDate ? daysBetween(uDate, cDate) : 999;
                        if (bestDiff === null || dd < bestDiff) {
                            best = c;
                            bestDiff = dd;
                        }
                    }
                    if (best !== null && bestDiff !== null && bestDiff <= dateToleranceDays) {
                        recUsed.add(String(best.ae_entry ?? '').trim());
                        alreadyReconciled.push({
                            ...u,
                            entry_number: String(best.ae_entry ?? '').trim(),
                            entry_date: isoDate(best.ae_lstdate),
                            entry_amount: round2(Number(best.amount_pounds ?? 0)),
                            entry_reference: trim(best.ae_entref),
                            entry_description: trim(best.ae_comment),
                            reclnum: best.ae_reclnum ?? null,
                            rec_date: isoDate(best.ae_recdate),
                            match_type: 'already_reconciled',
                            confidence: 100,
                        });
                    }
                    else {
                        stillUnmatched.push(u);
                    }
                }
                unmatchedStatement = stillUnmatched;
            }
        }
        return {
            success: true,
            auto_matched: autoMatched,
            suggested_matched: suggestedMatched,
            already_reconciled: alreadyReconciled,
            unmatched_statement: unmatchedStatement,
            unmatched_cashbook: unmatchedCashbook,
            summary: {
                total_statement_lines: statementTransactions.length,
                auto_matched_count: autoMatched.length,
                suggested_matched_count: suggestedMatched.length,
                already_reconciled_count: alreadyReconciled.length,
                unmatched_statement_count: unmatchedStatement.length,
                unmatched_cashbook_count: unmatchedCashbook.length,
            },
        };
    }
    catch (err) {
        return { ...emptyResult, success: false, error: err?.message ?? String(err) };
    }
}
//# sourceMappingURL=match-statement.js.map
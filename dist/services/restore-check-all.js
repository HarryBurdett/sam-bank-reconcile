import { getReconciliationStatus } from './reconciliation-status.js';
import { checkOrphanedTransactions } from './transaction-orphan-check.js';
export async function checkRestoreAcrossAllBanks(operaDb, appDb) {
    try {
        const banks = (await operaDb('nbank')
            .select(operaDb.raw('RTRIM(nk_acnt) AS code'), operaDb.raw('RTRIM(nk_desc) AS description'))
            .orderBy('nk_acnt'));
        const results = [];
        let affected = 0;
        for (const b of banks) {
            const code = (b.code ?? '').trim();
            if (!code)
                continue;
            const [status, orphans] = await Promise.all([
                getReconciliationStatus(operaDb, code, appDb, null),
                checkOrphanedTransactions(operaDb, appDb, code),
            ]);
            const divDetected = !!status.opera_divergence_detected;
            const orphanLines = orphans.success ? orphans.orphan_line_count : 0;
            const orphanStmts = orphans.success ? orphans.statement_count : 0;
            const needs = divDetected || orphanLines > 0;
            if (needs)
                affected += 1;
            results.push({
                bank_code: code,
                description: (b.description ?? '').trim(),
                reconciled_balance: Number(status.reconciled_balance ?? 0),
                divergence_detected: divDetected,
                divergence_message: status.opera_divergence_message ?? null,
                orphan_line_count: orphanLines,
                orphan_statement_count: orphanStmts,
                needs_recovery: needs,
            });
        }
        const detected = affected > 0;
        let summary = null;
        if (detected) {
            const affectedBanks = results
                .filter((r) => r.needs_recovery)
                .map((r) => `${r.bank_code} (${r.description})`)
                .slice(0, 3)
                .join(', ');
            const more = results.filter((r) => r.needs_recovery).length > 3
                ? ` (+${results.filter((r) => r.needs_recovery).length - 3} more)`
                : '';
            summary =
                `Opera restore likely detected on ${affected} bank account(s): ` +
                    `${affectedBanks}${more}. SAM has tracking for statements/lines ` +
                    `that no longer exist in Opera. Open each affected bank's ` +
                    `reconcile page to review and recover.`;
        }
        return {
            success: true,
            detected,
            total_banks_checked: results.length,
            affected_banks: affected,
            banks: results,
            summary_message: summary,
        };
    }
    catch (err) {
        return {
            success: false,
            detected: false,
            total_banks_checked: 0,
            affected_banks: 0,
            banks: [],
            summary_message: null,
            error: err?.message ?? String(err),
        };
    }
}
//# sourceMappingURL=restore-check-all.js.map
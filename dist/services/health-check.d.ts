/**
 * Bank-reconcile data-integrity health check.
 *
 * Faithful port of `apps/bank_reconcile/logic/health_check.py`.
 *
 * Verifies the bank-rec app's data still references valid Opera codes.
 * Especially useful immediately after an Opera 3 → Opera SE upgrade,
 * to confirm Opera's migration preserved the codes our learned data
 * references.
 */
import type { Knex } from 'knex';
export interface HealthCheckItem {
    name: string;
    description: string;
    passed: boolean;
    total_checked?: number;
    orphan_count?: number;
    orphans?: Array<Record<string, unknown>>;
    severity: 'info' | 'warning' | 'error';
}
export interface HealthCheckResult {
    app: string;
    healthy: boolean;
    summary: string;
    checks: HealthCheckItem[];
    metadata: Record<string, unknown>;
}
export declare function runHealthCheck(opts: {
    operaDb: Knex;
    appDb: Knex | null;
}): Promise<HealthCheckResult>;
//# sourceMappingURL=health-check.d.ts.map
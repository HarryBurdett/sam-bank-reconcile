/**
 * Default adapters for bank-reconcile import flows.
 *
 * These let the route layer run end-to-end without explicit SAM
 * wiring; the SAM team can override any of them via the runtime
 * context object.
 *
 *   - inMemoryImportLock        → bank-level lock (5-minute stale TTL)
 *   - bankStatementImportsOverlapChecker → reads the bank_statement_imports
 *                                  audit table for period overlaps
 */
import type { Knex } from 'knex';
import type { ImportLockAdapter, PeriodOverlapChecker } from './import-from-pdf.js';
export declare const inMemoryImportLock: ImportLockAdapter;
export declare function makeBankStatementOverlapChecker(appDb: Knex): PeriodOverlapChecker;
//# sourceMappingURL=import-defaults.d.ts.map
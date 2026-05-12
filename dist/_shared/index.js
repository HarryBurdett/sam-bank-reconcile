/**
 * @sqlrag/sam-shared — utilities used by all SAM plugins in this repo.
 *
 * Modules:
 *   - opera/      Opera SQL helpers (control accounts, period status, etc.)
 *   - posting/    Common posting primitives (id allocation, VAT tracking)
 *
 * Faithfully ports utilities from the Python codebase (`sql_rag/`,
 * `apps/core/`) that are reused across multiple apps.
 */
export * from './opera/index.js';
export * from './posting/index.js';
export { sequenceMatcherRatio } from './string/sequence-matcher.js';
//# sourceMappingURL=index.js.map
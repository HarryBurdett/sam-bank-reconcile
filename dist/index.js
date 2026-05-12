/**
 * bank-reconcile — SAM plugin entry point.
 *
 * Foundation in place; endpoints are being ported in stages from
 * the Python `apps/bank_reconcile/` app (127 endpoints, 16K LOC).
 * See docs/sam-rewrite/progress.md for status.
 */
import { createRouter } from './router.js';
const factory = (ctx) => {
    ctx.logger.info(`bank-reconcile plugin loaded for tenant ${ctx.tenantId}`);
    return createRouter(ctx);
};
export default factory;
//# sourceMappingURL=index.js.map
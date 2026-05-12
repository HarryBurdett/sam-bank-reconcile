/**
 * Express router for the bank-reconcile plugin.
 *
 * Foundation endpoints + first batch of read-only ports. Many more
 * endpoints to come — bank-reconcile is the largest app at 127 routes.
 */
import { Router } from 'express';
import type { AppContext } from './app-context.js';
export declare function createRouter(ctx: AppContext): Router;
//# sourceMappingURL=router.d.ts.map
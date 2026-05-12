/**
 * Bank Reconciliation plugin — UMD bundle entry.
 *
 * The id MUST match `apps-sam/bank-reconcile/manifest.json: "id"` and
 * the registered component MUST match
 * `manifest.frontend.entryComponent`.
 */
import './index.css';
import BankReconcile from './BankReconcile';

if (typeof window !== 'undefined') {
  window.__SAM_APPS__ = window.__SAM_APPS__ ?? {};
  window.__SAM_APPS__['bank-reconcile'] = {
    id: 'bank-reconcile',
    component: BankReconcile as unknown as (props: {
      context: import('./sam').SamPluginContext;
    }) => unknown,
  };
}

export default BankReconcile;

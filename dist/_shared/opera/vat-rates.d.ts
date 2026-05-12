/**
 * Opera VAT-codes lookup with date-effective rate selection.
 *
 * Faithful port of `fetch_vat_codes_with_rates` from
 * `apps/balance_check/logic/vat_reconcile.py`.
 *
 * Used by both:
 *   - balance-check `/api/reconcile/vat`
 *   - gocardless    `/api/gocardless/vat-codes` (fees split)
 *
 * The ztax table stores up to two rate/date pairs per code. Returns
 * the most recent rate where the effective date <= refDate.
 */
import type { Knex } from 'knex';
export interface VatCodeRow {
    code: string;
    description: string;
    rate: number;
    type: string;
    nominal_account: string;
}
export interface VatCodesWithRatesResult {
    vatCodes: VatCodeRow[];
    outputNominalAccounts: Set<string>;
    inputNominalAccounts: Set<string>;
}
/**
 * Read ztax (Home country VAT codes) and compute the applicable rate
 * for `refDate`.
 */
export declare function fetchVatCodesWithRates(db: Knex, refDate: Date): Promise<VatCodesWithRatesResult>;
//# sourceMappingURL=vat-rates.d.ts.map
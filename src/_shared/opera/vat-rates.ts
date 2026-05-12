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
 * Choose the most recent effective rate <= refDate.
 * Faithful port of `_pick_applicable_rate` from vat_reconcile.py.
 */
function pickApplicableRate(
  rate1: number,
  rate2: number,
  date1: Date | null,
  date2: Date | null,
  refDate: Date,
): number {
  if (date1 && date2) {
    if (date2 <= refDate && date1 <= refDate) {
      return date2 > date1 ? rate2 : rate1;
    }
    if (date2 <= refDate) return rate2;
    if (date1 <= refDate) return rate1;
    return rate1;
  }
  if (date2 && date2 <= refDate) return rate2;
  return rate1;
}

function coerceDate(d: unknown): Date | null {
  if (d === null || d === undefined) return null;
  if (d instanceof Date) {
    if (Number.isNaN(d.getTime())) return null;
    return d;
  }
  if (typeof d === 'string' && d) {
    const parsed = new Date(d);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/**
 * Read ztax (Home country VAT codes) and compute the applicable rate
 * for `refDate`.
 */
export async function fetchVatCodesWithRates(
  db: Knex,
  refDate: Date,
): Promise<VatCodesWithRatesResult> {
  const sql = `
    SELECT tx_code, tx_desc, tx_rate1, tx_rate1dy, tx_rate2, tx_rate2dy, tx_trantyp, tx_nominal
    FROM ztax WITH (NOLOCK)
    WHERE tx_ctrytyp = 'H'
    ORDER BY tx_trantyp, tx_code
  `;
  const rows = (await db.raw(sql)) as unknown as Array<{
    tx_code: string | null;
    tx_desc: string | null;
    tx_rate1: number | null;
    tx_rate1dy: Date | string | null;
    tx_rate2: number | null;
    tx_rate2dy: Date | string | null;
    tx_trantyp: string | null;
    tx_nominal: string | null;
  }>;

  const vatCodes: VatCodeRow[] = [];
  const outputNominals = new Set<string>();
  const inputNominals = new Set<string>();

  for (const row of Array.isArray(rows) ? rows : []) {
    const code = row.tx_code ? String(row.tx_code).trim() : '';
    const nominal = row.tx_nominal ? String(row.tx_nominal).trim() : '';
    const vatType = row.tx_trantyp ? String(row.tx_trantyp).trim() : '';

    const rate1 = Number(row.tx_rate1 ?? 0);
    const rate2 = Number(row.tx_rate2 ?? 0);
    const date1 = coerceDate(row.tx_rate1dy);
    const date2 = coerceDate(row.tx_rate2dy);

    const applicableRate = pickApplicableRate(rate1, rate2, date1, date2, refDate);

    vatCodes.push({
      code,
      description: row.tx_desc ? String(row.tx_desc).trim() : '',
      rate: applicableRate,
      type: vatType,
      nominal_account: nominal,
    });

    if (nominal) {
      if (vatType === 'S') outputNominals.add(nominal);
      else if (vatType === 'P') inputNominals.add(nominal);
    }
  }

  return {
    vatCodes,
    outputNominalAccounts: outputNominals,
    inputNominalAccounts: inputNominals,
  };
}

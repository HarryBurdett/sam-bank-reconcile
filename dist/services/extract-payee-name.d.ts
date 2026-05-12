/**
 * Extract payee/payer name from bank statement description.
 *
 * Faithful port of `extract_payee_name_full`
 * (sql_rag/bank_import.py:135-216). Used by the matcher to clean
 * AI-extracted descriptions before fuzzy matching, e.g.:
 *
 *   "Giro Direct Credit From Balladeer Limited Ref: Inv.26395"
 *     → "Balladeer Limited"
 *
 *   "DD Direct Debit to HMRC E VAT Ref: 000917304990"
 *     → "HMRC E VAT"
 *
 *   "Card Purchase Tyreland Limited On 10 Feb"
 *     → "Tyreland Limited"
 *
 *   "MJM DATA CAPTURE LTD, SUPPLIER, FP 23/03/26 40, 11013128004084000N"
 *     → "MJM DATA CAPTURE LTD"
 *
 * Pure text manipulation — no DB, identical behaviour on Opera SE and
 * Opera 3.
 */
export declare function extractPayeeName(description: string | null | undefined): string;
//# sourceMappingURL=extract-payee-name.d.ts.map
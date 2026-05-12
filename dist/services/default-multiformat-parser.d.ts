/**
 * Default multiformat parser — CSV / OFX / QIF / MT940.
 *
 * Faithful port of the format detection + parsing logic in
 * `sql_rag/bank_import.py` (parse_csv, parse_file, detect_file_format).
 *
 * The SAM team can override via `ctx.multiformatParser` if they want
 * a different parser (e.g. one that supports bank-specific dialects).
 */
import type { MultiformatParser } from './misc-endpoints.js';
export interface ParsedTransaction {
    date: string | null;
    name: string | null;
    memo: string | null;
    amount: number;
    type: string;
}
export declare const defaultMultiformatParser: MultiformatParser;
//# sourceMappingURL=default-multiformat-parser.d.ts.map
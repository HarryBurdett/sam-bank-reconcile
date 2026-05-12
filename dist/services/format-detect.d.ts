/**
 * Bank statement format detection.
 *
 * Faithful port of the parser sniffing logic in
 * `sql_rag/bank_parsers.py` and `BankStatementImport.detect_file_format`
 * in `sql_rag/bank_import.py:1879-1908`.
 *
 * Returns the format name ('CSV', 'OFX', 'QIF', 'MT940') or null when
 * none of the parsers can claim the content.
 *
 * Detection priority follows Python's PARSERS list order:
 *   1. CSV  — extension OR header containing 'date' / 'transaction'
 *   2. OFX  — extension .ofx/.qfx OR content starting with OFXHEADER:/<?OFX/<OFX>
 *   3. QIF  — extension .qif OR content starting with !TYPE:
 *   4. MT940— extension .mt940/.sta/.940 OR :20:/{1:/:60F:/:61:
 *
 * NOTE: CSV is greedy by design — its `can_parse` matches any file
 * containing the word 'date' or 'transaction' on the first line, so
 * many OFX/QIF/MT940 files will match CSV first if their content
 * contains those words. Faithful to Python's behaviour.
 */
declare const SUPPORTED_FORMATS: readonly ["CSV", "OFX", "QIF", "MT940"];
export type BankFileFormat = (typeof SUPPORTED_FORMATS)[number];
export declare const supportedFormats: readonly BankFileFormat[];
/**
 * Detect the format of a bank statement from its content + filename.
 * Mirrors `bank_parsers.detect_format` exactly.
 */
export declare function detectFormat(content: string, filename?: string): BankFileFormat | null;
export {};
//# sourceMappingURL=format-detect.d.ts.map
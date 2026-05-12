import type { PdfExtractor } from './import-from-pdf.js';
import type { LlmService } from './preview-from-pdf.js';
interface ExtractorOptions {
    llm: LlmService;
    model?: string;
    maxTokens?: number;
}
export declare function createDefaultBankPdfExtractor(options: ExtractorOptions): PdfExtractor;
export {};
//# sourceMappingURL=default-bank-pdf-extractor.d.ts.map
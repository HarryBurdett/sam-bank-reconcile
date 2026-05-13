const EXTRACTION_PROMPT = `You are a bank-statement parser. Extract the
following from the PDF I'm sending and return a JSON document with
this exact shape:

{
  "bank_name": "<bank name on the statement, or null>",
  "account_number": "<account number, digits only>",
  "sort_code": "<UK sort code XX-XX-XX, or null>",
  "statement_date": "<YYYY-MM-DD, or null>",
  "period_start": "<YYYY-MM-DD>",
  "period_end": "<YYYY-MM-DD>",
  "opening_balance": <number, or null>,
  "closing_balance": <number, or null>,
  "transactions": [
    {
      "date": "<YYYY-MM-DD>",
      "name": "<short payee description>",
      "memo": "<full transaction description as it appears>",
      "amount": <signed number — receipts positive, payments negative>,
      "type": "credit" | "debit",
      "balance": <running balance after this transaction, or null>
    }
  ]
}

Rules:
- DO NOT include any prose. Return ONLY the JSON object.
- Amounts are in pounds, with two decimals.
- Receipts (money in) are positive, payments (money out) are negative.
- If a column shows debits/credits separately, sign the amount accordingly.
- If a value isn't present on the statement, return null.
- Order transactions by date ascending; same-date by appearance order.`;
async function fetchBank(operaDb, bankCode) {
    try {
        const row = (await operaDb('nbank')
            .select(operaDb.raw('RTRIM(nk_acnt) AS code'), operaDb.raw('RTRIM(nk_desc) AS description'), operaDb.raw("RTRIM(ISNULL(nk_sort, '')) AS sort_code"), operaDb.raw("RTRIM(ISNULL(nk_number, '')) AS account_number"), operaDb.raw('nk_recbal / 100.0 AS reconciled_balance'))
            .whereRaw('RTRIM(nk_acnt) = ?', [bankCode])
            .first());
        return row ?? null;
    }
    catch {
        return null;
    }
}
async function findBankByDetails(operaDb, sortCode, accountNumber) {
    try {
        const row = (await operaDb('nbank')
            .select(operaDb.raw('RTRIM(nk_acnt) AS code'))
            .whereRaw("REPLACE(REPLACE(RTRIM(ISNULL(nk_sort,'')), '-', ''), ' ', '') = ?", [sortCode])
            .andWhereRaw("REPLACE(REPLACE(RTRIM(ISNULL(nk_number,'')), '-', ''), ' ', '') = ?", [accountNumber])
            .first());
        return row?.code ? row.code.trim() : null;
    }
    catch {
        return null;
    }
}
async function callLlmForExtraction(llm, pdfPath, pdfBytes) {
    // Build a content payload referencing the PDF. SAM's LLM service
    // wraps Anthropic's Messages API; the route layer is responsible for
    // shoving the PDF bytes into the message in a format ctx.llm expects.
    // For replication purposes, we send the prompt plus a pointer to the
    // PDF so the SAM team's ctx.llm wrapper can attach the document.
    const ref = pdfPath ?? `<pdf-bytes:${pdfBytes?.byteLength ?? 0}>`;
    const stream = llm.chat({
        messages: [
            {
                role: 'user',
                content: `${EXTRACTION_PROMPT}\n\nPDF reference: ${ref}`,
            },
        ],
        model: 'claude-sonnet-4',
        maxTokens: 16_000,
        temperature: 0,
    });
    // Concatenate streamed chunks. ctx.llm is contractually an async-
    // iterable; the chunks may be strings or {type: 'text_delta', text}.
    const buf = [];
    for await (const chunk of stream) {
        if (typeof chunk === 'string') {
            buf.push(chunk);
        }
        else if (chunk && typeof chunk === 'object') {
            const c = chunk;
            if (typeof c.text === 'string')
                buf.push(c.text);
            else if (c.delta && typeof c.delta.text === 'string')
                buf.push(c.delta.text);
        }
    }
    const raw = buf.join('').trim();
    // Strip Markdown code fences if Claude wraps the JSON
    const cleaned = raw
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
    let parsed;
    try {
        parsed = JSON.parse(cleaned);
    }
    catch (err) {
        throw new Error(`LLM returned non-JSON output. First 200 chars: ${raw.slice(0, 200)}. Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    const data = parsed;
    const transactions = Array.isArray(data.transactions)
        ? data.transactions.map((t, i) => ({
            date: typeof t.date === 'string' ? t.date : null,
            name: typeof t.name === 'string' ? t.name : null,
            memo: typeof t.memo === 'string' ? t.memo : null,
            amount: Number(t.amount ?? 0),
            type: typeof t.type === 'string' ? t.type : 'credit',
            balance: typeof t.balance === 'number' || t.balance === null
                ? t.balance
                : null,
            line_number: typeof t.line_number === 'number' ? t.line_number : i + 1,
        }))
        : [];
    return {
        bank_name: typeof data.bank_name === 'string' ? data.bank_name : null,
        account_number: typeof data.account_number === 'string' ? data.account_number : null,
        sort_code: typeof data.sort_code === 'string' ? data.sort_code : null,
        statement_date: typeof data.statement_date === 'string' ? data.statement_date : null,
        period_start: typeof data.period_start === 'string' ? data.period_start : null,
        period_end: typeof data.period_end === 'string' ? data.period_end : null,
        opening_balance: typeof data.opening_balance === 'number' ? data.opening_balance : null,
        closing_balance: typeof data.closing_balance === 'number' ? data.closing_balance : null,
        transactions,
    };
}
function normaliseBankNumber(s) {
    return (s ?? '').replace(/[\s-]/g, '').trim();
}
export async function previewBankImportFromPdf(operaDb, llm, input, extractor = null) {
    if (!input.bankCode) {
        return { success: false, error: 'bank_code is required' };
    }
    if (!input.filePath && !input.pdfBytes) {
        return { success: false, error: 'filePath or pdfBytes is required' };
    }
    if (!extractor && !llm) {
        return {
            success: false,
            error: 'No PDF extractor configured. Standalone host needs GEMINI_API_KEY to wire ctx.bankPdfExtractor, or SAM must provide ctx.llm.',
        };
    }
    const bank = await fetchBank(operaDb, input.bankCode);
    if (!bank) {
        return {
            success: false,
            error: `Bank account '${input.bankCode}' not found in Opera.`,
        };
    }
    let extracted;
    try {
        if (extractor) {
            // Preferred path: dedicated extractor (e.g. standalone host's
            // Gemini-backed adapter matching legacy behaviour).
            extracted = await extractor.extractFromPdf({
                filePath: input.filePath,
                bytes: input.pdfBytes,
                filename: input.filename,
            });
        }
        else {
            // Fallback: SAM-plugged mode where only ctx.llm is wired.
            extracted = await callLlmForExtraction(llm, input.filePath, input.pdfBytes);
        }
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: `PDF extraction failed: ${msg}` };
    }
    const warnings = [];
    // Bank match
    const stmtSort = normaliseBankNumber(extracted.sort_code);
    const stmtAcct = normaliseBankNumber(extracted.account_number);
    const operaSort = normaliseBankNumber(bank.sort_code);
    const operaAcct = normaliseBankNumber(bank.account_number);
    if (stmtSort && stmtAcct && operaSort && operaAcct) {
        if (stmtSort !== operaSort || stmtAcct !== operaAcct) {
            const correctBankCode = await findBankByDetails(operaDb, stmtSort, stmtAcct);
            return {
                success: false,
                bank_mismatch: true,
                detected_bank: `${stmtSort} / ${stmtAcct}`,
                selected_bank: `${operaSort} / ${operaAcct} (${input.bankCode})`,
                correct_bank_code: correctBankCode,
                error: 'Bank account mismatch',
            };
        }
    }
    // Opening balance vs reconciled — warn, don't override
    if (extracted.opening_balance !== null &&
        bank.reconciled_balance !== null &&
        Math.abs(extracted.opening_balance - bank.reconciled_balance) > 0.02) {
        warnings.push(`Opening balance mismatch: extracted £${extracted.opening_balance.toFixed(2)} vs Opera reconciled £${bank.reconciled_balance.toFixed(2)}.`);
    }
    else if (extracted.opening_balance === null &&
        bank.reconciled_balance !== null) {
        extracted.opening_balance = bank.reconciled_balance;
        warnings.push(`Used Opera reconciled balance £${bank.reconciled_balance.toFixed(2)} as opening balance (LLM did not extract one).`);
    }
    // Closing balance via transaction-chain walk
    if (extracted.opening_balance !== null && extracted.transactions.length > 0) {
        let current = extracted.opening_balance;
        const used = new Set();
        for (let _ = 0; _ < extracted.transactions.length; _++) {
            let found = false;
            for (let i = 0; i < extracted.transactions.length; i++) {
                if (used.has(i))
                    continue;
                const st = extracted.transactions[i];
                const expected = Math.round((current + st.amount) * 100) / 100;
                if (st.balance !== null &&
                    st.balance !== undefined &&
                    Math.abs(expected - st.balance) < 0.02) {
                    current = st.balance;
                    used.add(i);
                    found = true;
                    break;
                }
            }
            if (!found)
                break;
        }
        if (used.size > 0) {
            extracted.closing_balance = current;
            const excluded = extracted.transactions.length - used.size;
            if (excluded > 0) {
                warnings.push(`Balance chain excluded ${excluded} transaction(s) that didn't fit the running total — likely from a different account on the same PDF.`);
            }
        }
    }
    return {
        success: true,
        filename: input.filename ?? input.filePath?.split('/').pop() ?? undefined,
        statement_info: {
            bank_name: extracted.bank_name,
            account_number: extracted.account_number,
            sort_code: extracted.sort_code,
            statement_date: extracted.statement_date,
            period_start: extracted.period_start,
            period_end: extracted.period_end,
            opening_balance: extracted.opening_balance,
            closing_balance: extracted.closing_balance,
        },
        transactions: extracted.transactions,
        bank: {
            code: bank.code,
            description: bank.description,
            sort_code: bank.sort_code,
            account_number: bank.account_number,
            reconciled_balance: bank.reconciled_balance,
        },
        warnings,
    };
}
//# sourceMappingURL=preview-from-pdf.js.map
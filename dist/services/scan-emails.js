import { detectBankFromEmail, extractStatementNumberFromFilename, isBankStatementAttachment, compareSortKeys, } from './email-helpers.js';
async function fetchBankFromOpera(operaDb, bankCode) {
    try {
        const row = (await operaDb('nbank')
            .select(operaDb.raw('nk_recbal / 100.0 as reconciled_balance'), operaDb.raw('RTRIM(nk_sort) as sort_code'), operaDb.raw('RTRIM(nk_number) as account_number'))
            .whereRaw('RTRIM(nk_acnt) = ?', [bankCode])
            .first());
        if (!row)
            return null;
        return {
            reconciled_balance: row.reconciled_balance !== null && row.reconciled_balance !== undefined
                ? Number(row.reconciled_balance)
                : null,
            sort_code: row.sort_code,
            account_number: row.account_number,
        };
    }
    catch {
        return null;
    }
}
export async function scanEmailsForBankStatements(operaDb, _appDb, mailbox, reconciledStore, input) {
    const bankCode = (input.bankCode ?? '').toString().trim();
    const daysBack = Number.isFinite(input.daysBack) ? Number(input.daysBack) : 30;
    const includeProcessed = !!input.includeProcessed;
    const bank = await fetchBankFromOpera(operaDb, bankCode);
    if (!bank) {
        return {
            success: false,
            bank_code: bankCode,
            reconciled_balance: null,
            opera_sort_code: null,
            opera_account_number: null,
            total_emails_scanned: 0,
            total_pdfs_found: 0,
            already_processed_count: 0,
            skipped_reasons: [],
            statements: [],
            error: `Bank account '${bankCode}' not found in Opera. Please select a valid bank account.`,
        };
    }
    if (mailbox.sync) {
        try {
            await Promise.race([
                mailbox.sync(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('sync timeout')), 30_000)),
            ]);
        }
        catch {
            // proceed with cached state
        }
    }
    const fromDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    const list = await mailbox.list({ fromDate, pageSize: 500 });
    const reconciledKeys = await reconciledStore.getReconciledKeys(bankCode);
    const reconciledFilenames = await reconciledStore.getReconciledFilenames(bankCode);
    const statements = [];
    const skippedReasons = [];
    let totalEmailsScanned = 0;
    let totalPdfsFound = 0;
    let alreadyProcessed = 0;
    for (const email of list.emails ?? []) {
        if (!email.has_attachments)
            continue;
        totalEmailsScanned += 1;
        const detail = await mailbox.getById(email.id);
        if (!detail || !detail.attachments || detail.attachments.length === 0) {
            continue;
        }
        const candidates = [];
        for (const att of detail.attachments) {
            if (!isBankStatementAttachment({
                filename: att.filename,
                contentType: att.content_type ?? null,
                fromAddress: email.from_address ?? null,
                subject: email.subject ?? null,
            })) {
                continue;
            }
            totalPdfsFound += 1;
            const key = `${email.id}:${att.attachment_id}`;
            if (!includeProcessed &&
                (reconciledKeys.has(key) || reconciledFilenames.has(att.filename))) {
                alreadyProcessed += 1;
                skippedReasons.push(`Statement ${att.filename}: already reconciled`);
                continue;
            }
            const date = extractStatementNumberFromFilename(att.filename, email.subject ?? null);
            candidates.push({
                attachment_id: att.attachment_id,
                filename: att.filename,
                size_bytes: att.size_bytes ?? 0,
                content_type: att.content_type ?? '',
                already_processed: false,
                sort_key: date.sort_key,
                statement_date: date.display_date,
            });
        }
        if (candidates.length === 0)
            continue;
        const detectedBank = detectBankFromEmail(email.from_address ?? '', candidates[0]?.filename ?? '', email.subject ?? '');
        const firstFilename = candidates[0]?.filename ?? '';
        const dateForEmail = extractStatementNumberFromFilename(firstFilename, email.subject ?? null);
        statements.push({
            email_id: email.id,
            subject: email.subject ?? null,
            from_address: email.from_address ?? null,
            received_at: email.received_at instanceof Date
                ? email.received_at.toISOString()
                : email.received_at
                    ? String(email.received_at)
                    : null,
            detected_bank: detectedBank,
            sort_key: dateForEmail.sort_key,
            statement_date: dateForEmail.display_date,
            attachments: candidates.sort((a, b) => compareSortKeys(a.sort_key, b.sort_key)),
            validation_status: input.validateBalances === false ? 'unsupported' : 'pending',
        });
    }
    statements.sort((a, b) => compareSortKeys(a.sort_key, b.sort_key));
    return {
        success: true,
        bank_code: bankCode,
        reconciled_balance: bank.reconciled_balance,
        opera_sort_code: bank.sort_code,
        opera_account_number: bank.account_number,
        total_emails_scanned: totalEmailsScanned,
        total_pdfs_found: totalPdfsFound,
        already_processed_count: alreadyProcessed,
        skipped_reasons: skippedReasons,
        statements,
    };
}
//# sourceMappingURL=scan-emails.js.map
/**
 * scan_all_banks_for_statements — faithful TS port of
 * apps/bank_reconcile/api/routes.py:6559 (1,375 lines).
 *
 * 8-step orchestration:
 *   1. Bank discovery + lookup tables          (legacy: 6662-6712)
 *   2. Email fetch (cached or live IMAP)       (legacy: 6714-6730)
 *      + load statement tracking data         (legacy: 6720-6749)
 *      + imported_pending_closings chain      (legacy: 6750-6789)
 *   3. Email scan + classify + bucket          (legacy: 6873-7303)
 *   4. Folder scan                             (legacy: 7306-7556)  — pending
 *   4a. Cross-check by sort/acct               (legacy: 7557-7597)  — pending
 *   4b. Sort statements                        (legacy: 7598-7605)
 *   5. Sort + filter reconciled + finalize     (legacy: 7615-7905)
 *      + draft annotation                     (legacy: 7647-7684)
 *      + final cleanup                        (legacy: 7686-7805)
 *      + per-bank extraction_status           (legacy: 7817-7861)
 *      + sequential statement gating          (legacy: 7862-7906)
 *
 * Legacy uses six external dependencies the SAM port doesn't have yet:
 *
 *   - email_sync_manager.sync_all_providers()  — IMAP sync trigger.
 *     SAM port reads IMAP live via the standalone IMAP adapter
 *     (or SAM's ctx.emailIngest), no sync trigger needed.
 *   - email_storage.get_emails_with_attachments() — cached emails.
 *     SAM port reads live via mailbox.list(); same response shape.
 *   - sql_rag.pdf_extraction_cache.get_extraction_cache()  — PDF
 *     content cache. Without it the cached-info fast-path simply
 *     does not fire; matches legacy's degraded behaviour when the
 *     cache module is unavailable (try/except return).
 *   - sql_rag.period_reconciliation.check_period_reconciled — used
 *     in step 5 final cleanup. Same degradation: when the module
 *     can't be imported, legacy line 7768 catches and continues.
 *   - DeferredTransactionsDB.count_for_statement — used for
 *     deferred_count. SAM port reads the migrated
 *     deferred_transactions table directly (line ~565 below).
 *   - email_storage.get_draft_statement_keys — read from migrated
 *     bank_import_drafts table.
 *
 * Each of those gaps surfaces as a `logger.debug(...)` line in the
 * legacy itself, so this port matches legacy behaviour when the
 * dependency is absent.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { detectBankFromEmail, extractStatementNumberFromFilename, isBankStatementAttachment, } from './email-helpers.js';
import { getAllStatementTrackingData, } from './statement-tracking.js';
import { sortStatementsByChain, filterFullyReconciledStatements, } from './scan-chain-ordering.js';
import { buildOperaSePeriodReconciliationDs, checkPeriodReconciled, } from './period-reconciliation.js';
import { markStatementReconciled } from './statement-files.js';
import { autoCleanResolvedDefers } from './deferred-items.js';
import { checkChainComplete } from './scan-chain-check.js';
import { findExistingCycleRow } from './cycle-row-lookup.js';
import { classifyExtractionError, getGeminiBreaker, } from '../_shared/extraction-error.js';
// Shared Gemini circuit breaker — same instance used by every call
// site (scan loop, /extract endpoint, future bulk import). Opens
// after 3 consecutive auth/quota failures. When open, subsequent
// scans skip Gemini calls entirely and surface the underlying
// error to the operator. Half-open after 60s — a single test call
// goes through to detect recovery.
const geminiBreaker = getGeminiBreaker();
/**
 * Read opening/closing/period balances from the per-PDF extraction
 * cache when the bank_statement_imports tracking has no row for
 * this filename yet. Hashes the PDF (SHA256), queries
 * extraction_cache, parses statement_info from the cached
 * extraction_json. Returns null when:
 *   - the file isn't readable
 *   - no cache row for the hash
 *   - the JSON is malformed or missing opening/closing
 *
 * Faithful port of legacy step-4 fallback (routes.py:6440 which
 * calls `pdf_extraction_cache.get_extraction_cache()` keyed by
 * file hash). Means a statement that's been Analysed but not yet
 * Imported still shows balances in the Bank Statements grid
 * instead of being stuck at "Pending".
 */
async function readBalancesFromExtractionCache(appDb, filePath, logger) {
    try {
        const bytes = await readFile(filePath);
        const hash = createHash('sha256').update(bytes).digest('hex');
        const row = (await appDb('extraction_cache')
            .where({ content_hash: hash })
            .first());
        if (!row?.extraction_json)
            return null;
        const parsed = JSON.parse(row.extraction_json);
        const info = parsed.statement_info ?? {};
        const opening = typeof info.opening_balance === 'number' ? info.opening_balance : null;
        const closing = typeof info.closing_balance === 'number' ? info.closing_balance : null;
        if (opening === null || closing === null)
            return null;
        return {
            opening_balance: opening,
            closing_balance: closing,
            period_start: typeof info.period_start === 'string' ? info.period_start : null,
            period_end: typeof info.period_end === 'string' ? info.period_end : null,
            sort_code: typeof info.sort_code === 'string' ? info.sort_code : null,
            account_number: typeof info.account_number === 'string' ? info.account_number : null,
        };
    }
    catch (err) {
        logger.debug(`extraction_cache fallback failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}
function normaliseSortAcct(value) {
    return (value ?? '').replace(/[-\s]/g, '').trim();
}
export async function scanAllBanksFaithful(operaDb, mailbox, appDb, logger, opts = {}) {
    const daysBack = Number.isFinite(opts.daysBack) ? Number(opts.daysBack) : 30;
    const pageSize = Number.isFinite(opts.pageSize) ? Number(opts.pageSize) : 500;
    const validateBalances = opts.validateBalances !== false;
    const extractOnMiss = opts.extractOnMiss !== false;
    const extractor = opts.extractor ?? null;
    const emailAttachments = opts.emailAttachments ?? null;
    const t0 = Date.now();
    const timings = {};
    const nonCurrent = {
        already_processed: [],
        old_statements: [],
        not_classified: [],
        advanced: [],
    };
    // ---- Step 1: Load all banks from nbank, build lookup tables ----
    let allBanks;
    const bankLookup = new Map(); // "<sort><acct>" -> bank_code
    try {
        const rows = (await operaDb.raw(`SELECT RTRIM(nk_acnt) AS bank_code,
              RTRIM(nk_desc) AS description,
              RTRIM(ISNULL(nk_sort, '')) AS sort_code,
              RTRIM(ISNULL(nk_number, '')) AS account_number,
              ISNULL(nk_recbal, 0) / 100.0 AS reconciled_balance,
              ISNULL(nk_curbal, 0) / 100.0 AS current_balance,
              CASE WHEN nk_petty = 1 THEN 'Petty Cash' ELSE 'Bank Account' END AS type
       FROM nbank WITH (NOLOCK)
       ORDER BY nk_acnt`));
        allBanks = {};
        for (const r of rows ?? []) {
            const code = (r.bank_code ?? '').trim();
            if (!code)
                continue;
            allBanks[code] = {
                ...r,
                bank_code: code,
                statements: [],
                statement_count: 0,
            };
            const normSort = normaliseSortAcct(r.sort_code);
            const normAcct = normaliseSortAcct(r.account_number);
            if (normSort && normAcct) {
                bankLookup.set(`${normSort}|${normAcct}`, code);
            }
        }
        logger.info(`Scan-all-banks: loaded ${Object.keys(allBanks).length} bank accounts, ${bankLookup.size} with sort/acct for matching`);
    }
    catch (err) {
        return errorResponse(err, daysBack, timings, t0);
    }
    if (Object.keys(allBanks).length === 0) {
        return {
            ...emptyResponse(daysBack, t0, timings),
            success: false,
            error: 'No bank accounts found in Opera',
        };
    }
    timings.banks_load = round1((Date.now() - t0) / 1000);
    const t1 = Date.now();
    // ---- Step 2: Email fetch + tracking data ----
    const fromDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    let emails = [];
    // Sync the mailbox first so the scan sees emails that have arrived
    // since the last sync. scan-emails (per-bank) does this; we do it
    // here too so the Hub's aggregated scan reflects fresh IMAP state.
    // 30s timeout matches scan-emails — IMAP fetch on a slow server
    // shouldn't block the whole Hub render forever.
    let mailboxSynced = false;
    let mailboxSyncSkipped = false;
    if (mailbox && mailbox.sync) {
        try {
            await Promise.race([
                mailbox.sync(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('sync timeout')), 30_000)),
            ]);
            mailboxSynced = true;
        }
        catch (err) {
            mailboxSyncSkipped = true;
            logger.warn(`Scan-all-banks: mailbox.sync failed (proceeding with cached): ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    else if (mailbox) {
        // Adapter has no sync() method — already-cached state only.
        mailboxSyncSkipped = true;
    }
    if (mailbox) {
        try {
            const result = await mailbox.list({ fromDate, pageSize });
            emails = (result.emails ?? []).map((e) => ({
                id: typeof e.id === 'number' ? e.id : Number(e.id),
                from_address: e.from_address ?? null,
                subject: e.subject ?? null,
                received_at: e.received_at ?? null,
                has_attachments: (e.attachments?.length ?? 0) > 0,
                attachments: (e.attachments ?? []).map((a) => ({
                    attachment_id: a.attachment_id,
                    filename: a.filename,
                    content_type: a.content_type ?? null,
                    size_bytes: a.size_bytes,
                })),
            }));
        }
        catch (err) {
            logger.warn(`Scan-all-banks: mailbox.list failed: ${err.message}`);
        }
    }
    // Tracking data — matches legacy line 6720
    const tracking = appDb
        ? await getAllStatementTrackingData(appDb).catch(() => emptyTracking())
        : emptyTracking();
    logger.info(`Scan: got ${tracking.managed_keys.size} managed_keys, ${tracking.managed_filenames.size} managed_filenames`);
    // Build detected_bank_name → bank_code lookup from previous imports
    // (legacy line 6806). Allows Tide/fintech matching even with generic
    // filenames like "attachment.pdf".
    const detectedNameToBank = new Map();
    for (const info of tracking.cached_stmt_info.values()) {
        const stmtSort = normaliseSortAcct(info.sort_code);
        const stmtAcct = normaliseSortAcct(info.account_number);
        if (stmtSort && stmtAcct) {
            const code = bankLookup.get(`${stmtSort}|${stmtAcct}`);
            if (code && info.bank_code) {
                const lowDesc = (allBanks[code]?.description ?? '').toLowerCase();
                const detected = legacyBankNameFromDescription(lowDesc);
                if (detected)
                    detectedNameToBank.set(detected, code);
            }
        }
    }
    // Build imported_pending_closings — sequential gating helper (legacy line 6756).
    const importedPendingClosings = new Map();
    for (const [, info] of tracking.cached_stmt_info.entries()) {
        if (info.bank_code === 'DEDUP' || !info.bank_code)
            continue;
        if (tracking.imported_nr_filenames.has(info.filename)) {
            const closing = info.closing_balance;
            if (closing !== null && closing !== undefined) {
                let s = importedPendingClosings.get(info.bank_code);
                if (!s) {
                    s = new Set();
                    importedPendingClosings.set(info.bank_code, s);
                }
                s.add(round2(closing));
            }
        }
    }
    function openingUnblocksChain(bankCode, opening) {
        // Legacy line 6774.
        if (opening === null || opening === undefined || !bankCode)
            return false;
        const target = round2(opening);
        const recBal = allBanks[bankCode]?.reconciled_balance;
        if (recBal !== null && recBal !== undefined && target === round2(recBal))
            return true;
        const recOpens = tracking.reconciled_opening_balances.get(bankCode);
        if (recOpens && recOpens.has(target))
            return true;
        const pending = importedPendingClosings.get(bankCode);
        if (pending && pending.has(target))
            return true;
        return false;
    }
    // openingUnblocksChain is the chain-advance callback used by the
    // chain-check at the bottom of this file. Lets the 3rd statement
    // in a sequence through when the middle statement is imported-
    // but-not-reconciled (`imported_pending_closings` contains its
    // closing balance, which becomes the 3rd statement's expected
    // opening). Legacy line 6774. Pre-port TS built the callback then
    // discarded it with `void openingUnblocksChain` — audit 2026-05-15
    // GAP-1.
    let totalEmailsScanned = 0;
    let totalPdfsFound = 0;
    const emailsSavedToFolders = 0;
    const duplicatesArchived = 0;
    // ---- Step 3: Scan emails ----
    // Faithful port of routes.py:6873.
    for (const email of emails) {
        if (!email.has_attachments)
            continue;
        totalEmailsScanned += 1;
        const attachments = email.attachments ?? [];
        if (attachments.length === 0)
            continue;
        const emailFrom = email.from_address ?? '';
        const emailSubject = email.subject ?? '';
        const emailId = email.id;
        for (const att of attachments) {
            const filename = att.filename ?? '';
            const contentType = att.content_type ?? '';
            const attachmentId = att.attachment_id;
            if (!isBankStatementAttachment({
                filename,
                contentType,
                subject: emailSubject,
                fromAddress: emailFrom,
            })) {
                continue;
            }
            totalPdfsFound += 1;
            // Skip managed (archived/deleted/retained). Legacy line 6898.
            const eaKey = `${emailId}:${attachmentId}`;
            const baseName = filename.includes('.')
                ? filename.slice(0, filename.lastIndexOf('.'))
                : filename;
            const isManaged = tracking.managed_keys.has(eaKey) ||
                tracking.managed_filenames.has(filename) ||
                Array.from(tracking.managed_filenames).some((mf) => mf.startsWith(baseName));
            if (isManaged) {
                logger.info(`Scan: skipping managed email ${filename}`);
                continue;
            }
            // Skip fully reconciled. Legacy line 6913.
            if (tracking.reconciled_keys.has(eaKey) ||
                tracking.reconciled_filenames.has(filename)) {
                continue;
            }
            const isImportedNotReconciled = tracking.imported_nr_keys.has(eaKey) ||
                tracking.imported_nr_filenames.has(filename);
            const detectedBankName = detectBankFromEmail(emailFrom, filename, emailSubject);
            const { sort_key: sortKey, display_date: statementDate } = extractStatementNumberFromFilename(filename, emailSubject);
            const stmt = {
                source: 'email',
                email_id: emailId,
                attachment_id: attachmentId,
                filename,
                subject: emailSubject,
                from_address: emailFrom,
                received_at: email.received_at instanceof Date
                    ? email.received_at.toISOString()
                    : (email.received_at ?? null),
                detected_bank_name: detectedBankName,
                already_processed: false,
                status: isImportedNotReconciled ? 'imported' : 'pending',
                sort_key: sortKey,
                statement_date: statementDate,
            };
            // `is_imported` field used by step 5's final cleanup auto-promote.
            stmt.is_imported = isImportedNotReconciled;
            let matchedBankCode = null;
            // FAST PATH: cached info from previous imports. Legacy line 6940.
            const cachedInfo = tracking.cached_stmt_info.get(filename);
            if (cachedInfo && validateBalances) {
                logger.info(`Scan fast-path: using cached info for ${filename}`);
                stmt.opening_balance = cachedInfo.opening_balance;
                stmt.closing_balance = cachedInfo.closing_balance;
                stmt.period_start = cachedInfo.period_start;
                stmt.period_end = cachedInfo.period_end;
                stmt.sort_code = cachedInfo.sort_code;
                stmt.account_number =
                    cachedInfo.account_number;
                stmt.bank_name = cachedInfo.bank_code;
                const stmtSort = normaliseSortAcct(cachedInfo.sort_code);
                const stmtAcct = normaliseSortAcct(cachedInfo.account_number);
                if (stmtSort && stmtAcct) {
                    matchedBankCode =
                        bankLookup.get(`${stmtSort}|${stmtAcct}`) ?? null;
                }
                if (!matchedBankCode && detectedBankName) {
                    matchedBankCode =
                        detectedNameToBank.get(detectedBankName.toLowerCase()) ?? null;
                    if (matchedBankCode) {
                        logger.info(`Cached fast-path: matched '${filename}' to ${matchedBankCode} via detected bank name '${detectedBankName}'`);
                    }
                }
                if (!matchedBankCode && detectedBankName) {
                    const detectedLower = detectedBankName.toLowerCase();
                    const nameMatches = Object.entries(allBanks)
                        .filter(([, b]) => {
                        const d = (b.description ?? '').toLowerCase();
                        return d.includes(detectedLower) || detectedLower.includes(d);
                    })
                        .map(([code]) => code);
                    if (nameMatches.length === 1) {
                        matchedBankCode = nameMatches[0];
                    }
                }
                if (matchedBankCode) {
                    stmt.status = 'ready';
                }
            }
            else if (validateBalances && filename.toLowerCase().endsWith('.pdf')) {
                // No cached info — metadata-based bank matching. Legacy line 6983.
                stmt.status = 'ready';
                // Priority 1: account number in filename.
                const acctMatches = filename.match(/\b(\d{8,})\b/g) ?? [];
                for (const acct of acctMatches) {
                    for (const [code, info] of Object.entries(allBanks)) {
                        const operaAcct = normaliseSortAcct(info.account_number);
                        if (operaAcct && acct === operaAcct) {
                            matchedBankCode = code;
                            logger.info(`Scan: matched '${filename}' to ${code} via account number ${acct} in filename`);
                            break;
                        }
                    }
                    if (matchedBankCode)
                        break;
                }
                // Priority 2: detected bank name (unambiguous).
                if (!matchedBankCode && detectedBankName) {
                    const detectedLower = detectedBankName.toLowerCase();
                    const nameMatches = [];
                    for (const [code, info] of Object.entries(allBanks)) {
                        const descLower = (info.description ?? '').toLowerCase();
                        if (descLower.includes(detectedLower) ||
                            detectedLower.includes(descLower)) {
                            nameMatches.push(code);
                        }
                    }
                    if (nameMatches.length === 1) {
                        matchedBankCode = nameMatches[0];
                    }
                    else if (nameMatches.length > 1) {
                        // Disambiguate via account number in subject/filename.
                        const allSources = `${filename} ${emailSubject ?? ''}`
                            .replace(/[-\s]/g, '');
                        for (const code of nameMatches) {
                            const operaAcct = normaliseSortAcct(allBanks[code]?.account_number);
                            if (operaAcct && allSources.includes(operaAcct)) {
                                matchedBankCode = code;
                                logger.info(`Scan: disambiguated '${filename}' to ${code} via account number in metadata`);
                                break;
                            }
                        }
                        if (!matchedBankCode) {
                            matchedBankCode = nameMatches[0];
                            logger.info(`Scan: ambiguous bank name match for '${filename}' — ${nameMatches.join(',')}, using ${matchedBankCode} pending PDF extraction`);
                        }
                    }
                }
                // Priority 3: from detected_name_to_bank lookup.
                if (!matchedBankCode && detectedBankName) {
                    matchedBankCode =
                        detectedNameToBank.get(detectedBankName.toLowerCase()) ?? null;
                }
                // Priority 4: description word match (fallback). Legacy line 7031.
                if (!matchedBankCode) {
                    const matchSources = [
                        (emailFrom ?? '').toLowerCase(),
                        filename.toLowerCase(),
                        (emailSubject ?? '').toLowerCase(),
                    ];
                    outer: for (const [code, info] of Object.entries(allBanks)) {
                        const desc = (info.description ?? '').toLowerCase();
                        const descWords = desc
                            .split(/\s+/)
                            .filter((w) => w.length >= 4 &&
                            !['bank', 'account', 'current', 'the', 'and', 'for', 'with'].includes(w));
                        for (const word of descWords) {
                            for (const source of matchSources) {
                                if (source.includes(word)) {
                                    matchedBankCode = code;
                                    break outer;
                                }
                            }
                        }
                    }
                }
                // Legacy then attempts a PDF download → extraction cache check.
                // Without a Gemini cache adapter wired, we skip and statements
                // stay at status='ready' (already set above). Matches legacy
                // line 7132: `except Exception as dl_err: ... pass through`.
                if (!matchedBankCode) {
                    logger.info(`Scan-all: skipping ${filename} — no Opera bank match from metadata`);
                }
            }
            // Step 3 bucket assignment. Legacy line 7265.
            const category = stmt.category;
            if (matchedBankCode) {
                const b = allBanks[matchedBankCode];
                stmt.matched_bank_code = matchedBankCode;
                stmt.matched_bank_description = b.description;
                stmt.matched_sort_code = b.sort_code;
                stmt.matched_account_number = b.account_number;
                if (category === 'already_processed' || category === 'old_statement') {
                    const ncKey = category === 'old_statement' ? 'old_statements' : 'already_processed';
                    nonCurrent[ncKey].push(stmt);
                }
                else if (category === 'advanced') {
                    nonCurrent.advanced.push(stmt);
                }
                else if (stmt.status === 'ready' ||
                    stmt.status === 'imported' ||
                    stmt.status === 'pending_extraction') {
                    b.statements.push(stmt);
                }
                else {
                    logger.info(`Skipping ${filename} for ${matchedBankCode}: status=${stmt.status}`);
                }
            }
            else {
                logger.info(`Skipping ${filename}: no matching Opera bank in current company`);
                nonCurrent.not_classified.push(stmt);
            }
        }
    }
    timings.scan_emails = round1((Date.now() - t1) / 1000);
    const t2 = Date.now();
    // ---- Step 4: Scan local PDF folders ----
    // Faithful port of routes.py:7306. Reads PDFs from
    // `<folder_settings.base_folder>/<bank_code>-<slug>/*.pdf`.
    // Folder-name prefix match (legacy line 7411) assigns the statement
    // to the matching Opera bank even without PDF extraction.
    // PDF cache lookup + Gemini extraction (legacy lines 7361-7457) are
    // skipped when no PDF cache adapter is wired — matches legacy
    // graceful-fallback at line 7405.
    let basePath = null;
    if (appDb) {
        try {
            const row = (await appDb('settings')
                .where({ key: 'folder_settings' })
                .first());
            if (row?.value) {
                const parsed = JSON.parse(row.value);
                if (parsed.base_folder && parsed.base_folder.length > 0) {
                    basePath = parsed.base_folder;
                }
            }
        }
        catch {
            // tolerated
        }
    }
    if (basePath) {
        const { existsSync, readdirSync, statSync } = await import('node:fs');
        const { join } = await import('node:path');
        const seenBankFilenames = new Map();
        if (existsSync(basePath)) {
            let subdirs;
            try {
                subdirs = readdirSync(basePath, { withFileTypes: true })
                    .filter((d) => d.isDirectory() && d.name !== 'archive')
                    .map((d) => d.name)
                    .sort();
            }
            catch {
                subdirs = [];
            }
            for (const folderName of subdirs) {
                const folderPath = join(basePath, folderName);
                if (!existsSync(folderPath))
                    continue;
                let files;
                try {
                    files = readdirSync(folderPath, { withFileTypes: true })
                        .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.pdf'))
                        .map((d) => d.name);
                }
                catch {
                    continue;
                }
                for (const filename of files) {
                    const fileIsImportedNr = tracking.imported_nr_filenames.has(filename);
                    const folderBaseClean = filename
                        .replace(/\.[^.]+$/, '')
                        .replace(/_\d+$/, '');
                    const isManaged = tracking.managed_filenames.has(filename) ||
                        Array.from(tracking.managed_filenames).some((mf) => mf.startsWith(folderBaseClean));
                    if (isManaged)
                        continue;
                    if (tracking.reconciled_filenames.has(filename))
                        continue;
                    totalPdfsFound += 1;
                    const fullPath = join(folderPath, filename);
                    const { sort_key: sortKey, display_date: statementDate } = extractStatementNumberFromFilename(filename, '');
                    const stmt = {
                        source: 'pdf',
                        full_path: fullPath,
                        file_path: fullPath,
                        filename,
                        already_processed: false,
                        status: fileIsImportedNr ? 'imported' : 'pending',
                        sort_key: sortKey,
                        statement_date: statementDate,
                    };
                    stmt.folder = folderName;
                    stmt.is_imported =
                        fileIsImportedNr;
                    // Cached statement info (from bank_statement_imports). The
                    // tracking-data map keyed by filename gives us the same
                    // opening/closing/period balances when the statement has
                    // been imported before. When that misses, fall back to the
                    // PDF extraction cache (extraction_cache table, SHA256-
                    // keyed) — faithful port of legacy step 4's `get_extraction_
                    // _cache()` lookup at routes.py:6440. Lets the FE display
                    // balances for statements that have been extracted via
                    // Analyse but not yet successfully imported.
                    const cachedInfo = tracking.cached_stmt_info.get(filename);
                    if (cachedInfo && validateBalances) {
                        stmt.opening_balance = cachedInfo.opening_balance;
                        stmt.closing_balance = cachedInfo.closing_balance;
                        stmt.period_start = cachedInfo.period_start;
                        stmt.period_end = cachedInfo.period_end;
                        stmt.sort_code =
                            cachedInfo.sort_code;
                        stmt.account_number =
                            cachedInfo.account_number;
                        stmt.extraction_status =
                            'cached';
                    }
                    else if (validateBalances && appDb) {
                        const extracted = await readBalancesFromExtractionCache(appDb, fullPath, logger);
                        if (extracted) {
                            stmt.opening_balance = extracted.opening_balance;
                            stmt.closing_balance = extracted.closing_balance;
                            stmt.period_start = extracted.period_start;
                            stmt.period_end = extracted.period_end;
                            stmt.sort_code =
                                extracted.sort_code;
                            stmt.account_number =
                                extracted.account_number;
                            stmt.extraction_status =
                                'cached';
                        }
                    }
                    // Folder-name prefix match (legacy 7411).
                    let matchedBankCode = null;
                    const folderPrefix = (folderName.includes('-')
                        ? folderName.split('-')[0]
                        : folderName).toUpperCase();
                    if (allBanks[folderPrefix]) {
                        matchedBankCode = folderPrefix;
                        const b = allBanks[folderPrefix];
                        if (b) {
                            stmt.status = 'ready';
                            stmt.matched_bank_code = matchedBankCode;
                            stmt.matched_bank_description = b.description;
                            stmt.matched_sort_code = b.sort_code;
                            stmt.matched_account_number = b.account_number;
                            stmt.sort_code =
                                b.sort_code;
                            stmt.account_number =
                                b.account_number;
                            logger.info(`Matched ${filename} to ${matchedBankCode} via folder name '${folderName}'`);
                        }
                    }
                    if (!matchedBankCode) {
                        logger.info(`Skipping local PDF ${filename}: no matching Opera bank in current company`);
                        continue;
                    }
                    // Status preservation rule (legacy line 7494).
                    if (stmt.status !== 'ready' &&
                        stmt.status !== 'imported' &&
                        stmt.status !== 'pending_extraction') {
                        logger.info(`Skipping ${filename} for ${matchedBankCode}: status=${stmt.status}`);
                        continue;
                    }
                    // Dedup by filename within bank (legacy line 7496).
                    const fnLower = filename.toLowerCase().trim();
                    const fnKey = `${matchedBankCode}|${fnLower}`;
                    let fileMtime = '';
                    try {
                        fileMtime = String(statSync(fullPath).mtimeMs);
                    }
                    catch {
                        // tolerated
                    }
                    const prev = seenBankFilenames.get(fnKey);
                    if (prev) {
                        const [prevDate, prevEntry] = prev;
                        if (fileMtime > prevDate) {
                            const idx = allBanks[matchedBankCode].statements.indexOf(prevEntry);
                            if (idx >= 0) {
                                allBanks[matchedBankCode].statements.splice(idx, 1);
                            }
                            seenBankFilenames.set(fnKey, [fileMtime, stmt]);
                        }
                        else {
                            continue;
                        }
                    }
                    else {
                        seenBankFilenames.set(fnKey, [fileMtime, stmt]);
                    }
                    allBanks[matchedBankCode].statements.push(stmt);
                }
            }
        }
        else {
            logger.info(`Folder scan: base_folder '${basePath}' does not exist`);
        }
    }
    timings.scan_folder = round1((Date.now() - t2) / 1000);
    // ---- Step 4a: Cross-source dedup ----
    // Three-stage dedup faithful to legacy routes.py:7495-7550:
    //   1. Exact filename (preferring source='pdf' over 'email').
    //   2. Filename-period-key (Monzo / Barclays patterns) — collapses
    //      the legacy "save-with-counter" rename artefacts where the
    //      same statement gets written 30+ times as <name>_1.pdf,
    //      <name>_2.pdf etc. when content differs by metadata only.
    //   3. Start-date supersession — partial Feb (02-01 to 02-19)
    //      superseded by full Feb (02-01 to 02-28). The longer
    //      statement wins.
    // Pre-port TS only had stage 1, leaving 34 near-duplicate PDFs in
    // the Barclays scan for intsys. Audit 2026-05-15 out-of-sequence
    // GAP-3.
    const extractStatementPeriodKey = (fn) => {
        const lower = fn.toLowerCase();
        // Monzo: Monzo_bank_statement_2026-01-01-2026-01-31_4539.pdf
        const monzo = lower.match(/(\d{4}-\d{2}-\d{2})[_-](\d{4}-\d{2}-\d{2})/);
        if (monzo)
            return `${monzo[1]}_${monzo[2]}`;
        // Barclays: Statement DD-MMM-YY AC XXXXXXXX XXXXXXXX.pdf
        const barclays = lower.match(/statement\s+(\d{1,2}-[a-z]{3}-\d{2})\s+ac\s+(\d{8})/);
        if (barclays)
            return `${barclays[1]}_${barclays[2]}`;
        return null;
    };
    const extractPeriodDates = (fn) => {
        const m = fn.match(/(\d{4}-\d{2}-\d{2})[_-](\d{4}-\d{2}-\d{2})/);
        if (m)
            return { start: m[1], end: m[2] };
        return null;
    };
    for (const bank of Object.values(allBanks)) {
        // Stage 1: exact filename
        const byName = new Map();
        for (const stmt of bank.statements) {
            const key = stmt.filename.toLowerCase().trim();
            const existing = byName.get(key);
            if (!existing) {
                byName.set(key, stmt);
                continue;
            }
            if (existing.source === 'pdf')
                continue;
            if (stmt.source === 'pdf')
                byName.set(key, stmt);
        }
        const stage1 = Array.from(byName.values());
        // Stage 2: filename-period-key (statement-number + date)
        const byPeriod = new Map();
        const stage2 = [];
        for (const stmt of stage1) {
            const periodKey = extractStatementPeriodKey(stmt.filename);
            if (!periodKey) {
                stage2.push(stmt);
                continue;
            }
            const existing = byPeriod.get(periodKey);
            if (!existing) {
                byPeriod.set(periodKey, stmt);
                stage2.push(stmt);
                continue;
            }
            // Tiebreak between same-period-key PDFs.
            // 1. Prefer the file without an `_N` counter suffix (the
            //    original — when one is `attachment_1.pdf`, the other
            //    `attachment.pdf`, the bare one wins).
            // 2. When both have suffixes (typical for Monzo, which always
            //    appends a generation id like `_8732`/`_8841`), prefer
            //    the one with the LATER `received_at` — bank statements
            //    issued later are restated/refreshed versions that
            //    supersede earlier ones for the same period.
            // 3. If received_at is missing/equal, prefer the LARGER
            //    numeric suffix (Monzo's file IDs are monotonically
            //    increasing per cycle).
            // 4. Final tiebreaker: keep the first seen.
            const existingHasSuffix = /_\d+\.pdf$/i.test(existing.filename);
            const stmtHasSuffix = /_\d+\.pdf$/i.test(stmt.filename);
            const extractSuffix = (fn) => {
                const m = fn.match(/_(\d+)\.pdf$/i);
                return m ? Number(m[1]) : Number.NaN;
            };
            let stmtWins = false;
            let replaceReason = '';
            if (existingHasSuffix && !stmtHasSuffix) {
                // Rule 1 — bare name beats suffixed copy.
                stmtWins = true;
                replaceReason = 'bare-filename';
            }
            else if (existingHasSuffix && stmtHasSuffix) {
                // Rule 2 — later received_at wins for same-period restatements.
                const existingRx = existing.received_at
                    ? Date.parse(String(existing.received_at))
                    : Number.NaN;
                const stmtRx = stmt.received_at
                    ? Date.parse(String(stmt.received_at))
                    : Number.NaN;
                if (Number.isFinite(stmtRx) && Number.isFinite(existingRx) && stmtRx !== existingRx) {
                    stmtWins = stmtRx > existingRx;
                    replaceReason = stmtWins ? 'later-received_at' : '';
                }
                else {
                    // Rule 3 — larger numeric suffix wins (Monzo monotonic IDs).
                    const exN = extractSuffix(existing.filename);
                    const stN = extractSuffix(stmt.filename);
                    if (Number.isFinite(exN) && Number.isFinite(stN) && exN !== stN) {
                        stmtWins = stN > exN;
                        replaceReason = stmtWins ? 'higher-suffix' : '';
                    }
                }
            }
            if (stmtWins) {
                const idx = stage2.indexOf(existing);
                if (idx >= 0)
                    stage2.splice(idx, 1);
                byPeriod.set(periodKey, stmt);
                stage2.push(stmt);
                logger.info(`period-dedup[${bank.bank_code}]: kept ${stmt.filename} (${replaceReason}), dropped ${existing.filename}`);
            }
            else {
                logger.info(`period-dedup[${bank.bank_code}]: dropped duplicate ${stmt.filename} (period ${periodKey} already present as ${existing.filename})`);
            }
        }
        // Stage 3: start-date supersession (e.g. partial Feb superseded
        // by full Feb on same period_start).
        const byStart = new Map();
        const stage3 = [];
        for (const stmt of stage2) {
            const dates = extractPeriodDates(stmt.filename);
            if (!dates) {
                stage3.push(stmt);
                continue;
            }
            const existing = byStart.get(dates.start);
            if (!existing) {
                byStart.set(dates.start, stmt);
                stage3.push(stmt);
                continue;
            }
            const existingDates = extractPeriodDates(existing.filename);
            if (!existingDates) {
                stage3.push(stmt);
                continue;
            }
            // Whichever covers a LATER end date wins (full-period beats
            // partial-period). Same end date → keep existing.
            if (dates.end > existingDates.end) {
                const idx = stage3.indexOf(existing);
                if (idx >= 0)
                    stage3.splice(idx, 1);
                byStart.set(dates.start, stmt);
                stage3.push(stmt);
                logger.info(`start-date-dedup[${bank.bank_code}]: ${stmt.filename} (${dates.end}) supersedes ${existing.filename} (${existingDates.end})`);
            }
            else if (dates.end < existingDates.end) {
                logger.info(`start-date-dedup[${bank.bank_code}]: ${stmt.filename} (${dates.end}) superseded by ${existing.filename} (${existingDates.end})`);
            }
            else {
                stage3.push(stmt);
            }
        }
        bank.statements = stage3;
    }
    // ---- Step 5: Sort + finalize each bank's statements ----
    // Legacy line 7615. fill_missing_balances_from_cache is a no-op
    // without PDF cache (see scan-chain-ordering.ts).
    const banksWithStatements = {};
    let totalStatements = 0;
    // Auto-clean defer audit rows whose transaction has since been
    // posted to Opera. Faithful port of `_auto_clean_resolved_defers`
    // (routes.py:133). Runs once per scan, per bank, before computing
    // deferred_count so the operator sees the corrected number. Silent
    // and idempotent — no rows changed means no log noise.
    if (appDb) {
        for (const [code] of Object.entries(allBanks)) {
            await autoCleanResolvedDefers(appDb, operaDb, code);
        }
    }
    for (const [code, bank] of Object.entries(allBanks)) {
        let stmts = bank.statements;
        logger.info(`Step 5: bank ${code} has ${stmts.length} statements before filtering`);
        if (stmts.length === 0)
            continue;
        const recBal = bank.reconciled_balance;
        stmts = sortStatementsByChain(stmts, recBal);
        stmts = filterFullyReconciledStatements(stmts, code, recBal);
        bank.statements = stmts;
        logger.info(`Step 5 final: ${code} = ${stmts.length} statements`);
        // Clean up internal sort_key + assign import_sequence.
        stmts.forEach((s, i) => {
            delete s.sort_key;
            s.import_sequence = i + 1;
        });
        bank.statement_count = stmts.length;
        totalStatements += stmts.length;
        banksWithStatements[code] = bank;
    }
    // Draft annotation. Legacy line 7647. Source: migrated bank_import_drafts.
    if (appDb) {
        try {
            const drafts = (await appDb('bank_import_drafts')
                .select('bank_code', 'source', 'email_id', 'attachment_id', 'filename', 'updated_at'));
            const draftByBank = new Map();
            for (const d of drafts) {
                let entry = draftByBank.get(d.bank_code);
                if (!entry) {
                    entry = { byFilename: new Map(), byKey: new Map() };
                    draftByBank.set(d.bank_code, entry);
                }
                const upd = String(d.updated_at);
                if (d.filename)
                    entry.byFilename.set(d.filename, upd);
                if (d.source === 'email') {
                    entry.byKey.set(`email|${d.email_id ?? ''}|${d.attachment_id ?? ''}`, upd);
                }
                else {
                    entry.byKey.set(`pdf|${d.filename}|`, upd);
                }
            }
            for (const [code, bank] of Object.entries(banksWithStatements)) {
                const entry = draftByBank.get(code);
                if (!entry)
                    continue;
                for (const stmt of bank.statements) {
                    const fn = stmt.filename ?? '';
                    if (fn && entry.byFilename.has(fn)) {
                        stmt.has_draft = true;
                        stmt.draft_updated_at = entry.byFilename.get(fn) ?? null;
                    }
                    else {
                        const src = stmt.source;
                        const key = src === 'email'
                            ? `email|${stmt.email_id ?? ''}|${stmt.attachment_id ?? ''}`
                            : `pdf|${fn}|`;
                        if (entry.byKey.has(key)) {
                            stmt.has_draft = true;
                            stmt.draft_updated_at = entry.byKey.get(key) ?? null;
                        }
                        else {
                            stmt.has_draft = false;
                        }
                    }
                }
            }
        }
        catch (e) {
            logger.debug(`Could not annotate drafts for scan-all-banks: ${e.message}`);
        }
    }
    // Auto-promote imported statements where period is fully reconciled.
    // Faithful port of routes.py:7693-7769. For every is_imported
    // statement on a bank with a known rec_bal, query the single source
    // of truth (check_period_reconciled) and auto-mark as reconciled
    // when FULLY_RECONCILED. UNKNOWN / PARTIALLY_RECONCILED keep the
    // row visible (legacy line 7757-7766 "show, don't auto-promote").
    const finalRecFilenames = new Set(tracking.reconciled_filenames);
    // Self-heal pass — for each bank, run the balance-match auto-promote
    // BEFORE checkPeriodReconciled. The balance-match check is stronger
    // (uses Opera's authoritative nk_recbal directly, doesn't depend on
    // line-level Opera atran/aentry data) and handles the
    // "SAM-reconcile-completed-but-flag-never-flipped" case which is
    // common in the wild. selfHealBalanceMatch enforces strict safety
    // conditions internally (exactly one match, at-or-after the
    // anchor's statement_date) so a false-positive promotion is
    // impossible.
    try {
        const { selfHealBalanceMatch } = await import('./self-heal-reconciled-flag.js');
        for (const [code, bank] of Object.entries(banksWithStatements)) {
            if (!appDb)
                continue;
            const recBal = bank.reconciled_balance;
            if (recBal === null || recBal === undefined)
                continue;
            const healed = await selfHealBalanceMatch(operaDb, appDb, code);
            if (healed.promoted) {
                // Mark the promoted statement as reconciled in the in-memory
                // scan result too, so the post-cleanup filter drops it from
                // the bank's "needs action" list.
                const promotedStmt = bank.statements.find((s) => s.closing_balance !== null &&
                    s.closing_balance !== undefined &&
                    Math.abs(Number(s.closing_balance) - (healed.closing_balance ?? 0)) <
                        0.005);
                if (promotedStmt)
                    finalRecFilenames.add(promotedStmt.filename);
                logger.info(`Scan self-heal: ${code} promoted import_id=${healed.import_id} ` +
                    `(closing=£${(healed.closing_balance ?? 0).toFixed(2)}) ` +
                    `— Opera's nk_recbal proves it was reconciled`);
            }
        }
    }
    catch (healErr) {
        logger.warn(`Scan self-heal failed: ${healErr instanceof Error ? healErr.message : String(healErr)}`);
    }
    try {
        const ds = buildOperaSePeriodReconciliationDs(operaDb);
        for (const [code, bank] of Object.entries(banksWithStatements)) {
            const recBal = bank.reconciled_balance;
            if (recBal === null || recBal === undefined)
                continue;
            for (const stmt of bank.statements) {
                // Originally legacy only auto-promoted status='imported'
                // statements. Widened to also include 'ready' and
                // 'in_progress' state — those are statements SAM has tracked
                // but hasn't marked reconciled, even though Opera may
                // already have the entries (the common "Opera ahead of SAM"
                // case: workflow completed but is_reconciled never flipped).
                // checkPeriodReconciled still guards behind FULLY_RECONCILED,
                // so we only promote when Opera genuinely has the period
                // reconciled — false positives are impossible.
                const eff = (stmt.state ?? stmt.status);
                if (stmt.status !== 'imported' &&
                    eff !== 'ready' &&
                    eff !== 'in_progress') {
                    continue;
                }
                const periodStart = (stmt.period_start ?? null);
                const periodEnd = (stmt.period_end ?? null);
                const closing = (stmt.closing_balance ?? null);
                const res = await checkPeriodReconciled(ds, {
                    bankCode: code,
                    periodStart,
                    periodEnd,
                    statementClosing: closing,
                    currentRecBal: Number(recBal),
                });
                if (res.status === 'fully_reconciled') {
                    const fn = stmt.filename;
                    logger.info(`Scan cleanup: auto-marking '${fn}' as reconciled — ${res.reason}`);
                    finalRecFilenames.add(fn);
                    if (appDb) {
                        try {
                            await markStatementReconciled(appDb, {
                                filename: fn,
                                reconciledCount: 0,
                                bankCode: code,
                            });
                        }
                        catch {
                            /* best-effort */
                        }
                    }
                }
                else if (res.status === 'partially_reconciled' || res.status === 'unknown') {
                    logger.info(`Scan cleanup: NOT auto-marking '${stmt.filename}' — ${res.reason}`);
                }
                // 'not_reconciled': keep visible silently (legacy line 7767).
            }
        }
    }
    catch (promoErr) {
        logger.warn(`Auto-promote scan cleanup failed: ${promoErr instanceof Error ? promoErr.message : String(promoErr)}`);
    }
    // Remove reconciled statements from bank + non_current lists. Legacy 7771.
    for (const [code, bank] of Object.entries(banksWithStatements)) {
        const before = bank.statements.length;
        bank.statements = bank.statements.filter((s) => !finalRecFilenames.has(s.filename));
        const after = bank.statements.length;
        if (before !== after) {
            logger.info(`Final cleanup: ${code} reduced from ${before} to ${after} statements`);
        }
        bank.statement_count = bank.statements.length;
    }
    for (const k of ['already_processed', 'old_statements', 'not_classified', 'advanced']) {
        nonCurrent[k] = nonCurrent[k].filter((s) => !finalRecFilenames.has(s.filename));
    }
    // Sort non_current: bank ascending, then date descending. Legacy 7783.
    for (const k of ['already_processed', 'old_statements', 'not_classified', 'advanced']) {
        nonCurrent[k].sort((a, b) => ncSortKey(b).localeCompare(ncSortKey(a)));
        nonCurrent[k].sort((a, b) => (a.matched_bank_code ?? '').localeCompare(b.matched_bank_code ?? ''));
    }
    // Per-bank extraction_status + sequential gating. Legacy line 7817.
    for (const [, bank] of Object.entries(banksWithStatements)) {
        const stmts = bank.statements;
        const statementsTotal = stmts.length;
        const statementsExtracted = stmts.filter((s) => s.opening_balance != null && s.closing_balance != null).length;
        const extractionFailures = stmts
            .filter((s) => s.opening_balance == null || s.closing_balance == null)
            .map((s) => ({
            filename: s.filename,
            reason: s.extraction_status ?? 'rate_limit',
        }));
        bank.statements_total = statementsTotal;
        bank.statements_extracted = statementsExtracted;
        bank.extraction_failures = extractionFailures;
        // extraction_status drives the FE's per-bank "Process disabled"
        // gate (BankStatementHub.tsx:2243 — canProcess requires
        // bankExtractionComplete !== false). Counting EVERY statement in
        // the folder against the gate breaks the common operator scenario:
        // 1 current statement + a folder of stale unimported PDFs from
        // earlier months. The current statement has cached balances and
        // is ready, but the stale ones drag the bank to "incomplete" and
        // the FE blocks Process. Now we count only the NEXT-IN-SEQUENCE
        // statement (sortStatementsByChain already put it first): if it
        // has balances, the bank is "complete" enough for the operator
        // to proceed. The stale ones still surface as pending_extraction
        // for visibility but don't block the workflow.
        const nextStmt = stmts[0];
        const nextHasBalances = !!nextStmt &&
            nextStmt.opening_balance != null &&
            nextStmt.closing_balance != null;
        bank.extraction_status =
            statementsTotal === 0 || nextHasBalances ? 'complete' : 'incomplete';
        // Per-statement promotion only: a statement with cached balances
        // (opening + closing both set) stays "ready" even when other
        // statements on the same bank failed extraction. The legacy
        // blanket promotion turned a folder full of stale PDFs into a
        // wall of "Pending" rows that blocked the operator from
        // processing the one current statement that DID extract. The
        // pending_extraction signal now only fires for statements that
        // are themselves missing balances.
        if (bank.extraction_status === 'incomplete') {
            for (const s of stmts) {
                const hasBalances = s.opening_balance !== null &&
                    s.opening_balance !== undefined &&
                    s.closing_balance !== null &&
                    s.closing_balance !== undefined;
                if (s.status === 'ready' && !hasBalances) {
                    s.status = 'pending_extraction';
                }
            }
        }
    }
    // ---- Eager extraction pass ----
    // For each bank still marked incomplete, walk pending_extraction
    // statements (up to MAX_EAGER_PER_BANK per scan) and resolve their
    // balances via Gemini. This populates opening_balance +
    // closing_balance + period dates so the FE can render the balance
    // columns AND determine which statement is the next-in-sequence
    // (the one whose opening_balance matches the bank's reconciled
    // balance). Bounded per bank to cap Gemini cost; the rest stay
    // pending until the operator clicks Analyse or re-scans.
    const MAX_EAGER_PER_BANK = 8;
    if (extractOnMiss && extractor && appDb) {
        // Short-circuit when the breaker is open — recent permanent
        // failures (e.g. revoked API key, quota exhausted) mean ALL
        // pending statements should surface the same error, not
        // hammer Gemini and silently fail one-at-a-time.
        if (geminiBreaker.isOpen()) {
            const reason = geminiBreaker.openReason();
            logger.warn(`eager-extract: ${reason}`);
            for (const bank of Object.values(banksWithStatements)) {
                for (const s of bank.statements) {
                    if (s.opening_balance == null || s.closing_balance == null) {
                        s.extraction_status = 'failed';
                        s.extraction_error = reason;
                    }
                }
            }
        }
        else {
            for (const bank of Object.values(banksWithStatements)) {
                // Eligible target = any statement missing balances with a
                // source we can read (folder path or email attachment).
                const targets = bank.statements
                    .filter((s) => (s.opening_balance == null || s.closing_balance == null) &&
                    s.status !== 'imported' &&
                    s.status !== 'already_processed' &&
                    (!!(s.full_path || s.file_path) ||
                        (s.source === 'email' && s.email_id && s.attachment_id)))
                    .slice(0, MAX_EAGER_PER_BANK);
                if (targets.length === 0)
                    continue;
                logger.info(`eager-extract[${bank.bank_code}]: extracting ${targets.length} target(s)`);
                for (const target of targets) {
                    const filePath = (target.full_path || target.file_path) ?? null;
                    const fromEmail = target.source === 'email' && !filePath;
                    const now = new Date().toISOString();
                    target.extraction_attempted_at =
                        now;
                    if (fromEmail && !emailAttachments) {
                        const msg = 'Email attachment provider not configured.';
                        target.extraction_status =
                            'failed';
                        target.extraction_error = msg;
                        continue;
                    }
                    try {
                        let pdfBytes = null;
                        if (filePath) {
                            pdfBytes = await readFile(filePath);
                        }
                        else if (fromEmail && emailAttachments) {
                            const downloaded = await emailAttachments.fetchAttachment({
                                emailId: target.email_id,
                                attachmentId: target.attachment_id,
                            });
                            pdfBytes = downloaded?.bytes ?? null;
                        }
                        if (!pdfBytes) {
                            target.extraction_status =
                                'failed';
                            target.extraction_error =
                                'Could not read PDF bytes (file missing or attachment fetch failed).';
                            continue;
                        }
                        const extracted = await extractor.extractFromPdf({
                            bytes: pdfBytes,
                            filename: target.filename,
                        });
                        if (typeof extracted.opening_balance === 'number' &&
                            typeof extracted.closing_balance === 'number') {
                            target.opening_balance = extracted.opening_balance;
                            target.closing_balance = extracted.closing_balance;
                            target.period_start = extracted.period_start ?? null;
                            target.period_end = extracted.period_end ?? null;
                            target.extraction_status =
                                'extracted';
                            target.extraction_error =
                                null;
                            target.status = 'ready';
                            geminiBreaker.recordSuccess();
                        }
                        else {
                            target.extraction_status =
                                'failed';
                            target.extraction_error =
                                'Extraction returned without an opening or closing balance — statement may be unreadable.';
                        }
                        // The Gemini extractor caches the RAW response itself.
                    }
                    catch (extErr) {
                        const cls = classifyExtractionError(extErr);
                        geminiBreaker.recordFailure(extErr);
                        target.extraction_status =
                            cls.transient ? 'pending' : 'failed';
                        target.extraction_error =
                            cls.message;
                        logger.warn(`eager-extract[${bank.bank_code}]: ${target.filename} → ${cls.kind} (${cls.transient ? 'transient — will retry next scan' : 'permanent — operator action needed'}): ${cls.cause ?? cls.message}`);
                        // If the breaker just opened, mark all remaining targets
                        // in this scan with the same error rather than hammering.
                        if (geminiBreaker.isOpen()) {
                            const reason = geminiBreaker.openReason();
                            for (const bank2 of Object.values(banksWithStatements)) {
                                for (const s of bank2.statements) {
                                    if (s.opening_balance == null ||
                                        s.closing_balance == null) {
                                        const cur = s
                                            .extraction_status;
                                        if (cur !== 'extracted' && cur !== 'cached') {
                                            s.extraction_status =
                                                'failed';
                                            s.extraction_error =
                                                reason;
                                        }
                                    }
                                }
                            }
                            break; // exit inner targets loop
                        }
                    }
                } // end inner for-of targets
                // Re-evaluate the bank's extraction_status after all eager
                // extractions for this bank: complete when the first (next-in-
                // sequence) statement now has both balances populated.
                const nextHasBalances = bank.statements[0]?.opening_balance != null &&
                    bank.statements[0]?.closing_balance != null;
                if (nextHasBalances)
                    bank.extraction_status = 'complete';
                // If the breaker is now open, stop scanning further banks.
                if (geminiBreaker.isOpen())
                    break;
            }
        } // end else (breaker closed)
    }
    // Mark statements that have cached balances (i.e. were read from
    // extraction_cache, not freshly extracted) with extraction_status
    // 'cached' so the FE can show that distinction.
    for (const bank of Object.values(banksWithStatements)) {
        for (const s of bank.statements) {
            const cur = s.extraction_status;
            if (!cur &&
                s.opening_balance != null &&
                s.closing_balance != null) {
                s.extraction_status = 'cached';
            }
        }
    }
    // ---- Chain-complete check ----
    // Faithful port of legacy `check_chain_complete`
    // (apps/bank_reconcile/logic/scan_pdf_validation.py:285) applied
    // by routes.py:7395 + 7115 in the email/folder scan loops.
    //
    // A statement is "already_processed" when EITHER:
    //   (A) its closing balance matches a previously-reconciled
    //       statement's opening balance, OR
    //   (B) its opening is more than 1p below the bank's effective
    //       reconciled balance (Opera's nk_recbal).
    //
    // Pre-port TS skipped this entirely, so the FE marked the OLDEST
    // statement as "next" instead of the actual next-in-sequence.
    for (const bank of Object.values(banksWithStatements)) {
        const bankRecOpenings = tracking.reconciled_opening_balances.get(bank.bank_code) ??
            new Set();
        const effectiveRec = typeof bank.reconciled_balance === 'number'
            ? bank.reconciled_balance
            : null;
        const remaining = [];
        for (const stmt of bank.statements) {
            // Only run the check on statements that have balances AND a
            // matched bank code. Skip already-imported (status='imported')
            // since they're tracked elsewhere.
            if (stmt.opening_balance == null ||
                stmt.closing_balance == null ||
                stmt.status === 'imported' ||
                stmt.status === 'already_processed') {
                remaining.push(stmt);
                continue;
            }
            // Cycle-aware pre-check: if there's already a reconciled
            // bank_statement_imports row for this bank with the SAME
            // period_start, this candidate is a duplicate or extension of
            // a cycle that's already been processed end-to-end. Classify
            // as already_processed and skip the chain check.
            //
            // Without this, the legacy chain-check (B) "opening_below_
            // reconciled" was bypassed by openingUnblocksChain when the
            // candidate's opening happened to match a reconciled
            // statement's opening — leaving the candidate visible as
            // "Ready" even though it represents a cycle that's already
            // closed in Opera (closing == nk_recbal).
            if (appDb && stmt.period_start) {
                try {
                    const cycle = await findExistingCycleRow(appDb, bank.bank_code, stmt.period_start);
                    if (cycle && cycle.is_reconciled === 1) {
                        stmt.status = 'already_processed';
                        stmt.chain_reason =
                            'cycle_already_reconciled';
                        stmt.skip_reason =
                            `Statement ${stmt.filename}: cycle starting ${stmt.period_start} ` +
                                `already reconciled in SAM (audit row id=${cycle.id}, closing ` +
                                `£${cycle.closing_balance?.toFixed(2) ?? '?'}).`;
                        nonCurrent.already_processed.push(stmt);
                        logger.info(`cycle-check[${bank.bank_code}]: ${stmt.filename} → already_processed (cycle ${stmt.period_start} reconciled as import_id=${cycle.id})`);
                        continue;
                    }
                }
                catch (cycleErr) {
                    logger.warn?.(`cycle-check[${bank.bank_code}]: lookup failed for ${stmt.filename}: ` +
                        `${cycleErr instanceof Error ? cycleErr.message : String(cycleErr)}`);
                }
            }
            const result = checkChainComplete({
                openingBalance: stmt.opening_balance,
                closingBalance: stmt.closing_balance,
                effectiveReconciledBalance: effectiveRec,
                bankRecOpenings,
                filename: stmt.filename,
                // Imported-but-not-reconciled chain advance: when an earlier
                // statement has been imported (audit row exists) but not
                // yet reconciled (Opera's nk_recbal hasn't moved), its
                // closing balance virtually advances the chain so this
                // statement can still process. Without this callback, the
                // chain-check incorrectly classifies the next-in-line
                // statement as `already_processed` and hides it.
                openingUnblocksChain: (opening) => openingUnblocksChain(bank.bank_code, opening),
            });
            if (result.chainComplete) {
                stmt.status = 'already_processed';
                stmt.chain_reason =
                    result.reasonKind;
                stmt.skip_reason =
                    result.skipReason;
                // Move to the non-current bucket so the FE doesn't surface
                // them as eligible for Process.
                nonCurrent.already_processed.push(stmt);
                logger.info(`chain-check[${bank.bank_code}]: ${stmt.filename} → already_processed (${result.reasonKind})`);
            }
            else {
                remaining.push(stmt);
            }
        }
        bank.statements = remaining;
        bank.statement_count = remaining.length;
    }
    // Recompute totalStatements after cleanup.
    totalStatements = 0;
    for (const b of Object.values(banksWithStatements)) {
        totalStatements += b.statement_count;
    }
    // Drop banks whose statements list became empty after cleanup.
    for (const code of Object.keys(banksWithStatements)) {
        if (banksWithStatements[code].statement_count === 0) {
            delete banksWithStatements[code];
        }
    }
    const bankCount = Object.keys(banksWithStatements).length;
    const message = totalStatements === 0
        ? `No new statements found across ${Object.keys(allBanks).length} bank accounts (${totalEmailsScanned} emails scanned, ${totalPdfsFound} PDFs checked)`
        : `Found ${totalStatements} statement(s) across ${bankCount} bank(s)`;
    timings.total = round1((Date.now() - t0) / 1000);
    return {
        success: true,
        banks: banksWithStatements,
        unidentified: [],
        non_current: nonCurrent,
        non_current_count: nonCurrent.already_processed.length +
            nonCurrent.old_statements.length +
            nonCurrent.not_classified.length +
            nonCurrent.advanced.length,
        total_statements: totalStatements,
        total_banks_with_statements: bankCount,
        total_banks_loaded: Object.keys(allBanks).length,
        total_emails_scanned: totalEmailsScanned,
        total_pdfs_found: totalPdfsFound,
        emails_saved_to_folders: emailsSavedToFolders,
        duplicates_archived: duplicatesArchived,
        days_searched: daysBack,
        mailbox_synced: mailboxSynced,
        mailbox_sync_skipped: mailboxSyncSkipped,
        timings,
        message,
    };
}
// ---- helpers ----
function round1(n) {
    return Math.round(n * 10) / 10;
}
function round2(n) {
    return Math.round(n * 100) / 100;
}
function legacyBankNameFromDescription(desc) {
    for (const k of ['barclays', 'lloyds', 'hsbc', 'natwest', 'santander', 'nationwide', 'rbs', 'tsb', 'metro', 'tide', 'monzo', 'starling', 'revolut']) {
        if (desc.includes(k))
            return k;
    }
    return null;
}
function ncSortKey(s) {
    const sd = s.statement_date ?? '';
    if (sd)
        return sd;
    const sk = s.sort_key;
    if (sk && Array.isArray(sk) && sk.length >= 3) {
        return `${String(sk[0]).padStart(4, '0')}-${String(sk[1]).padStart(2, '0')}-${String(sk[2]).padStart(2, '0')}`;
    }
    return '';
}
function emptyTracking() {
    return {
        reconciled_keys: new Set(),
        reconciled_filenames: new Set(),
        imported_nr_keys: new Set(),
        imported_nr_filenames: new Set(),
        reconciled_closing_balances: new Map(),
        reconciled_opening_balances: new Map(),
        managed_keys: new Set(),
        managed_filenames: new Set(),
        cached_stmt_info: new Map(),
        imported_hashes: new Map(),
        imported_identities: new Set(),
    };
}
function emptyResponse(daysBack, t0, timings) {
    timings.total = round1((Date.now() - t0) / 1000);
    return {
        success: true,
        banks: {},
        unidentified: [],
        non_current: {
            already_processed: [],
            old_statements: [],
            not_classified: [],
            advanced: [],
        },
        non_current_count: 0,
        total_statements: 0,
        total_banks_with_statements: 0,
        total_banks_loaded: 0,
        total_emails_scanned: 0,
        total_pdfs_found: 0,
        emails_saved_to_folders: 0,
        duplicates_archived: 0,
        days_searched: daysBack,
        mailbox_synced: false,
        mailbox_sync_skipped: false,
        timings,
        message: '',
    };
}
function errorResponse(err, daysBack, timings, t0) {
    return {
        ...emptyResponse(daysBack, t0, timings),
        success: false,
        error: err instanceof Error ? err.message : String(err),
    };
}
//# sourceMappingURL=scan-all-banks.js.map
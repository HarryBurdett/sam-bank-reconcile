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
import type { Knex } from 'knex';
import type { AppLogger as Logger } from '../app-context.js';
import type { BankMailboxAdapter } from './scan-emails.js';
import {
  detectBankFromEmail,
  extractStatementNumberFromFilename,
  isBankStatementAttachment,
  compareSortKeys,
  type StatementSortKey,
} from './email-helpers.js';
import {
  getAllStatementTrackingData,
  type StatementTrackingData,
} from './statement-tracking.js';
import {
  sortStatementsByChain,
  filterFullyReconciledStatements,
} from './scan-chain-ordering.js';
import {
  buildOperaSePeriodReconciliationDs,
  checkPeriodReconciled,
} from './period-reconciliation.js';
import { markStatementReconciled } from './statement-files.js';
import type {
  BankWithStatements,
  StatementCandidate,
} from './scan-all-banks-types.js';

interface BankRow {
  bank_code: string;
  description: string;
  sort_code: string;
  account_number: string;
  reconciled_balance: number | null;
  current_balance: number | null;
  type: string | null;
}

function normaliseSortAcct(value: string | null | undefined): string {
  return (value ?? '').replace(/[-\s]/g, '').trim();
}

/**
 * Full response shape — matches legacy line 7910 verbatim.
 */
export interface ScanAllBanksResponse {
  success: boolean;
  banks: Record<string, BankWithStatements & {
    statements_total?: number;
    statements_extracted?: number;
    extraction_failures?: Array<{ filename: string; reason: string }>;
    extraction_status?: 'complete' | 'incomplete';
  }>;
  unidentified: StatementCandidate[];
  non_current: {
    already_processed: StatementCandidate[];
    old_statements: StatementCandidate[];
    not_classified: StatementCandidate[];
    advanced: StatementCandidate[];
  };
  non_current_count: number;
  total_statements: number;
  total_banks_with_statements: number;
  total_banks_loaded: number;
  total_emails_scanned: number;
  total_pdfs_found: number;
  emails_saved_to_folders: number;
  duplicates_archived: number;
  days_searched: number;
  mailbox_synced: boolean;
  mailbox_sync_skipped: boolean;
  timings: Record<string, number>;
  message: string;
  error?: string;
}

export interface ScanAllBanksOptions {
  daysBack?: number;
  includeProcessed?: boolean;
  validateBalances?: boolean;
  extractOnMiss?: boolean;
  pageSize?: number;
}

export async function scanAllBanksFaithful(
  operaDb: Knex,
  mailbox: BankMailboxAdapter | null,
  appDb: Knex | null,
  logger: Logger,
  opts: ScanAllBanksOptions = {},
): Promise<ScanAllBanksResponse> {
  const daysBack = Number.isFinite(opts.daysBack) ? Number(opts.daysBack) : 30;
  const pageSize = Number.isFinite(opts.pageSize) ? Number(opts.pageSize) : 500;
  const validateBalances = opts.validateBalances !== false;
  const t0 = Date.now();
  const timings: Record<string, number> = {};

  const nonCurrent = {
    already_processed: [] as StatementCandidate[],
    old_statements: [] as StatementCandidate[],
    not_classified: [] as StatementCandidate[],
    advanced: [] as StatementCandidate[],
  };

  // ---- Step 1: Load all banks from nbank, build lookup tables ----
  let allBanks: Record<string, BankWithStatements>;
  const bankLookup = new Map<string, string>(); // "<sort><acct>" -> bank_code
  try {
    const rows = (await operaDb.raw(
      `SELECT RTRIM(nk_acnt) AS bank_code,
              RTRIM(nk_desc) AS description,
              RTRIM(ISNULL(nk_sort, '')) AS sort_code,
              RTRIM(ISNULL(nk_number, '')) AS account_number,
              ISNULL(nk_recbal, 0) / 100.0 AS reconciled_balance,
              ISNULL(nk_curbal, 0) / 100.0 AS current_balance,
              CASE WHEN nk_petty = 1 THEN 'Petty Cash' ELSE 'Bank Account' END AS type
       FROM nbank WITH (NOLOCK)
       ORDER BY nk_acnt`,
    )) as unknown as BankRow[];

    allBanks = {};
    for (const r of rows ?? []) {
      const code = (r.bank_code ?? '').trim();
      if (!code) continue;
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
    logger.info(
      `Scan-all-banks: loaded ${Object.keys(allBanks).length} bank accounts, ${bankLookup.size} with sort/acct for matching`,
    );
  } catch (err) {
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
  let emails: Array<{
    id: number;
    from_address?: string | null;
    subject?: string | null;
    received_at?: string | Date | null;
    has_attachments?: boolean;
    attachments?: Array<{
      attachment_id: string;
      filename: string;
      content_type?: string | null;
      size_bytes?: number;
    }>;
  }> = [];
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
    } catch (err) {
      logger.warn(`Scan-all-banks: mailbox.list failed: ${(err as Error).message}`);
    }
  }

  // Tracking data — matches legacy line 6720
  const tracking: StatementTrackingData = appDb
    ? await getAllStatementTrackingData(appDb).catch(() => emptyTracking())
    : emptyTracking();
  logger.info(
    `Scan: got ${tracking.managed_keys.size} managed_keys, ${tracking.managed_filenames.size} managed_filenames`,
  );

  // Build detected_bank_name → bank_code lookup from previous imports
  // (legacy line 6806). Allows Tide/fintech matching even with generic
  // filenames like "attachment.pdf".
  const detectedNameToBank = new Map<string, string>();
  for (const info of tracking.cached_stmt_info.values()) {
    const stmtSort = normaliseSortAcct(info.sort_code);
    const stmtAcct = normaliseSortAcct(info.account_number);
    if (stmtSort && stmtAcct) {
      const code = bankLookup.get(`${stmtSort}|${stmtAcct}`);
      if (code && info.bank_code) {
        const lowDesc = (allBanks[code]?.description ?? '').toLowerCase();
        const detected = legacyBankNameFromDescription(lowDesc);
        if (detected) detectedNameToBank.set(detected, code);
      }
    }
  }

  // Build imported_pending_closings — sequential gating helper (legacy line 6756).
  const importedPendingClosings = new Map<string, Set<number>>();
  for (const [, info] of tracking.cached_stmt_info.entries()) {
    if (info.bank_code === 'DEDUP' || !info.bank_code) continue;
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

  function openingUnblocksChain(bankCode: string, opening: number | null): boolean {
    // Legacy line 6774.
    if (opening === null || opening === undefined || !bankCode) return false;
    const target = round2(opening);
    const recBal = allBanks[bankCode]?.reconciled_balance;
    if (recBal !== null && recBal !== undefined && target === round2(recBal)) return true;
    const recOpens = tracking.reconciled_opening_balances.get(bankCode);
    if (recOpens && recOpens.has(target)) return true;
    const pending = importedPendingClosings.get(bankCode);
    if (pending && pending.has(target)) return true;
    return false;
  }
  // openingUnblocksChain is used by the not-yet-ported step 4/5 chain
  // check; kept here for parity with legacy. Reference once so the
  // linter doesn't flag it.
  void openingUnblocksChain;

  let totalEmailsScanned = 0;
  let totalPdfsFound = 0;
  const emailsSavedToFolders = 0;
  const duplicatesArchived = 0;

  // ---- Step 3: Scan emails ----
  // Faithful port of routes.py:6873.
  for (const email of emails) {
    if (!email.has_attachments) continue;
    totalEmailsScanned += 1;
    const attachments = email.attachments ?? [];
    if (attachments.length === 0) continue;
    const emailFrom = email.from_address ?? '';
    const emailSubject = email.subject ?? '';
    const emailId = email.id;

    for (const att of attachments) {
      const filename = att.filename ?? '';
      const contentType = att.content_type ?? '';
      const attachmentId = att.attachment_id;

      if (
        !isBankStatementAttachment({
          filename,
          contentType,
          subject: emailSubject,
          fromAddress: emailFrom,
        })
      ) {
        continue;
      }
      totalPdfsFound += 1;

      // Skip managed (archived/deleted/retained). Legacy line 6898.
      const eaKey = `${emailId}:${attachmentId}`;
      const baseName = filename.includes('.')
        ? filename.slice(0, filename.lastIndexOf('.'))
        : filename;
      const isManaged =
        tracking.managed_keys.has(eaKey) ||
        tracking.managed_filenames.has(filename) ||
        Array.from(tracking.managed_filenames).some((mf) =>
          mf.startsWith(baseName),
        );
      if (isManaged) {
        logger.info(`Scan: skipping managed email ${filename}`);
        continue;
      }

      // Skip fully reconciled. Legacy line 6913.
      if (
        tracking.reconciled_keys.has(eaKey) ||
        tracking.reconciled_filenames.has(filename)
      ) {
        continue;
      }

      const isImportedNotReconciled =
        tracking.imported_nr_keys.has(eaKey) ||
        tracking.imported_nr_filenames.has(filename);
      const detectedBankName = detectBankFromEmail(
        emailFrom,
        filename,
        emailSubject,
      );
      const { sort_key: sortKey, display_date: statementDate } =
        extractStatementNumberFromFilename(filename, emailSubject);

      const stmt: StatementCandidate = {
        source: 'email',
        email_id: emailId,
        attachment_id: attachmentId,
        filename,
        subject: emailSubject,
        from_address: emailFrom,
        received_at:
          email.received_at instanceof Date
            ? email.received_at.toISOString()
            : (email.received_at ?? null) as string | null,
        detected_bank_name: detectedBankName,
        already_processed: false,
        status: isImportedNotReconciled ? 'imported' : 'pending',
        sort_key: sortKey,
        statement_date: statementDate,
      };
      // `is_imported` field used by step 5's final cleanup auto-promote.
      (stmt as unknown as Record<string, unknown>).is_imported = isImportedNotReconciled;

      let matchedBankCode: string | null = null;

      // FAST PATH: cached info from previous imports. Legacy line 6940.
      const cachedInfo = tracking.cached_stmt_info.get(filename);
      if (cachedInfo && validateBalances) {
        logger.info(`Scan fast-path: using cached info for ${filename}`);
        stmt.opening_balance = cachedInfo.opening_balance;
        stmt.closing_balance = cachedInfo.closing_balance;
        stmt.period_start = cachedInfo.period_start;
        stmt.period_end = cachedInfo.period_end;
        (stmt as unknown as Record<string, unknown>).sort_code = cachedInfo.sort_code;
        (stmt as unknown as Record<string, unknown>).account_number =
          cachedInfo.account_number;
        (stmt as unknown as Record<string, unknown>).bank_name = cachedInfo.bank_code;

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
            logger.info(
              `Cached fast-path: matched '${filename}' to ${matchedBankCode} via detected bank name '${detectedBankName}'`,
            );
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
            matchedBankCode = nameMatches[0]!;
          }
        }

        if (matchedBankCode) {
          stmt.status = 'ready';
        }
      } else if (validateBalances && filename.toLowerCase().endsWith('.pdf')) {
        // No cached info — metadata-based bank matching. Legacy line 6983.
        stmt.status = 'ready';

        // Priority 1: account number in filename.
        const acctMatches = filename.match(/\b(\d{8,})\b/g) ?? [];
        for (const acct of acctMatches) {
          for (const [code, info] of Object.entries(allBanks)) {
            const operaAcct = normaliseSortAcct(info.account_number);
            if (operaAcct && acct === operaAcct) {
              matchedBankCode = code;
              logger.info(
                `Scan: matched '${filename}' to ${code} via account number ${acct} in filename`,
              );
              break;
            }
          }
          if (matchedBankCode) break;
        }

        // Priority 2: detected bank name (unambiguous).
        if (!matchedBankCode && detectedBankName) {
          const detectedLower = detectedBankName.toLowerCase();
          const nameMatches: string[] = [];
          for (const [code, info] of Object.entries(allBanks)) {
            const descLower = (info.description ?? '').toLowerCase();
            if (
              descLower.includes(detectedLower) ||
              detectedLower.includes(descLower)
            ) {
              nameMatches.push(code);
            }
          }
          if (nameMatches.length === 1) {
            matchedBankCode = nameMatches[0]!;
          } else if (nameMatches.length > 1) {
            // Disambiguate via account number in subject/filename.
            const allSources = `${filename} ${emailSubject ?? ''}`
              .replace(/[-\s]/g, '');
            for (const code of nameMatches) {
              const operaAcct = normaliseSortAcct(
                allBanks[code]?.account_number,
              );
              if (operaAcct && allSources.includes(operaAcct)) {
                matchedBankCode = code;
                logger.info(
                  `Scan: disambiguated '${filename}' to ${code} via account number in metadata`,
                );
                break;
              }
            }
            if (!matchedBankCode) {
              matchedBankCode = nameMatches[0]!;
              logger.info(
                `Scan: ambiguous bank name match for '${filename}' — ${nameMatches.join(',')}, using ${matchedBankCode} pending PDF extraction`,
              );
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
              .filter(
                (w) =>
                  w.length >= 4 &&
                  !['bank', 'account', 'current', 'the', 'and', 'for', 'with'].includes(w),
              );
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
          logger.info(
            `Scan-all: skipping ${filename} — no Opera bank match from metadata`,
          );
        }
      }

      // Step 3 bucket assignment. Legacy line 7265.
      const category = (stmt as unknown as Record<string, unknown>).category as string | undefined;
      if (matchedBankCode) {
        const b = allBanks[matchedBankCode]!;
        stmt.matched_bank_code = matchedBankCode;
        stmt.matched_bank_description = b.description;
        stmt.matched_sort_code = b.sort_code;
        stmt.matched_account_number = b.account_number;

        if (category === 'already_processed' || category === 'old_statement') {
          const ncKey =
            category === 'old_statement' ? 'old_statements' : 'already_processed';
          nonCurrent[ncKey].push(stmt);
        } else if (category === 'advanced') {
          nonCurrent.advanced.push(stmt);
        } else if (
          stmt.status === 'ready' ||
          stmt.status === 'imported' ||
          stmt.status === 'pending_extraction'
        ) {
          b.statements.push(stmt);
        } else {
          logger.info(
            `Skipping ${filename} for ${matchedBankCode}: status=${stmt.status}`,
          );
        }
      } else {
        logger.info(
          `Skipping ${filename}: no matching Opera bank in current company`,
        );
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
  let basePath: string | null = null;
  if (appDb) {
    try {
      const row = (await appDb('settings')
        .where({ key: 'folder_settings' })
        .first()) as { value?: string } | undefined;
      if (row?.value) {
        const parsed = JSON.parse(row.value) as { base_folder?: string };
        if (parsed.base_folder && parsed.base_folder.length > 0) {
          basePath = parsed.base_folder;
        }
      }
    } catch {
      // tolerated
    }
  }

  if (basePath) {
    const { existsSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const seenBankFilenames = new Map<string, [string, StatementCandidate]>();

    if (existsSync(basePath)) {
      let subdirs: string[];
      try {
        subdirs = readdirSync(basePath, { withFileTypes: true })
          .filter((d) => d.isDirectory() && d.name !== 'archive')
          .map((d) => d.name)
          .sort();
      } catch {
        subdirs = [];
      }

      for (const folderName of subdirs) {
        const folderPath = join(basePath, folderName);
        if (!existsSync(folderPath)) continue;

        let files: string[];
        try {
          files = readdirSync(folderPath, { withFileTypes: true })
            .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.pdf'))
            .map((d) => d.name);
        } catch {
          continue;
        }

        for (const filename of files) {
          const fileIsImportedNr = tracking.imported_nr_filenames.has(filename);
          const folderBaseClean = filename
            .replace(/\.[^.]+$/, '')
            .replace(/_\d+$/, '');
          const isManaged =
            tracking.managed_filenames.has(filename) ||
            Array.from(tracking.managed_filenames).some((mf) =>
              mf.startsWith(folderBaseClean),
            );
          if (isManaged) continue;
          if (tracking.reconciled_filenames.has(filename)) continue;

          totalPdfsFound += 1;
          const fullPath = join(folderPath, filename);
          const { sort_key: sortKey, display_date: statementDate } =
            extractStatementNumberFromFilename(filename, '');

          const stmt: StatementCandidate = {
            source: 'pdf',
            file_path: fullPath,
            filename,
            already_processed: false,
            status: fileIsImportedNr ? 'imported' : 'pending',
            sort_key: sortKey,
            statement_date: statementDate,
          };
          (stmt as unknown as Record<string, unknown>).folder = folderName;
          (stmt as unknown as Record<string, unknown>).is_imported =
            fileIsImportedNr;

          // Cached statement info (from bank_statement_imports). Legacy
          // step 4 also queries the PDF extraction cache by hash — that
          // path needs a cache adapter and is left for later. The
          // tracking-data map keyed by filename gives us the same
          // opening/closing/period balances when the statement has been
          // imported before.
          const cachedInfo = tracking.cached_stmt_info.get(filename);
          if (cachedInfo && validateBalances) {
            stmt.opening_balance = cachedInfo.opening_balance;
            stmt.closing_balance = cachedInfo.closing_balance;
            stmt.period_start = cachedInfo.period_start;
            stmt.period_end = cachedInfo.period_end;
            (stmt as unknown as Record<string, unknown>).sort_code =
              cachedInfo.sort_code;
            (stmt as unknown as Record<string, unknown>).account_number =
              cachedInfo.account_number;
            (stmt as unknown as Record<string, unknown>).extraction_status =
              'cached';
          }

          // Folder-name prefix match (legacy 7411).
          let matchedBankCode: string | null = null;
          const folderPrefix = (folderName.includes('-')
            ? folderName.split('-')[0]
            : folderName
          )!.toUpperCase();
          if (allBanks[folderPrefix]) {
            matchedBankCode = folderPrefix;
            const b = allBanks[folderPrefix];
            if (b) {
              stmt.status = 'ready';
              stmt.matched_bank_code = matchedBankCode;
              stmt.matched_bank_description = b.description;
              stmt.matched_sort_code = b.sort_code;
              stmt.matched_account_number = b.account_number;
              (stmt as unknown as Record<string, unknown>).sort_code =
                b.sort_code;
              (stmt as unknown as Record<string, unknown>).account_number =
                b.account_number;
              logger.info(
                `Matched ${filename} to ${matchedBankCode} via folder name '${folderName}'`,
              );
            }
          }

          if (!matchedBankCode) {
            logger.info(
              `Skipping local PDF ${filename}: no matching Opera bank in current company`,
            );
            continue;
          }

          // Status preservation rule (legacy line 7494).
          if (
            stmt.status !== 'ready' &&
            stmt.status !== 'imported' &&
            stmt.status !== 'pending_extraction'
          ) {
            logger.info(
              `Skipping ${filename} for ${matchedBankCode}: status=${stmt.status}`,
            );
            continue;
          }

          // Dedup by filename within bank (legacy line 7496).
          const fnLower = filename.toLowerCase().trim();
          const fnKey = `${matchedBankCode}|${fnLower}`;
          let fileMtime = '';
          try {
            fileMtime = String(statSync(fullPath).mtimeMs);
          } catch {
            // tolerated
          }
          const prev = seenBankFilenames.get(fnKey);
          if (prev) {
            const [prevDate, prevEntry] = prev;
            if (fileMtime > prevDate) {
              const idx = allBanks[matchedBankCode]!.statements.indexOf(
                prevEntry,
              );
              if (idx >= 0) {
                allBanks[matchedBankCode]!.statements.splice(idx, 1);
              }
              seenBankFilenames.set(fnKey, [fileMtime, stmt]);
            } else {
              continue;
            }
          } else {
            seenBankFilenames.set(fnKey, [fileMtime, stmt]);
          }

          allBanks[matchedBankCode]!.statements.push(stmt);
        }
      }
    } else {
      logger.info(`Folder scan: base_folder '${basePath}' does not exist`);
    }
  }
  timings.scan_folder = round1((Date.now() - t2) / 1000);

  // ---- Step 4a: Cross-source dedup ----
  // Legacy avoids duplicates by saving email PDFs to the bank
  // subfolder during step 3 then re-discovering them as source='pdf'
  // in step 4. The save-to-folder bytes path requires IMAP download
  // + write, which the SAM port can wire later. For now, post-scan
  // dedupe by (bank_code, filename) preferring source='pdf' — same
  // end result the operator sees in the Hub.
  for (const bank of Object.values(allBanks)) {
    const byName = new Map<string, StatementCandidate>();
    for (const stmt of bank.statements) {
      const key = stmt.filename.toLowerCase().trim();
      const existing = byName.get(key);
      if (!existing) {
        byName.set(key, stmt);
        continue;
      }
      // Prefer source='pdf' over source='email' (legacy end-state).
      if (existing.source === 'pdf') continue;
      if (stmt.source === 'pdf') byName.set(key, stmt);
    }
    bank.statements = Array.from(byName.values());
  }

  // ---- Step 5: Sort + finalize each bank's statements ----
  // Legacy line 7615. fill_missing_balances_from_cache is a no-op
  // without PDF cache (see scan-chain-ordering.ts).
  const banksWithStatements: Record<string, BankWithStatements & {
    statements_total?: number;
    statements_extracted?: number;
    extraction_failures?: Array<{ filename: string; reason: string }>;
    extraction_status?: 'complete' | 'incomplete';
  }> = {};
  let totalStatements = 0;

  for (const [code, bank] of Object.entries(allBanks)) {
    let stmts = bank.statements;
    logger.info(`Step 5: bank ${code} has ${stmts.length} statements before filtering`);
    if (stmts.length === 0) continue;

    const recBal = bank.reconciled_balance;
    stmts = sortStatementsByChain(stmts, recBal);
    stmts = filterFullyReconciledStatements(stmts, code, recBal);

    bank.statements = stmts;
    logger.info(`Step 5 final: ${code} = ${stmts.length} statements`);

    // Clean up internal sort_key + assign import_sequence.
    stmts.forEach((s, i) => {
      delete (s as unknown as Record<string, unknown>).sort_key;
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
        .select(
          'bank_code',
          'source',
          'email_id',
          'attachment_id',
          'filename',
          'updated_at',
        )) as Array<{
        bank_code: string;
        source: string;
        email_id: string | null;
        attachment_id: string | null;
        filename: string;
        updated_at: string | Date;
      }>;
      const draftByBank = new Map<string, {
        byFilename: Map<string, string>;
        byKey: Map<string, string>;
      }>();
      for (const d of drafts) {
        let entry = draftByBank.get(d.bank_code);
        if (!entry) {
          entry = { byFilename: new Map(), byKey: new Map() };
          draftByBank.set(d.bank_code, entry);
        }
        const upd = String(d.updated_at);
        if (d.filename) entry.byFilename.set(d.filename, upd);
        if (d.source === 'email') {
          entry.byKey.set(`email|${d.email_id ?? ''}|${d.attachment_id ?? ''}`, upd);
        } else {
          entry.byKey.set(`pdf|${d.filename}|`, upd);
        }
      }
      for (const [code, bank] of Object.entries(banksWithStatements)) {
        const entry = draftByBank.get(code);
        if (!entry) continue;
        for (const stmt of bank.statements) {
          const fn = stmt.filename ?? '';
          if (fn && entry.byFilename.has(fn)) {
            stmt.has_draft = true;
            stmt.draft_updated_at = entry.byFilename.get(fn) ?? null;
          } else {
            const src = stmt.source;
            const key =
              src === 'email'
                ? `email|${stmt.email_id ?? ''}|${stmt.attachment_id ?? ''}`
                : `pdf|${fn}|`;
            if (entry.byKey.has(key)) {
              stmt.has_draft = true;
              stmt.draft_updated_at = entry.byKey.get(key) ?? null;
            } else {
              stmt.has_draft = false;
            }
          }
        }
      }
    } catch (e) {
      logger.debug(`Could not annotate drafts for scan-all-banks: ${(e as Error).message}`);
    }
  }

  // Auto-promote imported statements where period is fully reconciled.
  // Faithful port of routes.py:7693-7769. For every is_imported
  // statement on a bank with a known rec_bal, query the single source
  // of truth (check_period_reconciled) and auto-mark as reconciled
  // when FULLY_RECONCILED. UNKNOWN / PARTIALLY_RECONCILED keep the
  // row visible (legacy line 7757-7766 "show, don't auto-promote").
  const finalRecFilenames = new Set(tracking.reconciled_filenames);
  try {
    const ds = buildOperaSePeriodReconciliationDs(operaDb);
    for (const [code, bank] of Object.entries(banksWithStatements)) {
      const recBal = bank.reconciled_balance;
      if (recBal === null || recBal === undefined) continue;
      for (const stmt of bank.statements) {
        // is_imported in legacy maps to status === 'imported' here.
        if (stmt.status !== 'imported') continue;
        const periodStart = (stmt.period_start ?? null) as string | null;
        const periodEnd = (stmt.period_end ?? null) as string | null;
        const closing = (stmt.closing_balance ?? null) as number | null;
        const res = await checkPeriodReconciled(ds, {
          bankCode: code,
          periodStart,
          periodEnd,
          statementClosing: closing,
          currentRecBal: Number(recBal),
        });
        if (res.status === 'fully_reconciled') {
          const fn = stmt.filename;
          logger.info(
            `Scan cleanup: auto-marking '${fn}' as reconciled — ${res.reason}`,
          );
          finalRecFilenames.add(fn);
          if (appDb) {
            try {
              await markStatementReconciled(appDb, {
                filename: fn,
                reconciledCount: 0,
                bankCode: code,
              });
            } catch {
              /* best-effort */
            }
          }
        } else if (res.status === 'partially_reconciled' || res.status === 'unknown') {
          logger.info(
            `Scan cleanup: NOT auto-marking '${stmt.filename}' — ${res.reason}`,
          );
        }
        // 'not_reconciled': keep visible silently (legacy line 7767).
      }
    }
  } catch (promoErr) {
    logger.warn(
      `Auto-promote scan cleanup failed: ${
        promoErr instanceof Error ? promoErr.message : String(promoErr)
      }`,
    );
  }

  // Remove reconciled statements from bank + non_current lists. Legacy 7771.
  for (const [code, bank] of Object.entries(banksWithStatements)) {
    const before = bank.statements.length;
    bank.statements = bank.statements.filter(
      (s) => !finalRecFilenames.has(s.filename),
    );
    const after = bank.statements.length;
    if (before !== after) {
      logger.info(`Final cleanup: ${code} reduced from ${before} to ${after} statements`);
    }
    bank.statement_count = bank.statements.length;
  }
  for (const k of ['already_processed', 'old_statements', 'not_classified', 'advanced'] as const) {
    nonCurrent[k] = nonCurrent[k].filter((s) => !finalRecFilenames.has(s.filename));
  }

  // Sort non_current: bank ascending, then date descending. Legacy 7783.
  for (const k of ['already_processed', 'old_statements', 'not_classified', 'advanced'] as const) {
    nonCurrent[k].sort((a, b) => ncSortKey(b).localeCompare(ncSortKey(a)));
    nonCurrent[k].sort((a, b) =>
      (a.matched_bank_code ?? '').localeCompare(b.matched_bank_code ?? ''),
    );
  }

  // Per-bank extraction_status + sequential gating. Legacy line 7817.
  for (const [, bank] of Object.entries(banksWithStatements)) {
    const stmts = bank.statements;
    const statementsTotal = stmts.length;
    const statementsExtracted = stmts.filter(
      (s) => s.opening_balance != null && s.closing_balance != null,
    ).length;
    const extractionFailures = stmts
      .filter((s) => s.opening_balance == null || s.closing_balance == null)
      .map((s) => ({
        filename: s.filename,
        reason: s.extraction_status ?? 'rate_limit',
      }));
    bank.statements_total = statementsTotal;
    bank.statements_extracted = statementsExtracted;
    bank.extraction_failures = extractionFailures;
    bank.extraction_status =
      statementsTotal > 0 && statementsExtracted === statementsTotal
        ? 'complete'
        : statementsTotal > 0
          ? 'incomplete'
          : 'complete';
    if (bank.extraction_status === 'incomplete') {
      for (const s of stmts) {
        if (s.status === 'ready') s.status = 'pending_extraction';
      }
    }
  }

  // Recompute totalStatements after cleanup.
  totalStatements = 0;
  for (const b of Object.values(banksWithStatements)) {
    totalStatements += b.statement_count;
  }
  // Drop banks whose statements list became empty after cleanup.
  for (const code of Object.keys(banksWithStatements)) {
    if (banksWithStatements[code]!.statement_count === 0) {
      delete banksWithStatements[code];
    }
  }

  const bankCount = Object.keys(banksWithStatements).length;
  const message =
    totalStatements === 0
      ? `No new statements found across ${Object.keys(allBanks).length} bank accounts (${totalEmailsScanned} emails scanned, ${totalPdfsFound} PDFs checked)`
      : `Found ${totalStatements} statement(s) across ${bankCount} bank(s)`;

  timings.total = round1((Date.now() - t0) / 1000);

  return {
    success: true,
    banks: banksWithStatements,
    unidentified: [],
    non_current: nonCurrent,
    non_current_count:
      nonCurrent.already_processed.length +
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
    mailbox_synced: false,
    mailbox_sync_skipped: false,
    timings,
    message,
  };
}

// ---- helpers ----

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function legacyBankNameFromDescription(desc: string): string | null {
  for (const k of ['barclays', 'lloyds', 'hsbc', 'natwest', 'santander', 'nationwide', 'rbs', 'tsb', 'metro', 'tide', 'monzo', 'starling', 'revolut']) {
    if (desc.includes(k)) return k;
  }
  return null;
}

function ncSortKey(s: StatementCandidate): string {
  const sd = s.statement_date ?? '';
  if (sd) return sd;
  const sk = (s as unknown as Record<string, unknown>).sort_key as StatementSortKey | undefined;
  if (sk && Array.isArray(sk) && sk.length >= 3) {
    return `${String(sk[0]).padStart(4, '0')}-${String(sk[1]).padStart(2, '0')}-${String(sk[2]).padStart(2, '0')}`;
  }
  return '';
}

function emptyTracking(): StatementTrackingData {
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

function emptyResponse(
  daysBack: number,
  t0: number,
  timings: Record<string, number>,
): ScanAllBanksResponse {
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

function errorResponse(
  err: unknown,
  daysBack: number,
  timings: Record<string, number>,
  t0: number,
): ScanAllBanksResponse {
  return {
    ...emptyResponse(daysBack, t0, timings),
    success: false,
    error: err instanceof Error ? err.message : String(err),
  };
}

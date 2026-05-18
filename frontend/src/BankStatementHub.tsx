import { useState, useCallback, useMemo, useEffect } from 'react';
import { Landmark, RefreshCw, FileText, ArrowRight, CheckCircle, AlertTriangle, Search, ChevronDown, ChevronRight, Mail, FolderOpen, X, Archive, Trash2, Eye, Clock, ShieldAlert, RotateCcw } from 'lucide-react';
import { authFetch, friendlyError } from './api-shim';
import { Imports } from './Imports';
import { BankStatementReconcileWithBoundary as BankStatementReconcile } from './BankStatementReconcile';
import { LIVE_VERSION } from './PageHeader';

// ---- Types ----

interface StatementEntry {
  email_id?: number;
  attachment_id?: string;
  filename: string;
  source: 'email' | 'pdf';
  full_path?: string;
  folder?: string;
  subject?: string;
  from_address?: string;
  received_at?: string;
  detected_bank_name?: string;
  already_processed?: boolean;
  is_reconciled?: boolean;
  is_imported?: boolean;
  status: 'ready' | 'sequence_gap' | 'uncached' | 'pending' | 'already_processed' | 'imported' | 'pending_extraction';
  state?: 'ready' | 'in_progress' | 'imported' | 'reconciled' | 'pending_extraction' | 'sequence_gap' | 'already_processed';
  deferred_count?: number;
  extraction_status?: 'extracted' | 'cached' | 'pending_extraction' | 'failed' | 'pending';
  extraction_failure_reason?: 'rate_limit' | 'extraction_error';
  /** Human-readable explanation of the most recent extraction failure
   *  or pending state. Populated by BE when extraction_status is
   *  'failed' or 'pending'. */
  extraction_error?: string | null;
  /** ISO timestamp of the last extraction attempt — drives the
   *  "last tried N min ago" subtext on failed/pending statements. */
  extraction_attempted_at?: string | null;
  validation_note?: string;
  opening_balance?: number;
  closing_balance?: number;
  period_start?: string;
  period_end?: string;
  bank_name?: string;
  account_number?: string;
  sort_code?: string;
  import_sequence?: number;
  statement_date?: string;
  category?: 'already_processed' | 'old_statement' | 'not_classified' | 'advanced';
  matched_bank_code?: string;
  matched_bank_description?: string;
  matched_sort_code?: string;
  matched_account_number?: string;
  balance_gap?: number;
}

interface BankGroup {
  bank_code: string;
  description: string;
  sort_code: string;
  account_number: string;
  reconciled_balance: number | null;
  current_balance: number | null;
  type: string;
  statements: StatementEntry[];
  statement_count: number;
  extraction_status?: 'complete' | 'incomplete';
  statements_extracted?: number;
  statements_total?: number;
  extraction_failures?: { filename: string; reason: string }[];
}

interface NonCurrentStatements {
  already_processed: StatementEntry[];
  old_statements: StatementEntry[];
  not_classified: StatementEntry[];
  advanced: StatementEntry[];
}

interface ScanResult {
  success: boolean;
  banks: Record<string, BankGroup>;
  unidentified: StatementEntry[];
  non_current: NonCurrentStatements;
  non_current_count: number;
  total_statements: number;
  total_banks_with_statements: number;
  total_banks_loaded: number;
  total_emails_scanned: number;
  total_pdfs_found: number;
  duplicates_archived: number;
  days_searched: number;
  mailbox_synced?: boolean;
  message: string;
  error?: string;
}

interface InProgressStatement {
  id: number;
  filename: string;
  bank_code: string;
  source: string;
  transactions_imported: number;
  total_receipts: number;
  total_payments: number;
  import_date: string;
  imported_by: string;
  target_system: string;
  email_id?: number;
  attachment_id?: string;
  opening_balance?: number;
  closing_balance?: number;
  statement_date?: string;
  account_number?: string;
  sort_code?: string;
  stored_transaction_count: number;
  reconciled_count?: number;
  is_reconciled?: number;
  reconciled_date?: string;
}

type TabType = 'pending' | 'manage' | 'process' | 'reconcile';

interface ReconcileHandoff {
  bank_code: string;
  statement_transactions: any[];
  statement_info: any;
  source: string;
  filename?: string;
  import_id?: number;
}

// ---- Component ----

interface RestoreCheckBank {
  bank_code: string;
  description: string;
  reconciled_balance: number;
  divergence_detected: boolean;
  divergence_message: string | null;
  orphan_line_count: number;
  orphan_statement_count: number;
  needs_recovery: boolean;
}
interface RestoreCheckResponse {
  success: boolean;
  detected: boolean;
  total_banks_checked: number;
  affected_banks: number;
  banks: RestoreCheckBank[];
  summary_message: string | null;
}

export function BankStatementHub() {
  const [activeTab, setActiveTab] = useState<TabType>('pending');
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [lastScanTime, setLastScanTime] = useState<string | null>(null);
  const [daysBack, setDaysBack] = useState(30);
  const [restoreCheck, setRestoreCheck] = useState<RestoreCheckResponse | null>(null);
  const [restoreBannerDismissed, setRestoreBannerDismissed] = useState(false);
  const [restoreRecovering, setRestoreRecovering] = useState(false);
  const [restoreRecoveryResult, setRestoreRecoveryResult] = useState<string | null>(null);

  const [selectedStatement, setSelectedStatement] = useState<{
    bankCode: string;
    bankDescription: string;
    statement: StatementEntry;
  } | null>(null);

  const [reconcileData, setReconcileData] = useState<ReconcileHandoff | null>(null);
  const [resumeStatement, setResumeStatement] = useState<InProgressStatement | null>(null);
  const [resumeImportId, setResumeImportId] = useState<number | null>(null);
  const [inProgressStatements, setInProgressStatements] = useState<InProgressStatement[]>([]);
  const [inProgressLoading, setInProgressLoading] = useState(false);
  const [completedStatements, setCompletedStatements] = useState<InProgressStatement[]>([]);
  const [completedLoading, setCompletedLoading] = useState(false);
  const [archivedStatements, setArchivedStatements] = useState<{ id: number; filename: string; bank_code: string; import_date: string; period_start?: string; period_end?: string; source: string; imported_by: string; target_system: string }[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [expandedBanks, setExpandedBanks] = useState<Set<string>>(new Set());
  const [manualUploadMode, setManualUploadMode] = useState(false);

  // PDF viewer state
  const [pdfViewer, setPdfViewer] = useState<{ url: string; filename: string } | null>(null);

  // Recurring entries check state
  const [recurringCheck, setRecurringCheck] = useState<{
    bankCode: string;
    mode: 'warn' | 'process';
    totalDue: number;
    entries: any[];
    checking: boolean;
  } | null>(null);
  const [postingRecurringNow, setPostingRecurringNow] = useState(false);
  const [recurringPostError, setRecurringPostError] = useState<string | null>(null);
  const [recurringPostSuccess, setRecurringPostSuccess] = useState<string | null>(null);
  const [recurringSelected, setRecurringSelected] = useState<Set<string>>(new Set());

  const nonCurrentCount = scanResult?.non_current_count || 0;

  const fetchInProgress = useCallback(async () => {
    setInProgressLoading(true);
    try {
      const resp = await authFetch('/api/statement-files/imported-for-reconciliation');
      const data = await resp.json();
      if (data.success) setInProgressStatements(data.statements || []);
    } catch (err) {
      console.error('Failed to fetch in-progress statements:', err);
    } finally {
      setInProgressLoading(false);
    }
  }, []);

  const fetchCompleted = useCallback(async () => {
    setCompletedLoading(true);
    try {
      const resp = await authFetch('/api/statement-files/imported-for-reconciliation?include_reconciled=true');
      const data = await resp.json();
      if (data.success) {
        // Filter to only reconciled ones (exclude in-progress)
        const reconciled = (data.statements || []).filter((s: InProgressStatement) => s.is_reconciled === 1 || (s.reconciled_count != null && s.reconciled_count > 0));
        setCompletedStatements(reconciled);
      }
    } catch (err) {
      console.error('Failed to fetch completed statements:', err);
    } finally {
      setCompletedLoading(false);
    }
  }, []);

  const fetchArchived = useCallback(async () => {
    setArchivedLoading(true);
    try {
      const resp = await authFetch('/api/bank-import/archived-statements');
      const data = await resp.json();
      if (data.success) {
        setArchivedStatements(data.statements || []);
      }
    } catch (err) {
      console.error('Failed to fetch archived statements:', err);
    } finally {
      setArchivedLoading(false);
    }
  }, []);

  const handleRestoreArchived = useCallback(async (recordId: number) => {
    try {
      const resp = await authFetch('/api/bank-import/restore-statement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ record_id: recordId }),
      });
      const data = await resp.json();
      if (data.success) {
        fetchArchived();
        fetchCompleted();
      } else {
        alert(data.error || 'Failed to restore statement');
      }
    } catch (err: any) {
      alert(err.message || 'Failed to restore statement');
    }
  }, [fetchArchived, fetchCompleted]);

  const handleDeleteArchived = useCallback(async (recordId: number) => {
    try {
      const resp = await authFetch('/api/bank-import/delete-archived-statement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ record_id: recordId }),
      });
      const data = await resp.json();
      if (data.success) {
        fetchArchived();
      } else {
        alert(data.error || 'Failed to delete statement');
      }
    } catch (err: any) {
      alert(err.message || 'Failed to delete statement');
    }
  }, [fetchArchived]);

  useEffect(() => {
    fetchInProgress();
    fetchCompleted();
    fetchArchived();
  }, [fetchInProgress, fetchCompleted, fetchArchived]);

  const handleRestoreRecovery = useCallback(async () => {
    if (!restoreCheck?.banks) return;
    const affected = restoreCheck.banks.filter((b) => b.needs_recovery);
    if (affected.length === 0) return;
    const confirmed = window.confirm(
      `This will clear the 'already posted' tracking on ${affected
        .reduce((s, b) => s + b.orphan_line_count, 0)
        .toString()} statement line(s) across ${affected.length} bank account(s) ` +
        `so the underlying statements can be re-imported and re-posted to Opera.\n\n` +
        `Only confirm if Opera was actually restored from a backup ` +
        `(NOT if entries were deleted on purpose). Continue?`,
    );
    if (!confirmed) return;
    setRestoreRecovering(true);
    setRestoreRecoveryResult(null);
    try {
      let totalLines = 0;
      const errors: string[] = [];
      for (const b of affected) {
        try {
          const resp = await authFetch(
            `/api/reconcile/bank/${encodeURIComponent(b.bank_code)}/recover-orphan-transactions`,
            { method: 'POST' },
          );
          const data = await resp.json();
          if (data.success) {
            totalLines += Number(data.cleared_lines ?? 0);
          } else {
            errors.push(`${b.bank_code}: ${data.error ?? 'unknown error'}`);
          }
        } catch (err: any) {
          errors.push(`${b.bank_code}: ${err?.message ?? String(err)}`);
        }
      }
      setRestoreRecoveryResult(
        errors.length === 0
          ? `Cleared ${totalLines} line(s) across ${affected.length} bank(s). Re-import the affected statements to re-post them to Opera.`
          : `Recovery completed with errors: ${errors.join('; ')}`,
      );
      // Re-run the check so banner clears
      try {
        const rcResp = await authFetch('/api/bank-import/restore-check');
        const rc = (await rcResp.json()) as RestoreCheckResponse;
        setRestoreCheck(rc.success ? rc : null);
      } catch {
        setRestoreCheck(null);
      }
    } finally {
      setRestoreRecovering(false);
    }
  }, [restoreCheck]);

  const handleScan = useCallback(async () => {
    setScanning(true);
    setScanError(null);
    setRestoreBannerDismissed(false);
    try {
      // Run scan + tenant-wide Opera-restore detection in parallel.
      // The restore-check looks at every bank's most-recent reconciled
      // statement vs Opera nk_recbal, plus every posted statement line
      // against Opera atran/aentry — if Opera was restored from a
      // backup since the last scan, the banner fires with a list of
      // affected banks and a Recover prompt.
      const [scanResp, restoreResp] = await Promise.all([
        authFetch(`/api/bank-import/scan-all-banks?days_back=${daysBack}&validate_balances=true`),
        authFetch('/api/bank-import/restore-check'),
      ]);
      const data: ScanResult = await scanResp.json();
      if (data.success) {
        setScanResult(data);
        setLastScanTime(new Date().toLocaleTimeString());
        setExpandedBanks(new Set(Object.keys(data.banks)));
      } else {
        setScanError(friendlyError(data.error || 'Scan failed'));
      }
      try {
        const rc = (await restoreResp.json()) as RestoreCheckResponse;
        setRestoreCheck(rc.success ? rc : null);
      } catch {
        setRestoreCheck(null);
      }
    } catch (err: any) {
      setScanError(friendlyError(err.message || 'Network error'));
    } finally {
      setScanning(false);
      fetchInProgress();
      fetchCompleted();
    }
  }, [daysBack, fetchInProgress, fetchCompleted]);

  const handleDeleteStatement = useCallback(async (stmt: StatementEntry) => {
    try {
      const resp = await authFetch('/api/bank-import/manage-statements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'delete',
          statements: [{
            source: stmt.source,
            email_id: stmt.email_id,
            attachment_id: stmt.attachment_id,
            filename: stmt.filename,
            full_path: stmt.full_path,
            matched_bank_code: stmt.matched_bank_code,
          }],
        }),
      });
      const data = await resp.json();
      if (data.success) {
        // Remove from scan result in-place for instant feedback
        // Do NOT auto-rescan — the email scan would re-download the PDF
        if (scanResult) {
          const updated = { ...scanResult };
          for (const bankCode of Object.keys(updated.banks)) {
            updated.banks[bankCode] = {
              ...updated.banks[bankCode],
              statements: updated.banks[bankCode].statements.filter(s => s.filename !== stmt.filename || s.email_id !== stmt.email_id),
            };
            updated.banks[bankCode].statement_count = updated.banks[bankCode].statements.length;
          }
          updated.total_statements = Object.values(updated.banks).reduce((sum, b) => sum + (b.statement_count || 0), 0);
          setScanResult(updated);
        }
      } else {
        alert(data.error || data.message || 'Failed to delete statement');
      }
    } catch (err: any) {
      alert(err.message || 'Failed to delete statement');
    }
  }, [scanResult, handleScan]);

  const handleViewStatement = useCallback((stmt: StatementEntry) => {
    const token = localStorage.getItem('auth_token') || '';
    let url: string;
    if (stmt.source === 'email' && stmt.email_id && stmt.attachment_id) {
      url = `/api/email/messages/${stmt.email_id}/attachments/${encodeURIComponent(stmt.attachment_id)}/view?token=${encodeURIComponent(token)}`;
    } else if (stmt.full_path) {
      url = `/api/file/view?path=${encodeURIComponent(stmt.full_path)}&token=${encodeURIComponent(token)}`;
    } else {
      return;
    }
    setPdfViewer({ url, filename: stmt.filename });
  }, []);

  // Check recurring entries for a bank — returns { mode, totalDue, entries } or null if no issues
  const checkRecurringEntries = useCallback(async (bankCode: string): Promise<{ mode: 'warn' | 'process'; totalDue: number; entries: any[] } | null> => {
    try {
      const [checkRes, configRes] = await Promise.all([
        authFetch(`/api/recurring-entries/check/${encodeURIComponent(bankCode)}`),
        authFetch('/api/recurring-entries/config'),
      ]);
      const checkData = await checkRes.json();
      const configData = await configRes.json();
      const mode = configData.mode || 'process';
      if (checkData.success && checkData.total_due > 0) {
        return { mode, totalDue: checkData.total_due, entries: checkData.entries || [] };
      }
      return null;
    } catch {
      // If check fails, don't block — proceed silently
      return null;
    }
  }, []);

  const handleProcess = useCallback(async (bankCode: string, bankDescription: string, stmt: StatementEntry) => {
    // Set pending state so user sees we're checking
    setRecurringCheck({ bankCode, mode: 'process', totalDue: 0, entries: [], checking: true });
    setSelectedStatement({ bankCode, bankDescription, statement: stmt });

    const result = await checkRecurringEntries(bankCode);

    if (result && result.totalDue > 0) {
      // Recurring entries found — set the check result
      setRecurringCheck({ bankCode, mode: result.mode, totalDue: result.totalDue, entries: result.entries, checking: false });
      // Default: ticked ON unless any occurrence of the same record is blocked
      const blockedRefs = new Set(result.entries.filter((e: any) => !e.can_post).map((e: any) => (e.base_entry_ref || e.entry_ref.split(':')[0])));
      const autoSelected = new Set(result.entries.filter((e: any) => e.can_post && !blockedRefs.has(e.base_entry_ref || e.entry_ref.split(':')[0])).map((e: any) => e.entry_ref));
      setRecurringSelected(autoSelected);
      if (result.mode === 'process') {
        // If ALL entries are period-blocked, don't hard-block — let user proceed
        const hasPostable = result.entries.some((e: any) => e.can_post);
        if (!hasPostable) {
          // All entries are blocked — show as warning instead of hard block
          setRecurringCheck({ bankCode, mode: 'warn', totalDue: result.totalDue, entries: result.entries, checking: false });
          setActiveTab('process');
          return;
        }
        // Hard block — don't switch to process tab, stay on pending with block message
        setActiveTab('process');
        return;
      }
      // Warn mode — show warning but allow proceeding
      setActiveTab('process');
      return;
    }

    // No recurring entries due — proceed normally
    setRecurringCheck(null);
    setReconcileData(null);
    setActiveTab('process');
  }, [checkRecurringEntries]);

  const handleRecurringRecheck = useCallback(async () => {
    if (!recurringCheck || !selectedStatement) return;
    setRecurringCheck(prev => prev ? { ...prev, checking: true } : null);
    const result = await checkRecurringEntries(recurringCheck.bankCode);
    if (result && result.totalDue > 0) {
      const hasPostable = result.entries.some((e: any) => e.can_post);
      const effectiveMode = (result.mode === 'process' && !hasPostable) ? 'warn' : result.mode;
      setRecurringCheck({ bankCode: recurringCheck.bankCode, mode: effectiveMode, totalDue: result.totalDue, entries: result.entries, checking: false });
      const blockedRefs = new Set(result.entries.filter((e: any) => !e.can_post).map((e: any) => (e.base_entry_ref || e.entry_ref.split(':')[0])));
      const autoSelected = new Set(result.entries.filter((e: any) => e.can_post && !blockedRefs.has(e.base_entry_ref || e.entry_ref.split(':')[0])).map((e: any) => e.entry_ref));
      setRecurringSelected(autoSelected);
    } else {
      // Cleared — dismiss and proceed
      setRecurringCheck(null);
    }
  }, [recurringCheck, selectedStatement, checkRecurringEntries]);

  const handleDismissRecurringWarning = useCallback(() => {
    setRecurringCheck(null);
  }, []);

  const handlePostRecurringNow = useCallback(async () => {
    if (!recurringCheck || !recurringCheck.entries.length || recurringSelected.size === 0) return;
    setPostingRecurringNow(true);
    setRecurringPostError(null);
    setRecurringPostSuccess(null);
    try {
      const entries = recurringCheck.entries
        .filter((e: any) => recurringSelected.has(e.entry_ref))
        .map((e: any) => ({
          entry_ref: e.entry_ref,
          override_date: e.next_post_date || null
        }));
      const res = await authFetch('/api/recurring-entries/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bank_code: recurringCheck.bankCode, entries })
      });
      const data = await res.json();
      if (data.posted_count > 0) {
        setRecurringPostSuccess(`${data.posted_count} recurring ${data.posted_count === 1 ? 'entry' : 'entries'} posted successfully.`);
        // Re-check after a brief delay to show success message
        setTimeout(async () => {
          const result = await checkRecurringEntries(recurringCheck.bankCode);
          if (result && result.totalDue > 0) {
            const hasPostable = result.entries.some((e: any) => e.can_post);
            const effectiveMode = (result.mode === 'process' && !hasPostable) ? 'warn' : result.mode;
            setRecurringCheck({ bankCode: recurringCheck.bankCode, mode: effectiveMode, totalDue: result.totalDue, entries: result.entries, checking: false });
            const blockedRefs = new Set(result.entries.filter((e: any) => !e.can_post).map((e: any) => (e.base_entry_ref || e.entry_ref.split(':')[0])));
            const autoSelected = new Set(result.entries.filter((e: any) => e.can_post && !blockedRefs.has(e.base_entry_ref || e.entry_ref.split(':')[0])).map((e: any) => e.entry_ref));
            setRecurringSelected(autoSelected);
          } else {
            setRecurringCheck(null);
          }
          setRecurringPostSuccess(null);
        }, 1500);
      }
      if (data.failed_count > 0) {
        const failures = (data.results || []).filter((r: any) => !r.success).map((r: any) => r.error || r.entry_ref).join('; ');
        setRecurringPostError(`${data.failed_count} failed: ${failures}`);
      }
    } catch (err: any) {
      setRecurringPostError(err.message || 'Failed to post recurring entries');
    } finally {
      setPostingRecurringNow(false);
    }
  }, [recurringCheck, recurringSelected, checkRecurringEntries]);

  const handleImportComplete = useCallback((data: ReconcileHandoff) => {
    setReconcileData(data);
    setResumeStatement(null);
    setActiveTab('reconcile');
    fetchInProgress(); // Refresh in-progress list after new import
  }, [fetchInProgress]);

  const handleReconcileComplete = useCallback(() => {
    setSelectedStatement(null);
    setReconcileData(null);
    setResumeStatement(null);
    setActiveTab('pending');
    fetchInProgress();
    // Re-scan to update statement list (removes reconciled statement, highlights next)
    if (scanResult) handleScan();
  }, [fetchInProgress, handleScan, scanResult]);

  const handleResumeReconcile = useCallback((stmt: InProgressStatement) => {
    setResumeStatement(stmt);
    setReconcileData(null);
    setSelectedStatement(null);
    setActiveTab('reconcile');
  }, []);

  const handleReprocessStatement = useCallback(async (stmt: InProgressStatement) => {
    if (!window.confirm(
      `Clear Statement: ${stmt.filename}\n\n` +
      `This will:\n` +
      `• Clear the import tracking record (${stmt.transactions_imported} of ${stmt.stored_transaction_count} transactions imported)\n` +
      `• Remove stored statement transactions from the local database\n` +
      `• Allow you to re-import this statement from scratch\n\n` +
      `This does NOT affect Opera cashbook entries already posted.\n\n` +
      `Continue?`
    )) {
      return;
    }
    // Delete import tracking data (does not affect Opera cashbook entries)
    try {
      const resp = await authFetch(`/api/bank-import/import-history/${stmt.id}`, { method: 'DELETE' });
      const data = await resp.json();
      if (!data.success) {
        alert(`Failed to reset statement: ${data.error || 'Unknown error'}`);
        // Still refresh lists to sync with actual DB state
        await fetchInProgress();
        if (scanResult) handleScan();
        return;
      }
    } catch (err) {
      alert(`Failed to reset statement: ${err}`);
      await fetchInProgress();
      if (scanResult) handleScan();
      return;
    }
    // Refresh both in-progress list and scan results to update all badges
    await fetchInProgress();
    if (scanResult) handleScan();
  }, [fetchInProgress, handleScan, scanResult]);

  const handleContinueImport = useCallback((stmt: InProgressStatement) => {
    // Look up full path from scan results if available
    let fullPath: string | undefined;
    if (scanResult?.banks) {
      const bankGroup = scanResult.banks[stmt.bank_code];
      if (bankGroup) {
        const match = bankGroup.statements.find(s => s.filename === stmt.filename);
        if (match?.full_path) fullPath = match.full_path;
      }
    }

    const source: 'email' | 'pdf' = stmt.source === 'email' ? 'email' : 'pdf';
    const stmtEntry: StatementEntry = {
      email_id: stmt.email_id,
      attachment_id: stmt.attachment_id,
      filename: stmt.filename,
      source,
      full_path: fullPath,
      status: 'ready',
      is_imported: false,
      opening_balance: stmt.opening_balance,
      closing_balance: stmt.closing_balance,
      statement_date: stmt.statement_date,
      account_number: stmt.account_number,
      sort_code: stmt.sort_code,
    };
    setSelectedStatement({ bankCode: stmt.bank_code, bankDescription: stmt.bank_code, statement: stmtEntry });
    setReconcileData(null);
    setResumeStatement(null);
    setResumeImportId(stmt.id);
    setActiveTab('process');
  }, [scanResult]);

  const handleReconcileFromPending = useCallback((bankCode: string, stmt: StatementEntry) => {
    const match = inProgressStatements.find(ip =>
      ip.filename === stmt.filename && ip.bank_code === bankCode
    );
    if (match) {
      handleResumeReconcile(match);
    }
  }, [inProgressStatements, handleResumeReconcile]);

  const handleBackToPending = useCallback(() => {
    setResumeImportId(null);
    setManualUploadMode(false);
    setRecurringCheck(null);
    setActiveTab('pending');
  }, []);

  const toggleBank = useCallback((code: string) => {
    setExpandedBanks(prev => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }, []);

  const bankList = useMemo(() => {
    if (!scanResult?.banks) return [];
    return Object.values(scanResult.banks).sort((a, b) => a.bank_code.localeCompare(b.bank_code));
  }, [scanResult]);

  const tabs: { key: TabType; label: string; disabled: boolean; badge?: number; secondaryBadge?: number }[] = [
    { key: 'pending', label: 'Load Statements', disabled: false, badge: scanResult?.total_statements, secondaryBadge: inProgressStatements.length || undefined },
    { key: 'process', label: 'Process & Import', disabled: !selectedStatement },
    { key: 'reconcile', label: 'Reconcile', disabled: !reconcileData && !resumeStatement },
    { key: 'manage', label: 'Manage', disabled: !scanResult && completedStatements.length === 0 && archivedStatements.length === 0, badge: (nonCurrentCount + completedStatements.length + archivedStatements.length) || undefined },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center">
          <Landmark className="h-5 w-5 text-blue-600" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-gray-900">
            Bank Statements
            <span className="ml-2 text-xs font-medium text-gray-400">
              Live Version {LIVE_VERSION}
            </span>
          </h1>
          <p className="text-sm text-gray-500">Import, process and reconcile</p>
        </div>
      </div>

      <div className="flex border-b border-gray-200">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => {
              if (tab.disabled) return;
              setActiveTab(tab.key);
              if (tab.key === 'pending') fetchInProgress();
            }}
            disabled={tab.disabled}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? 'border-blue-600 text-blue-600'
                : tab.disabled
                  ? 'border-transparent text-gray-300 cursor-not-allowed'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
            {tab.badge != null && tab.badge > 0 && (
              <span className={`ml-1.5 text-xs rounded-full px-1.5 py-0.5 ${
                tab.key === 'manage' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'
              }`}>
                {tab.badge}
              </span>
            )}
            {tab.secondaryBadge != null && tab.secondaryBadge > 0 && (
              <span className="ml-1 text-xs rounded-full px-1.5 py-0.5 bg-orange-100 text-orange-700">
                {tab.secondaryBadge}
              </span>
            )}
          </button>
        ))}
      </div>

      {restoreCheck?.detected && !restoreBannerDismissed && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4 shadow-sm">
          <div className="flex items-start gap-3">
            <span className="text-2xl text-amber-600">⚠</span>
            <div className="flex-1">
              <div className="text-sm font-semibold text-amber-900">
                Opera restore likely detected — {restoreCheck.affected_banks} bank account(s) need review
              </div>
              <div className="mt-1 text-sm text-amber-800">
                {restoreCheck.summary_message ??
                  'SAM has tracking for statements or lines that no longer exist in Opera.'}
              </div>
              <ul className="mt-2 list-disc pl-5 text-sm text-amber-800">
                {restoreCheck.banks
                  .filter((b) => b.needs_recovery)
                  .map((b) => (
                    <li key={b.bank_code}>
                      <span className="font-medium">{b.bank_code}</span>{' '}
                      {b.description} — rec balance £{b.reconciled_balance.toFixed(2)}
                      {b.orphan_line_count > 0 && (
                        <> · {b.orphan_line_count} orphaned line(s) across {b.orphan_statement_count} statement(s)</>
                      )}
                      {b.divergence_detected && <> · statement-level divergence</>}
                    </li>
                  ))}
              </ul>
              <div className="mt-3 flex items-center gap-3">
                <button
                  onClick={handleRestoreRecovery}
                  disabled={restoreRecovering}
                  className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                >
                  {restoreRecovering ? 'Recovering…' : 'Clear stale tracking and re-enable re-import'}
                </button>
                <span className="text-xs text-amber-700">
                  Only click this if Opera was actually restored from a backup.
                </span>
              </div>
              {restoreRecoveryResult && (
                <div className="mt-2 rounded border border-amber-200 bg-white p-2 text-sm text-amber-900">
                  {restoreRecoveryResult}
                </div>
              )}
            </div>
            <button
              onClick={() => setRestoreBannerDismissed(true)}
              className="text-amber-500 hover:text-amber-700"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {activeTab === 'pending' && (
        <PendingStatementsTab
          scanResult={scanResult}
          bankList={bankList}
          scanning={scanning}
          scanError={scanError}
          lastScanTime={lastScanTime}
          daysBack={daysBack}
          setDaysBack={setDaysBack}
          expandedBanks={expandedBanks}
          toggleBank={toggleBank}
          nonCurrentCount={nonCurrentCount}
          onScan={handleScan}
          onProcess={handleProcess}
          onReconcile={handleReconcileFromPending}
          onSwitchToManage={() => setActiveTab('manage')}
          onManualUpload={() => { setManualUploadMode(true); setActiveTab('process'); }}
          inProgressStatements={inProgressStatements}
          inProgressLoading={inProgressLoading}
          onContinueImport={handleContinueImport}
          onClearStatement={handleReprocessStatement}
          onResumeReconcile={handleResumeReconcile}
          onDeleteStatement={handleDeleteStatement}
          onViewStatement={handleViewStatement}
        />
      )}

      {activeTab === 'process' && manualUploadMode && !selectedStatement && (
        <div>
          <div className="mb-3 flex items-center gap-2">
            <button onClick={() => { setManualUploadMode(false); setActiveTab('pending'); }} className="text-sm text-blue-600 hover:text-blue-800 flex items-center gap-1">
              <ArrowRight className="h-3.5 w-3.5 rotate-180" /> Back to Pending
            </button>
            <span className="text-gray-300">|</span>
            <span className="text-sm text-gray-600">Manual PDF Import</span>
          </div>
          <Imports
            key="manual-upload"
            bankRecOnly
            onImportComplete={(data) => {
              setManualUploadMode(false);
              handleImportComplete(data);
            }}
          />
        </div>
      )}

      {activeTab === 'manage' && (scanResult || completedStatements.length > 0 || archivedStatements.length > 0) && (
        <ManageStatementsTab
          nonCurrent={scanResult?.non_current || { already_processed: [], old_statements: [], not_classified: [], advanced: [] }}
          completedStatements={completedStatements}
          completedLoading={completedLoading}
          archivedStatements={archivedStatements}
          archivedLoading={archivedLoading}
          onRestoreArchived={handleRestoreArchived}
          onDeleteArchived={handleDeleteArchived}
          onRefresh={handleScan}
          onProcess={(stmt) => {
            if (stmt.matched_bank_code) {
              handleProcess(stmt.matched_bank_code, stmt.matched_bank_description || stmt.matched_bank_code, stmt);
            }
          }}
        />
      )}

      {activeTab === 'process' && selectedStatement && (
        <div>
          <div className="mb-3 flex items-center gap-2">
            <button onClick={handleBackToPending} className="text-sm text-blue-600 hover:text-blue-800 flex items-center gap-1">
              <ArrowRight className="h-3.5 w-3.5 rotate-180" /> Back to Pending
            </button>
            <span className="text-gray-300">|</span>
            <span className="text-sm text-gray-600">
              {resumeImportId ? 'Continue Import' : 'Processing'}: <strong>{selectedStatement.statement.filename}</strong> for {selectedStatement.bankDescription}
            </span>
            {resumeImportId && (
              <span className="px-2 py-0.5 text-xs font-medium bg-orange-100 text-orange-700 rounded-full">
                Resume — already-posted lines will be skipped
              </span>
            )}
          </div>

          {/* Recurring entries checking spinner */}
          {recurringCheck?.checking && (
            <div className="mb-4 bg-blue-50 border border-blue-200 rounded-xl p-4 flex items-center gap-3">
              <RefreshCw className="w-5 h-5 text-blue-500 animate-spin flex-shrink-0" />
              <p className="text-sm text-blue-700">Checking for due recurring entries...</p>
            </div>
          )}

          {/* Recurring entries — HARD BLOCK (process mode) */}
          {recurringCheck && !recurringCheck.checking && recurringCheck.mode === 'process' && recurringCheck.totalDue > 0 && (
            <div className="mb-4 bg-red-50 border-2 border-red-300 rounded-xl p-5">
              <div className="flex items-start gap-3">
                <ShieldAlert className="w-6 h-6 text-red-600 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-base font-bold text-red-800">Recurring Entries Must Be Processed First</p>
                  <p className="text-sm text-red-700 mt-1">
                    {recurringCheck.totalDue} recurring {recurringCheck.totalDue === 1 ? 'entry is' : 'entries are'} due for bank {recurringCheck.bankCode}.
                    These must be posted before importing this statement to avoid duplicate entries.
                  </p>
                  {(() => {
                    const postableCount = recurringCheck.entries.filter((e: any) => e.can_post).length;
                    const blockedCount = recurringCheck.entries.filter((e: any) => !e.can_post).length;
                    if (postableCount > 0 && blockedCount > 0) {
                      return (
                        <p className="text-xs text-red-600 mt-1.5 bg-red-100/70 rounded px-2 py-1.5">
                          <strong>{postableCount}</strong> {postableCount === 1 ? 'entry can' : 'entries can'} be posted now (select and post below).{' '}
                          <strong>{blockedCount}</strong> {blockedCount === 1 ? 'entry is' : 'entries are'} period-blocked and greyed out — {blockedCount === 1 ? 'it' : 'they'} cannot be posted until the posting period is opened in Opera.
                        </p>
                      );
                    } else if (postableCount > 0) {
                      return (
                        <p className="text-xs text-red-600 mt-1.5 bg-red-100/70 rounded px-2 py-1.5">
                          Select the entries below and click &quot;Post Selected&quot; to post them, or if you have already run these in Opera, click &quot;Check Again&quot; to refresh.
                        </p>
                      );
                    }
                    return null;
                  })()}
                  {recurringCheck.entries.length > 0 && (
                    <div className="mt-3 bg-white/60 border border-red-200 rounded-lg overflow-hidden">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-red-100/50 text-red-800">
                            <th className="px-3 py-1.5 w-8">
                              <input
                                type="checkbox"
                                checked={recurringCheck.entries.filter((e: any) => e.can_post).length > 0 && recurringCheck.entries.filter((e: any) => e.can_post).every((e: any) => recurringSelected.has(e.entry_ref))}
                                onChange={(ev) => {
                                  if (ev.target.checked) {
                                    setRecurringSelected(new Set(recurringCheck.entries.filter((e: any) => e.can_post).map((e: any) => e.entry_ref)));
                                  } else {
                                    setRecurringSelected(new Set());
                                  }
                                }}
                                disabled={postingRecurringNow}
                                className="accent-red-600"
                              />
                            </th>
                            <th className="px-3 py-1.5 text-left font-medium">Entry</th>
                            <th className="px-3 py-1.5 text-left font-medium">Description</th>
                            <th className="px-3 py-1.5 text-left font-medium">Type</th>
                            <th className="px-3 py-1.5 text-right font-medium">Amount</th>
                            <th className="px-3 py-1.5 text-left font-medium">Next Due</th>
                          </tr>
                        </thead>
                        <tbody>
                          {recurringCheck.entries.map((entry: any, i: number) => {
                            const isBlocked = !entry.can_post;
                            const isSelected = recurringSelected.has(entry.entry_ref);
                            return (
                              <tr key={i} className={`border-t border-red-100 ${isBlocked ? 'opacity-50' : ''}`}>
                                <td className="px-3 py-1.5">
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    disabled={isBlocked || postingRecurringNow}
                                    onChange={() => {
                                      const next = new Set(recurringSelected);
                                      if (isSelected) next.delete(entry.entry_ref);
                                      else next.add(entry.entry_ref);
                                      setRecurringSelected(next);
                                    }}
                                    className="accent-red-600"
                                  />
                                </td>
                                <td className="px-3 py-1.5 font-mono text-red-900">{entry.base_entry_ref || entry.entry_ref.split(':')[0]}</td>
                                <td className="px-3 py-1.5 text-red-800">
                                  {entry.description}
                                  {isBlocked && <div className="text-[10px] text-red-500 mt-0.5">{entry.blocked_reason || 'Period blocked'}</div>}
                                </td>
                                <td className="px-3 py-1.5 text-red-700">{entry.type_desc}</td>
                                <td className="px-3 py-1.5 text-right font-mono text-red-900">
                                  £{(entry.amount_pounds || 0).toLocaleString('en-GB', { minimumFractionDigits: 2 })}
                                </td>
                                <td className="px-3 py-1.5 text-red-700">{entry.next_post_date}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <div className="mt-4 flex flex-col gap-2">
                    <div className="flex items-center gap-3">
                      <button
                        onClick={handlePostRecurringNow}
                        disabled={postingRecurringNow || recurringSelected.size === 0}
                        className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
                      >
                        {postingRecurringNow ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5" />}
                        {postingRecurringNow ? 'Posting...' : `Post Selected (${recurringSelected.size})`}
                      </button>
                      <button
                        onClick={handleRecurringRecheck}
                        className="px-4 py-2 text-sm font-medium bg-red-600 text-white rounded-lg hover:bg-red-700 flex items-center gap-2"
                      >
                        <RefreshCw className="h-3.5 w-3.5" /> Already Run in Opera — Check Again
                      </button>
                    </div>
                    <button
                      onClick={handleBackToPending}
                      className="self-start px-4 py-2 text-sm font-medium text-red-700 bg-white border border-red-300 rounded-lg hover:bg-red-50"
                    >
                      Back to Statements
                    </button>
                  </div>
                  {recurringPostError && (
                    <div className="mt-3 p-3 bg-red-100 border border-red-300 rounded-lg text-sm text-red-800">
                      {recurringPostError}
                    </div>
                  )}
                  {recurringPostSuccess && (
                    <div className="mt-3 p-3 bg-green-50 border border-green-300 rounded-lg text-sm text-green-800">
                      {recurringPostSuccess}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Recurring entries — WARNING (warn mode) — dismissible */}
          {recurringCheck && !recurringCheck.checking && recurringCheck.mode === 'warn' && recurringCheck.totalDue > 0 && (
            <div className="mb-4 bg-amber-50 border border-amber-300 border-l-4 border-l-amber-500 rounded-xl p-4 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-semibold text-amber-800">Recurring Entries Due</p>
                {recurringCheck.entries.every((e: any) => !e.can_post) ? (
                  <>
                    <p className="text-sm text-amber-700 mt-0.5">
                      {recurringCheck.totalDue} recurring {recurringCheck.totalDue === 1 ? 'entry is' : 'entries are'} due for this bank, but {recurringCheck.totalDue === 1 ? 'it is' : 'all are'} period-blocked.
                    </p>
                    <p className="text-xs text-amber-600 mt-1 bg-amber-100/60 rounded px-2 py-1.5">
                      The posting period for {recurringCheck.totalDue === 1 ? 'this entry' : 'these entries'} is not currently open in Opera.
                      You can safely continue with the bank statement import — these recurring entries will not cause duplicates because they cannot be posted until the period is opened.
                      If the period has since been opened, click &quot;Check Again&quot; to refresh.
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-amber-700 mt-0.5">
                    {recurringCheck.totalDue} recurring {recurringCheck.totalDue === 1 ? 'entry is' : 'entries are'} due for this bank.
                    Consider running recurring entries in Opera first to avoid duplicate postings.
                  </p>
                )}
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={handleRecurringRecheck}
                    className="px-3 py-1.5 text-xs font-medium text-amber-700 bg-white border border-amber-300 rounded hover:bg-amber-50 flex items-center gap-1"
                  >
                    <RefreshCw className="h-3 w-3" /> Check Again
                  </button>
                  <button
                    onClick={handleDismissRecurringWarning}
                    className="px-3 py-1.5 text-xs font-medium bg-amber-600 text-white rounded hover:bg-amber-700 flex items-center gap-1"
                  >
                    Continue with Import
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Only show import UI if not blocked by recurring entries in process mode */}
          {!(recurringCheck && !recurringCheck.checking && recurringCheck.mode === 'process' && recurringCheck.totalDue > 0) && !recurringCheck?.checking && (
            <Imports
              key={`${selectedStatement.bankCode}-${selectedStatement.statement.filename}-${selectedStatement.statement.email_id || ''}-${resumeImportId || ''}`}
              bankRecOnly
              initialStatement={{
                bankCode: selectedStatement.bankCode,
                bankDescription: selectedStatement.bankDescription,
                emailId: selectedStatement.statement.email_id,
                attachmentId: selectedStatement.statement.attachment_id,
                filename: selectedStatement.statement.filename,
                source: selectedStatement.statement.source,
                fullPath: selectedStatement.statement.full_path,
              }}
              resumeImportId={resumeImportId || undefined}
              onImportComplete={(data) => {
                setResumeImportId(null);
                handleImportComplete(data);
              }}
            />
          )}
        </div>
      )}

      {activeTab === 'reconcile' && (reconcileData || resumeStatement) && (
        <div>
          <div className="mb-3 flex items-center gap-2">
            <button onClick={handleBackToPending} className="text-sm text-blue-600 hover:text-blue-800 flex items-center gap-1">
              <ArrowRight className="h-3.5 w-3.5 rotate-180" /> Back to Pending
            </button>
            <span className="text-gray-300">|</span>
            <span className="text-sm text-gray-600">
              Reconciling: <strong>{reconcileData?.filename || resumeStatement?.filename || 'Statement'}</strong>
            </span>
          </div>
          <BankStatementReconcile
            initialReconcileData={reconcileData}
            resumeImportId={resumeStatement?.id}
            resumeStatement={resumeStatement ? {
              id: resumeStatement.id,
              bank_code: resumeStatement.bank_code,
              filename: resumeStatement.filename,
              source: resumeStatement.source,
              opening_balance: resumeStatement.opening_balance,
              closing_balance: resumeStatement.closing_balance,
              statement_date: resumeStatement.statement_date,
            } : undefined}
            onReconcileComplete={handleReconcileComplete}
          />
        </div>
      )}

      {/* Floating PDF Viewer */}
      {pdfViewer && (
        <div className="fixed bottom-4 right-4 z-50 bg-white border border-gray-300 rounded-xl shadow-2xl flex flex-col"
          style={{ width: '500px', height: '600px' }}>
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 bg-gray-50 rounded-t-xl">
            <div className="flex items-center gap-2 min-w-0">
              <FileText className="h-4 w-4 text-blue-600 flex-shrink-0" />
              <span className="text-sm font-medium text-gray-800 truncate">{pdfViewer.filename}</span>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <a href={pdfViewer.url} target="_blank" rel="noreferrer"
                className="p-1 text-gray-400 hover:text-blue-600 rounded hover:bg-blue-50"
                title="Open in new tab">
                <ArrowRight className="h-3.5 w-3.5 -rotate-45" />
              </a>
              <button onClick={() => setPdfViewer(null)}
                className="p-1 text-gray-400 hover:text-red-600 rounded hover:bg-red-50"
                title="Close viewer">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          <iframe src={pdfViewer.url} className="flex-1 rounded-b-xl" title="Statement PDF" />
        </div>
      )}
    </div>
  );
}

// ---- Pending Statements Tab ----

function PendingStatementsTab({
  scanResult, bankList, scanning, scanError, lastScanTime, daysBack, setDaysBack,
  expandedBanks, toggleBank, nonCurrentCount, onScan, onProcess, onReconcile, onSwitchToManage, onManualUpload,
  inProgressStatements, inProgressLoading, onContinueImport, onClearStatement, onResumeReconcile, onDeleteStatement, onViewStatement,
}: {
  scanResult: ScanResult | null;
  bankList: BankGroup[];
  scanning: boolean;
  scanError: string | null;
  lastScanTime: string | null;
  daysBack: number;
  setDaysBack: (d: number) => void;
  expandedBanks: Set<string>;
  toggleBank: (code: string) => void;
  nonCurrentCount: number;
  onScan: () => void;
  onProcess: (bankCode: string, bankDescription: string, stmt: StatementEntry) => void;
  onReconcile: (bankCode: string, stmt: StatementEntry) => void;
  onSwitchToManage: () => void;
  onManualUpload: () => void;
  inProgressStatements: InProgressStatement[];
  inProgressLoading: boolean;
  onContinueImport: (stmt: InProgressStatement) => void;
  onClearStatement: (stmt: InProgressStatement) => void;
  onResumeReconcile: (stmt: InProgressStatement) => void;
  onDeleteStatement: (stmt: StatementEntry) => void;
  onViewStatement: (stmt: StatementEntry) => void;
}) {
  // Build lookup: (bank_code, filename) → InProgressStatement
  const inProgressMap = useMemo(() => {
    const map = new Map<string, InProgressStatement>();
    for (const ip of inProgressStatements) {
      map.set(`${ip.bank_code}::${ip.filename}`, ip);
    }
    return map;
  }, [inProgressStatements]);

  // Compute in-progress statements per bank (for badge counts)
  const inProgressByBank = useMemo(() => {
    const map = new Map<string, InProgressStatement[]>();
    for (const ip of inProgressStatements) {
      const key = ip.bank_code || 'Unknown';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(ip);
    }
    return map;
  }, [inProgressStatements]);

  // Find orphaned in-progress statements (imported but not in scan results)
  const orphanedByBank = useMemo(() => {
    if (!scanResult?.banks) return new Map<string, InProgressStatement[]>();
    const scannedKeys = new Set<string>();
    for (const bank of bankList) {
      for (const stmt of bank.statements) {
        scannedKeys.add(`${bank.bank_code}::${stmt.filename}`);
      }
    }
    const orphaned = new Map<string, InProgressStatement[]>();
    for (const ip of inProgressStatements) {
      if (!scannedKeys.has(`${ip.bank_code}::${ip.filename}`)) {
        if (!orphaned.has(ip.bank_code)) orphaned.set(ip.bank_code, []);
        orphaned.get(ip.bank_code)!.push(ip);
      }
    }
    return orphaned;
  }, [inProgressStatements, scanResult, bankList]);

  // Banks that only have orphaned in-progress statements (no scan results)
  const orphanedOnlyBanks = useMemo(() => {
    const scanBankCodes = new Set(bankList.map(b => b.bank_code));
    const result: string[] = [];
    for (const [bankCode] of orphanedByBank) {
      if (!scanBankCodes.has(bankCode)) result.push(bankCode);
    }
    return result.sort();
  }, [bankList, orphanedByBank]);

  // When at least one bank is incomplete (extraction pending), switch button copy to prompt re-scan
  const hasIncompleteBank = useMemo(
    () => Object.values(scanResult?.banks ?? {}).some(
      (b) => b.extraction_status === 'incomplete'
    ),
    [scanResult]
  );

  return (
    <div className="space-y-4">
      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <button onClick={onScan} disabled={scanning}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2 text-sm font-medium">
              {scanning ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              {scanning ? 'Scanning...' : hasIncompleteBank ? 'Re-scan to complete extraction' : 'Scan All Banks'}
            </button>
            <div className="flex items-center gap-1.5 text-sm text-gray-600">
              <span>Last</span>
              <select value={daysBack} onChange={e => setDaysBack(Number(e.target.value))}
                className="border border-gray-300 rounded px-2 py-1 text-sm">
                <option value={7}>7 days</option>
                <option value={14}>14 days</option>
                <option value={30}>30 days</option>
                <option value={60}>60 days</option>
                <option value={90}>90 days</option>
              </select>
            </div>
          </div>
          {lastScanTime && <span className="text-xs text-gray-400">Last scan: {lastScanTime}</span>}
        </div>
        {scanResult && !scanning && (
          <div className="mt-3 text-sm text-gray-600">
            {scanResult.message}
            {scanResult.mailbox_synced && (
              <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
                <Mail className="h-3 w-3 mr-1" /> Mailbox synced
              </span>
            )}
            {scanResult.duplicates_archived > 0 && (
              <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
                Auto-archived {scanResult.duplicates_archived} duplicate{scanResult.duplicates_archived !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        )}
      </div>

      {scanError && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
          <span className="text-red-500">⚠</span>
          <div className="flex-1">
            <p className="text-sm text-red-800 font-medium">Scan Error</p>
            <p className="text-sm text-red-700">{scanError}</p>
          </div>
        </div>
      )}

      {!scanResult && !scanning && !scanError && (
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-8 text-center">
          <Landmark className="h-10 w-10 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500 text-sm">Click "Scan All Banks" to find pending statements across all bank accounts</p>
        </div>
      )}

      {scanning && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-6 text-center">
          <RefreshCw className="h-8 w-8 text-blue-400 mx-auto mb-2 animate-spin" />
          <p className="text-blue-700 text-sm font-medium">Syncing mailbox and scanning for bank statements...</p>
          <p className="text-blue-500 text-xs mt-1">Fetching latest emails, then checking attachments and local files</p>
        </div>
      )}

      {/* In-progress summary strip */}
      {inProgressStatements.length > 0 && !scanning && (
        <div className="bg-orange-50 border border-orange-200 rounded-xl p-3 flex items-center gap-2">
          <Clock className="h-4 w-4 text-orange-500 flex-shrink-0" />
          <span className="text-sm text-orange-800 font-medium">
            {inProgressStatements.length} statement{inProgressStatements.length !== 1 ? 's' : ''} imported, awaiting reconciliation
          </span>
          {inProgressLoading && <RefreshCw className="h-3.5 w-3.5 text-orange-400 animate-spin" />}
        </div>
      )}

      {scanResult && !scanning && bankList.length > 0 && (
        <div className="space-y-3">
          {bankList.map(bank => (
            <BankCard key={bank.bank_code} bank={bank}
              expanded={expandedBanks.has(bank.bank_code)}
              onToggle={() => toggleBank(bank.bank_code)}
              onProcess={(stmt) => onProcess(bank.bank_code, bank.description, stmt)}
              onReconcile={(stmt) => onReconcile(bank.bank_code, stmt)}
              onDeleteStatement={onDeleteStatement}
              onViewStatement={onViewStatement}
              inProgressForBank={inProgressByBank.get(bank.bank_code) || []}
              inProgressMap={inProgressMap}
              orphanedStatements={orphanedByBank.get(bank.bank_code) || []}
              onContinueImport={onContinueImport}
              onClearStatement={onClearStatement}
              onResumeReconcile={onResumeReconcile} />
          ))}

          {/* Orphaned-only banks (in-progress statements with no scan results) */}
          {orphanedOnlyBanks.map(bankCode => {
            const orphaned = orphanedByBank.get(bankCode) || [];
            return (
              <OrphanedBankCard key={`orphaned-${bankCode}`} bankCode={bankCode} statements={orphaned}
                onContinueImport={onContinueImport} onClearStatement={onClearStatement} onResumeReconcile={onResumeReconcile} />
            );
          })}
        </div>
      )}

      {scanResult && !scanning && bankList.length === 0 && (
        <div className="space-y-3">
          {/* Orphaned-only banks when no scan results */}
          {orphanedOnlyBanks.map(bankCode => {
            const orphaned = orphanedByBank.get(bankCode) || [];
            return (
              <OrphanedBankCard key={`orphaned-${bankCode}`} bankCode={bankCode} statements={orphaned}
                onContinueImport={onContinueImport} onClearStatement={onClearStatement} onResumeReconcile={onResumeReconcile} />
            );
          })}
          {orphanedOnlyBanks.length === 0 && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-6 text-center">
              <CheckCircle className="h-8 w-8 text-green-400 mx-auto mb-2" />
              <p className="text-green-700 text-sm font-medium">All bank statements are up to date</p>
              <p className="text-green-600 text-xs mt-1">No pending statements found across {scanResult.total_banks_loaded} bank accounts</p>
              <button
                onClick={onManualUpload}
                className="mt-3 px-4 py-2 text-sm font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100 transition-colors"
              >
                <FileText className="h-4 w-4 inline-block mr-1.5" />
                Import PDF Manually
              </button>
            </div>
          )}
        </div>
      )}

      {/* Non-current link (replaces old unidentified box) */}
      {scanResult && nonCurrentCount > 0 && !scanning && (
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            <span>{nonCurrentCount} non-current statement{nonCurrentCount !== 1 ? 's' : ''} found (already processed, old, or unmatched)</span>
          </div>
          <button onClick={onSwitchToManage}
            className="text-sm text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1">
            Manage <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

// ---- Manage Statements Tab ----

function ManageStatementsTab({
  nonCurrent,
  completedStatements,
  completedLoading,
  archivedStatements,
  archivedLoading,
  onRestoreArchived,
  onDeleteArchived,
  onRefresh,
  onProcess,
}: {
  nonCurrent: NonCurrentStatements;
  completedStatements: InProgressStatement[];
  completedLoading: boolean;
  archivedStatements: { id: number; filename: string; bank_code: string; import_date: string; period_start?: string; period_end?: string; source: string; imported_by: string; target_system: string }[];
  archivedLoading: boolean;
  onRestoreArchived: (recordId: number) => void;
  onDeleteArchived?: (recordId: number) => void;
  onRefresh: () => void;
  onProcess?: (stmt: StatementEntry) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set()); // key: `${source}-${email_id}-${filename}`
  const [actionLoading, setActionLoading] = useState(false);
  const [actionResult, setActionResult] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const stmtKey = (s: StatementEntry) => `${s.source}-${s.email_id || ''}-${s.filename}`;

  const toggleSelect = (s: StatementEntry) => {
    const key = stmtKey(s);
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAll = (stmts: StatementEntry[]) => {
    setSelected(prev => {
      const next = new Set(prev);
      stmts.forEach(s => next.add(stmtKey(s)));
      return next;
    });
  };

  const allStatements = useMemo(() => [
    ...nonCurrent.already_processed,
    ...nonCurrent.old_statements,
    ...nonCurrent.not_classified,
  ], [nonCurrent]);

  const selectedStatements = useMemo(
    () => allStatements.filter(s => selected.has(stmtKey(s))),
    [allStatements, selected]
  );

  const handleAction = async (action: 'archive' | 'delete' | 'retain', stmts?: StatementEntry[]) => {
    const targets = stmts || selectedStatements;
    if (targets.length === 0) return;

    if (action === 'delete' && !confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setConfirmDelete(false);
    setActionLoading(true);
    setActionResult(null);
    try {
      const resp = await authFetch('/api/bank-import/manage-statements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          statements: targets.map(s => ({
            source: s.source,
            email_id: s.email_id,
            attachment_id: s.attachment_id,
            filename: s.filename,
            full_path: s.full_path,
            matched_bank_code: s.matched_bank_code,
            category: s.category,
          })),
        }),
      });
      const data = await resp.json();
      if (data.success) {
        setActionResult(data.message);
        setSelected(new Set());
        // Refresh scan after action
        setTimeout(() => onRefresh(), 500);
      } else {
        const failedDetails = (data.results || [])
          .filter((r: any) => !r.success)
          .map((r: any) => r.error || r.filename)
          .join(', ');
        setActionResult(`Error: ${data.error || data.message || failedDetails || 'Action failed'}`);
      }
    } catch (err: any) {
      setActionResult(`Error: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  const categories: { key: keyof NonCurrentStatements; label: string; description: string; color: string; actions: ('archive' | 'delete' | 'retain')[] }[] = [
    { key: 'already_processed', label: 'Already Processed', description: 'Opening balance is behind reconciled — these have already been imported', color: 'gray', actions: ['archive', 'delete'] },
    { key: 'old_statements', label: 'Old Statements', description: 'Multiple statement periods behind — both opening and closing are below reconciled balance', color: 'gray', actions: ['archive', 'delete'] },
    { key: 'not_classified', label: 'Not Classified', description: 'Cannot be matched to any Opera bank account by sort code and account number', color: 'amber', actions: ['delete', 'retain'] },
    { key: 'advanced', label: 'Advanced', description: 'Opening balance is ahead of reconciled — there may be a missing intermediate statement', color: 'purple', actions: [] },
  ];

  return (
    <div className="space-y-4">
      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 flex items-center justify-between sticky top-0 z-10">
          <span className="text-sm font-medium text-blue-800">{selected.size} selected</span>
          <div className="flex items-center gap-2">
            <button onClick={() => handleAction('archive')} disabled={actionLoading}
              className="px-3 py-1.5 text-xs font-medium bg-gray-600 text-white rounded hover:bg-gray-700 disabled:opacity-50 flex items-center gap-1">
              <Archive className="h-3 w-3" /> Archive Selected
            </button>
            {confirmDelete ? (
              <div className="flex items-center gap-1">
                <span className="text-xs text-red-700">Confirm delete?</span>
                <button onClick={() => handleAction('delete')} className="px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700">Yes</button>
                <button onClick={() => setConfirmDelete(false)} className="px-2 py-1 text-xs bg-gray-300 text-gray-700 rounded hover:bg-gray-400">No</button>
              </div>
            ) : (
              <button onClick={() => handleAction('delete')} disabled={actionLoading}
                className="px-3 py-1.5 text-xs font-medium bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50 flex items-center gap-1">
                <Trash2 className="h-3 w-3" /> Delete Selected
              </button>
            )}
            <button onClick={() => setSelected(new Set())} className="px-3 py-1.5 text-xs text-gray-600 hover:text-gray-800">
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Action result */}
      {actionResult && (
        <div className={`p-3 rounded-lg text-sm flex items-center justify-between ${
          actionResult.startsWith('Error') ? 'bg-red-50 border border-red-200 text-red-700' : 'bg-green-50 border border-green-200 text-green-700'
        }`}>
          <span>{actionResult}</span>
          <button onClick={() => setActionResult(null)} className="text-gray-400 hover:text-gray-600"><X className="h-4 w-4" /></button>
        </div>
      )}

      {/* Category sections */}
      {categories.map(cat => {
        const stmts = nonCurrent[cat.key];
        if (stmts.length === 0) return null;
        return (
          <CategorySection
            key={cat.key}
            label={cat.label}
            description={cat.description}
            color={cat.color}
            statements={stmts}
            actions={cat.actions}
            selected={selected}
            onToggleSelect={toggleSelect}
            onSelectAll={() => selectAll(stmts)}
            onAction={handleAction}
            actionLoading={actionLoading}
            onProcess={cat.key === 'already_processed' ? onProcess : undefined}
          />
        );
      })}

      {/* Completed / Reconciled Statements */}
      {completedLoading && (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-center">
          <RefreshCw className="h-5 w-5 text-gray-400 mx-auto mb-1 animate-spin" />
          <p className="text-gray-500 text-xs">Loading completed statements...</p>
        </div>
      )}
      {completedStatements.length > 0 && (
        <CompletedStatementsSection statements={completedStatements} />
      )}

      {/* Archived Statements */}
      {archivedLoading && (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-center">
          <RefreshCw className="h-5 w-5 text-gray-400 mx-auto mb-1 animate-spin" />
          <p className="text-gray-500 text-xs">Loading archived statements...</p>
        </div>
      )}
      {archivedStatements.length > 0 && (
        <ArchivedStatementsSection statements={archivedStatements} onRestore={onRestoreArchived} onDelete={onDeleteArchived} />
      )}

      {/* All empty */}
      {Object.values(nonCurrent).every(arr => arr.length === 0) && completedStatements.length === 0 && archivedStatements.length === 0 && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-6 text-center">
          <CheckCircle className="h-8 w-8 text-green-400 mx-auto mb-2" />
          <p className="text-green-700 text-sm font-medium">No statements to manage</p>
        </div>
      )}
    </div>
  );
}

// ---- Completed Statements Section ----

function CompletedStatementsSection({ statements: rawStatements }: { statements: InProgressStatement[] }) {
  const [expanded, setExpanded] = useState(false);

  // Backend returns sorted; just use as-is
  const statements = rawStatements;

  const formatBal = (val: number | undefined | null) => {
    if (val === null || val === undefined) return '—';
    return `£${val.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const formatDate = (dateStr: string | undefined) => {
    if (!dateStr) return '—';
    try {
      return new Date(dateStr).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch { return dateStr; }
  };

  return (
    <div className="border rounded-lg overflow-hidden bg-green-50 border-green-200">
      <button onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-white/30 transition-colors">
        <div className="flex items-center gap-2">
          {expanded ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
          <CheckCircle className="h-4 w-4 text-green-500" />
          <span className="text-sm font-medium text-gray-900">Completed</span>
          <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-green-200 text-green-800">
            {statements.length}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="bg-white">
          <p className="px-4 py-2 text-xs text-gray-500 border-t border-gray-100">Statements that have been imported and reconciled</p>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-xs text-gray-500 uppercase border-t border-gray-100">
                <th className="px-4 py-2 text-left font-medium">Filename</th>
                <th className="px-4 py-2 text-left font-medium">Bank</th>
                <th className="px-4 py-2 text-left font-medium">Date</th>
                <th className="px-4 py-2 text-right font-medium">Opening</th>
                <th className="px-4 py-2 text-right font-medium">Closing</th>
                <th className="px-4 py-2 text-right font-medium">Transactions</th>
                <th className="px-4 py-2 text-right font-medium">Reconciled</th>
              </tr>
            </thead>
            <tbody>
              {statements.map((stmt) => (
                <tr key={stmt.id} className="border-t border-gray-50 hover:bg-gray-50/50">
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-1.5">
                      <FileText className="h-3.5 w-3.5 text-green-400 flex-shrink-0" />
                      <span className="text-gray-800 font-medium truncate max-w-[220px]" title={stmt.filename}>{stmt.filename}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-600">
                    <span className="font-medium">{stmt.bank_code}</span>
                    {stmt.sort_code && (
                      <div className="text-[10px] text-gray-400 mt-0.5 font-mono">
                        {stmt.sort_code.replace(/(\d{2})(\d{2})(\d{2})/, '$1-$2-$3')}
                        {stmt.account_number && ` / ${stmt.account_number}`}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-600">{formatDate(stmt.statement_date || stmt.import_date)}</td>
                  <td className="px-4 py-2 text-right text-xs font-mono text-gray-700">{formatBal(stmt.opening_balance)}</td>
                  <td className="px-4 py-2 text-right text-xs font-mono text-gray-700">{formatBal(stmt.closing_balance)}</td>
                  <td className="px-4 py-2 text-right text-xs text-gray-600">{stmt.transactions_imported}</td>
                  <td className="px-4 py-2 text-right">
                    <span className="inline-flex items-center gap-1 text-xs text-green-600">
                      <CheckCircle className="h-3 w-3" /> {stmt.reconciled_count || 0}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- Archived Statements Section ----

function ArchivedStatementsSection({
  statements,
  onRestore,
  onDelete,
}: {
  statements: { id: number; filename: string; bank_code: string; import_date: string; period_start?: string; period_end?: string; source: string; imported_by: string; target_system: string }[];
  onRestore: (recordId: number) => void;
  onDelete?: (recordId: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [restoringId, setRestoringId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const formatDate = (dateStr: string | undefined) => {
    if (!dateStr) return '\u2014';
    try {
      return new Date(dateStr).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch { return dateStr; }
  };

  const handleRestore = (id: number) => {
    setRestoringId(id);
    onRestore(id);
    // Reset after a brief delay (parent will refresh the list)
    setTimeout(() => setRestoringId(null), 2000);
  };

  return (
    <div className="border rounded-lg overflow-hidden bg-gray-50 border-gray-200">
      <button onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-white/30 transition-colors">
        <div className="flex items-center gap-2">
          {expanded ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
          <Archive className="h-4 w-4 text-gray-400" />
          <span className="text-sm font-medium text-gray-900">Archived</span>
          <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-gray-200 text-gray-700">
            {statements.length}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="bg-white">
          <p className="px-4 py-2 text-xs text-gray-500 border-t border-gray-100">Statements that have been archived or deleted from active processing</p>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-xs text-gray-500 uppercase border-t border-gray-100">
                <th className="px-4 py-2 text-left font-medium">Filename</th>
                <th className="px-4 py-2 text-left font-medium">Bank</th>
                <th className="px-4 py-2 text-left font-medium">Archived Date</th>
                <th className="px-4 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {statements.map((stmt) => (
                <tr key={stmt.id} className="border-t border-gray-50 hover:bg-gray-50/50">
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-1.5">
                      <FileText className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
                      <span className="text-gray-800 font-medium truncate max-w-[220px]" title={stmt.filename}>{stmt.filename}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-600">
                    <span className="font-medium">{stmt.bank_code}</span>
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-600">{formatDate(stmt.import_date)}</td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={async () => {
                          try {
                            const resp = await authFetch(`/api/bank-import/archived-statement-pdf/${stmt.id}`);
                            const blob = await resp.blob();
                            const url = URL.createObjectURL(blob);
                            window.open(url, '_blank');
                          } catch (e) {
                            alert('Failed to open PDF');
                          }
                        }}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-gray-600 bg-gray-50 border border-gray-200 rounded hover:bg-gray-100"
                        title="View statement PDF"
                      >
                        <Eye className="h-3 w-3" /> View
                      </button>
                      <button
                        onClick={() => handleRestore(stmt.id)}
                        disabled={restoringId === stmt.id}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded hover:bg-blue-100 disabled:opacity-50"
                      >
                        <RotateCcw className={`h-3 w-3 ${restoringId === stmt.id ? 'animate-spin' : ''}`} />
                        {restoringId === stmt.id ? 'Restoring...' : 'Restore'}
                      </button>
                      {onDelete && (
                        confirmDeleteId === stmt.id ? (
                          <div className="flex items-center gap-1">
                            <span className="text-xs text-red-600 font-medium">Delete permanently?</span>
                            <button onClick={() => { onDelete(stmt.id); setConfirmDeleteId(null); }}
                              className="px-2 py-1 text-xs font-medium bg-red-600 text-white rounded hover:bg-red-700">Yes</button>
                            <button onClick={() => setConfirmDeleteId(null)}
                              className="px-2 py-1 text-xs font-medium bg-gray-300 text-gray-700 rounded hover:bg-gray-400">No</button>
                          </div>
                        ) : (
                          <button onClick={() => setConfirmDeleteId(stmt.id)}
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded hover:bg-red-100"
                            title="Permanently delete this statement">
                            <Trash2 className="h-3 w-3" /> Delete
                          </button>
                        )
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- Category Section ----

function CategorySection({
  label, description, color, statements, actions, selected, onToggleSelect, onSelectAll, onAction, actionLoading, onProcess,
}: {
  label: string;
  description: string;
  color: string;
  statements: StatementEntry[];
  actions: ('archive' | 'delete' | 'retain')[];
  selected: Set<string>;
  onToggleSelect: (s: StatementEntry) => void;
  onSelectAll: () => void;
  onAction: (action: 'archive' | 'delete' | 'retain', stmts: StatementEntry[]) => void;
  actionLoading: boolean;
  onProcess?: (stmt: StatementEntry) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const stmtKey = (s: StatementEntry) => `${s.source}-${s.email_id || ''}-${s.filename}`;

  const headerColors: Record<string, string> = {
    gray: 'bg-gray-50 border-gray-200',
    amber: 'bg-amber-50 border-amber-200',
    purple: 'bg-purple-50 border-purple-200',
  };

  const badgeColors: Record<string, string> = {
    gray: 'bg-gray-200 text-gray-700',
    amber: 'bg-amber-200 text-amber-800',
    purple: 'bg-purple-200 text-purple-800',
  };

  const formatBal = (val: number | undefined | null) => {
    if (val === null || val === undefined) return '—';
    return `£${val.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  return (
    <div className={`border rounded-lg overflow-hidden ${headerColors[color] || 'bg-gray-50 border-gray-200'}`}>
      <button onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-white/30 transition-colors">
        <div className="flex items-center gap-2">
          {expanded ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
          <span className="text-sm font-medium text-gray-900">{label}</span>
          <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${badgeColors[color] || 'bg-gray-200 text-gray-700'}`}>
            {statements.length}
          </span>
        </div>
        {actions.length > 0 && expanded && (
          <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
            <button onClick={onSelectAll} className="text-xs text-blue-600 hover:text-blue-800 mr-2">Select all</button>
            {actions.includes('archive') && (
              <button onClick={() => onAction('archive', statements)} disabled={actionLoading}
                className="px-2 py-1 text-xs bg-gray-500 text-white rounded hover:bg-gray-600 disabled:opacity-50">
                Archive All
              </button>
            )}
          </div>
        )}
      </button>

      {expanded && (
        <div className="bg-white">
          <p className="px-4 py-2 text-xs text-gray-500 border-t border-gray-100">{description}</p>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-xs text-gray-500 uppercase border-t border-gray-100">
                {actions.length > 0 && <th className="px-4 py-2 w-8"></th>}
                <th className="px-4 py-2 text-left font-medium">Filename</th>
                <th className="px-4 py-2 text-left font-medium">Source</th>
                <th className="px-4 py-2 text-left font-medium">Bank</th>
                <th className="px-4 py-2 text-right font-medium">Opening</th>
                <th className="px-4 py-2 text-right font-medium">Closing</th>
                <th className="px-4 py-2 text-right font-medium">Gap</th>
                {actions.length > 0 && <th className="px-4 py-2 text-right font-medium">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {statements.map((stmt, i) => (
                <tr key={i} className="border-t border-gray-50 hover:bg-gray-50/50">
                  {actions.length > 0 && (
                    <td className="px-4 py-2">
                      <input type="checkbox" checked={selected.has(stmtKey(stmt))}
                        onChange={() => onToggleSelect(stmt)}
                        className="rounded border-gray-300" />
                    </td>
                  )}
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-1.5">
                      <FileText className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
                      <span className="text-gray-800 font-medium truncate max-w-[220px]" title={stmt.filename}>{stmt.filename}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2">
                    {stmt.source === 'email' ? (
                      <span className="inline-flex items-center gap-1 text-xs text-purple-600"><Mail className="h-3 w-3" /> Email</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-green-600"><FolderOpen className="h-3 w-3" /> File</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-600">
                    {stmt.matched_bank_code ? (
                      <div>
                        <span className="font-medium">{stmt.matched_bank_code}</span>
                        <span className="text-gray-400 mx-1">—</span>
                        <span>{stmt.matched_bank_description}</span>
                        {(stmt.matched_sort_code || stmt.matched_account_number) && (
                          <div className="text-[10px] text-gray-400 mt-0.5 font-mono">
                            {stmt.matched_sort_code && `${stmt.matched_sort_code.replace(/(\d{2})(\d{2})(\d{2})/, '$1-$2-$3')}`}
                            {stmt.matched_sort_code && stmt.matched_account_number && ' / '}
                            {stmt.matched_account_number}
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right text-xs font-mono text-gray-700">{formatBal(stmt.opening_balance)}</td>
                  <td className="px-4 py-2 text-right text-xs font-mono text-gray-700">{formatBal(stmt.closing_balance)}</td>
                  <td className="px-4 py-2 text-right text-xs font-mono text-amber-600">
                    {stmt.balance_gap != null ? `£${stmt.balance_gap.toLocaleString('en-GB', { minimumFractionDigits: 2 })}` : '—'}
                  </td>
                  {actions.length > 0 && (
                    <td className="px-4 py-2 text-right">
                      <div className="flex items-center gap-1 justify-end">
                        {actions.includes('archive') && (
                          <button onClick={() => onAction('archive', [stmt])} disabled={actionLoading}
                            title="Archive" className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium text-gray-600 bg-gray-50 border border-gray-200 rounded-md hover:bg-gray-100 hover:border-gray-300 disabled:opacity-50 transition-colors">
                            <Archive className="h-3.5 w-3.5" /> Archive
                          </button>
                        )}
                        {actions.includes('delete') && (
                          <button onClick={() => onAction('delete', [stmt])} disabled={actionLoading}
                            title="Delete" className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-md hover:bg-red-100 hover:border-red-300 disabled:opacity-50 transition-colors">
                            <Trash2 className="h-3.5 w-3.5" /> Delete
                          </button>
                        )}
                        {actions.includes('retain') && (
                          <button onClick={() => onAction('retain', [stmt])} disabled={actionLoading}
                            title="Retain (keep but hide from scan)" className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium text-blue-600 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100 hover:border-blue-300 disabled:opacity-50 transition-colors">
                            <Eye className="h-3.5 w-3.5" /> Retain
                          </button>
                        )}
                        {onProcess && stmt.matched_bank_code && (
                          <button onClick={() => onProcess(stmt)}
                            className="px-2 py-1 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-700 flex items-center gap-1 ml-1"
                            title="Process & reconcile this statement">
                            Reconcile <ArrowRight className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- Bank Card ----

function BankCard({ bank, expanded, onToggle, onProcess, onReconcile, onDeleteStatement, onViewStatement, inProgressForBank, inProgressMap, orphanedStatements, onContinueImport, onClearStatement, onResumeReconcile }: {
  bank: BankGroup; expanded: boolean; onToggle: () => void; onProcess: (stmt: StatementEntry) => void; onReconcile: (stmt: StatementEntry) => void; onDeleteStatement?: (stmt: StatementEntry) => void; onViewStatement?: (stmt: StatementEntry) => void;
  inProgressForBank: InProgressStatement[]; inProgressMap: Map<string, InProgressStatement>; orphanedStatements: InProgressStatement[];
  onContinueImport: (stmt: InProgressStatement) => void; onClearStatement: (stmt: InProgressStatement) => void; onResumeReconcile: (stmt: InProgressStatement) => void;
}) {
  const readyCount = bank.statements.filter(s => (s.state ?? s.status) === 'ready').length;
  const awaitingReconcileCount = inProgressForBank.length;

  // Per-bank summary of outstanding deferred work
  const importedCount = bank.statements.filter(s => s.state === 'imported').length;
  const totalDeferred = bank.statements.reduce(
    (acc, s) => acc + ((s.state === 'imported') ? (s.deferred_count ?? 0) : 0),
    0,
  );

  const formatBal = (val: number | undefined | null) => {
    if (val === null || val === undefined) return '—';
    return `£${val.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <button onClick={onToggle}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors">
        <div className="flex items-center gap-3">
          {expanded ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
          <Landmark className="h-5 w-5 text-blue-600" />
          <div className="text-left">
            <div className="text-sm font-medium text-gray-900">
              {bank.description}
              <span className="text-gray-400 ml-2 font-normal">{bank.bank_code}</span>
            </div>
            <div className="text-xs text-gray-500">
              {bank.sort_code} / {bank.account_number}
              {bank.reconciled_balance !== null && (
                <span className="ml-2">
                  Reconciled: <span className="font-medium text-gray-700">£{bank.reconciled_balance.toLocaleString('en-GB', { minimumFractionDigits: 2 })}</span>
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {awaitingReconcileCount > 0 && (
            <span className="px-2 py-0.5 text-xs font-medium bg-orange-100 text-orange-700 rounded-full">
              {awaitingReconcileCount} awaiting reconcile
            </span>
          )}
          {readyCount > 0 && <span className="px-2 py-0.5 text-xs font-medium bg-blue-100 text-blue-700 rounded-full">{readyCount} ready</span>}
          <span className="text-xs text-gray-400">{bank.statement_count} statement{bank.statement_count !== 1 ? 's' : ''}</span>
        </div>
      </button>

      {bank.extraction_status === 'incomplete' && (() => {
        // Pull a representative error from the first failed/pending
        // statement so the operator knows WHY it's incomplete (key
        // invalid vs quota vs rate-limit). All failures from a single
        // scan are typically the same root cause.
        const firstWithError = bank.statements.find(
          s => (s.extraction_status === 'failed' || s.extraction_status === 'pending') && s.extraction_error
        );
        const reason = firstWithError?.extraction_error;
        const isPermanent = firstWithError?.extraction_status === 'failed';
        return (
          <div className={`px-4 py-2 border-t text-sm flex items-start gap-2 ${
            isPermanent
              ? 'bg-red-50 border-red-200 text-red-800'
              : 'bg-amber-50 border-amber-200 text-amber-800'
          }`}>
            <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <div className="flex flex-col gap-0.5">
              <span>
                <strong>{bank.statements_extracted ?? 0}</strong> of <strong>{bank.statements_total ?? 0}</strong> statements extracted.
                {!reason && ' Re-scan to complete (Gemini quota may need a minute or two to recover).'}
              </span>
              {reason && (
                <span className="text-xs">{reason}</span>
              )}
            </div>
          </div>
        );
      })()}

      {importedCount > 0 && (
        <div className="px-4 py-2 text-sm text-amber-700 bg-amber-50 border-t border-amber-100">
          {importedCount} statement{importedCount !== 1 ? 's' : ''} imported with deferred items, {totalDeferred} transaction{totalDeferred !== 1 ? 's' : ''} awaiting decision
        </div>
      )}

      {expanded && (
        <div className="border-t border-gray-100">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-xs text-gray-500 uppercase">
                <th className="px-4 py-2 text-left font-medium">#</th>
                <th className="px-4 py-2 text-left font-medium">Filename</th>
                <th className="px-4 py-2 text-left font-medium">Source</th>
                <th className="px-4 py-2 text-left font-medium">Period</th>
                <th className="px-4 py-2 text-right font-medium">Opening</th>
                <th className="px-4 py-2 text-right font-medium">Closing</th>
                <th className="px-4 py-2 text-center font-medium">Status</th>
                <th className="px-4 py-2 text-right font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {bank.statements.map((stmt, idx) => {
                const firstReadyIdx = bank.statements.findIndex(s => {
                  const eff = s.state ?? s.status;
                  return eff === 'ready' || eff === 'in_progress';
                });
                const isNextToProcess = idx === firstReadyIdx;
                const ipData = inProgressMap.get(`${bank.bank_code}::${stmt.filename}`);
                return (
                  <StatementRow key={idx} stmt={stmt} isNext={isNextToProcess} onProcess={() => onProcess(stmt)}
                    onReconcile={stmt.status === 'imported' ? () => onReconcile(stmt) : undefined}
                    onDelete={onDeleteStatement ? () => onDeleteStatement(stmt) : undefined}
                    onView={onViewStatement ? () => onViewStatement(stmt) : undefined}
                    inProgressData={ipData} onContinueImport={onContinueImport} onClearStatement={onClearStatement} onResumeReconcile={onResumeReconcile}
                    bankExtractionComplete={bank.extraction_status !== 'incomplete'} />
                );
              })}
              {/* Orphaned in-progress rows (imported but not in scan results for this bank) */}
              {orphanedStatements.map(ip => (
                <tr key={`orphan-${ip.id}`} className="border-t border-orange-100 bg-orange-50/30 hover:bg-orange-50/60 transition-colors">
                  <td className="px-4 py-2 text-gray-400 text-xs">—</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-1.5">
                      <FileText className="h-3.5 w-3.5 text-orange-400 flex-shrink-0" />
                      <span className="text-gray-800 font-medium truncate max-w-[250px]" title={ip.filename}>{ip.filename}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2">
                    <span className="inline-flex items-center gap-1 text-xs text-gray-500">{ip.source === 'email' ? 'Email' : 'File'}</span>
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-600">{ip.statement_date || '—'}</td>
                  <td className="px-4 py-2 text-right text-xs font-mono text-gray-700">{formatBal(ip.opening_balance)}</td>
                  <td className="px-4 py-2 text-right text-xs font-mono text-gray-700">{formatBal(ip.closing_balance)}</td>
                  <td className="px-4 py-2 text-center">
                    {(ip.reconciled_count || 0) > 0
                      ? <span className="px-2 py-0.5 text-xs font-medium bg-purple-100 text-purple-700 rounded-full" title={`${ip.reconciled_count} entries reconciled — complete in Opera`}>Partially Reconciled</span>
                      : <span className="px-2 py-0.5 text-xs font-medium bg-orange-100 text-orange-700 rounded-full">Awaiting Reconcile</span>
                    }
                    {ip.transactions_imported < ip.stored_transaction_count && (
                      <div className="text-[10px] text-orange-600 mt-0.5">{ip.transactions_imported}/{ip.stored_transaction_count} posted</div>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex items-center gap-1.5 justify-end">
                      <button onClick={() => onClearStatement(ip)}
                        className="px-2.5 py-1 text-xs font-medium bg-gray-500 text-white rounded hover:bg-gray-600"
                        title="Clear import tracking data and start over">Clear</button>
                      {ip.transactions_imported < ip.stored_transaction_count && (
                        <button onClick={() => onContinueImport(ip)}
                          className="px-2.5 py-1 text-xs font-medium bg-orange-600 text-white rounded hover:bg-orange-700 flex items-center gap-1"
                          title={`${ip.stored_transaction_count - ip.transactions_imported} lines not yet posted to Opera`}>
                          Continue Import <ArrowRight className="h-3 w-3" />
                        </button>
                      )}
                      <button onClick={() => onResumeReconcile(ip)}
                        className="px-2.5 py-1 text-xs font-medium bg-green-600 text-white rounded hover:bg-green-700 flex items-center gap-1">
                        Reconcile <ArrowRight className="h-3 w-3" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- Orphaned Bank Card (in-progress only, no scan results) ----

function OrphanedBankCard({ bankCode, statements, onContinueImport, onClearStatement, onResumeReconcile }: {
  bankCode: string; statements: InProgressStatement[];
  onContinueImport: (stmt: InProgressStatement) => void; onClearStatement: (stmt: InProgressStatement) => void; onResumeReconcile: (stmt: InProgressStatement) => void;
}) {
  const formatBal = (val: number | undefined | null) => {
    if (val === null || val === undefined) return '—';
    return `£${val.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  return (
    <div className="bg-white border border-orange-200 rounded-xl overflow-hidden">
      <div className="px-4 py-3 bg-orange-50 flex items-center gap-3">
        <Landmark className="h-5 w-5 text-orange-600" />
        <div className="text-left">
          <div className="text-sm font-medium text-gray-900">{bankCode}</div>
          <div className="text-xs text-orange-600">Imported statements only (not in current scan)</div>
        </div>
        <span className="ml-auto px-2 py-0.5 text-xs font-medium bg-orange-100 text-orange-700 rounded-full">
          {statements.length} awaiting reconcile
        </span>
      </div>
      <div className="border-t border-orange-100">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-xs text-gray-500 uppercase">
              <th className="px-4 py-2 text-left font-medium">Filename</th>
              <th className="px-4 py-2 text-left font-medium">Source</th>
              <th className="px-4 py-2 text-left font-medium">Date</th>
              <th className="px-4 py-2 text-right font-medium">Opening</th>
              <th className="px-4 py-2 text-right font-medium">Closing</th>
              <th className="px-4 py-2 text-center font-medium">Status</th>
              <th className="px-4 py-2 text-right font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {statements.map(ip => (
              <tr key={ip.id} className="border-t border-gray-50 hover:bg-orange-50/30 transition-colors">
                <td className="px-4 py-2">
                  <div className="flex items-center gap-1.5">
                    <FileText className="h-3.5 w-3.5 text-orange-400 flex-shrink-0" />
                    <span className="text-gray-800 font-medium truncate max-w-[250px]" title={ip.filename}>{ip.filename}</span>
                  </div>
                </td>
                <td className="px-4 py-2">
                  <span className="inline-flex items-center gap-1 text-xs text-gray-500">{ip.source === 'email' ? 'Email' : 'File'}</span>
                </td>
                <td className="px-4 py-2 text-xs text-gray-600">{ip.statement_date || '—'}</td>
                <td className="px-4 py-2 text-right text-xs font-mono text-gray-700">{formatBal(ip.opening_balance)}</td>
                <td className="px-4 py-2 text-right text-xs font-mono text-gray-700">{formatBal(ip.closing_balance)}</td>
                <td className="px-4 py-2 text-center">
                  {(ip.reconciled_count || 0) > 0
                    ? <span className="px-2 py-0.5 text-xs font-medium bg-purple-100 text-purple-700 rounded-full" title={`${ip.reconciled_count} entries reconciled — complete in Opera`}>Partially Reconciled</span>
                    : <span className="px-2 py-0.5 text-xs font-medium bg-orange-100 text-orange-700 rounded-full">Awaiting Reconcile</span>
                  }
                  {ip.transactions_imported < ip.stored_transaction_count && (
                    <div className="text-[10px] text-orange-600 mt-0.5">{ip.transactions_imported}/{ip.stored_transaction_count} posted</div>
                  )}
                </td>
                <td className="px-4 py-2 text-right">
                  <div className="flex items-center gap-1.5 justify-end">
                    <button onClick={() => onClearStatement(ip)}
                      className="px-2.5 py-1 text-xs font-medium bg-gray-500 text-white rounded hover:bg-gray-600"
                      title="Clear import tracking data and start over">Clear</button>
                    {ip.transactions_imported < ip.stored_transaction_count && (
                      <button onClick={() => onContinueImport(ip)}
                        className="px-2.5 py-1 text-xs font-medium bg-orange-600 text-white rounded hover:bg-orange-700 flex items-center gap-1"
                        title={`${ip.stored_transaction_count - ip.transactions_imported} lines not yet posted to Opera`}>
                        Continue Import <ArrowRight className="h-3 w-3" />
                      </button>
                    )}
                    <button onClick={() => onResumeReconcile(ip)}
                      className="px-2.5 py-1 text-xs font-medium bg-green-600 text-white rounded hover:bg-green-700 flex items-center gap-1">
                      Reconcile <ArrowRight className="h-3 w-3" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- Statement Row ----

function StatementRow({ stmt, isNext, onProcess, onReconcile, onDelete, onView, inProgressData, onContinueImport, onClearStatement, onResumeReconcile, bankExtractionComplete }: {
  stmt: StatementEntry; isNext: boolean; onProcess: () => void; onReconcile?: () => void; onDelete?: () => void; onView?: () => void;
  inProgressData?: InProgressStatement; onContinueImport?: (stmt: InProgressStatement) => void;
  onClearStatement?: (stmt: InProgressStatement) => void; onResumeReconcile?: (stmt: InProgressStatement) => void;
  bankExtractionComplete?: boolean;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Process button stays available while there's anything not yet posted to
  // Opera — including deferred rows. Deferred is a pending decision, not a
  // resolved one: the operator may want to re-run Analyse later to pick up
  // a previously-deferred row that's since been entered in Opera.
  const hasPartialImport = inProgressData
    && inProgressData.transactions_imported < inProgressData.stored_transaction_count;
  const isImportedWithData = stmt.status === 'imported' && inProgressData;

  const hasPartialReconcile = inProgressData && (inProgressData.reconciled_count || 0) > 0;

  // Relative-time formatter for extraction_attempted_at — gives the
  // operator "tried 3 min ago" instead of a static failed badge, so
  // they can tell whether the breaker has had time to re-test.
  const formatAttemptedAt = (iso?: string | null): string => {
    if (!iso) return '';
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return '';
    const deltaSec = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (deltaSec < 60) return `${deltaSec}s ago`;
    if (deltaSec < 3600) return `${Math.round(deltaSec / 60)} min ago`;
    if (deltaSec < 86400) return `${Math.round(deltaSec / 3600)}h ago`;
    return `${Math.round(deltaSec / 86400)}d ago`;
  };

  const statusBadge = useMemo(() => {
    // Extraction-level failure trumps the generic status badge — this
    // is what the operator needs to act on (rotate key, retry later).
    if (stmt.extraction_status === 'failed') {
      const tooltip = [
        stmt.extraction_error ?? 'Extraction failed',
        stmt.extraction_attempted_at
          ? `Last tried ${formatAttemptedAt(stmt.extraction_attempted_at)}`
          : null,
      ].filter(Boolean).join(' — ');
      return (
        <span
          className="px-2 py-0.5 text-xs font-medium bg-red-100 text-red-800 rounded-full cursor-help"
          title={tooltip}>
          Failed
        </span>
      );
    }
    if (stmt.extraction_status === 'pending') {
      const tooltip = [
        stmt.extraction_error ?? 'Retry queued',
        stmt.extraction_attempted_at
          ? `Last tried ${formatAttemptedAt(stmt.extraction_attempted_at)}`
          : null,
      ].filter(Boolean).join(' — ');
      return (
        <span
          className="px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-800 rounded-full cursor-help"
          title={tooltip}>
          Retrying
        </span>
      );
    }
    switch (stmt.status) {
      case 'ready':
        return <span className="px-2 py-0.5 text-xs font-medium bg-blue-100 text-blue-700 rounded-full">Ready</span>;
      case 'imported':
        if (hasPartialReconcile) {
          return <span className="px-2 py-0.5 text-xs font-medium bg-purple-100 text-purple-700 rounded-full" title={`${inProgressData!.reconciled_count} entries reconciled — complete in Opera`}>Partially Reconciled</span>;
        }
        return <span className="px-2 py-0.5 text-xs font-medium bg-orange-100 text-orange-700 rounded-full" title="Imported but not yet reconciled">Awaiting Reconcile</span>;
      case 'uncached':
        return <span className="px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-500 rounded-full">Uncached</span>;
      case 'pending_extraction':
        if (stmt.extraction_failure_reason === 'extraction_error') {
          return null;
        }
        return <span className="px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-800 rounded-full">Pending</span>;
      default:
        return <span className="px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-500 rounded-full">Pending</span>;
    }
  }, [stmt.status, stmt.extraction_status, stmt.extraction_error, stmt.extraction_attempted_at, stmt.extraction_failure_reason, hasPartialReconcile, inProgressData]);

  const formatBal = (val: number | undefined | null) => {
    if (val === null || val === undefined) return '—';
    return `£${val.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const formatPeriod = () => {
    if (stmt.period_start && stmt.period_end) return `${stmt.period_start} → ${stmt.period_end}`;
    if (stmt.period_end) return stmt.period_end;
    if (stmt.statement_date) return stmt.statement_date;
    return '—';
  };

  const effectiveState = stmt.state ?? stmt.status;
  // Process button enables on the next-in-sequence statement that is either fresh
  // ('ready') or has a saved draft ('in_progress') — clicking Process auto-resumes
  // the draft, so it must not be greyed out just because the user previously
  // started work on this statement.
  const canProcess = (bankExtractionComplete !== false)
    && (effectiveState === 'ready' || effectiveState === 'in_progress')
    && isNext;

  return (
    <tr className={`border-t border-gray-50 transition-colors ${
      isNext ? 'bg-blue-50/50 hover:bg-blue-50' : isImportedWithData ? 'bg-orange-50/20 hover:bg-orange-50/40' : 'hover:bg-blue-50/30'
    } ${effectiveState === 'ready' && !isNext ? 'opacity-60' : ''}`}>
      <td className="px-4 py-2 text-gray-400 text-xs">{stmt.import_sequence}</td>
      <td className="px-4 py-2">
        <div className="flex items-center gap-1.5">
          <FileText className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
          <span className="text-gray-800 font-medium truncate max-w-[250px]" title={stmt.filename}>{stmt.filename}</span>
          {onView && (
            <button onClick={onView}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100 hover:border-blue-300 transition-colors flex-shrink-0"
              title="View statement PDF">
              <Eye className="h-3.5 w-3.5" />
              View
            </button>
          )}
        </div>
      </td>
      <td className="px-4 py-2">
        {stmt.source === 'email' ? (
          <span className="inline-flex items-center gap-1 text-xs text-purple-600"><Mail className="h-3 w-3" /> Email</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-green-600"><FolderOpen className="h-3 w-3" /> File</span>
        )}
      </td>
      <td className="px-4 py-2 text-xs text-gray-600">{formatPeriod()}</td>
      <td className="px-4 py-2 text-right text-xs font-mono text-gray-700">{formatBal(stmt.opening_balance)}</td>
      <td className="px-4 py-2 text-right text-xs font-mono text-gray-700">{formatBal(stmt.closing_balance)}</td>
      <td className="px-4 py-2 text-center">
        <div className="flex flex-col items-center gap-0.5">
          <div className="flex items-center justify-center gap-1 flex-wrap">
            {statusBadge}
            {isNext && effectiveState === 'ready' && (
              <span className="px-2 py-0.5 text-xs font-medium bg-blue-600 text-white rounded-full">Next</span>
            )}
            {stmt.extraction_failure_reason === 'extraction_error' && (
              <span className="px-2 py-0.5 text-xs font-medium bg-red-100 text-red-800 rounded-full">Failed</span>
            )}
            {stmt.state === 'imported' && (stmt.deferred_count ?? 0) > 0 && (
              <span className="px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-800 rounded-full inline-flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Imported · {stmt.deferred_count} deferred
              </span>
            )}
          </div>
          {isImportedWithData && hasPartialImport && (
            <span className="text-[10px] text-orange-600">{inProgressData.transactions_imported}/{inProgressData.stored_transaction_count} posted</span>
          )}
          {(stmt.extraction_status === 'failed' || stmt.extraction_status === 'pending') && stmt.extraction_error && (
            <span
              className={`text-[10px] max-w-[240px] truncate ${
                stmt.extraction_status === 'failed' ? 'text-red-600' : 'text-amber-700'
              }`}
              title={stmt.extraction_error}>
              {stmt.extraction_error}
            </span>
          )}
        </div>
      </td>
      <td className="px-4 py-2 text-right">
        <div className="flex items-center gap-1.5 justify-end">
          {isImportedWithData ? (
            // ONE button only — pick the next action in the workflow:
            //   - hasPartialImport (some rows still need posting)        → Process
            //   - everything imported, awaiting Stage 4 reconciliation   → Reconcile
            // Never both. Operator's mental model: one clear next step.
            hasPartialImport && onContinueImport ? (
              <button onClick={() => onContinueImport(inProgressData)}
                className="px-3 py-1 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-700 flex items-center gap-1">
                Process <ArrowRight className="h-3 w-3" />
              </button>
            ) : onResumeReconcile ? (
              <button onClick={() => onResumeReconcile(inProgressData)}
                className="px-3 py-1 text-xs font-medium bg-green-600 text-white rounded hover:bg-green-700 flex items-center gap-1">
                Reconcile <ArrowRight className="h-3 w-3" />
              </button>
            ) : null
          ) : onReconcile ? (
            <button onClick={onReconcile}
              className="px-3 py-1 text-xs font-medium bg-green-600 text-white rounded hover:bg-green-700 flex items-center gap-1">
              Reconcile <ArrowRight className="h-3 w-3" />
            </button>
          ) : (
            <button onClick={onProcess} disabled={!canProcess}
              className={`px-3 py-1 text-xs font-medium text-white rounded flex items-center gap-1 ${
                canProcess ? 'bg-blue-600 hover:bg-blue-700' : 'bg-gray-400 cursor-not-allowed opacity-40'
              }`}
              title={effectiveState === 'ready' && !isNext ? 'Import previous statements first' : ''}>
              Process <ArrowRight className="h-3 w-3" />
            </button>
          )}
          {onDelete && (
            confirmingDelete ? (
              <div className="flex items-center gap-1">
                <span className="text-xs text-amber-700 font-medium">Archive?</span>
                <button onClick={() => { onDelete(); setConfirmingDelete(false); }}
                  className="px-2 py-1 text-xs font-medium bg-amber-600 text-white rounded hover:bg-amber-700">Yes</button>
                <button onClick={() => setConfirmingDelete(false)}
                  className="px-2 py-1 text-xs font-medium bg-gray-300 text-gray-700 rounded hover:bg-gray-400">No</button>
              </div>
            ) : (
              <button onClick={() => setConfirmingDelete(true)}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-md hover:bg-amber-100 hover:border-amber-300 transition-colors"
                title="Archive statement — moves to archive folder, can be restored later">
                <Archive className="h-3.5 w-3.5" /> Archive
              </button>
            )
          )}
        </div>
      </td>
    </tr>
  );
}

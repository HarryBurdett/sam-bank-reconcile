import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle,
  RefreshCw,
  Landmark,
  CheckSquare,
  Square,
  ArrowUpDown,
  Search,
  Upload,
  FileText,
  AlertCircle,
  Check,
  X,
  FolderOpen,
  ChevronDown,
  ChevronRight,
  Plus,
  HelpCircle,
  XCircle,
  Archive,
  RotateCcw,
  Clock,
} from 'lucide-react';
import apiClient, { authFetch, friendlyError } from './api-shim';

// SAM port shims — replace react-router-dom and VoiceContext with the
// minimum the page needs.
function useSearchParams(): [URLSearchParams] {
  if (typeof window === 'undefined') return [new URLSearchParams()];
  return [new URLSearchParams(window.location.search)];
}
type VoiceCommand = unknown;
function useVoice() {
  return {
    registerCommands: (_cmds: VoiceCommand[]) => () => undefined,
  };
}

// Types previously imported from frontend/src/api/client. Inline here
// because SAM plugins live outside the legacy frontend package — kept
// permissive (Record<string, unknown>) where the response shape is
// only weakly typed in the original.
interface BankAccountsResponse {
  banks: Array<{
    nk_acnt: string;
    nk_desc: string;
    nk_curbal?: number;
    nk_recbal?: number;
    nk_lstrec?: string;
    nk_lstno?: number;
    account_code?: string;
    description?: string;
    [key: string]: unknown;
  }>;
}
interface BankReconciliationStatusResponse {
  reconciled_balance: number;
  current_balance: number;
  last_statement_number: number | null;
  last_reconciliation_date: string | null;
  total_unreconciled: number;
  unreconciled_count: number;
  reconciliation_in_progress?: boolean;
  reconciliation_in_progress_message?: string;
  partial_entries?: number;
  last_stmt_no?: number | null;
  [key: string]: unknown;
}
interface UnreconciledEntriesResponse {
  entries: Array<{
    ae_entry: string;
    ae_entref?: string;
    ae_unique?: string;
    ae_lstdate: string;
    ae_ref: string;
    ae_detail: string;
    ae_comment?: string;
    ae_cbtype?: string;
    value_pounds: number;
    at_type?: number;
    at_account?: string;
    is_match_candidate?: boolean;
    [key: string]: unknown;
  }>;
  count?: number;
}
interface MarkReconciledResponse {
  success: boolean;
  reconciled_count?: number;
  error?: string;
  message?: string;
  [key: string]: unknown;
}
interface ArchiveLogEntry {
  id: number;
  archived_at: string;
  original_path: string;
  archive_path: string;
  import_type: string;
  filename: string;
  metadata?: Record<string, unknown>;
  restored_at?: string | null;
  restored_to?: string | null;
}

interface BankValidation {
  valid: boolean;
  match_type?: string;
  error?: string;
  opera_bank?: {
    code: string;
    description: string;
    sort_code: string;
    account_number: string;
  };
  suggested_bank?: {
    bank_code: string;
    description: string;
  };
}

interface StatementMatch {
  statement_txn: {
    date: string;
    description: string;
    amount: number;
    balance: number | null;
    type: string | null;
  };
  opera_entry: {
    ae_entry: string;
    ae_date: string;
    ae_ref: string;
    value_pounds: number;
    ae_detail: string;
  };
  match_score: number;
  match_reasons: string[];
}

interface StatementTransaction {
  date: string;
  description: string;
  amount: number;
  balance: number | null;
  type: string | null;
}

interface ProcessStatementResponse {
  success: boolean;
  error?: string;
  status?: 'skipped' | 'pending';  // Statement sequence status
  reason?: 'already_processed' | 'missing_statement';
  reconciled_balance?: number;
  missing_statement_balance?: number;
  message?: string;
  bank_code?: string;
  bank_validation?: BankValidation;
  statement_info?: {
    bank_name: string;
    account_number: string;
    sort_code: string | null;
    statement_date: string | null;
    period_start: string | null;
    period_end: string | null;
    opening_balance: number | null;
    closing_balance: number | null;
  };
  // Opera reconciliation status - reliable data from Opera
  opera_status?: {
    reconciled_balance: number | null;
    current_balance: number | null;
    last_statement_number: number | null;
    last_reconciliation_date: string | null;
  };
  extracted_transactions?: number;
  opera_unreconciled?: number;
  matches?: StatementMatch[];
  unmatched_statement?: StatementTransaction[];
  unmatched_opera?: {
    ae_entry: string;
    ae_date: string;
    ae_ref: string;
    value_pounds: number;
    ae_detail: string;
  }[];
}


// New interfaces for enhanced auto-reconciliation
interface StatementValidationResult {
  valid: boolean;
  expected_opening?: number;
  statement_opening?: number;
  statement_closing?: number;
  difference?: number;
  opening_matches?: boolean;
  next_statement_number?: number;
  error_message?: string;
}

interface MatchedEntry {
  statement_line: number;
  statement_date: string | null;
  statement_amount: number;
  statement_reference: string;
  statement_description: string;
  statement_balance: number | null;
  entry_number: string;
  entry_date: string;
  entry_amount: number;
  entry_reference: string;
  entry_description: string;
  confidence: number;
}

interface UnmatchedStatementLine {
  statement_line: number;
  statement_date: string | null;
  statement_amount: number;
  statement_reference: string;
  statement_description: string;
  statement_balance: number | null;
  // Auto-match fields
  matched_account?: string;
  matched_name?: string;
  match_method?: string;
  suggested_type?: 'customer' | 'supplier';
}

interface UnmatchedCashbookEntry {
  entry_number: string;
  entry_date: string;
  entry_amount: number;
  entry_reference: string;
  entry_description: string;
}

interface MatchingResult {
  success: boolean;
  auto_matched: MatchedEntry[];
  suggested_matched: MatchedEntry[];
  // Statement lines that match an aentry already reconciled in Opera
  // (ae_reclnum > 0). They're 'done' from Opera's perspective — the UI
  // should render them as ✓ (no further action needed) rather than as
  // unmatched, which is the same render as 'this needs new work'.
  already_reconciled?: MatchedEntry[];
  unmatched_statement: UnmatchedStatementLine[];
  unmatched_cashbook: UnmatchedCashbookEntry[];
  summary: {
    total_statement_lines: number;
    auto_matched_count: number;
    suggested_matched_count: number;
    already_reconciled_count?: number;
    unmatched_statement_count: number;
    unmatched_cashbook_count: number;
  };
  error?: string;
}

interface StatementFile {
  path: string;
  filename: string;
  folder: string;
  size: number;
  size_formatted: string;
  modified: string;
  modified_formatted: string;
  // Import status
  is_imported: boolean;
  import_date?: string;
  import_bank?: string;
  transactions_imported?: number;
  // Reconciliation status
  is_reconciled: boolean;
  reconciled_date?: string;
  reconciled_count?: number;
}

interface StatementFilesResponse {
  success: boolean;
  files: StatementFile[];
  count: number;
  imported_count: number;
  reconciled_count: number;
  error?: string;
}

// Imported statements awaiting reconciliation
interface ImportedStatement {
  id: number;
  filename: string;
  bank_code: string;
  source: 'email' | 'file';
  transactions_imported: number;
  total_receipts: number;
  total_payments: number;
  import_date: string;
  imported_by: string;
  target_system: string;
  email_id?: number;
  attachment_id?: number;
  is_reconciled: boolean;
  reconciled_date?: string;
  reconciled_count: number;
  opening_balance?: number;
  closing_balance?: number;
  statement_date?: string;
  account_number?: string;
  sort_code?: string;
  stored_transaction_count?: number;
  email_subject?: string;
  email_date?: string;
  email_from?: string;
}

interface ImportedStatementsResponse {
  success: boolean;
  statements: ImportedStatement[];
  count: number;
  error?: string;
}

export interface BankStatementReconcileProps {
  initialReconcileData?: {
    bank_code: string;
    statement_transactions: any[];
    statement_info: any;
    source: string;
    filename?: string;
    import_id?: number;
  } | null;
  resumeImportId?: number;
  resumeStatement?: {
    id: number;
    bank_code: string;
    filename: string;
    source: string;
    opening_balance?: number;
    closing_balance?: number;
    statement_date?: string;
  };
  onReconcileComplete?: () => void;
}

export function BankStatementReconcile({ initialReconcileData = null, resumeImportId, resumeStatement, onReconcileComplete }: BankStatementReconcileProps = {}) {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();

  // Fetch current company for storage key isolation
  const { data: companiesData } = useQuery({
    queryKey: ['companies'],
    queryFn: async () => {
      const res = await authFetch('/api/companies');
      return res.json();
    },
  });
  const currentCompanyId = companiesData?.current_company?.id || '';

  // Storage key builder - includes company ID for isolation between companies
  const storageKey = (base: string, bank?: string) => {
    const prefix = currentCompanyId ? `${currentCompanyId}_` : '';
    return bank ? `${base}_${prefix}${bank}` : `${base}_${prefix}`.replace(/_$/, '');
  };

  // Get bank from URL parameter if provided (e.g., from post-import redirect)
  const urlBank = searchParams.get('bank');


  const [selectedBank, setSelectedBank] = useState<string>(urlBank || initialReconcileData?.bank_code || '');
  const [selectedEntries, setSelectedEntries] = useState<Set<string>>(new Set());
  const [statementNumber, setStatementNumber] = useState<string>('');
  const [statementDate, setStatementDate] = useState<string>(
    new Date().toISOString().split('T')[0]
  );
  const [statementBalance, setStatementBalance] = useState<string>('0.00');
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [sortField, setSortField] = useState<'ae_entry' | 'value_pounds' | 'ae_lstdate'>('ae_lstdate');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  // Enhanced auto-reconciliation state - load from sessionStorage if available
  const [validationResult, setValidationResult] = useState<StatementValidationResult | null>(() => {
    try {
      const saved = sessionStorage.getItem(storageKey('validationResult', urlBank || ''));
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });
  const [matchingResult, setMatchingResult] = useState<MatchingResult | null>(() => {
    try {
      const saved = sessionStorage.getItem(storageKey('matchingResult', urlBank || ''));
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });
  // Store selections by ENTRY NUMBER (not index) so they survive data refreshes
  const [selectedAutoMatches, setSelectedAutoMatches] = useState<Set<string>>(new Set());
  const [selectedSuggestedMatches, setSelectedSuggestedMatches] = useState<Set<string>>(new Set());
  // Manual match overrides on the reconcile screen (line_number -> true=force matched, false=force unmatched)
  const [manualMatchOverrides, setManualMatchOverrides] = useState<Map<number, boolean>>(new Map());
  const [isValidating, setIsValidating] = useState(false);
  const [openingBalance, setOpeningBalance] = useState<string>('');
  const [closingBalance, setClosingBalance] = useState<string>('');
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Ignore transaction state (declared early — referenced in voice command useEffect)
  const [ignoreConfirm, setIgnoreConfirm] = useState<{
    date: string;
    description: string;
    amount: number;
  } | null>(null);
  const [isIgnoring, setIsIgnoring] = useState(false);

  // Custom dialog state (replaces native alert/confirm)
  const [dialogState, setDialogState] = useState<{
    open: boolean;
    title: string;
    message: string;
    type: 'info' | 'confirm' | 'success' | 'warning' | 'error';
    onConfirm?: () => void;
    confirmLabel?: string;
    cancelLabel?: string;
  }>({ open: false, title: '', message: '', type: 'info' });

  const showDialog = (opts: {
    title: string;
    message: string;
    type?: 'info' | 'confirm' | 'success' | 'warning' | 'error';
    onConfirm?: () => void;
    confirmLabel?: string;
    cancelLabel?: string;
  }) => {
    setDialogState({ open: true, type: 'info', ...opts });
  };

  const closeDialog = () => setDialogState(prev => ({ ...prev, open: false }));

  // Create entry modal state
  const [createEntryModal, setCreateEntryModal] = useState<{
    open: boolean;
    statementLine: UnmatchedStatementLine | null;
  }>({ open: false, statementLine: null });
  const [newEntryForm, setNewEntryForm] = useState({
    accountCode: '',
    accountType: 'nominal' as 'customer' | 'supplier' | 'nominal' | 'bank_transfer',
    nominalCode: '',
    reference: '',
    description: '',
    destBank: '',
    projectCode: '',
    departmentCode: '',
  });

  const [isCreatingEntry, setIsCreatingEntry] = useState(false);
  const [isReconciling, setIsReconciling] = useState(false);
  const [showAllTransactions, setShowAllTransactions] = useState(false);

  // Categorized import selection for unmatched statement lines
  const [selectedForImport, setSelectedForImport] = useState<Set<number>>(new Set());
  const [deferredLines, setDeferredLines] = useState<Set<number>>(new Set());
  const [enrichedUnmatched, setEnrichedUnmatched] = useState<UnmatchedStatementLine[]>([]);

  // (deferred-items effects defined further down — they reference
  // `deferredItemsQuery` and `matchingResult` which need to be declared
  // first to avoid a temporal-dead-zone ReferenceError on mount.)

  const [isBatchImporting, setIsBatchImporting] = useState(false);
  const [batchImportProgress, setBatchImportProgress] = useState<{
    total: number;
    completed: number;
    errors: string[];
  } | null>(null);

  // Balance mismatch detection - warns if Opera reconciled balance doesn't match statement opening balance
  const [balanceMismatch, setBalanceMismatch] = useState<{
    operaBalance: number;
    statementBalance: number;
  } | null>(null);
  const [balanceMismatchAcknowledged, setBalanceMismatchAcknowledged] = useState(false);

  // Reconciliation completion confirmation state (Task 2: show success before navigating back)
  const [reconcileCompleteInfo, setReconcileCompleteInfo] = useState<{
    entriesReconciled: number;
    closingBalance: number | null;
    isPartial: boolean;
    closingBalanceMismatch?: { expected: number; actual: number } | null;
  } | null>(null);

  // Reverse-rec modal state (audit 2026-05-05 stages-3-5 F10).
  // Operator surfaces a way to undo a rec batch they just made.
  // Calls the existing /api/reconcile/bank/{bank_code}/unreconcile
  // endpoint with the entry numbers from the just-completed rec.
  const [reverseModalOpen, setReverseModalOpen] = useState(false);
  const [reverseInProgress, setReverseInProgress] = useState(false);
  const [reverseError, setReverseError] = useState<string | null>(null);
  const [recentlyReconciledEntries, setRecentlyReconciledEntries] = useState<string[]>([]);

  // Partial update success indicator — shows confirmation without clearing the view
  const [lastPartialUpdateInfo, setLastPartialUpdateInfo] = useState<{
    timestamp: string;
    entriesReconciled: number;
  } | null>(null);

  // Statement data passed from Imports page (via sessionStorage) after import
  // Contains the real PDF-extracted transactions for matching
  const [importedStatementData, setImportedStatementData] = useState<{
    bank_code: string;
    statement_transactions: Array<{
      line_number: number;
      date: string;
      description: string;
      amount: number;
      balance: number | null;
      transaction_type: string;
      reference: string;
      posted_entry_number?: string | null;
    }>;
    statement_info: {
      bank_name?: string;
      account_number?: string;
      sort_code?: string;
      opening_balance?: number;
      closing_balance?: number;
      period_start?: string;
      period_end?: string;
      statement_date?: string;
    } | null;
    source: string;
    filename?: string;
    import_id?: number;
  } | null>(null);

  // Flag to auto-run matching after resume load completes validation
  const [pendingAutoMatch, setPendingAutoMatch] = useState(false);

  // Build lookup of posted lines (line_number -> entry_number) for partial recovery display
  const postedLines = useMemo(() => {
    const map = new Map<number, string>();
    if (importedStatementData?.statement_transactions) {
      for (const t of importedStatementData.statement_transactions) {
        if (t.posted_entry_number) {
          map.set(t.line_number, t.posted_entry_number);
        }
      }
    }
    return map;
  }, [importedStatementData]);

  // Bank accounts for transfers
  interface BankAccount {
    code: string;
    name: string;
  }
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);

  // Nominal accounts for NL posting
  interface NominalAccount {
    code: string;
    description: string;
    allow_project?: number;  // 1=Do Not Use, 2=Optional, 3=Mandatory
    allow_department?: number;
    default_project?: string;
    default_department?: string;
  }
  const [nominalAccounts, setNominalAccounts] = useState<NominalAccount[]>([]);

  // Advanced nominal analysis (project/department)
  const [advancedNominalConfig, setAdvancedNominalConfig] = useState<{ project_enabled: boolean; department_enabled: boolean; project_label: string; department_label: string }>({ project_enabled: false, department_enabled: false, project_label: 'Project', department_label: 'Department' });
  const [projectCodes, setProjectCodes] = useState<{ code: string; description: string }[]>([]);
  const [departmentCodes, setDepartmentCodes] = useState<{ code: string; description: string }[]>([]);

  // Voice control — current line highlight and commands
  const [voiceLineIndex, setVoiceLineIndex] = useState(-1);
  const { registerCommands } = useVoice();

  const openAssignForLine = useCallback((idx: number) => {
    const lines = enrichedUnmatched;
    if (idx < 0 || idx >= lines.length) return;
    const line = lines[idx];
    setNewEntryForm({
      accountCode: line.matched_account || '',
      accountType: line.suggested_type || (line.statement_amount > 0 ? 'customer' : 'supplier'),
      nominalCode: '',
      reference: line.statement_reference || '',
      description: line.statement_description || '',
      destBank: '',
      projectCode: '',
      departmentCode: '',
    });
    setCreateEntryModal({ open: true, statementLine: line });
  }, [enrichedUnmatched]);

  // Register voice commands for line entry
  useEffect(() => {
    const cmds: VoiceCommand[] = [
      {
        id: 'bank-next-line',
        phrases: ['next', 'next line', 'down', 'forward'],
        description: 'Next line',
        action: () => setVoiceLineIndex(prev => {
          const next = Math.min(prev + 1, enrichedUnmatched.length - 1);
          // Scroll the row into view
          const row = document.getElementById(`voice-line-${next}`);
          row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          return next;
        }),
      },
      {
        id: 'bank-prev-line',
        phrases: ['previous', 'previous line', 'up', 'back'],
        description: 'Previous line',
        action: () => setVoiceLineIndex(prev => {
          const next = Math.max(prev - 1, 0);
          const row = document.getElementById(`voice-line-${next}`);
          row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          return next;
        }),
      },
      {
        id: 'bank-first-line',
        phrases: ['first', 'first line', 'top'],
        description: 'First line',
        action: () => {
          setVoiceLineIndex(0);
          document.getElementById('voice-line-0')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        },
      },
      {
        id: 'bank-last-line',
        phrases: ['last', 'last line', 'bottom'],
        description: 'Last line',
        action: () => {
          const last = enrichedUnmatched.length - 1;
          setVoiceLineIndex(last);
          document.getElementById(`voice-line-${last}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        },
      },
      {
        id: 'bank-assign',
        phrases: ['assign', 'edit', 'open'],
        description: 'Assign current line',
        action: () => openAssignForLine(voiceLineIndex >= 0 ? voiceLineIndex : 0),
      },
      {
        id: 'bank-ignore',
        phrases: ['ignore', 'skip'],
        description: 'Ignore current line',
        action: () => {
          const idx = voiceLineIndex >= 0 ? voiceLineIndex : 0;
          if (idx < enrichedUnmatched.length) {
            const line = enrichedUnmatched[idx];
            setIgnoreConfirm({
              date: line.statement_date || '',
              description: line.statement_description,
              amount: line.statement_amount,
            });
          }
        },
      },
      {
        id: 'bank-select',
        phrases: ['select', 'tick', 'check'],
        description: 'Select current line',
        action: () => {
          const idx = voiceLineIndex >= 0 ? voiceLineIndex : 0;
          if (idx < enrichedUnmatched.length) {
            const lineNum = enrichedUnmatched[idx].statement_line;
            setSelectedForImport(prev => {
              const next = new Set(prev);
              if (next.has(lineNum)) next.delete(lineNum); else next.add(lineNum);
              return next;
            });
          }
        },
      },
      {
        id: 'bank-select-all',
        phrases: ['select all', 'tick all', 'check all'],
        description: 'Select all lines',
        action: () => {
          const matched = enrichedUnmatched.filter(l => l.matched_account);
          setSelectedForImport(new Set(matched.map(l => l.statement_line)));
        },
      },
      {
        id: 'bank-customer',
        phrases: ['customer'],
        description: 'Set type: Customer',
        action: () => {
          if (createEntryModal.open) {
            setNewEntryForm(prev => ({ ...prev, accountType: 'customer' }));
          } else {
            const idx = voiceLineIndex >= 0 ? voiceLineIndex : 0;
            openAssignForLine(idx);
            setTimeout(() => setNewEntryForm(prev => ({ ...prev, accountType: 'customer' })), 100);
          }
        },
      },
      {
        id: 'bank-supplier',
        phrases: ['supplier'],
        description: 'Set type: Supplier',
        action: () => {
          if (createEntryModal.open) {
            setNewEntryForm(prev => ({ ...prev, accountType: 'supplier' }));
          } else {
            const idx = voiceLineIndex >= 0 ? voiceLineIndex : 0;
            openAssignForLine(idx);
            setTimeout(() => setNewEntryForm(prev => ({ ...prev, accountType: 'supplier' })), 100);
          }
        },
      },
      {
        id: 'bank-nominal',
        phrases: ['nominal', 'nominal account'],
        description: 'Set type: Nominal',
        action: () => {
          if (createEntryModal.open) {
            setNewEntryForm(prev => ({ ...prev, accountType: 'nominal' }));
          } else {
            const idx = voiceLineIndex >= 0 ? voiceLineIndex : 0;
            openAssignForLine(idx);
            setTimeout(() => setNewEntryForm(prev => ({ ...prev, accountType: 'nominal' })), 100);
          }
        },
      },
      {
        id: 'bank-transfer',
        phrases: ['transfer', 'bank transfer'],
        description: 'Set type: Bank Transfer',
        action: () => {
          if (createEntryModal.open) {
            setNewEntryForm(prev => ({ ...prev, accountType: 'bank_transfer' }));
          } else {
            const idx = voiceLineIndex >= 0 ? voiceLineIndex : 0;
            openAssignForLine(idx);
            setTimeout(() => setNewEntryForm(prev => ({ ...prev, accountType: 'bank_transfer' })), 100);
          }
        },
      },
      {
        id: 'bank-cancel',
        phrases: ['cancel', 'close'],
        description: 'Close modal',
        action: () => setCreateEntryModal({ open: false, statementLine: null }),
      },
      {
        id: 'bank-yes',
        phrases: ['yes', 'confirm', 'ok'],
        description: 'Confirm',
        action: () => {
          // If ignore confirm is showing, confirm it
          if (ignoreConfirm) {
            handleIgnoreTransaction();
          }
        },
      },
      {
        id: 'bank-no',
        phrases: ['no'],
        description: 'Cancel',
        action: () => {
          if (ignoreConfirm) {
            setIgnoreConfirm(null);
          }
        },
      },
    ];

    const cleanup = registerCommands(cmds);
    return cleanup;
  }, [enrichedUnmatched, voiceLineIndex, createEntryModal.open, ignoreConfirm, registerCommands, openAssignForLine]);

  // Fetch bank accounts and nominal accounts on mount
  useEffect(() => {
    authFetch('/api/cashbook/bank-accounts')
      .then(res => res.json())
      .then(data => {
        if (data.success && data.accounts) {
          setBankAccounts(data.accounts);
          // Auto-select first bank if none selected AND no initial data pending
          if (data.accounts.length > 0 && !selectedBank && !initialReconcileData && !resumeStatement) {
            setSelectedBank(data.accounts[0].code);
          }
        }
      })
      .catch(err => console.error('Failed to fetch bank accounts:', err));

    authFetch('/api/gocardless/nominal-accounts')
      .then(res => res.json())
      .then(data => {
        if (data.success && data.accounts) {
          setNominalAccounts(data.accounts);
        }
      })
      .catch(err => console.error('Failed to fetch nominal accounts:', err));

    // Fetch advanced nominal config (project/department enabled flags)
    authFetch('/api/nominal/advanced-config')
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          setAdvancedNominalConfig({ project_enabled: data.project_enabled, department_enabled: data.department_enabled, project_label: data.project_label || 'Project', department_label: data.department_label || 'Department' });
          // Fetch project/department code lists if enabled
          if (data.project_enabled) {
            authFetch('/api/nominal/projects')
              .then(res => res.json())
              .then(pData => { if (pData.success) setProjectCodes(pData.projects || []); })
              .catch(err => console.error('Failed to fetch project codes:', err));
          }
          if (data.department_enabled) {
            authFetch('/api/nominal/departments')
              .then(res => res.json())
              .then(dData => { if (dData.success) setDepartmentCodes(dData.departments || []); })
              .catch(err => console.error('Failed to fetch department codes:', err));
          }
        }
      })
      .catch(err => console.error('Failed to fetch advanced nominal config:', err));
  }, []);

  // Check for statement data: prefer prop (hub mode) > sessionStorage (standalone mode)
  useEffect(() => {
    try {
      // Helper to apply reconcile data from either source
      const applyReconcileData = async (data: any) => {
        // If we have an import_id but no statement_transactions, load from DB
        if (data.bank_code && (!data.statement_transactions || data.statement_transactions.length === 0) && data.import_id) {
          console.log(`No statement_transactions in handoff, loading from DB for import_id=${data.import_id}`);

          setSelectedBank(data.bank_code);
          loadStatementFromDb(data.import_id, {
            id: data.import_id,
            filename: data.filename || '',
            bank_code: data.bank_code,
            source: (data.source || 'email') as 'email' | 'file',
            opening_balance: data.statement_info?.opening_balance,
            closing_balance: data.statement_info?.closing_balance,
            statement_date: data.statement_info?.period_end || data.statement_info?.statement_date,
            transactions_imported: 0,
            total_receipts: 0,
            total_payments: 0,
            import_date: data.imported_at || '',
            imported_by: '',
            target_system: '',
            is_reconciled: false,
            reconciled_count: 0,
          });
          return;
        }

        if (data.bank_code && data.statement_transactions?.length > 0) {
          // Don't clear matchingResult here — the auto-match effect will
          // only run when matchingResult is null, so existing results are preserved.
          // Matching re-runs automatically when importedStatementData changes.

          setImportedStatementData({
            ...data,
            filename: data.filename || null,
            import_id: data.import_id || null,
          });
          setSelectedBank(data.bank_code);

          if (data.statement_info?.opening_balance != null) {
            setOpeningBalance(Number(data.statement_info.opening_balance).toFixed(2));
          }
          if (data.statement_info?.closing_balance != null) {
            setClosingBalance(Number(data.statement_info.closing_balance).toFixed(2));
          }
          if (data.statement_info?.period_end) {
            setStatementDate(data.statement_info.period_end.split('T')[0]);
          }
          if (data.import_id) {
            setActiveImportId(data.import_id);
          }
          console.log(`Loaded ${data.statement_transactions.length} statement transactions for reconciliation (import_id=${data.import_id || 'none'})`);

          // Run validation and trigger auto-match
          const ob = data.statement_info?.opening_balance;
          const cb = data.statement_info?.closing_balance;
          const sd = (data.statement_info?.period_end || data.statement_info?.statement_date || '').split('T')[0];
          if (ob != null && cb != null) {
            try {
              const valResp = await authFetch(
                `/api/bank-reconciliation/validate-statement?bank_code=${data.bank_code}&opening_balance=${ob}&closing_balance=${cb}&statement_date=${sd}`,
                { method: 'POST' }
              );
              const valData = await valResp.json();
              setValidationResult(valData);
              if (valData.valid) {
                if (valData.next_statement_number) {
                  setStatementNumber(valData.next_statement_number.toString());
                }
                setPendingAutoMatch(true);
              }
            } catch (err) {
              console.error('Auto-validation failed:', err);
              // Still try auto-match even if validation fails
              setPendingAutoMatch(true);
            }
          } else {
            // No balance info - still try auto-match
            setPendingAutoMatch(true);
          }
        }
      };

      // Priority 1: initialReconcileData prop (fresh from import via hub)
      if (initialReconcileData) {
        applyReconcileData(initialReconcileData);
        return;
      }

      // Priority 2: resumeImportId + resumeStatement (from In Progress tab)
      if (resumeImportId && resumeStatement) {
        setSelectedBank(resumeStatement.bank_code);
        loadStatementFromDb(resumeImportId, {
          id: resumeStatement.id,
          filename: resumeStatement.filename,
          bank_code: resumeStatement.bank_code,
          source: resumeStatement.source as 'email' | 'file',
          opening_balance: resumeStatement.opening_balance,
          closing_balance: resumeStatement.closing_balance,
          statement_date: resumeStatement.statement_date,
          // Provide required fields with defaults for resume case
          transactions_imported: 0,
          total_receipts: 0,
          total_payments: 0,
          import_date: '',
          imported_by: '',
          target_system: '',
          is_reconciled: false,
          reconciled_count: 0,
        });
        return;
      }

      // Priority 3: check sessionStorage (standalone mode)
      const stored = sessionStorage.getItem(storageKey('reconcile_statement_data'));
      if (stored) {
        const data = JSON.parse(stored);
        sessionStorage.removeItem(storageKey('reconcile_statement_data'));
        applyReconcileData(data);
      }
    } catch (err) {
      console.error('Failed to load imported statement data:', err);
    }
  }, [initialReconcileData, resumeImportId, resumeStatement]);

  // Auto-match state - load last used path for the selected bank from localStorage
  const getStoredPath = (bankCode: string) => {
    const saved = localStorage.getItem(`statementPath_${bankCode}`);
    return saved || '/Users/maccb/Downloads/bank-statements/';
  };

  // Load persisted statement result from sessionStorage (survives navigation but not browser close)
  const getStoredStatementResult = (bankCode: string): ProcessStatementResponse | null => {
    try {
      const saved = sessionStorage.getItem(storageKey('statementResult', bankCode));
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  };

  // Load persisted matching result from sessionStorage
  const getStoredMatchingResult = (bankCode: string): MatchingResult | null => {
    try {
      const saved = sessionStorage.getItem(storageKey('matchingResult', bankCode));
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  };

  // Load persisted validation result from sessionStorage
  const getStoredValidationResult = (bankCode: string): StatementValidationResult | null => {
    try {
      const saved = sessionStorage.getItem(storageKey('validationResult', bankCode));
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  };

  const [statementPath, setStatementPath] = useState<string>(() => getStoredPath(urlBank || ''));
  const [statementResult, setStatementResult] = useState<ProcessStatementResponse | null>(() => getStoredStatementResult(urlBank || ''));
  const [selectedMatches, setSelectedMatches] = useState<Set<number>>(new Set());
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingError, setProcessingError] = useState<string | null>(null);
  const [useManualPath, setUseManualPath] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string>('');


  // Archive history state
  const [showArchive, setShowArchive] = useState(false);
  const [restoringPath, setRestoringPath] = useState<string | null>(null);

  // Archive history query (only fetches when expanded)
  const archiveQuery = useQuery({
    queryKey: ['archiveHistory', 'bank-statement'],
    queryFn: async () => {
      const response = await apiClient.getArchiveHistory('bank-statement', 50);
      return response.data;
    },
    enabled: showArchive,
  });

  // Persist statement result to sessionStorage when it changes
  useEffect(() => {
    if (statementResult) {
      sessionStorage.setItem(storageKey('statementResult', selectedBank), JSON.stringify(statementResult));
    }
  }, [statementResult, selectedBank]);

  // Persist matching result to sessionStorage when it changes
  useEffect(() => {
    if (matchingResult) {
      sessionStorage.setItem(storageKey('matchingResult', selectedBank), JSON.stringify(matchingResult));
    }
  }, [matchingResult, selectedBank]);

  // Persist validation result to sessionStorage when it changes
  useEffect(() => {
    if (validationResult) {
      sessionStorage.setItem(storageKey('validationResult', selectedBank), JSON.stringify(validationResult));
    }
  }, [validationResult, selectedBank]);

  // Clear enrichment/import state when statement result is cleared
  useEffect(() => {
    if (!statementResult) {
      setEnrichedUnmatched([]);
      setSelectedForImport(new Set());
      setBatchImportProgress(null);
    }
  }, [statementResult]);

  // Auto-select enriched unmatched lines that have a matched account
  // This ensures selection stays in sync even if React batching separates the state updates
  useEffect(() => {
    if (enrichedUnmatched.length > 0) {
      const autoSelected = new Set<number>();
      for (const line of enrichedUnmatched) {
        if (line.matched_account && line.matched_name) {
          autoSelected.add(line.statement_line);
        }
      }
      if (autoSelected.size > 0) {
        setSelectedForImport(autoSelected);
      }
    }
  }, [enrichedUnmatched]);

  // Fetch available statement files
  const statementFilesQuery = useQuery<StatementFilesResponse>({
    queryKey: ['statementFiles'],
    queryFn: async () => {
      const response = await authFetch('/api/statement-files');
      return response.json();
    },
    staleTime: 30000, // Cache for 30 seconds
  });

  // Fetch imported statements awaiting reconciliation
  const importedStatementsQuery = useQuery<ImportedStatementsResponse>({
    queryKey: ['importedStatements', selectedBank],
    queryFn: async () => {
      const response = await authFetch(`/api/statement-files/imported-for-reconciliation?bank_code=${selectedBank}`);
      return response.json();
    },
    staleTime: 30000,
  });

  // State for selecting from imported statements
  const [selectedImportedStatement, setSelectedImportedStatement] = useState<ImportedStatement | null>(null);
  // Flag to auto-trigger processing after selecting an imported statement
  const [pendingReconcileProcess, setPendingReconcileProcess] = useState(false);
  // Active import_id for DB-persisted statement transactions
  const [activeImportId, setActiveImportId] = useState<number | null>(null);
  // Loading state for DB transaction fetch
  const [isLoadingFromDb, setIsLoadingFromDb] = useState(false);

  // Update statementPath when a file is selected from the dropdown
  useEffect(() => {
    if (selectedFile) {
      setStatementPath(selectedFile);
    }
  }, [selectedFile]);

  // Save path to localStorage for the current bank when processing succeeds
  const savePathToHistory = (path: string, bankCode: string) => {
    localStorage.setItem(`statementPath_${bankCode}`, path);
  };

  // Load stored path when bank selection changes
  const handleBankChange = (newBank: string) => {
    setSelectedBank(newBank);
    setStatementPath(getStoredPath(newBank));
    // Load persisted data for the new bank
    setStatementResult(getStoredStatementResult(newBank));
    setMatchingResult(getStoredMatchingResult(newBank));
    setValidationResult(getStoredValidationResult(newBank));
  };

  // Clear all persisted statement data for current bank
  const clearStatementData = async () => {
    const confirmed = window.confirm(
      'Are you sure you want to clear this statement?\n\n' +
      'This will remove the import record and all statement data, ' +
      'allowing you to start fresh with a new statement import.\n\n' +
      'Note: Any transactions already posted to Opera will NOT be affected.'
    );
    if (!confirmed) return;

    // Delete the DB import record if we have one
    if (activeImportId) {
      try {
        await authFetch(`/api/bank-import/import-history/${activeImportId}`, { method: 'DELETE' });
        queryClient.invalidateQueries({ queryKey: ['importedStatements'] });
      } catch (e) {
        console.error('Failed to delete import record:', e);
      }
    }

    // Clear frontend state
    sessionStorage.removeItem(storageKey('statementResult', selectedBank));
    sessionStorage.removeItem(storageKey('matchingResult', selectedBank));
    sessionStorage.removeItem(storageKey('validationResult', selectedBank));
    setStatementResult(null);
    setMatchingResult(null);
    setValidationResult(null);
    setSelectedMatches(new Set());
    setSelectedAutoMatches(new Set());
    setSelectedSuggestedMatches(new Set());
    setProcessingError(null);
    setOpeningBalance('');
    setClosingBalance('');
    setActiveImportId(null);
    setBalanceMismatch(null);
    setBalanceMismatchAcknowledged(false);
    setReconcileCompleteInfo(null);
    setImportedStatementData(null as any);
  };

  // Load statement transactions from DB by import_id
  // This replaces the sessionStorage-based flow for persisted statements
  const loadStatementFromDb = async (importId: number, stmt: ImportedStatement) => {
    setIsLoadingFromDb(true);
    setProcessingError(null);
    try {
      console.log(`loadStatementFromDb: fetching transactions for import_id=${importId}`);
      const response = await authFetch(`/api/bank-reconciliation/statement-transactions/${importId}`);
      const data = await response.json();
      console.log(`loadStatementFromDb: response`, { success: data.success, txnCount: data.transactions?.length || 0, count: data.count });

      if (data.success && data.transactions?.length > 0) {
        // Don't clear matchingResult here — preserved until new matching runs.

        // Set the statement data as if it came from PDF import
        setImportedStatementData({
          bank_code: stmt.bank_code,
          statement_transactions: data.transactions.map((t: any) => ({
            line_number: t.line_number,
            date: t.date,
            description: t.description || '',
            amount: t.amount,
            balance: t.balance,
            transaction_type: t.transaction_type || '',
            reference: t.reference || '',
            posted_entry_number: t.posted_entry_number || null,
          })),
          statement_info: data.statement_info || {
            opening_balance: stmt.opening_balance,
            closing_balance: stmt.closing_balance,
          },
          source: stmt.source,
          filename: stmt.filename,
          import_id: stmt.id,
        });

        setActiveImportId(importId);
        setSelectedBank(stmt.bank_code);

        // Set statement path for Preview button — prefer full_path from API, fallback to filename
        if (data.statement_info?.full_path) {
          setStatementPath(data.statement_info.full_path);
        } else if (stmt.filename) {
          setStatementPath(stmt.filename); // Filename fallback; Preview button will try to resolve
        }

        // Set balances from statement info
        if (data.statement_info?.opening_balance != null) {
          setOpeningBalance(Number(data.statement_info.opening_balance).toFixed(2));
        } else if (stmt.opening_balance != null) {
          setOpeningBalance(Number(stmt.opening_balance).toFixed(2));
        }
        if (data.statement_info?.closing_balance != null) {
          setClosingBalance(Number(data.statement_info.closing_balance).toFixed(2));
        } else if (stmt.closing_balance != null) {
          setClosingBalance(Number(stmt.closing_balance).toFixed(2));
        }
        if (data.statement_info?.statement_date || stmt.statement_date) {
          const dateStr = data.statement_info?.statement_date || stmt.statement_date || '';
          setStatementDate(dateStr.split('T')[0]);
        }

        console.log(`Loaded ${data.transactions.length} statement transactions from DB for import_id=${importId}`);

        // Auto-trigger validation + matching so reconcile view is immediately usable
        const ob = data.statement_info?.opening_balance ?? stmt.opening_balance;
        const cb = data.statement_info?.closing_balance ?? stmt.closing_balance;
        const sd = (data.statement_info?.statement_date || stmt.statement_date || '').split('T')[0];
        if (ob != null && cb != null) {
          try {
            const valResp = await authFetch(
              `/api/bank-reconciliation/validate-statement?bank_code=${stmt.bank_code}&opening_balance=${ob}&closing_balance=${cb}&statement_date=${sd}`,
              { method: 'POST' }
            );
            const valData = await valResp.json();
            setValidationResult(valData);
            if (valData.valid && valData.next_statement_number) {
              setStatementNumber(valData.next_statement_number.toString());
            }
          } catch (err) {
            console.error('Auto-validation failed:', err);
          }
        }
        // Always trigger auto-match regardless of validation result
        setPendingAutoMatch(true);
      } else {
        // No transactions in DB - fall back to PDF file approach
        console.log(`No stored transactions for import_id=${importId}, falling back to file`);
        return false;
      }
      return true;
    } catch (error) {
      console.error('Failed to load statement transactions from DB:', error);
      return false;
    } finally {
      setIsLoadingFromDb(false);
    }
  };

  // Fetch bank accounts
  const banksQuery = useQuery<BankAccountsResponse>({
    queryKey: ['reconcileBanks'],
    queryFn: async () => {
      const response = await apiClient.reconcileBanks();
      return response.data;
    },
  });

  // Pick the best available filename for the active statement so the
  // status endpoint can detect Sequential-Statement-Gating context and
  // tailor its message ("self" vs "subsequent"). Falls back through prop
  // sources in priority order.
  const statusQueryFilename = (
    initialReconcileData?.filename
    || resumeStatement?.filename
    || (typeof window !== 'undefined' ? sessionStorage.getItem('reconcile_active_filename') : null)
    || ''
  );

  const statusQuery = useQuery<BankReconciliationStatusResponse>({
    queryKey: ['bankRecStatus', selectedBank, statusQueryFilename],
    queryFn: async () => {
      const response = await apiClient.getBankReconciliationStatus(selectedBank, statusQueryFilename || undefined);
      return response.data;
    },
    enabled: !!selectedBank,
  });

  // Auto-fill closing balance from nbank.nk_reccfwd when status loads
  useEffect(() => {
    const recCfwd = (statusQuery.data as Record<string, unknown> | undefined)?.rec_cfwd_balance as number | undefined;
    if (recCfwd != null && recCfwd !== 0 && !closingBalance) {
      setClosingBalance(recCfwd.toFixed(2));
    }
  }, [statusQuery.data?.rec_cfwd_balance]);

  // Fetch unreconciled entries
  const entriesQuery = useQuery<UnreconciledEntriesResponse>({
    queryKey: ['unreconciledEntries', selectedBank],
    queryFn: async () => {
      const response = await apiClient.getUnreconciledEntries(selectedBank);
      return response.data;
    },
    enabled: !!selectedBank,
  });

  // Orphan-tmpstat utility (cleanup for partial-reconcile residue)
  const orphanTmpstatQuery = useQuery({
    queryKey: ['orphanTmpstat', selectedBank],
    queryFn: async () => {
      const res = await authFetch(
        `/api/reconcile/bank/${selectedBank}/orphan-tmpstat`,
      );
      const data = await res.json();
      return data;
    },
    enabled: !!selectedBank,
    staleTime: 60_000,
  });

  const clearOrphanTmpstatMutation = useMutation<any, Error, void>({
    mutationFn: async () => {
      const res = await authFetch(
        `/api/reconcile/bank/${selectedBank}/clear-orphan-tmpstat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),  // no entry_numbers = clear all on bank
        },
      );
      return res.json();
    },
    onSuccess: () => {
      orphanTmpstatQuery.refetch();
      entriesQuery.refetch();
      statusQuery.refetch();
    },
  });

  // Fetch deferred audit rows for this bank+period so the reconcile page can
  // surface items the operator earlier marked 'awaiting manual entry'.
  // Used to pre-populate `deferredLines` and add a "Re-match" affordance once
  // the operator has manually entered the transaction in Opera.
  const deferredItemsQuery = useQuery<{
    success: boolean;
    items: Array<{
      id: number;
      bank_code: string;
      statement_date: string;
      amount: number;
      description: string;
      deferred_at: string;
      deferred_by: string;
    }>;
    count: number;
  }>({
    queryKey: ['deferredItems', selectedBank, statusQueryFilename],
    queryFn: async () => {
      const params = new URLSearchParams();
      // No period from this page right now — fetch all for bank, frontend
      // matches by date+amount+description.
      const url = `/api/reconcile/bank/${selectedBank}/deferred-items?${params.toString()}`;
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('auth_token') || ''}` },
        credentials: 'include',
      });
      return res.json();
    },
    enabled: !!selectedBank,
    staleTime: 10000,
  });

  // Auto-mark statement lines as deferred when they match a row in the
  // deferred-transactions audit DB. Triggered whenever the unmatched lines
  // are loaded or the deferred-items query refreshes. The match is by
  // (date prefix, rounded amount, normalised description) — robust to
  // whitespace and ISO-date suffix differences.
  useEffect(() => {
    if (!deferredItemsQuery.data?.items || deferredItemsQuery.data.items.length === 0) return;
    if (!enrichedUnmatched || enrichedUnmatched.length === 0) return;
    const norm = (s: string) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const dateOnly = (s: string | null | undefined) => (s || '').split('T')[0];
    const auditByKey = new Map<string, number>();
    for (const it of deferredItemsQuery.data.items) {
      const key = `${dateOnly(it.statement_date)}|${Math.round(it.amount * 100) / 100}|${norm(it.description)}`;
      auditByKey.set(key, it.id);
    }
    setDeferredLines(prev => {
      const next = new Set(prev);
      let changed = false;
      for (const line of enrichedUnmatched) {
        const k = `${dateOnly(line.statement_date)}|${Math.round((line.statement_amount || 0) * 100) / 100}|${norm(line.statement_description || line.statement_reference || '')}`;
        if (auditByKey.has(k) && !next.has(line.statement_line)) {
          next.add(line.statement_line);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [deferredItemsQuery.data, enrichedUnmatched]);

  // Auto-clean stale defer audit rows: when the matcher pairs a previously-
  // deferred bank line with an Opera entry (the operator entered it manually),
  // the audit row's purpose is done. Drop it silently so deferred_count drops
  // to 0 and the statement's state cleanly transitions to 'reconciled' on
  // the next scan. No UI action — just bookkeeping.
  useEffect(() => {
    if (!deferredItemsQuery.data?.items || deferredItemsQuery.data.items.length === 0) return;
    if (!matchingResult) return;
    const norm = (s: string) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const dateOnly = (s: string | null | undefined) => (s || '').split('T')[0];
    const matchedKeys = new Set<string>();
    const collect = (e: { statement_date: string | null; statement_amount: number; statement_description: string; statement_reference?: string }) => {
      const key = `${dateOnly(e.statement_date || '')}|${Math.round((e.statement_amount || 0) * 100) / 100}|${norm(e.statement_description || e.statement_reference || '')}`;
      matchedKeys.add(key);
    };
    (matchingResult.auto_matched || []).forEach(collect);
    (matchingResult.suggested_matched || []).forEach(collect);
    const stale: number[] = [];
    for (const it of deferredItemsQuery.data.items) {
      const k = `${dateOnly(it.statement_date)}|${Math.round(it.amount * 100) / 100}|${norm(it.description)}`;
      if (matchedKeys.has(k)) stale.push(it.id);
    }
    if (stale.length === 0) return;
    fetch(`/api/reconcile/bank/${selectedBank}/deferred-items`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('auth_token') || ''}`,
      },
      credentials: 'include',
      body: JSON.stringify({ ids: stale }),
    })
      .then(() => {
        console.info(`[deferred] auto-cleaned ${stale.length} audit row(s) for now-matched lines`);
        queryClient.invalidateQueries({ queryKey: ['deferredItems', selectedBank] });
      })
      .catch(err => console.warn('Auto-clean defer audit failed (non-blocking):', err));
  }, [matchingResult, deferredItemsQuery.data, selectedBank, queryClient]);

  // Mark reconciled mutation (manual mode)
  const markReconciledMutation = useMutation<MarkReconciledResponse, Error, void>({
    mutationFn: async () => {
      const entries = Array.from(selectedEntries).map((entry, index) => ({
        entry_number: entry,
        statement_line: (index + 1) * 10,
      }));
      const response = await apiClient.markEntriesReconciled(selectedBank, {
        entries,
        statement_number: parseInt(statementNumber) || (statusQuery.data?.last_stmt_no || 0) + 1,
        statement_date: statementDate,
        reconciliation_date: statementDate,
      });
      const data = response.data;

      // Period validation surface (matcher-period-bound spec): the API
      // returns success=false with an out_of_period list when the
      // matched entries straddle the statement period.
      if (data && (data as any).out_of_period && Array.isArray((data as any).out_of_period)) {
        const oop = (data as any).out_of_period as Array<{entry: string; date: string; period_start: string; period_end: string}>;
        const lines = oop.map(e => `  • ${e.entry} dated ${e.date}`).join('\n');
        const period = oop.length > 0 ? `${oop[0].period_start} to ${oop[0].period_end}` : '';
        const msg = `Cannot reconcile — these entries fall outside the statement period (${period}):\n\n${lines}\n\nEdit your selection to include only in-period entries, or extend the period if these legitimately belong.`;
        throw new Error(msg);
      }

      return data;
    },
    onSuccess: () => {
      setSelectedEntries(new Set());
      // Clear statement preview data after successful reconciliation
      setStatementResult(null);
      setStatementPath('');
      setProcessingError(null);
      queryClient.invalidateQueries({ queryKey: ['bankRecStatus', selectedBank] });
      queryClient.invalidateQueries({ queryKey: ['unreconciledEntries', selectedBank] });
    },
  });

  // Process statement
  const processStatement = async () => {
    if (!statementPath.trim()) {
      alert('Please enter a statement file path');
      return;
    }

    setIsProcessing(true);
    setStatementResult(null);
    setProcessingError(null);

    try {
      const response = await authFetch(
        `/api/reconcile/process-statement?file_path=${encodeURIComponent(statementPath)}&bank_code=${encodeURIComponent(selectedBank)}`,
        { method: 'POST' }
      );
      const data: ProcessStatementResponse = await response.json();

      // Auto-switch bank if statement is for a different bank account
      if ((data as any).bank_mismatch && !(data as any).correct_bank_code) {
        setProcessingError(`Bank account mismatch: statement is for ${(data as any).detected_bank} but no matching bank found in Opera. Please select the correct bank manually.`);
        setIsProcessing(false);
        return;
      }
      if ((data as any).bank_mismatch && (data as any).correct_bank_code) {
        const correctBank = (data as any).correct_bank_code;
        setSelectedBank(correctBank);
        // Re-process with correct bank — use direct fetch with same processing logic
        const retryResponse = await authFetch(
          `/api/reconcile/process-statement?file_path=${encodeURIComponent(statementPath)}&bank_code=${encodeURIComponent(correctBank)}`,
          { method: 'POST' }
        );
        const retryData: ProcessStatementResponse = await retryResponse.json();
        // Replace data and fall through to normal processing
        Object.assign(data, retryData);
      }

      if (data.success) {
        // Check for sequence validation status
        if (data.status === 'skipped') {
          // Earlier/already processed statement - silently ignore
          setStatementResult(null);
          setProcessingError(null);
          // Could show subtle info message if desired
          return;
        }

        if (data.status === 'pending') {
          // Future statement - missing one in between
          setStatementResult(null);
          setProcessingError(
            `Missing Statement: Cannot process this statement yet.\n\n` +
            `Statement opening balance: £${data.statement_info?.opening_balance?.toFixed(2)}\n` +
            `Opera reconciled balance: £${data.reconciled_balance?.toFixed(2)}\n\n` +
            `Please send the statement with opening balance £${data.missing_statement_balance?.toFixed(2)} to continue processing.`
          );
          return;
        }

        // Normal processing - statement is valid and in sequence
        setStatementResult(data);
        setProcessingError(null);
        // Save successful path to history for this bank
        savePathToHistory(statementPath, selectedBank);
        // Pre-select all matches
        if (data.matches) {
          setSelectedMatches(new Set(data.matches.map((_, i) => i)));
        }
        // Update statement balance and date from extracted data
        if (data.statement_info?.closing_balance != null) {
          setStatementBalance(data.statement_info.closing_balance.toString());
          setClosingBalance(data.statement_info.closing_balance.toString());
        }
        if (data.statement_info?.opening_balance != null) {
          setOpeningBalance(data.statement_info.opening_balance.toString());
        }
        // Set reconciliation date to the last transaction date on the statement
        const allTransactionDates: string[] = [];
        if (data.unmatched_statement) {
          data.unmatched_statement.forEach((t: any) => {
            if (t.date) allTransactionDates.push(t.date.split('T')[0]);
          });
        }
        if (data.matches) {
          data.matches.forEach((m: any) => {
            if (m.statement_date) allTransactionDates.push(m.statement_date.split('T')[0]);
          });
        }
        if (allTransactionDates.length > 0) {
          const lastDate = allTransactionDates.sort().pop();
          if (lastDate) setStatementDate(lastDate);
        } else if (data.statement_info?.period_end) {
          // Fallback to period_end if no transactions
          setStatementDate(data.statement_info.period_end.split('T')[0]);
        }

        // Enrich unmatched lines with customer/supplier auto-match data
        if (data.unmatched_statement && data.unmatched_statement.length > 0) {
          const unmatchedAsLines: UnmatchedStatementLine[] = data.unmatched_statement.map((t: any, i: number) => ({
            statement_line: i + 1,
            statement_date: t.date,
            statement_amount: t.amount,
            statement_reference: t.description || '',
            statement_description: t.description || '',
            statement_balance: t.balance ?? null,
          }));
          const enriched = await autoMatchUnmatchedLines(unmatchedAsLines);
          setEnrichedUnmatched(enriched);
          // Auto-select items that have a matched account
          const autoSelected = new Set<number>();
          for (const line of enriched) {
            if (line.matched_account && line.matched_name) {
              autoSelected.add(line.statement_line);
            }
          }
          setSelectedForImport(autoSelected);
        } else {
          setEnrichedUnmatched([]);
          setSelectedForImport(new Set());
        }
      } else {
        // Check if it's a bank mismatch error with suggestion
        if (data.bank_validation?.suggested_bank) {
          const suggested = data.bank_validation.suggested_bank;
          const useOther = window.confirm(
            `${data.error}\n\nWould you like to switch to bank account '${suggested.bank_code}' (${suggested.description})?`
          );
          if (useOther) {
            handleBankChange(suggested.bank_code);
          }
        } else if (data.error?.includes('429') || data.error?.includes('Resource exhausted') || data.error?.includes('rate limit')) {
          setProcessingError('API Rate Limit Exceeded - The Google Gemini API has temporarily limited requests. Please wait 1-2 minutes and try again.');
        } else {
          setProcessingError(friendlyError(data.error || 'Unknown error occurred'));
        }
      }
    } catch (error) {
      const errorMsg = String(error);
      if (errorMsg.includes('429') || errorMsg.includes('Resource exhausted') || errorMsg.includes('rate limit')) {
        setProcessingError('API Rate Limit Exceeded - The Google Gemini API has temporarily limited requests. Please wait 1-2 minutes and try again.');
      } else {
        setProcessingError(friendlyError(`Failed to process statement: ${error}`));
      }
    } finally {
      setIsProcessing(false);
    }
  };

  // Confirm auto-matches
  const confirmMatches = async () => {
    if (!statementResult?.matches || selectedMatches.size === 0) return;

    const matchesToConfirm = statementResult.matches.filter((_, i) => selectedMatches.has(i));

    try {
      const response = await authFetch(
        `/api/reconcile/bank/${selectedBank}/confirm-matches`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            matches: matchesToConfirm.map(m => ({ ae_entry: m.opera_entry.ae_entry })),
            statement_balance: parseFloat(statementBalance),
            statement_date: statementDate,
          }),
        }
      );
      const data = await response.json();

      if (data.success) {
        // Prompt to archive the statement file
        const shouldArchive = window.confirm(
          `Successfully reconciled ${data.reconciled_count} entries.\n\nArchive this statement file?`
        );

        if (shouldArchive && statementPath) {
          try {
            const archiveResponse = await authFetch(
              `/api/archive/file?file_path=${encodeURIComponent(statementPath)}&import_type=bank-statement&transactions_extracted=${statementResult?.extracted_transactions || 0}&transactions_matched=${statementResult?.matches?.length || 0}&transactions_reconciled=${data.reconciled_count}`,
              { method: 'POST' }
            );
            const archiveData = await archiveResponse.json();
            if (archiveData.success) {
              alert(`Statement archived to:\n${archiveData.archive_path}`);
            }
          } catch {
            // Silently fail archive - main operation succeeded
          }
        }

        setStatementResult(null);
        setSelectedMatches(new Set());
        queryClient.invalidateQueries({ queryKey: ['bankRecStatus', selectedBank] });
        queryClient.invalidateQueries({ queryKey: ['unreconciledEntries', selectedBank] });
      } else {
        alert(`Error: ${data.error}`);
      }
    } catch (error) {
      alert(`Failed to confirm matches: ${error}`);
    }
  };

  // Ignore a transaction (mark it so it won't appear in future reconciliations)
  const handleIgnoreTransaction = async () => {
    if (!ignoreConfirm) return;

    setIsIgnoring(true);
    try {
      const params = new URLSearchParams({
        transaction_date: ignoreConfirm.date,
        amount: ignoreConfirm.amount.toString(),
        description: ignoreConfirm.description,
        reason: 'Already entered in Opera'
      });

      const response = await authFetch(
        `/api/reconcile/bank/${selectedBank}/ignore-transaction?${params}`,
        { method: 'POST' }
      );
      const data = await response.json();

      if (data.success) {
        // Remove this transaction from the unmatched list (statementResult)
        if (statementResult) {
          setStatementResult({
            ...statementResult,
            unmatched_statement: statementResult.unmatched_statement?.filter(
              t => !(t.date === ignoreConfirm.date && Math.abs(t.amount - ignoreConfirm.amount) < 0.01)
            )
          });
        }
        // Also remove from matchingResult if present
        if (matchingResult) {
          setMatchingResult({
            ...matchingResult,
            unmatched_statement: matchingResult.unmatched_statement?.filter(
              t => !(t.statement_date === ignoreConfirm.date && Math.abs(t.statement_amount - ignoreConfirm.amount) < 0.01)
            ),
            summary: {
              ...matchingResult.summary || {},
              unmatched_statement_count: Math.max(0, (matchingResult.summary?.unmatched_statement_count || 0) - 1)
            }
          });
        }
        setIgnoreConfirm(null);
      } else {
        alert(`Error: ${data.error}`);
      }
    } catch (error) {
      alert(`Failed to ignore transaction: ${error}`);
    } finally {
      setIsIgnoring(false);
    }
  };

  // Validate statement opening balance against Opera's expected
  const validateStatement = async () => {
    if (!openingBalance || !closingBalance) {
      alert('Please enter both opening and closing balance');
      return;
    }

    setIsValidating(true);
    setValidationResult(null);
    setMatchingResult(null);
    setManualMatchOverrides(new Map());

    try {
      const response = await authFetch(
        `/api/bank-reconciliation/validate-statement?bank_code=${selectedBank}&opening_balance=${openingBalance}&closing_balance=${closingBalance}&statement_date=${statementDate}`,
        { method: 'POST' }
      );
      const data: StatementValidationResult = await response.json();
      setValidationResult(data);

      if (data.valid && data.next_statement_number) {
        setStatementNumber(data.next_statement_number.toString());
        // Auto-run matching after successful validation
        await runMatchingFromUnreconciled();
      }

      return data;
    } catch (error) {
      setValidationResult({
        valid: false,
        error_message: `Failed to validate: ${error}`
      });
    } finally {
      setIsValidating(false);
    }
  };

  // Run matching using unreconciled entries (builds statement transactions from cashbook)
  const runMatchingFromUnreconciled = async () => {

    // Advisory balance check - warn but don't block matching
    if (!checkBalanceAlignment()) {
      console.warn('Balance mismatch detected - proceeding with matching anyway');
    }

    try {
      let statementTransactions: Array<{
        line_number: number;
        date: string;
        amount: number;
        reference: string;
        description: string;
      }>;

      // Use real statement transactions if available (from import redirect or PDF processing)
      if (importedStatementData?.statement_transactions?.length) {
        // Real statement data from PDF extraction — use as-is
        statementTransactions = importedStatementData.statement_transactions.map(st => ({
          line_number: st.line_number,
          date: st.date,
          amount: st.amount,
          reference: st.reference || '',
          description: st.description || ''
        }));
        console.log(`Using ${statementTransactions.length} real statement transactions from PDF for matching`);
      } else {
        // Fallback: build statement transactions from unreconciled Opera entries
        const entries = entriesQuery.data?.entries || [];
        statementTransactions = entries.map((entry, idx) => ({
          line_number: idx + 1,
          date: entry.ae_lstdate?.substring(0, 10) || '',
          amount: entry.value_pounds,
          reference: entry.ae_entref || '',
          description: entry.ae_comment || ''
        }));
      }

      if (statementTransactions.length === 0) {
        setMatchingResult({
          success: true,
          auto_matched: [],
          suggested_matched: [],
          unmatched_statement: [],
          unmatched_cashbook: [],
          summary: {
            total_statement_lines: 0,
            auto_matched_count: 0,
            suggested_matched_count: 0,
            unmatched_statement_count: 0,
            unmatched_cashbook_count: 0
          }
        });
        return;
      }

      // Include import_id if available for DB-based matching
      const matchUrl = activeImportId
        ? `/api/bank-reconciliation/match-statement?bank_code=${selectedBank}&import_id=${activeImportId}`
        : `/api/bank-reconciliation/match-statement?bank_code=${selectedBank}`;

      const response = await authFetch(
        matchUrl,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            statement_transactions: statementTransactions,
            // Period bounds enforce in-period matching — out-of-period
            // aentries cannot pair with this statement, preventing the
            // tmpstat-on-wrong-row class of bug. The bounds live under
            // `statement_info` on this data structure, not at the top
            // level (initial plan had this path wrong; fixed here so
            // we don't always send null and force the backend onto its
            // import_id-fallback path).
            period_start: importedStatementData?.statement_info?.period_start ?? null,
            period_end: importedStatementData?.statement_info?.period_end ?? null,
          }),
        }
      );

      const data: MatchingResult = await response.json();

      if (data.success) {
        // Auto-match unmatched statement lines to customers/suppliers
        if (data.unmatched_statement && data.unmatched_statement.length > 0) {
          data.unmatched_statement = await autoMatchUnmatchedLines(data.unmatched_statement);
        }

        setMatchingResult(data);

        // Pre-select all auto-matched entries (by entry number, not index)
        // Preserve any existing selections from previous matches
        setSelectedAutoMatches(prev => {
          const newSet = new Set(prev);
          (data.auto_matched || []).forEach((match: any) => newSet.add(match.entry_number));
          return newSet;
        });
        // Pre-select suggested matches too (amount + date matched, just no exact reference)
        setSelectedSuggestedMatches(prev => {
          const newSet = new Set(prev);
          (data.suggested_matched || []).forEach((match: any) => newSet.add(match.entry_number));
          return newSet;
        });
      } else {
        setMatchingResult(data);
      }
    } catch (error) {
      console.error('Matching error:', error);
    }
  };

  // Auto-run matching after data loads — always run when pending, regardless of validation result
  useEffect(() => {
    if (pendingAutoMatch && importedStatementData) {
      setPendingAutoMatch(false);
      runMatchingFromUnreconciled();
    }
  }, [pendingAutoMatch, importedStatementData]);

  // Check if Opera reconciled balance matches statement opening balance
  // This catches scenarios where Opera data has been restored to a different point
  const checkBalanceAlignment = (): boolean => {
    const operaRecBal = statusQuery.data?.reconciled_balance;
    const stmtOpenBal = importedStatementData?.statement_info?.opening_balance
      ?? (openingBalance ? parseFloat(openingBalance) : null);

    if (operaRecBal != null && stmtOpenBal != null) {
      if (Math.abs(operaRecBal - stmtOpenBal) > 0.01) {
        setBalanceMismatch({ operaBalance: operaRecBal, statementBalance: stmtOpenBal });
        // Don't block matching — only set the warning state
        return false;
      }
    }
    setBalanceMismatch(null);
    setBalanceMismatchAcknowledged(false);
    return true;
  };

  // Auto-fill balance inputs from statement data when available
  useEffect(() => {
    if (importedStatementData?.statement_info) {
      const info = importedStatementData.statement_info;
      const ob = Number(info.opening_balance);
      const cb = Number(info.closing_balance);
      if (!isNaN(ob) && !openingBalance) {
        setOpeningBalance(ob.toFixed(2));
      }
      if (!isNaN(cb) && !closingBalance) {
        setClosingBalance(cb.toFixed(2));
      }
      const dateVal = info.period_end || info.statement_date;
      if (dateVal && !statementDate) {
        setStatementDate(String(dateVal).split('T')[0]);
      }
    }
  }, [importedStatementData]);

  // Track whether auto-matching has already run for this statement
  const [autoMatchDone, setAutoMatchDone] = useState(false);

  // Reset when new statement loads
  useEffect(() => {
    setAutoMatchDone(false);
  }, [importedStatementData?.import_id, importedStatementData?.filename]);

  // Auto-trigger matching ONCE when imported statement data is available
  useEffect(() => {
    let cancelled = false;

    if (autoMatchDone) return; // Already ran for this statement
    if (importedStatementData?.statement_transactions?.length && entriesQuery.data?.entries
        && !matchingResult && !pendingAutoMatch && !isRefreshing) {
      // Check balance alignment (advisory warning only)
      const stmtInfo = importedStatementData.statement_info;
      if (stmtInfo?.opening_balance != null) {
        checkBalanceAlignment();
      }

      // Run matching — but only update state if this effect hasn't been cleaned up
      const doMatch = async () => {
        try {
          const statementTransactions = importedStatementData.statement_transactions.map(st => ({
            line_number: st.line_number,
            date: st.date,
            amount: st.amount,
            reference: st.reference || '',
            description: st.description || ''
          }));

          if (statementTransactions.length === 0) return;

          const matchUrl = activeImportId
            ? `/api/bank-reconciliation/match-statement?bank_code=${selectedBank}&import_id=${activeImportId}`
            : `/api/bank-reconciliation/match-statement?bank_code=${selectedBank}`;

          const response = await authFetch(matchUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ statement_transactions: statementTransactions })
          });

          if (cancelled) return;

          const data: MatchingResult = await response.json();

          if (cancelled) return;

          if (data.success) {
            if (data.unmatched_statement && data.unmatched_statement.length > 0) {
              data.unmatched_statement = await autoMatchUnmatchedLines(data.unmatched_statement);
            }
            if (cancelled) return;

            setMatchingResult(data);
            setAutoMatchDone(true);
            setSelectedAutoMatches(prev => {
              const newSet = new Set(prev);
              (data.auto_matched || []).forEach((match: any) => newSet.add(match.entry_number));
              return newSet;
            });
            setSelectedSuggestedMatches(prev => {
              const newSet = new Set(prev);
              (data.suggested_matched || []).forEach((match: any) => newSet.add(match.entry_number));
              return newSet;
            });
          }
        } catch (error) {
          if (!cancelled) console.error('Auto-matching error:', error);
        }
      };

      doMatch();
    }

    return () => { cancelled = true; };
  }, [importedStatementData, entriesQuery.data]);

  // Auto-trigger statement processing when user clicks Reconcile on an imported statement
  useEffect(() => {
    if (pendingReconcileProcess && statementPath.trim() && !isProcessing) {
      setPendingReconcileProcess(false);
      const timer = setTimeout(() => processStatement(), 100);
      return () => clearTimeout(timer);
    }
  }, [pendingReconcileProcess, statementPath, isProcessing]);

  // Auto-resume: if there's a pending imported statement and no data loaded yet, load from DB
  // Skip when resumeImportId is provided (hub already handles loading via the main useEffect)
  useEffect(() => {
    if (
      !resumeImportId &&
      importedStatementsQuery.data?.statements?.length === 1 &&
      !matchingResult &&
      !statementResult &&
      !importedStatementData &&
      !activeImportId &&
      !isLoadingFromDb
    ) {
      const stmt = importedStatementsQuery.data.statements[0];
      if (stmt.stored_transaction_count && stmt.stored_transaction_count > 0) {
        console.log(`Auto-resuming reconciliation for import_id=${stmt.id}`);
        loadStatementFromDb(stmt.id, stmt);
      }
    }
  }, [importedStatementsQuery.data]);

  // Complete reconciliation with selected matches
  const completeEnhancedReconciliation = async () => {
    if (!matchingResult || isReconciling) return;

    // Advisory: re-check balance alignment before committing (warn only, never block)
    if (!checkBalanceAlignment() && !balanceMismatchAcknowledged) {
      // Auto-acknowledge — balance mismatches are expected during import testing
      setBalanceMismatchAcknowledged(true);
    }

    setIsReconciling(true);
    setLastPartialUpdateInfo(null); // Clear previous indicator while updating

    // Gather all selected entries (using entry_number as key), respecting manual overrides
    const selectedEntriesToReconcile: { entry_number: string; statement_line: number }[] = [];

    matchingResult.auto_matched?.forEach((match) => {
      if (selectedAutoMatches.has(match.entry_number) && manualMatchOverrides.get(match.statement_line) !== false) {
        selectedEntriesToReconcile.push({
          entry_number: match.entry_number,
          statement_line: match.statement_line
        });
      }
    });

    matchingResult.suggested_matched?.forEach((match) => {
      if (selectedSuggestedMatches.has(match.entry_number) && manualMatchOverrides.get(match.statement_line) !== false) {
        selectedEntriesToReconcile.push({
          entry_number: match.entry_number,
          statement_line: match.statement_line
        });
      }
    });

    // Include manually force-matched lines (unmatched lines the user ticked)
    // These don't have Opera entry numbers — they're marked as reconciled without a specific entry
    const manuallyMatchedLines = (matchingResult.unmatched_statement || [])
      .filter(u => manualMatchOverrides.get(u.statement_line) === true);

    if (selectedEntriesToReconcile.length === 0 && manuallyMatchedLines.length === 0) {
      showDialog({ title: 'No Entries Selected', message: 'No entries selected for reconciliation.', type: 'warning' });
      return;
    }

    // Count truly unmatched lines (excluding manual overrides)
    const remainingUnmatched = (matchingResult.unmatched_statement || [])
      .filter(u => manualMatchOverrides.get(u.statement_line) !== true).length
      + [...(matchingResult.auto_matched || []), ...(matchingResult.suggested_matched || [])]
        .filter(m => manualMatchOverrides.get(m.statement_line) === false).length;
    const hasUnmatched = remainingUnmatched > 0;

    // When there are unmatched lines, prompt before proceeding
    if (hasUnmatched) {
      showDialog({
        title: 'Partial Reconciliation',
        message: `${matchingResult.unmatched_statement?.length || 0} statement line(s) are unmatched.\n\nMatched entries will be posted to Opera with line numbers, but the reconciliation will not be marked as complete.\n\nComplete the remaining items in Opera Cashbook > Reconcile.`,
        type: 'confirm',
        confirmLabel: 'Continue',
        onConfirm: () => { closeDialog(); doCompleteReconciliation(selectedEntriesToReconcile, hasUnmatched); },
      });
      return;
    }

    doCompleteReconciliation(selectedEntriesToReconcile, hasUnmatched);
  };

  // Extracted reconciliation logic (called directly or from confirm dialog)
  const doCompleteReconciliation = async (
    selectedEntriesToReconcile: Array<{ entry_number: string; statement_line: number }>,
    hasUnmatched: boolean
  ) => {
    try {
      const stmtNo = parseInt(statementNumber) || (statusQuery.data?.last_stmt_no || 0) + 1;

      // Validate required fields before sending
      const closingBal = parseFloat(closingBalance);
      if (!closingBalance || isNaN(closingBal)) {
        showDialog({ title: 'Missing Closing Balance', message: 'Please enter the statement closing balance before reconciling.', type: 'warning' });
        return;
      }
      if (!statementDate) {
        showDialog({ title: 'Missing Statement Date', message: 'Please enter the statement date before reconciling.', type: 'warning' });
        return;
      }

      // Include import_id if available for DB-based reconciliation tracking
      const completeParams = new URLSearchParams({
        bank_code: selectedBank,
        statement_number: stmtNo.toString(),
        statement_date: statementDate,
        closing_balance: closingBal.toString(),
        partial: hasUnmatched.toString(),
      });
      if (activeImportId) {
        completeParams.set('import_id', activeImportId.toString());
      }

      const response = await authFetch(
        `/api/bank-reconciliation/complete?${completeParams}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            matched_entries: selectedEntriesToReconcile,
            statement_transactions: [
              ...(matchingResult?.auto_matched || []).map(m => ({
                line_number: m.statement_line,
                date: m.statement_date,
                amount: m.statement_amount,
                reference: m.statement_reference,
                description: m.statement_description
              })),
              ...(matchingResult?.suggested_matched || []).map(m => ({
                line_number: m.statement_line,
                date: m.statement_date,
                amount: m.statement_amount,
                reference: m.statement_reference,
                description: m.statement_description
              })),
              ...(matchingResult?.unmatched_statement || []).map(u => ({
                line_number: u.statement_line,
                date: u.statement_date,
                amount: u.statement_amount,
                reference: u.statement_reference,
                description: u.statement_description
              }))
            ]
          })
        }
      );
      const data = await response.json();

      if (!response.ok) {
        const errMsg = data?.detail
          ? (Array.isArray(data.detail) ? data.detail.map((d: { msg?: string }) => d.msg).join(', ') : String(data.detail))
          : data?.error || 'Server error';
        showDialog({ title: 'Reconciliation Failed', message: errMsg, type: 'error' });
        return;
      }

      if (data.success) {
        // Mark the statement file as reconciled in the database
        const selectedFileInfo = statementFilesQuery.data?.files?.find(f => f.path === statementPath);
        if (selectedFileInfo?.filename) {
          try {
            await authFetch(
              `/api/statement-files/mark-reconciled?filename=${encodeURIComponent(selectedFileInfo.filename)}&bank_code=${selectedBank}&reconciled_count=${data.entries_reconciled}`,
              { method: 'POST' }
            );
          } catch (e) {
            console.warn('Could not mark statement as reconciled:', e);
          }
        }

        // Use server-side partial flag (auto-detected when balance doesn't match)
        const isPartial = data.partial || hasUnmatched;

        // Auto-archive is now handled server-side in the complete_reconciliation endpoint

        // Validate closing balance against Opera's new reconciled balance
        const newRecBal = data.new_reconciled_balance;
        const expectedClosing = parseFloat(closingBalance);
        // Detect closing balance mismatch (was previously a separate dialog)
        const hasClosingMismatch = newRecBal != null && !isNaN(expectedClosing) && Math.abs(newRecBal - expectedClosing) > 0.01;

        if (isPartial) {
          // Partial update: keep the matching view intact, show success indicator
          const now = new Date();
          setLastPartialUpdateInfo({
            timestamp: now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
            entriesReconciled: data.entries_reconciled || 0,
          });
          // Refresh queries so the table reflects updated reconciliation state
          queryClient.invalidateQueries({ queryKey: ['bankRecStatus', selectedBank] });
          queryClient.invalidateQueries({ queryKey: ['unreconciledEntries', selectedBank] });
          queryClient.invalidateQueries({ queryKey: ['statementFiles'] });
        } else {
          // Full reconciliation: show completion confirmation and clear the view
          setReconcileCompleteInfo({
            entriesReconciled: data.entries_reconciled || 0,
            closingBalance: newRecBal,
            isPartial: false,
            closingBalanceMismatch: hasClosingMismatch ? { expected: expectedClosing, actual: newRecBal! } : null,
          });
          // Cache the entry numbers we just reconciled so the
          // Reverse button on the success banner has them available
          // (audit 2026-05-05 stages-3-5 F10).
          setRecentlyReconciledEntries(
            selectedEntriesToReconcile.map(e => e.entry_number)
          );
          // Reset matching state but keep completion info visible
          setMatchingResult(null);
          setValidationResult(null);
          setSelectedAutoMatches(new Set());
          setSelectedSuggestedMatches(new Set());
          // Clear statement preview data
          setStatementResult(null);
          setStatementPath('');
          setProcessingError(null);
          // Refresh queries
          queryClient.invalidateQueries({ queryKey: ['bankRecStatus', selectedBank] });
          queryClient.invalidateQueries({ queryKey: ['unreconciledEntries', selectedBank] });
          queryClient.invalidateQueries({ queryKey: ['statementFiles'] });
        }
      } else {
        showDialog({ title: 'Reconciliation Failed', message: data.error || data.messages?.join(', ') || 'Unknown error', type: 'error' });
      }
    } catch (error) {
      showDialog({ title: 'Reconciliation Failed', message: `Failed to complete reconciliation: ${error}`, type: 'error' });
    } finally {
      setIsReconciling(false);
    }
  };

  // Auto-match unmatched statement lines to customers/suppliers
  const autoMatchUnmatchedLines = async (lines: UnmatchedStatementLine[]): Promise<UnmatchedStatementLine[]> => {
    if (!lines || lines.length === 0) return lines;

    try {
      const response = await authFetch('/api/cashbook/auto-match-statement-lines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines }),
      });
      const data = await response.json();

      if (data.success && data.lines) {
        return data.lines;
      }
    } catch (error) {
      console.error('Auto-match failed:', error);
    }
    return lines;
  };

  // Create cashbook entry for unmatched statement line
  const createCashbookEntry = async () => {
    if (!createEntryModal.statementLine) return;

    const line = createEntryModal.statementLine;
    setIsCreatingEntry(true);

    try {
      let data;

      // Handle bank transfer separately
      if (newEntryForm.accountType === 'bank_transfer') {
        if (!newEntryForm.destBank) {
          alert('Please select a destination bank account');
          setIsCreatingEntry(false);
          return;
        }

        // For bank transfers, source bank is the current bank account
        // Determine source/dest based on amount direction
        // Negative amount = money going OUT from this bank (this bank is source)
        // Positive amount = money coming IN to this bank (this bank is destination)
        const isOutgoing = line.statement_amount < 0;
        const sourceBank = isOutgoing ? selectedBank : newEntryForm.destBank;
        const destBank = isOutgoing ? newEntryForm.destBank : selectedBank;

        const params = new URLSearchParams({
          source_bank: sourceBank,
          dest_bank: destBank,
          amount: Math.abs(line.statement_amount).toString(),
          reference: newEntryForm.reference || line.statement_reference || '',
          date: line.statement_date || statementDate,
          comment: newEntryForm.description || line.statement_description || '',
        });

        const response = await authFetch(`/api/cashbook/create-bank-transfer?${params}`, {
          method: 'POST',
        });
        data = await response.json();

        if (data.success) {
          alert(`Bank transfer created:\n${data.source_entry} (${sourceBank}) -> ${data.dest_entry} (${destBank})\nAmount: £${data.amount?.toFixed(2)}`);
        }
      } else {
        // Existing customer/supplier/nominal logic
        let transactionType: string;
        if (line.statement_amount > 0) {
          // Money in
          if (newEntryForm.accountType === 'customer') {
            transactionType = 'sales_receipt';
          } else if (newEntryForm.accountType === 'nominal') {
            transactionType = 'nominal_receipt';
          } else {
            transactionType = 'other_receipt';
          }
        } else {
          // Money out
          if (newEntryForm.accountType === 'supplier') {
            transactionType = 'purchase_payment';
          } else if (newEntryForm.accountType === 'nominal') {
            transactionType = 'nominal_payment';
          } else {
            transactionType = 'other_payment';
          }
        }

        const requestBody: Record<string, any> = {
          bank_account: selectedBank,
          transaction_date: line.statement_date || statementDate,
          amount: Math.abs(line.statement_amount),
          reference: newEntryForm.reference || line.statement_reference,
          description: newEntryForm.description || line.statement_description,
          transaction_type: transactionType,
          account_code: newEntryForm.accountType === 'nominal' ? newEntryForm.nominalCode : newEntryForm.accountCode,
          account_type: newEntryForm.accountType,
        };
        // Include project/department codes for nominal entries
        if (newEntryForm.accountType === 'nominal') {
          if (newEntryForm.projectCode) requestBody.project_code = newEntryForm.projectCode;
          if (newEntryForm.departmentCode) requestBody.department_code = newEntryForm.departmentCode;
        }
        // Include import tracking for partial recovery
        if (activeImportId) {
          requestBody.import_id = activeImportId;
          requestBody.line_number = line.statement_line;
        }

        const response = await authFetch('/api/cashbook/create-entry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });
        data = await response.json();

        if (data.success) {
          alert(`Entry created: ${data.entry_number}`);
        }
      }

      if (data.success) {
        // Close modal and refresh
        setCreateEntryModal({ open: false, statementLine: null });
        // Re-run matching to pick up the new entry
        queryClient.invalidateQueries({ queryKey: ['unreconciledEntries', selectedBank] });
        // If we had processed a statement, re-run matching
        if (statementResult) {
          // Re-process the statement to update matches
          await processStatement();
        } else if (validationResult?.valid) {
          // Re-run matching from unreconciled
          await runMatchingFromUnreconciled();
        }
      } else if (data.duplicate) {
        // Duplicate detected - transaction already exists in Opera
        const proceed = window.confirm(
          `This transaction already exists in Opera:\n\n` +
          `${data.duplicate_details?.details || data.error}\n\n` +
          `This may have been posted since the statement was first processed, ` +
          `or the Opera data may have been restored.\n\n` +
          `Would you like to re-run matching to pick up the existing entry instead?`
        );
        if (proceed) {
          setCreateEntryModal({ open: false, statementLine: null });
          queryClient.invalidateQueries({ queryKey: ['unreconciledEntries', selectedBank] });
          await runMatchingFromUnreconciled();
        }
      } else {
        alert(`Error creating entry: ${data.error}`);
      }
    } catch (error) {
      alert(`Failed to create entry: ${error}`);
    } finally {
      setIsCreatingEntry(false);
    }
  };

  // Batch import all selected unmatched lines
  const batchImportSelected = async () => {
    const toImport = enrichedUnmatched.filter(line =>
      selectedForImport.has(line.statement_line) && line.matched_account && !deferredLines.has(line.statement_line)
    );
    if (toImport.length === 0) return;

    setIsBatchImporting(true);
    setBatchImportProgress({ total: toImport.length, completed: 0, errors: [] });

    for (const line of toImport) {
      try {
        let transactionType: string;
        if (line.statement_amount > 0) {
          transactionType = line.suggested_type === 'supplier' ? 'other_receipt' : 'sales_receipt';
        } else {
          transactionType = line.suggested_type === 'customer' ? 'other_payment' : 'purchase_payment';
        }

        const requestBody: Record<string, any> = {
          bank_account: selectedBank,
          transaction_date: line.statement_date || statementDate,
          amount: Math.abs(line.statement_amount),
          reference: line.statement_reference || '',
          description: line.statement_description || '',
          transaction_type: transactionType,
          account_code: line.matched_account,
          account_type: line.suggested_type || (line.statement_amount > 0 ? 'customer' : 'supplier'),
        };
        if (activeImportId) {
          requestBody.import_id = activeImportId;
          requestBody.line_number = line.statement_line;
        }

        const response = await authFetch('/api/cashbook/create-entry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });
        const data = await response.json();

        setBatchImportProgress(prev => prev ? {
          ...prev,
          completed: prev.completed + 1,
          errors: data.success ? prev.errors : [...prev.errors, `${line.statement_description}: ${data.error}`],
        } : null);
      } catch (error) {
        setBatchImportProgress(prev => prev ? {
          ...prev,
          completed: prev.completed + 1,
          errors: [...prev.errors, `${line.statement_description}: ${error}`],
        } : null);
      }
    }

    setIsBatchImporting(false);
    setDeferredLines(new Set());

    // Refresh data after batch import
    queryClient.invalidateQueries({ queryKey: ['unreconciledEntries', selectedBank] });
    if (statementResult) {
      await processStatement();
    } else if (validationResult?.valid) {
      await runMatchingFromUnreconciled();
    }
  };

  const formatCurrency = (value: number | undefined | null) => {
    if (value === undefined || value === null) return '';
    return Math.abs(value).toLocaleString('en-GB', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-GB');
  };

  const toggleEntry = (entryNumber: string) => {
    const newSelected = new Set(selectedEntries);
    if (newSelected.has(entryNumber)) {
      newSelected.delete(entryNumber);
    } else {
      newSelected.add(entryNumber);
    }
    setSelectedEntries(newSelected);
  };

  const toggleAll = () => {
    if (filteredEntries.length === selectedEntries.size) {
      setSelectedEntries(new Set());
    } else {
      setSelectedEntries(new Set(filteredEntries.map(e => e.ae_entry)));
    }
  };

  const handleSort = (field: 'ae_entry' | 'value_pounds' | 'ae_lstdate') => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  // Filter and sort entries
  const filteredEntries = useMemo(() => {
    let entries = entriesQuery.data?.entries || [];

    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      entries = entries.filter(
        e =>
          e.ae_entry.toLowerCase().includes(term) ||
          e.ae_entref?.toLowerCase().includes(term) ||
          e.ae_comment?.toLowerCase().includes(term)
      );
    }

    entries = [...entries].sort((a, b) => {
      let aVal: string | number = a[sortField] ?? '';
      let bVal: string | number = b[sortField] ?? '';

      if (sortField === 'value_pounds') {
        aVal = a.value_pounds;
        bVal = b.value_pounds;
      } else if (sortField === 'ae_lstdate') {
        aVal = a.ae_lstdate || '';
        bVal = b.ae_lstdate || '';
      }

      if (typeof aVal === 'string') {
        aVal = aVal.toLowerCase();
        bVal = (bVal as string).toLowerCase();
      }

      if (sortDirection === 'asc') {
        return aVal > bVal ? 1 : -1;
      } else {
        return aVal < bVal ? 1 : -1;
      }
    });

    return entries;
  }, [entriesQuery.data?.entries, searchTerm, sortField, sortDirection]);

  // Calculate totals
  const totals = useMemo(() => {
    const selected = filteredEntries.filter(e => selectedEntries.has(e.ae_entry));
    const reconciled = selected.reduce((sum, e) => sum + e.value_pounds, 0);
    const stmtBal = parseFloat(statementBalance) || 0;
    const difference = stmtBal - reconciled;

    return { reconciled, statementBalance: stmtBal, difference };
  }, [filteredEntries, selectedEntries, statementBalance]);

  // Calculate running balance for display
  const entriesWithBalance = useMemo(() => {
    let runningBalance = statusQuery.data?.reconciled_balance || 0;
    return filteredEntries.map((entry) => {
      if (selectedEntries.has(entry.ae_entry)) {
        runningBalance += entry.value_pounds;
      }
      return {
        ...entry,
        runningBalance,
        lineNumber: selectedEntries.has(entry.ae_entry)
          ? (Array.from(selectedEntries).indexOf(entry.ae_entry) + 1) * 10
          : null,
      };
    });
  }, [filteredEntries, selectedEntries, statusQuery.data?.reconciled_balance]);

  const bankDescription = banksQuery.data?.banks?.find(b => b.account_code === selectedBank)?.description || '';

  // Compute active statement info from all available data sources
  const activeStatementInfo = useMemo(() => {
    // Find matching imported statement from query data (has filename, dates, balances)
    const matchedStmt = selectedImportedStatement
      || importedStatementsQuery.data?.statements?.find(s =>
        activeImportId ? s.id === activeImportId : s.bank_code === selectedBank && !s.is_reconciled
      );

    const info = importedStatementData?.statement_info;
    if (!importedStatementData && !matchedStmt) return null;

    return {
      filename: importedStatementData?.filename || matchedStmt?.filename || null,
      bankName: `${selectedBank} — ${info?.bank_name || bankDescription || ''}`.replace(/ — $/, ''),
      accountNumber: info?.account_number || matchedStmt?.account_number || null,
      sortCode: info?.sort_code || matchedStmt?.sort_code || null,
      openingBalance: info?.opening_balance ?? matchedStmt?.opening_balance ?? null,
      closingBalance: info?.closing_balance ?? matchedStmt?.closing_balance ?? null,
      periodStart: info?.period_start || null,
      periodEnd: info?.period_end || matchedStmt?.statement_date || null,
      source: importedStatementData?.source || matchedStmt?.source || null,
      transactionCount: importedStatementData?.statement_transactions?.length
        || matchedStmt?.transactions_imported || 0,
      postedCount: postedLines.size,
      importDate: matchedStmt?.import_date || null,
    };
  }, [importedStatementData, selectedImportedStatement, importedStatementsQuery.data, activeImportId, selectedBank, bankDescription, postedLines]);

  // Auto-fill from activeStatementInfo (e.g. loaded from DB via Manage tab)
  useEffect(() => {
    if (activeStatementInfo) {
      const ob = Number(activeStatementInfo.openingBalance);
      const cb = Number(activeStatementInfo.closingBalance);
      if (!isNaN(ob) && !openingBalance) {
        setOpeningBalance(ob.toFixed(2));
      }
      if (!isNaN(cb) && !closingBalance) {
        setClosingBalance(cb.toFixed(2));
      }
      if (activeStatementInfo.periodEnd && !statementDate) {
        setStatementDate(String(activeStatementInfo.periodEnd).split('T')[0]);
      }
    }
  }, [activeStatementInfo]);

  // Whether a statement is actively being reconciled (locks bank selector)
  const hasActiveStatement = !!(importedStatementData || activeImportId);

  // Shared matching results renderer used in both auto-match and manual modes
  const renderMatchingResults = () => {
    if (!matchingResult || !matchingResult.success) return null;

    // Selected count must match the predicate used by the completion
    // payload (BankStatementReconcile.tsx:1966-1982): a row is in the
    // batch iff it's in selected*Matches AND not toggled off via
    // manualMatchOverrides. Plus any unmatched statement line the
    // operator manually toggled ✓ counts too. Without this the
    // confirmation dialog showed "5 entries" while only 3 actually
    // posted (audit finding stages-3-5 F7).
    const selectedCount =
      (matchingResult.auto_matched?.filter(m =>
        selectedAutoMatches.has(m.entry_number)
        && manualMatchOverrides.get(m.statement_line) !== false
      ).length || 0) +
      (matchingResult.suggested_matched?.filter(m =>
        selectedSuggestedMatches.has(m.entry_number)
        && manualMatchOverrides.get(m.statement_line) !== false
      ).length || 0) +
      (matchingResult.unmatched_statement?.filter(u =>
        manualMatchOverrides.get(u.statement_line) === true
      ).length || 0);

    const allMatched = matchingResult.summary != null && matchingResult.summary.unmatched_statement_count === 0;
    const stmtNo = parseInt(statementNumber) || (statusQuery.data?.last_stmt_no || 0) + 1;

    return (
      <div className="space-y-4">
        {/* Statement Table — only shown in auto-match mode (manual mode renders its own table above) */}
        {!importedStatementData && (
        <div className="bg-white border border-gray-300 rounded-lg overflow-hidden">
          <div className="bg-gray-100 px-4 py-2 border-b border-gray-300 flex justify-between items-center">
            <h3 className="font-medium text-gray-800">
              Statement {stmtNo} — {matchingResult.summary?.total_statement_lines || 0} transactions
              {allMatched ? (
                <span className="ml-2 text-green-600 text-sm">(all matched)</span>
              ) : (
                <span className="ml-2 text-red-600 text-sm">
                  ({matchingResult.summary?.unmatched_statement_count || 0} unmatched)
                </span>
              )}
            </h3>
          </div>
          <div className="max-h-96 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="w-16 px-3 py-2 text-center">Stmt #</th>
                  <th className="w-16 px-3 py-2 text-center">Line</th>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Description</th>
                  <th className="px-3 py-2 text-right">Payments</th>
                  <th className="px-3 py-2 text-right">Receipts</th>
                  <th className="px-3 py-2 text-right">Balance</th>
                  <th className="px-3 py-2 text-left">Opera Entry</th>
                  <th className="w-16 px-3 py-2 text-center">Match</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const allLines: Array<{
                    statement_line: number;
                    statement_date: string | null;
                    statement_reference: string;
                    statement_description: string;
                    statement_amount: number;
                    statement_balance: number | null;
                    entry_number: string | null;
                    type: 'matched' | 'unmatched';
                  }> = [
                    ...(matchingResult.auto_matched || []).map(m => ({
                      statement_line: m.statement_line,
                      statement_date: m.statement_date,
                      statement_reference: m.statement_reference,
                      statement_description: m.statement_description,
                      statement_amount: m.statement_amount,
                      statement_balance: m.statement_balance,
                      entry_number: m.entry_number,
                      type: 'matched' as const
                    })),
                    ...(matchingResult.suggested_matched || []).map(m => ({
                      statement_line: m.statement_line,
                      statement_date: m.statement_date,
                      statement_reference: m.statement_reference,
                      statement_description: m.statement_description,
                      statement_amount: m.statement_amount,
                      statement_balance: m.statement_balance,
                      entry_number: m.entry_number,
                      type: 'matched' as const
                    })),
                    ...(matchingResult.unmatched_statement || []).map(u => ({
                      statement_line: u.statement_line,
                      statement_date: u.statement_date,
                      statement_reference: u.statement_reference,
                      statement_description: u.statement_description,
                      statement_amount: u.statement_amount,
                      statement_balance: u.statement_balance,
                      entry_number: null,
                      type: 'unmatched' as const
                    }))
                  ].sort((a, b) => a.statement_line - b.statement_line);

                  if (selectedAutoMatches.size === 0 && selectedSuggestedMatches.size === 0) {
                    setTimeout(() => {
                      setSelectedAutoMatches(new Set((matchingResult.auto_matched || []).map(m => m.entry_number)));
                      setSelectedSuggestedMatches(new Set((matchingResult.suggested_matched || []).map(m => m.entry_number)));
                    }, 0);
                  }

                  return allLines.map((line) => {
                    const hasOverride = manualMatchOverrides.has(line.statement_line);
                    const isMatched = hasOverride
                      ? manualMatchOverrides.get(line.statement_line)!
                      : line.type === 'matched';
                    const isException = !isMatched;
                    const isManual = hasOverride && manualMatchOverrides.get(line.statement_line) !== (line.type === 'matched');
                    return (
                      <tr
                        key={line.statement_line}
                        className={`border-t ${isException ? 'bg-red-50' : ''}`}
                      >
                        <td className="px-3 py-2 text-center text-gray-600">{stmtNo}</td>
                        <td className="px-3 py-2 text-center font-medium text-gray-700">{line.statement_line * 10}</td>
                        <td className="px-3 py-2 text-gray-600">{formatDate(line.statement_date)}</td>
                        <td className="px-3 py-2">
                          <div className="truncate max-w-md">{line.statement_reference || line.statement_description}</div>
                        </td>
                        <td className="px-3 py-2 text-right font-medium text-red-600">
                          {line.statement_amount < 0 ? formatCurrency(Math.abs(line.statement_amount)) : ''}
                        </td>
                        <td className="px-3 py-2 text-right font-medium text-green-600">
                          {line.statement_amount >= 0 ? formatCurrency(line.statement_amount) : ''}
                        </td>
                        <td className="px-3 py-2 text-right text-gray-600">
                          {line.statement_balance != null ? formatCurrency(line.statement_balance) : ''}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-blue-600">
                          {line.entry_number || ''}
                        </td>
                        <td
                          className={`px-3 py-2 text-center select-none ${
                            line.entry_number ? 'cursor-pointer' : 'cursor-not-allowed'
                          }`}
                          onClick={() => {
                            // No Opera entry → no toggle. Clicking ✓ on a
                            // row that never matched would set an override
                            // the completion payload silently discards
                            // (audit 2026-05-05 stages-3-5 F8). Operators
                            // would see "matched" in the UI but the line
                            // would stay open in Opera and reappear on the
                            // next scan.
                            if (!line.entry_number) {
                              return;
                            }
                            setManualMatchOverrides(prev => {
                              const next = new Map(prev);
                              const currentlyMatched = next.has(line.statement_line)
                                ? next.get(line.statement_line)!
                                : line.type === 'matched';
                              // Toggle — if override matches original state, remove override
                              const newVal = !currentlyMatched;
                              if (newVal === (line.type === 'matched')) {
                                next.delete(line.statement_line);
                              } else {
                                next.set(line.statement_line, newVal);
                              }
                              return next;
                            });
                          }}
                          title={
                            line.entry_number
                              ? (isException
                                ? `Click to mark as matched (${line.entry_number})`
                                : `Click to unmatch (${line.entry_number})`)
                              : 'No Opera entry — post the line via the Unmatched section first'
                          }
                        >
                          {isException ? (
                            <span className={`text-red-600 ${line.entry_number ? 'hover:text-green-600' : 'opacity-50'} ${isManual ? 'ring-1 ring-red-300 rounded px-1' : ''}`}>&#x2717;</span>
                          ) : (
                            <span className={`text-green-600 ${line.entry_number ? 'hover:text-red-600' : 'opacity-50'} ${isManual ? 'ring-1 ring-blue-300 rounded px-1' : ''}`}>&#x2713;</span>
                          )}
                        </td>
                      </tr>
                    );
                  });
                })()}
              </tbody>
            </table>
          </div>
        </div>
        )}

        {/* Audit Trail - Posted Entries */}
        {postedLines.size > 0 && (
          <details className="mt-3 bg-green-50 border border-green-200 rounded-lg">
            <summary className="px-4 py-2 cursor-pointer text-sm font-medium text-green-800 hover:bg-green-100 rounded-t-lg">
              Posted to Opera: {postedLines.size} of {importedStatementData?.statement_transactions?.length || '?'} transactions
            </summary>
            <div className="px-4 py-2 border-t border-green-200">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-600">
                    <th className="text-left py-1 px-2">Line</th>
                    <th className="text-left py-1 px-2">Description</th>
                    <th className="text-right py-1 px-2">Amount</th>
                    <th className="text-left py-1 px-2">Entry Number</th>
                  </tr>
                </thead>
                <tbody>
                  {importedStatementData?.statement_transactions
                    ?.filter(t => t.posted_entry_number)
                    .map(t => (
                      <tr key={t.line_number} className="border-t border-green-100">
                        <td className="py-1 px-2 text-gray-600">{t.line_number}</td>
                        <td className="py-1 px-2 truncate max-w-xs">{t.description || t.reference}</td>
                        <td className="py-1 px-2 text-right font-medium">
                          <span className={t.amount >= 0 ? 'text-green-700' : 'text-red-700'}>
                            {formatCurrency(Math.abs(t.amount))}
                          </span>
                        </td>
                        <td className="py-1 px-2 font-mono text-green-700">{t.posted_entry_number}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </details>
        )}

        {/* Balance Summary */}
        {(() => {
          const operaRecBal = statusQuery.data?.reconciled_balance;
          const stmtClosing = activeStatementInfo?.closingBalance ?? (closingBalance ? parseFloat(closingBalance) : null);
          // Include auto/suggested matches (respecting overrides) plus manually matched unmatched lines
          const autoMatchedTotal = [
            ...(matchingResult.auto_matched || []).filter(m => selectedAutoMatches.has(m.entry_number) && manualMatchOverrides.get(m.statement_line) !== false),
            ...(matchingResult.suggested_matched || []).filter(m => selectedSuggestedMatches.has(m.entry_number) && manualMatchOverrides.get(m.statement_line) !== false),
          ].reduce((sum, m) => sum + (m.statement_amount || 0), 0);
          const manualMatchedTotal = (matchingResult.unmatched_statement || [])
            .filter(u => manualMatchOverrides.get(u.statement_line) === true)
            .reduce((sum, u) => sum + (u.statement_amount || 0), 0);
          const matchedTotal = autoMatchedTotal + manualMatchedTotal;
          const expectedClosing = operaRecBal != null ? operaRecBal + matchedTotal : null;
          const difference = stmtClosing != null && expectedClosing != null ? stmtClosing - expectedClosing : null;

          return (
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div>
                <span className="text-gray-500 text-xs font-medium">Opera Reconciled Balance</span>
                <p className="text-gray-900 font-bold">
                  {operaRecBal != null ? `£${formatCurrency(operaRecBal)}` : '—'}
                </p>
              </div>
              <div>
                <span className="text-gray-500 text-xs font-medium">Selected Entries Total</span>
                <p className={`font-bold ${matchedTotal >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                  {matchedTotal >= 0 ? '+' : ''}£{formatCurrency(matchedTotal)}
                </p>
              </div>
              <div>
                <span className="text-gray-500 text-xs font-medium">Statement Closing Balance</span>
                <p className="text-gray-900 font-bold">
                  {stmtClosing != null ? `£${formatCurrency(stmtClosing)}` : '—'}
                </p>
              </div>
              <div>
                <span className="text-gray-500 text-xs font-medium">Difference</span>
                <p className={`font-bold ${
                  difference == null ? 'text-gray-400'
                    : Math.abs(difference) < 0.01 ? 'text-green-700'
                    : 'text-red-700'
                }`}>
                  {difference != null
                    ? Math.abs(difference) < 0.01
                      ? '£0.00'
                      : `£${formatCurrency(difference)}`
                    : '—'}
                </p>
              </div>
            </div>
          );
        })()}

        {/* Action Buttons */}
        <div className="flex justify-end gap-3 pt-4">
          <button
            onClick={() => {
              setMatchingResult(null);
              setSelectedAutoMatches(new Set());
              setSelectedSuggestedMatches(new Set());
            }}
            className="px-4 py-2 border border-gray-300 rounded hover:bg-gray-50 flex items-center gap-2"
          >
            <X className="w-4 h-4" />
            Cancel
          </button>
          <button
            onClick={async () => {
              setIsRefreshing(true);
              try {
                await runMatchingFromUnreconciled();
              } finally {
                setIsRefreshing(false);
              }
            }}
            disabled={isRefreshing}
            className="px-4 py-2 border border-blue-300 text-blue-700 rounded hover:bg-blue-50 disabled:opacity-50 flex items-center gap-2"
            title="Refresh cashbook data (preserves your selections)"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            onClick={() => {
              if (allMatched) {
                showDialog({
                  title: 'Update Cashbook',
                  message: `This will mark ${selectedCount} entries as reconciled on Statement ${stmtNo}.`,
                  type: 'confirm',
                  confirmLabel: 'Update Cashbook',
                  onConfirm: () => { closeDialog(); completeEnhancedReconciliation(); },
                });
              } else {
                completeEnhancedReconciliation();
              }
            }}
            disabled={isReconciling || selectedCount === 0}
            className={`px-4 py-2 text-white rounded disabled:opacity-50 flex items-center gap-2 ${
              allMatched ? 'bg-green-600 hover:bg-green-700' : 'bg-amber-500 hover:bg-amber-600'
            }`}
            title={!allMatched ? `${matchingResult.summary?.unmatched_statement_count || 0} unmatched line(s) — partial reconciliation` : ''}
          >
            {isReconciling ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            {isReconciling ? 'Updating...' : allMatched
              ? `Update Cashbook (${selectedCount} Entries)`
              : `Update Partial (${selectedCount} of ${matchingResult.summary?.total_statement_lines || selectedCount} Entries)`
            }
          </button>
        </div>
        {lastPartialUpdateInfo && (
          <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded px-3 py-1.5 text-sm text-green-800">
            <CheckCircle className="w-4 h-4 text-green-600 flex-shrink-0" />
            <span>
              Opera updated at {lastPartialUpdateInfo.timestamp} — {lastPartialUpdateInfo.entriesReconciled} {lastPartialUpdateInfo.entriesReconciled === 1 ? 'entry' : 'entries'} reconciled
            </span>
            <button
              onClick={() => setLastPartialUpdateInfo(null)}
              className="ml-auto text-green-400 hover:text-green-600"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {!allMatched && selectedCount > 0 && !lastPartialUpdateInfo && (
          <p className="text-xs text-amber-700 text-right mt-1">
            {matchingResult.summary?.unmatched_statement_count || 0} unmatched line(s) — complete remaining in Opera Cashbook &gt; Reconcile
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6 flex justify-between items-center">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center">
            <Landmark className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900">
              Reconcile: {selectedBank}{bankDescription ? ` — ${bankDescription}` : ''}
            </h1>
            {hasActiveStatement && activeStatementInfo?.filename && (
              <p className="text-sm text-gray-500">{activeStatementInfo.filename}</p>
            )}
          </div>
        </div>
      </div>

      {/* Active Statement Info Card */}
      {hasActiveStatement && activeStatementInfo && (
        <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-xl">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 mt-0.5">
              <div className="w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center">
                <FileText className="w-4 h-4 text-white" />
              </div>
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-2">
                <h3 className="text-sm font-bold text-blue-900">Active Statement</h3>
                {activeStatementInfo.source && (
                  <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-blue-200 text-blue-800">
                    {activeStatementInfo.source === 'email' ? 'Email' : 'File Upload'}
                  </span>
                )}
                {activeStatementInfo.postedCount > 0 && (
                  <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-green-200 text-green-800">
                    {activeStatementInfo.postedCount} / {activeStatementInfo.transactionCount} posted
                  </span>
                )}
              </div>

              {activeStatementInfo.filename && (
                <p className="text-sm font-medium text-blue-800 mb-2">{activeStatementInfo.filename}</p>
              )}

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <div>
                  <span className="text-blue-600 text-xs font-medium">Bank</span>
                  <p className="text-gray-900 font-medium">{activeStatementInfo.bankName}</p>
                  {(activeStatementInfo.sortCode || activeStatementInfo.accountNumber) && (
                    <p className="text-gray-500 text-xs">
                      {activeStatementInfo.sortCode && `${activeStatementInfo.sortCode}`}
                      {activeStatementInfo.sortCode && activeStatementInfo.accountNumber && ' / '}
                      {activeStatementInfo.accountNumber && `${activeStatementInfo.accountNumber}`}
                    </p>
                  )}
                </div>
                <div>
                  <span className="text-blue-600 text-xs font-medium">Period</span>
                  <p className="text-gray-900 font-medium">
                    {activeStatementInfo.periodStart
                      ? `${formatDate(activeStatementInfo.periodStart)} — ${formatDate(activeStatementInfo.periodEnd)}`
                      : activeStatementInfo.periodEnd
                        ? formatDate(activeStatementInfo.periodEnd)
                        : '—'}
                  </p>
                </div>
                <div>
                  <span className="text-blue-600 text-xs font-medium">Opening Balance</span>
                  <p className="text-gray-900 font-medium">
                    {activeStatementInfo.openingBalance != null
                      ? `£${formatCurrency(activeStatementInfo.openingBalance)}`
                      : '—'}
                  </p>
                </div>
                <div>
                  <span className="text-blue-600 text-xs font-medium">Closing Balance</span>
                  <p className="text-gray-900 font-medium">
                    {activeStatementInfo.closingBalance != null
                      ? `£${formatCurrency(activeStatementInfo.closingBalance)}`
                      : '—'}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Reconciliation Complete Confirmation (Task 2) */}
      {reconcileCompleteInfo && (
        <div className={`mb-4 p-4 border-2 rounded-lg ${
          reconcileCompleteInfo.closingBalanceMismatch
            ? 'bg-amber-50 border-amber-400'
            : 'bg-green-50 border-green-400'
        }`}>
          <div className="flex items-start gap-3">
            {reconcileCompleteInfo.closingBalanceMismatch ? (
              <AlertCircle className="w-6 h-6 text-amber-600 flex-shrink-0 mt-0.5" />
            ) : (
              <CheckCircle className="w-6 h-6 text-green-600 flex-shrink-0 mt-0.5" />
            )}
            <div className="flex-1">
              <h3 className={`font-semibold ${reconcileCompleteInfo.closingBalanceMismatch ? 'text-amber-800' : 'text-green-800'}`}>
                {reconcileCompleteInfo.isPartial
                  ? 'Partial Reconciliation Complete'
                  : reconcileCompleteInfo.closingBalanceMismatch
                    ? 'Reconciliation Complete — Closing Balance Mismatch'
                    : 'Statement Fully Reconciled'}
              </h3>
              <div className="mt-2 grid grid-cols-2 gap-4 text-sm">
                <div className={`bg-white rounded p-2 border ${reconcileCompleteInfo.closingBalanceMismatch ? 'border-amber-200' : 'border-green-200'}`}>
                  <span className="text-gray-600">Entries reconciled:</span>
                  <span className={`ml-2 font-bold ${reconcileCompleteInfo.closingBalanceMismatch ? 'text-amber-800' : 'text-green-800'}`}>
                    {reconcileCompleteInfo.entriesReconciled}
                  </span>
                </div>
                {reconcileCompleteInfo.closingBalance != null && (
                  <div className={`bg-white rounded p-2 border ${reconcileCompleteInfo.closingBalanceMismatch ? 'border-amber-200' : 'border-green-200'}`}>
                    <span className="text-gray-600">{reconcileCompleteInfo.isPartial ? 'Reconciled balance:' : 'Closing balance:'}</span>
                    <span className={`ml-2 font-bold ${reconcileCompleteInfo.closingBalanceMismatch ? 'text-amber-800' : 'text-green-800'}`}>
                      {'\u00A3'}{reconcileCompleteInfo.closingBalance.toLocaleString('en-GB', { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                )}
              </div>
              {reconcileCompleteInfo.closingBalanceMismatch && (
                <p className="text-sm text-amber-700 mt-2">
                  Opera reconciled balance ({'\u00A3'}{reconcileCompleteInfo.closingBalanceMismatch.actual.toLocaleString('en-GB', { minimumFractionDigits: 2 })})
                  differs from statement closing balance ({'\u00A3'}{reconcileCompleteInfo.closingBalanceMismatch.expected.toLocaleString('en-GB', { minimumFractionDigits: 2 })})
                  by {'\u00A3'}{Math.abs(reconcileCompleteInfo.closingBalanceMismatch.actual - reconcileCompleteInfo.closingBalanceMismatch.expected).toLocaleString('en-GB', { minimumFractionDigits: 2 })}.
                  This may indicate unmatched items. Review in Opera Cashbook &gt; Reconcile.
                </p>
              )}
              {reconcileCompleteInfo.isPartial && !reconcileCompleteInfo.closingBalanceMismatch && (
                <p className="text-sm text-green-700 mt-2">
                  Complete the remaining items in Opera Cashbook &gt; Reconcile.
                </p>
              )}
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => {
                    setReconcileCompleteInfo(null);
                    setOpeningBalance('');
                    setClosingBalance('');
                    setImportedStatementData(null as any);
                    setActiveImportId(null);
                    setRecentlyReconciledEntries([]);
                    if (onReconcileComplete) {
                      onReconcileComplete();
                    }
                  }}
                  className={`px-4 py-2 text-sm text-white rounded ${
                    reconcileCompleteInfo.closingBalanceMismatch ? 'bg-amber-600 hover:bg-amber-700' : 'bg-green-600 hover:bg-green-700'
                  }`}
                >
                  Back to Statements
                </button>
                {recentlyReconciledEntries.length > 0 && (
                  <button
                    onClick={() => { setReverseError(null); setReverseModalOpen(true); }}
                    className="px-4 py-2 text-sm rounded border border-gray-400 text-gray-700 hover:bg-gray-50"
                    title="Undo this reconciliation — clears the rec stamp from the just-reconciled entries and reverts nbank to the prior batch's state. Postings are NOT reversed."
                  >
                    Reverse this rec
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Reverse-rec confirmation modal — audit 2026-05-05 stages-3-5 F10 */}
      {reverseModalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-30 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full mx-4 p-5">
            <h3 className="font-semibold text-gray-900 text-lg">Reverse this reconciliation?</h3>
            <p className="text-sm text-gray-700 mt-3">
              This will:
            </p>
            <ul className="text-sm text-gray-700 list-disc ml-6 mt-1 space-y-1">
              <li>Clear the rec stamp ({reconcileCompleteInfo?.entriesReconciled} {reconcileCompleteInfo?.entriesReconciled === 1 ? 'entry' : 'entries'}) so they show as unreconciled in Opera again.</li>
              <li>Revert <code className="text-xs bg-gray-100 px-1 rounded">nbank</code> rec balance, last-statement number / date, and partial-rec carry-forward to the prior batch's state.</li>
              <li>NOT reverse the underlying postings — bank, nominal, ledger entries stay in Opera. Only the rec status is undone.</li>
            </ul>
            <p className="text-sm text-gray-700 mt-3">
              You should only do this if the rec was wrong. Continue?
            </p>
            {reverseError && (
              <div className="mt-3 p-2 text-sm bg-red-50 border border-red-200 text-red-800 rounded">
                {reverseError}
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => { setReverseModalOpen(false); setReverseError(null); }}
                disabled={reverseInProgress}
                className="px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  setReverseInProgress(true);
                  setReverseError(null);
                  try {
                    const resp = await authFetch(
                      `/api/reconcile/bank/${selectedBank}/unreconcile`,
                      {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(recentlyReconciledEntries),
                      },
                    );
                    const data = await resp.json();
                    if (!resp.ok || data?.success === false) {
                      setReverseError(data?.error || `Reversal failed (${resp.status})`);
                      return;
                    }
                    setReverseModalOpen(false);
                    setReconcileCompleteInfo(null);
                    setRecentlyReconciledEntries([]);
                    setOpeningBalance('');
                    setClosingBalance('');
                    setImportedStatementData(null as any);
                    setActiveImportId(null);
                    queryClient.invalidateQueries({ queryKey: ['bankRecStatus', selectedBank] });
                    queryClient.invalidateQueries({ queryKey: ['unreconciledEntries', selectedBank] });
                    queryClient.invalidateQueries({ queryKey: ['statementFiles'] });
                    if (onReconcileComplete) onReconcileComplete();
                  } catch (e: any) {
                    setReverseError(String(e));
                  } finally {
                    setReverseInProgress(false);
                  }
                }}
                disabled={reverseInProgress}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
              >
                {reverseInProgress ? 'Reversing…' : 'Reverse rec'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Balance Mismatch Warning Banner (Task 1) */}
      {balanceMismatch && !balanceMismatchAcknowledged && !reconcileCompleteInfo && (
        <div className="mb-4 p-4 bg-red-50 border-2 border-red-400 rounded-lg">
          <div className="flex items-start gap-3">
            <AlertCircle className="w-6 h-6 text-red-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <h3 className="font-semibold text-red-800">
                Balance Mismatch Detected
              </h3>
              <p className="text-sm text-red-700 mt-1">
                The Opera reconciled balance does not match the opening balance of this statement.
                This can happen if the Opera data has been restored to an earlier or later point.
              </p>
              <div className="mt-3 grid grid-cols-2 gap-4 text-sm">
                <div className="bg-white rounded p-2 border border-red-200">
                  <span className="text-gray-600">Opera reconciled balance:</span>
                  <span className="ml-2 font-bold text-red-800">{'\u00A3'}{formatCurrency(balanceMismatch.operaBalance)}</span>
                </div>
                <div className="bg-white rounded p-2 border border-red-200">
                  <span className="text-gray-600">Statement opening balance:</span>
                  <span className="ml-2 font-bold text-red-800">{'\u00A3'}{formatCurrency(balanceMismatch.statementBalance)}</span>
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => setBalanceMismatchAcknowledged(true)}
                  className="px-4 py-2 text-sm text-white bg-amber-600 rounded hover:bg-amber-700"
                >
                  Proceed Anyway
                </button>
                <p className="text-xs text-red-600 self-center">
                  You may also clear this statement and re-import once the Opera data aligns.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Persistent amber warning when balance mismatch has been acknowledged */}
      {balanceMismatch && balanceMismatchAcknowledged && !reconcileCompleteInfo && (
        <div className="mb-4 p-3 bg-amber-50 border border-amber-300 rounded-lg flex items-center gap-2">
          <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0" />
          <p className="text-sm text-amber-800">
            <span className="font-medium">Balance mismatch acknowledged.</span>{' '}
            Opera reconciled balance ({'\u00A3'}{formatCurrency(balanceMismatch.operaBalance)}) differs from
            statement opening balance ({'\u00A3'}{formatCurrency(balanceMismatch.statementBalance)}).
            Reconciliation results may not balance correctly.
          </p>
        </div>
      )}

      {/* Bank Selector Row */}
      <div className="bg-gray-100 border border-gray-300 rounded p-3 mb-4">
        <div className="flex items-center gap-6 flex-wrap">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">Bank:</label>
            {hasActiveStatement ? (
              <div className="border border-gray-300 rounded px-2 py-1 min-w-[250px] bg-gray-50 text-gray-700">
                {bankDescription || selectedBank}
              </div>
            ) : (
              <select
                value={selectedBank}
                onChange={e => {
                  handleBankChange(e.target.value);
                  setSelectedEntries(new Set());
                }}
                className="border border-gray-400 rounded px-2 py-1 min-w-[250px] bg-white"
              >
                {banksQuery.data?.banks?.map(bank => (
                  <option key={bank.account_code} value={bank.account_code}>
                    {bank.description || bank.account_code}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">Statement Date:</label>
            <input
              type="date"
              value={statementDate}
              onChange={e => setStatementDate(e.target.value)}
              className="border border-gray-400 rounded px-2 py-1 bg-white"
              readOnly={hasActiveStatement}
            />
          </div>

          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">Closing Balance:</label>
            <div className="flex items-center">
              <span className="text-gray-500 mr-1">£</span>
              <input
                type="number"
                step="0.01"
                value={closingBalance}
                onChange={e => setClosingBalance(e.target.value)}
                placeholder="0.00"
                className="border border-gray-400 rounded px-2 py-1 w-32 bg-white text-right"
              />
            </div>
          </div>

          <button
            onClick={() => {
              statusQuery.refetch();
              entriesQuery.refetch();
            }}
            className="p-1 text-gray-600 hover:text-gray-800 hover:bg-gray-200 rounded"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${statusQuery.isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Info: Existing partial reconciliation markers */}
      {statusQuery.data?.reconciliation_in_progress && (
        <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 mb-4 flex items-start gap-2">
          <span className="text-amber-500 text-lg">ℹ</span>
          <div className="flex-1">
            <p className="text-amber-800 text-sm">
              {statusQuery.data.reconciliation_in_progress_message ||
                `${statusQuery.data.partial_entries || 0} entries have partial reconciliation markers.`}
            </p>
          </div>
        </div>
      )}

      {/* Reconciliation In Progress - prominent amber banner (hide when active statement card is showing) */}
      {importedStatementsQuery.data?.statements && importedStatementsQuery.data.statements.length > 0 && !hasActiveStatement && (
        <div className="mb-4 p-4 bg-amber-50 border-2 border-amber-300 rounded-lg">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 mt-0.5">
              <div className="w-6 h-6 bg-amber-400 rounded-full flex items-center justify-center">
                <RefreshCw className="w-3.5 h-3.5 text-amber-900" />
              </div>
            </div>
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-amber-900">
                Reconciliation In Progress
              </h3>
              <p className="text-sm text-amber-700 mt-0.5 mb-3">
                {importedStatementsQuery.data.count === 1
                  ? 'A statement has been imported and is awaiting reconciliation. Resume or clear to start fresh.'
                  : `${importedStatementsQuery.data.count} statements have been imported and are awaiting reconciliation.`}
                {postedLines.size > 0 && (
                  <span className="ml-2 text-green-700 font-medium">
                    ({postedLines.size} of {(importedStatementData as any)?.statement_transactions?.length || '?'} transactions posted to Opera)
                  </span>
                )}
              </p>
              <div className="space-y-2">
                {importedStatementsQuery.data.statements.slice(0, 3).map(stmt => (
                  <div
                    key={stmt.id}
                    className={`flex items-center justify-between p-2 rounded cursor-pointer transition-colors ${
                      selectedImportedStatement?.id === stmt.id
                        ? 'bg-amber-200 border border-amber-400'
                        : 'bg-white border border-amber-100 hover:bg-amber-100'
                    }`}
                    onClick={async () => {
                      setSelectedImportedStatement(stmt);
                      // Auto-load statement data on click (same as Resume)
                      if (stmt.stored_transaction_count && stmt.stored_transaction_count > 0) {
                        await loadStatementFromDb(stmt.id, stmt);
                      }
                    }}
                  >
                    <div className="flex-1">
                      <p className="text-sm font-medium text-gray-800">{stmt.filename}</p>
                      <p className="text-xs text-gray-600">
                        {stmt.source === 'email' ? '📧 Email' : '📄 File'} •
                        {stmt.transactions_imported} txns •
                        Imported {new Date(stmt.import_date).toLocaleDateString()}
                        {stmt.stored_transaction_count ? (
                          <span className="ml-1 text-amber-600" title="Statement transactions stored in database - survives browser close">• Saved</span>
                        ) : null}
                        {stmt.email_subject && <span className="ml-1 text-gray-500">• {stmt.email_subject}</span>}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          setSelectedImportedStatement(stmt);

                          // Try loading statement transactions from DB first (persisted across sessions)
                          if (stmt.stored_transaction_count && stmt.stored_transaction_count > 0) {
                            const loaded = await loadStatementFromDb(stmt.id, stmt);
                            if (loaded) return; // DB load succeeded - no need for file
                          }

                          // Fallback: Find the PDF path from statement files list
                          const matchedFile = statementFilesQuery.data?.files?.find(
                            f => f.filename === stmt.filename
                          );
                          if (matchedFile) {
                            setStatementPath(matchedFile.path);
                            setSelectedFile(matchedFile.path);
                  
                            setPendingReconcileProcess(true);
                          } else {
                            // PDF not found in known folders - let user enter path manually
                  
                            setProcessingError(`Could not find PDF file "${stmt.filename}" in bank statement folders. Please select it manually.`);
                          }
                        }}
                        disabled={isLoadingFromDb}
                        className="px-3 py-1 text-sm bg-amber-600 text-white rounded hover:bg-amber-700 disabled:opacity-50"
                      >
                        {isLoadingFromDb ? 'Loading...' : 'Resume'}
                      </button>
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          const confirmed = window.confirm(
                            `Are you sure you want to clear this statement?\n\n` +
                            `"${stmt.filename}"\n\n` +
                            `This will remove the import record and all statement data, ` +
                            `allowing you to start fresh with a new statement import.\n\n` +
                            `Note: Any transactions already posted to Opera will NOT be affected.`
                          );
                          if (!confirmed) return;
                          try {
                            await authFetch(`/api/bank-import/import-history/${stmt.id}`, { method: 'DELETE' });
                            queryClient.invalidateQueries({ queryKey: ['importedStatements'] });
                            // If this was the active import, clear frontend state too
                            if (activeImportId === stmt.id) {
                              sessionStorage.removeItem(storageKey('statementResult', selectedBank));
                              sessionStorage.removeItem(storageKey('matchingResult', selectedBank));
                              sessionStorage.removeItem(storageKey('validationResult', selectedBank));
                              setStatementResult(null);
                              setMatchingResult(null);
                              setValidationResult(null);
                              setSelectedMatches(new Set());
                              setSelectedAutoMatches(new Set());
                              setSelectedSuggestedMatches(new Set());
                              setProcessingError(null);
                              setOpeningBalance('');
                              setClosingBalance('');
                              setActiveImportId(null);
                              setBalanceMismatch(null);
                              setBalanceMismatchAcknowledged(false);
                              setReconcileCompleteInfo(null);
                              setImportedStatementData(null as any);
                            }
                          } catch (err) {
                            console.error('Failed to delete import record:', err);
                          }
                        }}
                        className="px-3 py-1 text-sm bg-white text-gray-600 border border-gray-300 rounded hover:bg-red-50 hover:border-red-300 hover:text-red-700"
                        title="Clear this statement and start fresh"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Auto-match mode removed - reconcile always uses statement-centric view via Hub → Import workflow */}
      {false ? (
        <div>
          {/* Balance Mismatch Blocker */}
          {balanceMismatch && (
            <div className="mb-4 p-4 bg-red-50 border-2 border-red-400 rounded-lg">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-6 h-6 text-red-600 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <h3 className="font-semibold text-red-800">
                    Reconciliation Blocked — Balance Mismatch
                  </h3>
                  <p className="text-sm text-red-700 mt-1">
                    The Opera reconciled balance no longer matches the opening balance of this statement.
                    This can happen if the Opera data has been restored to an earlier or later point.
                  </p>
                  <div className="mt-3 grid grid-cols-2 gap-4 text-sm">
                    <div className="bg-white rounded p-2 border border-red-200">
                      <span className="text-gray-600">Opera reconciled balance:</span>
                      <span className="ml-2 font-bold text-red-800">{formatCurrency(balanceMismatch!.operaBalance)}</span>
                    </div>
                    <div className="bg-white rounded p-2 border border-red-200">
                      <span className="text-gray-600">Statement opening balance:</span>
                      <span className="ml-2 font-bold text-red-800">{formatCurrency(balanceMismatch!.statementBalance)}</span>
                    </div>
                  </div>
                  <p className="text-sm text-red-700 mt-3 font-medium">
                    Clear this statement and re-import once the Opera data aligns with the correct statement period.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Expected Opening Balance */}
          {statusQuery.data?.reconciled_balance != null && !statementResult && !balanceMismatch && (
            <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
              <p className="text-sm text-blue-800">
                <span className="font-medium">Next statement must have opening balance:</span>{' '}
                <span className="text-lg font-bold text-blue-900">
                  {formatCurrency(statusQuery.data!.reconciled_balance)}
                </span>
                <span className="text-blue-600 ml-2 text-xs">
                  (Opera reconciled balance for {bankDescription || selectedBank})
                </span>
              </p>
            </div>
          )}

          {/* Statement Upload Section - hidden when statement already loaded from import */}
          {!hasActiveStatement && (
          <div className={`rounded-lg p-4 mb-4 border ${statementResult ? 'bg-amber-50 border-amber-300' : 'bg-blue-50 border-blue-200'}`}>
            <div className="flex items-center gap-2 mb-3">
              <Upload className={`w-5 h-5 ${statementResult ? 'text-amber-600' : 'text-blue-600'}`} />
              <h2 className={`font-medium ${statementResult ? 'text-amber-900' : 'text-blue-900'}`}>
                {statementResult ? 'Statement In Preview' : 'Process Bank Statement'}
              </h2>
              {statementResult && (
                <span className="ml-2 px-2 py-0.5 text-xs font-semibold rounded-full bg-amber-200 text-amber-800">
                  IN PREVIEW
                </span>
              )}
              {/* Show import/reconciliation status of selected file */}
              {(() => {
                const _fi = statementFilesQuery.data?.files?.find(f => f.path === statementPath);
                if (!_fi) return null;
                const fi: StatementFile = _fi!;

                if (fi.is_reconciled) {
                  return (
                    <span className="ml-2 px-2 py-0.5 text-xs font-semibold rounded-full bg-green-200 text-green-800 flex items-center gap-1">
                      <CheckCircle className="w-3 h-3" />
                      RECONCILED
                      {fi.reconciled_count && (
                        <span className="text-green-600">({fi.reconciled_count} entries)</span>
                      )}
                    </span>
                  );
                } else if (fi.is_imported) {
                  return (
                    <span className="ml-2 px-2 py-0.5 text-xs font-semibold rounded-full bg-amber-200 text-amber-800 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" />
                      IMPORTED - NOT RECONCILED
                      {fi.transactions_imported && (
                        <span className="text-amber-600">({fi.transactions_imported} txns)</span>
                      )}
                    </span>
                  );
                }
                return null;
              })()}
            </div>

            <div className="flex gap-3 items-end">
              <div className="flex-1">
                <div className="flex items-center justify-between mb-1">
                  <label className="text-sm text-gray-600">Statement File (PDF)</label>
                  <button
                    onClick={() => {
                      setUseManualPath(!useManualPath);
                      if (!useManualPath) {
                        setSelectedFile('');
                      }
                    }}
                    className={`text-xs ${statementResult ? 'text-amber-600 hover:text-amber-800' : 'text-blue-600 hover:text-blue-800'}`}
                  >
                    {useManualPath ? 'Browse files' : 'Enter path manually'}
                  </button>
                </div>

                {useManualPath ? (
                  <input
                    type="text"
                    value={statementPath}
                    onChange={e => setStatementPath(e.target.value)}
                    placeholder="/Users/maccb/Downloads/Statement.pdf"
                    className="w-full border border-gray-300 rounded px-3 py-2"
                  />
                ) : (
                  <div className="relative">
                    <select
                      value={statementPath}
                      onChange={e => {
                        setStatementPath(e.target.value);
                        setSelectedFile(e.target.value);
                      }}
                      className="w-full border border-gray-300 rounded px-3 py-2 pr-8 appearance-none bg-white"
                    >
                      <option value="">-- Select a statement file --</option>
                      {statementFilesQuery.data?.files?.map(file => {
                        // Determine status icon and label
                        let statusIcon = '○';  // Not imported
                        let statusLabel = '';
                        if (file.is_reconciled) {
                          statusIcon = '✓';
                          statusLabel = ' [RECONCILED]';
                        } else if (file.is_imported) {
                          statusIcon = '⬤';
                          statusLabel = ' [IMPORTED]';
                        }
                        return (
                          <option
                            key={file.path}
                            value={file.path}
                            className={file.is_reconciled ? 'text-green-700' : file.is_imported ? 'text-amber-700' : ''}
                          >
                            {statusIcon} [{file.folder}] {file.filename} ({file.modified_formatted}){statusLabel}
                          </option>
                        );
                      })}
                    </select>
                    <ChevronDown className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                    {statementFilesQuery.data && (
                      <p className="text-xs text-gray-500 mt-1">
                        {statementFilesQuery.data!.count} files
                        {statementFilesQuery.data!.imported_count > 0 && (
                          <span className="text-amber-600 ml-2">
                            ({statementFilesQuery.data!.imported_count} imported)
                          </span>
                        )}
                        {statementFilesQuery.data!.reconciled_count > 0 && (
                          <span className="text-green-600 ml-1">
                            ({statementFilesQuery.data!.reconciled_count} reconciled)
                          </span>
                        )}
                      </p>
                    )}
                    {statementFilesQuery.data?.count === 0 && (
                      <p className="text-xs text-amber-600 mt-1">
                        No PDF files found. Use "Enter path manually" or add files to bank-statements folders.
                      </p>
                    )}
                  </div>
                )}
              </div>

              <button
                onClick={() => statementFilesQuery.refetch()}
                className="p-2 text-gray-600 hover:text-gray-800 hover:bg-gray-200 rounded"
                title="Refresh file list"
              >
                <FolderOpen className={`w-5 h-5 ${statementFilesQuery.isFetching ? 'animate-pulse' : ''}`} />
              </button>

              {/* Preview PDF Button */}
              <button
                onClick={() => {
                  const _token = localStorage.getItem('auth_token') || '';
                  // Resolve full path: use statementPath if it looks like a full path,
                  // otherwise look up from statement files list by filename
                  let viewPath = statementPath.trim();
                  if (viewPath && !viewPath.includes('/')) {
                    // Just a filename — try to find full path from statement files
                    const matched = statementFilesQuery.data?.files?.find(
                      f => f.filename === viewPath || f.path?.endsWith(viewPath)
                    );
                    if (matched?.path) viewPath = matched.path;
                    // Also try importedStatementData filename
                    if (!matched && importedStatementData?.filename) {
                      const matchByImport = statementFilesQuery.data?.files?.find(
                        f => f.filename === importedStatementData.filename
                      );
                      if (matchByImport?.path) viewPath = matchByImport.path;
                    }
                  }
                  if (viewPath) {
                    window.open(`/api/file/view?path=${encodeURIComponent(viewPath)}&token=${encodeURIComponent(_token)}`, '_blank');
                  }
                }}
                disabled={!statementPath.trim()}
                className="px-4 py-2 bg-gray-100 text-gray-700 border border-gray-300 rounded disabled:opacity-50 flex items-center gap-2 hover:bg-gray-200"
                title="Preview the PDF statement"
              >
                <Search className="w-4 h-4" />
                Preview
              </button>

              <button
                onClick={processStatement}
                disabled={isProcessing || !statementPath.trim()}
                className={`px-4 py-2 text-white rounded disabled:opacity-50 flex items-center gap-2 ${statementResult ? 'bg-amber-600 hover:bg-amber-700' : 'bg-blue-600 hover:bg-blue-700'}`}
              >
                {isProcessing ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <FileText className="w-4 h-4" />
                )}
                {isProcessing ? 'Processing...' : statementResult ? 'Process New Statement' : 'Process Statement'}
              </button>

              {/* Clear button - only show if there's data to clear */}
              {(statementResult || matchingResult || validationResult) && (
                <button
                  onClick={clearStatementData}
                  className="px-4 py-2 bg-gray-100 text-gray-700 border border-gray-300 rounded flex items-center gap-2 hover:bg-red-50 hover:border-red-300 hover:text-red-700"
                  title="Clear all statement data and start fresh"
                >
                  <X className="w-4 h-4" />
                  Clear
                </button>
              )}
            </div>

            {/* Imported Statements section moved to above mode toggle */}

            {/* Info for imported-but-not-reconciled statements */}
            {(() => {
              const _sfi = statementFilesQuery.data?.files?.find(f => f.path === statementPath);
              if (!_sfi) return null;
              const selectedFileInfo: StatementFile = _sfi!;
              if (selectedFileInfo.is_imported && !selectedFileInfo.is_reconciled) {
                return (
                  <div className="mt-3 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                    <div className="flex items-start gap-2">
                      <AlertCircle className="w-5 h-5 text-blue-600 mt-0.5 flex-shrink-0" />
                      <div className="flex-1">
                        <p className="text-sm text-blue-800 font-medium">
                          Statement was imported on {selectedFileInfo.import_date ? new Date(selectedFileInfo.import_date!).toLocaleDateString() : 'unknown date'}
                          {' '}({selectedFileInfo.transactions_imported || 0} transactions).
                        </p>
                        <p className="text-sm text-blue-700">
                          Click "Process Statement" to continue with reconciliation, or use the "Reconcile" button above.
                        </p>
                      </div>
                    </div>
                  </div>
                );
              }
              return null;
            })()}

            {/* Processing Error Display */}
            {processingError && (
              <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2">
                <span className="text-red-500 mt-0.5">⚠</span>
                <div className="flex-1">
                  <p className="text-sm text-red-800 font-medium">Processing Failed</p>
                  <p className="text-sm text-red-700">{processingError}</p>
                </div>
                <button
                  onClick={() => setProcessingError(null)}
                  className="text-red-400 hover:text-red-600 text-lg leading-none"
                >
                  ×
                </button>
              </div>
            )}
          </div>
          )}

          {/* Statement Results */}
          {statementResult && (
            <div className="space-y-4">
              {/* Opera Reconciliation Status - reliable data from Opera */}
              {statementResult!.opera_status && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <h3 className="font-medium mb-2 flex items-center gap-2 text-blue-800">
                    <FileText className="w-4 h-4" />
                    Last Reconciled Position (Opera)
                  </h3>
                  <div className="grid grid-cols-4 gap-4 text-sm">
                    <div>
                      <span className="text-gray-600">Last Statement:</span>{' '}
                      <span className="font-medium text-blue-900">#{statementResult!.opera_status!.last_statement_number || 0}</span>
                    </div>
                    <div>
                      <span className="text-gray-600">Last Reconciled:</span>{' '}
                      <span className="font-medium text-blue-900">{formatDate(statementResult!.opera_status!.last_reconciliation_date)}</span>
                    </div>
                    <div>
                      <span className="text-gray-600">Reconciled Balance:</span>{' '}
                      <span className="font-medium text-blue-900">{formatCurrency(statementResult!.opera_status!.reconciled_balance)}</span>
                    </div>
                    <div>
                      <span className="text-gray-600">Current Book Balance:</span>{' '}
                      <span className="font-medium text-blue-900">{formatCurrency(statementResult!.opera_status!.current_balance)}</span>
                    </div>
                  </div>
                  <p className="text-xs text-blue-600 mt-2">
                    The next statement should have an opening balance of {formatCurrency(statementResult!.opera_status!.reconciled_balance)}
                  </p>
                </div>
              )}

              {/* Preview Statement Button */}
              <div className="flex justify-end">
                <button
                  onClick={() => setShowAllTransactions(!showAllTransactions)}
                  className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                >
                  <Search className="w-4 h-4" />
                  {showAllTransactions ? 'Hide Preview' : 'Preview Statement'} ({statementResult!.extracted_transactions} transactions)
                  <ChevronDown className={`w-4 h-4 transition-transform ${showAllTransactions ? 'rotate-180' : ''}`} />
                </button>
              </div>

              {/* All Statement Transactions (Collapsible) */}
              {showAllTransactions && (
                <div className="bg-white border border-blue-200 rounded-lg overflow-hidden">
                  <div className="bg-blue-50 px-4 py-3 border-b border-blue-200">
                    <h3 className="font-medium text-blue-900 flex items-center gap-2">
                      <FileText className="w-4 h-4" />
                      All Statement Transactions
                    </h3>
                    <p className="text-xs text-blue-700 mt-1">Review all extracted transactions from the statement before proceeding</p>
                  </div>
                  <div className="max-h-96 overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 sticky top-0">
                        <tr>
                          <th className="px-3 py-2 text-left">#</th>
                          <th className="px-3 py-2 text-left">Date</th>
                          <th className="px-3 py-2 text-left">Description</th>
                          <th className="px-3 py-2 text-right">Amount</th>
                          <th className="px-3 py-2 text-right">Balance</th>
                          <th className="px-3 py-2 text-center">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {/* Combine matched and unmatched transactions */}
                        {[
                          ...(statementResult!.matches?.map((m, i) => ({
                            idx: i,
                            date: m.statement_txn.date,
                            description: m.statement_txn.description,
                            amount: m.statement_txn.amount,
                            balance: m.statement_txn.balance,
                            matched: true,
                          })) || []),
                          ...(statementResult!.unmatched_statement?.map((t, i) => ({
                            idx: (statementResult!.matches?.length || 0) + i,
                            date: t.date,
                            description: t.description,
                            amount: t.amount,
                            balance: t.balance,
                            matched: false,
                          })) || []),
                        ]
                          .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
                          .map((txn, idx) => (
                            <tr key={idx} className={`border-t ${txn.matched ? 'bg-green-50' : 'bg-orange-50'}`}>
                              <td className="px-3 py-2 text-gray-500">{idx + 1}</td>
                              <td className="px-3 py-2">{formatDate(txn.date)}</td>
                              <td className="px-3 py-2 max-w-xs truncate" title={txn.description}>
                                {txn.description}
                              </td>
                              <td className={`px-3 py-2 text-right font-medium ${txn.amount >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                {formatCurrency(txn.amount)}
                              </td>
                              <td className="px-3 py-2 text-right text-gray-600">
                                {txn.balance != null ? formatCurrency(txn.balance) : '-'}
                              </td>
                              <td className="px-3 py-2 text-center">
                                {txn.matched ? (
                                  <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-100 px-2 py-0.5 rounded">
                                    <Check className="w-3 h-3" /> Matched
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 text-xs text-orange-700 bg-orange-100 px-2 py-0.5 rounded">
                                    <AlertCircle className="w-3 h-3" /> Unmatched
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Summary Stats */}
              <div className="grid grid-cols-4 gap-4">
                <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
                  <div className="text-2xl font-bold text-gray-900">{statementResult!.extracted_transactions}</div>
                  <div className="text-sm text-gray-500">Statement Transactions</div>
                </div>
                <div className="bg-white border border-gray-200 rounded-lg p-4 text-center">
                  <div className="text-2xl font-bold text-gray-900">{statementResult!.opera_unreconciled}</div>
                  <div className="text-sm text-gray-500">Opera Unreconciled</div>
                </div>
                <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-center">
                  <div className="text-2xl font-bold text-green-600">{statementResult!.matches?.length || 0}</div>
                  <div className="text-sm text-green-700">Matched</div>
                </div>
                <div className="bg-orange-50 border border-orange-200 rounded-lg p-4 text-center">
                  <div className="text-2xl font-bold text-orange-600">
                    {(statementResult!.unmatched_statement?.length || 0) + (statementResult!.unmatched_opera?.length || 0)}
                  </div>
                  <div className="text-sm text-orange-700">Unmatched</div>
                </div>
              </div>

              {/* Matched Transactions */}
              {statementResult!.matches && statementResult!.matches!.length > 0 && (
                <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                  <div className="bg-green-50 px-4 py-3 border-b border-green-200 flex justify-between items-center">
                    <h3 className="font-medium text-green-900 flex items-center gap-2">
                      <CheckCircle className="w-4 h-4" />
                      Matched Transactions ({selectedMatches.size}/{statementResult!.matches!.length} selected)
                    </h3>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setSelectedMatches(new Set(statementResult!.matches!.map((_, i) => i)))}
                        className="text-sm text-green-700 hover:text-green-900"
                      >
                        Select All
                      </button>
                      <span className="text-gray-300">|</span>
                      <button
                        onClick={() => setSelectedMatches(new Set())}
                        className="text-sm text-green-700 hover:text-green-900"
                      >
                        Select None
                      </button>
                    </div>
                  </div>
                  <div className="max-h-96 overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 sticky top-0">
                        <tr>
                          <th className="w-8 px-2 py-2"></th>
                          <th className="px-3 py-2 text-left">Statement</th>
                          <th className="px-3 py-2 text-left">Opera Entry</th>
                          <th className="px-3 py-2 text-right">Amount</th>
                          <th className="px-3 py-2 text-center">Score</th>
                        </tr>
                      </thead>
                      <tbody>
                        {statementResult!.matches!.map((match, idx) => (
                          <tr
                            key={idx}
                            className={`border-t cursor-pointer hover:bg-gray-50 ${
                              selectedMatches.has(idx) ? 'bg-green-50' : ''
                            }`}
                            onClick={() => {
                              const newSelected = new Set(selectedMatches);
                              if (newSelected.has(idx)) {
                                newSelected.delete(idx);
                              } else {
                                newSelected.add(idx);
                              }
                              setSelectedMatches(newSelected);
                            }}
                          >
                            <td className="px-2 py-2 text-center">
                              <input
                                type="checkbox"
                                checked={selectedMatches.has(idx)}
                                onChange={() => {}}
                                className="rounded"
                              />
                            </td>
                            <td className="px-3 py-2">
                              <div className="font-medium">{formatDate(match.statement_txn.date)}</div>
                              <div className="text-xs text-gray-500 truncate max-w-xs" title={match.statement_txn.description}>
                                {match.statement_txn.description}
                              </div>
                            </td>
                            <td className="px-3 py-2">
                              <div className="font-medium">{match.opera_entry.ae_ref}</div>
                              <div className="text-xs text-gray-500">{formatDate(match.opera_entry.ae_date)}</div>
                            </td>
                            <td className={`px-3 py-2 text-right font-medium ${match.statement_txn.amount < 0 ? 'text-red-600' : 'text-green-600'}`}>
                              {match.statement_txn.amount < 0 ? '-' : '+'}
                              {formatCurrency(match.statement_txn.amount)}
                            </td>
                            <td className="px-3 py-2 text-center">
                              <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                                match.match_score >= 0.9 ? 'bg-green-100 text-green-800' :
                                match.match_score >= 0.8 ? 'bg-yellow-100 text-yellow-800' :
                                'bg-orange-100 text-orange-800'
                              }`}>
                                {Math.round(match.match_score * 100)}%
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Categorized Unmatched Statement Transactions */}
              {(() => {
                const unmatchedLines: UnmatchedStatementLine[] = enrichedUnmatched.length > 0
                  ? enrichedUnmatched
                  : (statementResult!.unmatched_statement || []).map((txn: any, i: number) => ({
                      statement_line: i + 1,
                      statement_date: txn.date,
                      statement_amount: txn.amount,
                      statement_reference: txn.description || '',
                      statement_description: txn.description || '',
                      statement_balance: txn.balance ?? null,
                    }));

                if (unmatchedLines.length === 0) return null;

                const receipts = unmatchedLines.filter(l => l.statement_amount > 0 && l.matched_account);
                const payments = unmatchedLines.filter(l => l.statement_amount < 0 && l.matched_account);
                const unassigned = unmatchedLines.filter(l => !l.matched_account);

                const selectedCount = unmatchedLines.filter(l => selectedForImport.has(l.statement_line) && l.matched_account).length;

                const renderCategoryTable = (
                  title: string,
                  lines: UnmatchedStatementLine[],
                  borderColor: string,
                  headerBg: string,
                  textColor: string,
                ) => {
                  if (lines.length === 0) return null;
                  const allSelected = lines.filter(l => l.matched_account).every(l => selectedForImport.has(l.statement_line));
                  return (
                    <div className={`bg-white border ${borderColor} rounded-lg overflow-hidden`}>
                      <div className={`${headerBg} px-4 py-3 border-b ${borderColor} flex justify-between items-center`}>
                        <h3 className={`font-medium ${textColor} flex items-center gap-2`}>
                          {title === 'Unassigned' ? <AlertCircle className="w-4 h-4" /> : <CheckCircle className="w-4 h-4" />}
                          {title} ({lines.length})
                        </h3>
                      </div>
                      <div className="max-h-60 overflow-y-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-gray-50 sticky top-0">
                            <tr>
                              <th className="px-3 py-2 text-center w-10">
                                <input
                                  type="checkbox"
                                  checked={allSelected && lines.some(l => l.matched_account)}
                                  onChange={(e) => {
                                    const newSet = new Set(selectedForImport);
                                    lines.forEach(l => {
                                      if (e.target.checked && l.matched_account) newSet.add(l.statement_line);
                                      else newSet.delete(l.statement_line);
                                    });
                                    setSelectedForImport(newSet);
                                  }}
                                  disabled={lines.every(l => !l.matched_account)}
                                  title="Select all"
                                />
                              </th>
                              <th className="px-3 py-2 text-left">Date</th>
                              <th className="px-3 py-2 text-left">Description</th>
                              <th className="px-3 py-2 text-left">Customer/Supplier</th>
                              <th className="px-3 py-2 text-right">Amount</th>
                              <th className="px-3 py-2 text-center w-32">Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {lines.map((line) => {
                              const isGcFx = /INTSYSUKLTD-[A-Z0-9]{6}/i.test(line.statement_description || '');
                              const globalIdx = enrichedUnmatched.indexOf(line);
                              const isVoiceActive = globalIdx === voiceLineIndex;
                              return (
                                <tr
                                  key={line.statement_line}
                                  id={`voice-line-${globalIdx}`}
                                  onClick={() => setVoiceLineIndex(globalIdx)}
                                  className={`border-t hover:bg-gray-50 cursor-pointer ${isGcFx ? 'bg-purple-50' : ''} ${isVoiceActive ? 'ring-2 ring-blue-400 bg-blue-50' : ''}`}
                                >
                                  <td className="px-3 py-2 text-center">
                                    <input
                                      type="checkbox"
                                      checked={selectedForImport.has(line.statement_line)}
                                      onChange={(e) => {
                                        const newSet = new Set(selectedForImport);
                                        if (e.target.checked) newSet.add(line.statement_line);
                                        else newSet.delete(line.statement_line);
                                        setSelectedForImport(newSet);
                                      }}
                                      disabled={!line.matched_account}
                                    />
                                  </td>
                                  <td className="px-3 py-2">{formatDate(line.statement_date)}</td>
                                  <td className="px-3 py-2 text-gray-600 truncate max-w-xs" title={line.statement_description}>
                                    {line.statement_description}
                                    {isGcFx && (
                                      <span className="ml-2 inline-flex items-center px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded text-xs font-medium">
                                        GoCardless FX
                                      </span>
                                    )}
                                  </td>
                                  <td className="px-3 py-2">
                                    {line.matched_name ? (
                                      <div>
                                        <span className="font-medium">{line.matched_name}</span>
                                        <span className="ml-1 text-xs text-gray-500">({line.matched_account})</span>
                                        {line.match_method && (
                                          <span className="ml-1 text-xs px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded">
                                            {line.match_method}
                                          </span>
                                        )}
                                      </div>
                                    ) : (
                                      <span className="text-gray-400 italic">No match</span>
                                    )}
                                  </td>
                                  <td className={`px-3 py-2 text-right font-medium ${line.statement_amount < 0 ? 'text-red-600' : 'text-green-600'}`}>
                                    {line.statement_amount < 0 ? '-' : '+'}
                                    {formatCurrency(line.statement_amount)}
                                  </td>
                                  <td className="px-3 py-2 text-center">
                                    {deferredLines.has(line.statement_line) ? (
                                      <div className="flex items-center justify-center gap-1">
                                        <span
                                          className="text-xs px-2 py-1 bg-amber-100 text-amber-800 rounded inline-flex items-center gap-1"
                                          title="This row will not be imported. It will reappear on the next scan unless it has been entered into Opera manually."
                                        >
                                          <Clock className="h-3 w-3" />
                                          Awaiting manual entry
                                        </span>
                                        <button
                                          onClick={() => {
                                            const next = new Set(deferredLines);
                                            next.delete(line.statement_line);
                                            setDeferredLines(next);
                                          }}
                                          className="text-xs px-2 py-1 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded"
                                          title="Undo defer"
                                        >
                                          Undo
                                        </button>
                                      </div>
                                    ) : (
                                      <div className="flex items-center justify-center gap-1">
                                        <button
                                          onClick={() => {
                                            setNewEntryForm({
                                              accountCode: line.matched_account || '',
                                              accountType: line.suggested_type || (line.statement_amount > 0 ? 'customer' : 'supplier'),
                                              nominalCode: '',
                                              reference: line.statement_reference || '',
                                              description: line.statement_description || '',
                                              destBank: '',
                                              projectCode: '',
                                              departmentCode: '',
                                            });
                                            setCreateEntryModal({ open: true, statementLine: line });
                                          }}
                                          className="text-xs px-2 py-1 text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded"
                                          title="Assign or edit customer/supplier/nominal"
                                        >
                                          Assign
                                        </button>
                                        <button
                                          onClick={() => {
                                            const next = new Set(deferredLines);
                                            next.add(line.statement_line);
                                            setDeferredLines(next);
                                            // Audit immediately on defer click — fire-and-forget,
                                            // never blocks the UI. Captures every defer even if
                                            // the user never reaches batch-import.
                                            authFetch(`/api/reconcile/bank/${selectedBank}/audit-defer`, {
                                              method: 'POST',
                                              headers: { 'Content-Type': 'application/json' },
                                              body: JSON.stringify({
                                                items: [{
                                                  statement_date: line.statement_date || '',
                                                  amount: line.statement_amount || 0,
                                                  description: line.statement_description || '',
                                                }],
                                              }),
                                            }).catch(err => console.warn('Defer audit failed (non-blocking):', err));
                                          }}
                                          className="text-xs px-2 py-1 text-amber-600 hover:text-amber-800 hover:bg-amber-50 rounded"
                                          title="Mark as awaiting manual entry — will not be imported, will reappear on next scan"
                                        >
                                          Defer
                                        </button>
                                        <button
                                          onClick={() => setIgnoreConfirm({
                                            date: line.statement_date || '',
                                            description: line.statement_description,
                                            amount: line.statement_amount,
                                          })}
                                          className="text-xs px-2 py-1 text-orange-600 hover:text-orange-800 hover:bg-orange-50 rounded"
                                          title="Ignore this transaction (already entered in Opera)"
                                        >
                                          Ignore
                                        </button>
                                      </div>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                };

                return (
                  <div className="space-y-3">
                    {/* Import Selected bar */}
                    {selectedCount > 0 && (
                      <div className="flex items-center justify-between bg-blue-50 border border-blue-200 rounded-lg px-4 py-3">
                        <span className="text-sm text-blue-800 font-medium">
                          {selectedCount} transaction(s) selected for import
                        </span>
                        <button
                          onClick={batchImportSelected}
                          disabled={isBatchImporting}
                          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2 text-sm font-medium"
                        >
                          {isBatchImporting ? (
                            <>
                              <RefreshCw className="w-4 h-4 animate-spin" />
                              Importing {batchImportProgress?.completed || 0}/{batchImportProgress?.total || 0}...
                            </>
                          ) : (
                            <>
                              <Plus className="w-4 h-4" />
                              Import {selectedCount} Selected
                            </>
                          )}
                        </button>
                      </div>
                    )}

                    {/* Batch import results */}
                    {batchImportProgress && !isBatchImporting && (() => {
                      const bp = batchImportProgress!;
                      return (
                      <div className={`border rounded-lg p-3 ${bp.errors.length > 0 ? 'bg-red-50 border-red-200' : 'bg-green-50 border-green-200'}`}>
                        <div className="flex items-center justify-between">
                          <p className={`text-sm font-medium ${bp.errors.length > 0 ? 'text-red-800' : 'text-green-800'}`}>
                            Import complete: {bp.completed - bp.errors.length} succeeded
                            {bp.errors.length > 0 && `, ${bp.errors.length} failed`}
                          </p>
                          <button onClick={() => setBatchImportProgress(null)} className="text-gray-400 hover:text-gray-600 text-lg leading-none">&times;</button>
                        </div>
                        {bp.errors.length > 0 && (
                          <ul className="text-xs text-red-700 mt-1 space-y-0.5">
                            {bp.errors.map((err, i) => <li key={i}>{err}</li>)}
                          </ul>
                        )}
                      </div>
                      );
                    })()}

                    {/* Matched Receipts (green) */}
                    {renderCategoryTable('Receipts', receipts, 'border-green-200', 'bg-green-50', 'text-green-900')}

                    {/* Matched Payments (red) */}
                    {renderCategoryTable('Payments', payments, 'border-red-200', 'bg-red-50', 'text-red-900')}

                    {/* Unassigned (orange) */}
                    {renderCategoryTable('Unassigned', unassigned, 'border-orange-200', 'bg-orange-50', 'text-orange-900')}
                  </div>
                );
              })()}

              {/* Guidance when no matches found */}
              {(!statementResult!.matches || statementResult!.matches!.length === 0) && statementResult!.unmatched_statement && statementResult!.unmatched_statement!.length > 0 && (
                <div className="bg-amber-50 border border-amber-300 rounded-lg p-4">
                  <h4 className="font-medium text-amber-800 mb-2 flex items-center gap-2">
                    <AlertCircle className="w-4 h-4" />
                    No Automatic Matches Found
                  </h4>
                  <p className="text-sm text-amber-700 mb-3">
                    The statement transactions couldn't be matched to Opera entries. This usually means:
                  </p>
                  <ul className="text-sm text-amber-700 list-disc list-inside mb-3 space-y-1">
                    <li>The transactions haven't been imported yet (use Imports page first)</li>
                    <li>The entries were imported with different dates</li>
                    <li>You're processing a different statement than the one imported</li>
                  </ul>
                  <p className="text-sm text-amber-700">
                    <strong>Options:</strong> Use the "Statement Balance Validation" section below to manually select and reconcile Opera entries,
                    or switch to "Manual Mode" for direct entry selection.
                  </p>
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => {
                    setStatementResult(null);
                    setSelectedMatches(new Set());
                  }}
                  className="px-4 py-2 border border-gray-300 rounded hover:bg-gray-50 flex items-center gap-2"
                >
                  <X className="w-4 h-4" />
                  Cancel
                </button>
                {statementResult!.matches && statementResult!.matches!.length > 0 && (
                  <button
                    onClick={confirmMatches}
                    disabled={selectedMatches.size === 0}
                    className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 flex items-center gap-2"
                  >
                    <Check className="w-4 h-4" />
                    Reconcile {selectedMatches.size} Matches
                  </button>
                )}
                {/* When no matches, offer to dismiss and use manual reconciliation */}
                {(!statementResult!.matches || statementResult!.matches!.length === 0) && (
                  <button
                    onClick={() => {
                      setStatementResult(null);
                      setSelectedMatches(new Set());
                    }}
                    className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 flex items-center gap-2"
                  >
                    <Check className="w-4 h-4" />
                    Continue to Manual Reconciliation
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Enhanced Reconciliation Section */}
          <div className="mt-6 border-t border-gray-300 pt-6">
            <div className="flex items-center gap-2 mb-4">
              <Landmark className="w-5 h-5 text-blue-600" />
              <h2 className="font-medium text-gray-900">Statement Balance Validation</h2>
              <div className="group relative">
                <HelpCircle className="w-4 h-4 text-gray-400 cursor-help" />
                <div className="hidden group-hover:block absolute left-0 top-6 w-64 p-2 bg-gray-800 text-white text-xs rounded shadow-lg z-10">
                  Enter the opening and closing balance from your bank statement.
                  The opening balance must match Opera's expected balance from the last reconciliation.
                </div>
              </div>
            </div>

            {/* Balance Inputs */}
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-4">
              <div className="grid grid-cols-4 gap-4">
                <div>
                  <label className="text-sm text-gray-600 block mb-1">Opening Balance</label>
                  <div className="flex items-center">
                    <span className="text-gray-500 mr-1">£</span>
                    <input
                      type="number"
                      step="0.01"
                      value={openingBalance}
                      onChange={e => setOpeningBalance(e.target.value)}
                      placeholder="0.00"
                      className="w-full border border-gray-300 rounded px-2 py-1"
                    />
                  </div>
                  {statusQuery.data && (
                    <p className="text-xs text-gray-500 mt-1">
                      Expected: £{statusQuery.data!.reconciled_balance?.toLocaleString('en-GB', { minimumFractionDigits: 2 })}
                    </p>
                  )}
                </div>
                <div>
                  <label className="text-sm text-gray-600 block mb-1">Closing Balance</label>
                  <div className="flex items-center">
                    <span className="text-gray-500 mr-1">£</span>
                    <input
                      type="number"
                      step="0.01"
                      value={closingBalance}
                      onChange={e => setClosingBalance(e.target.value)}
                      placeholder="0.00"
                      className="w-full border border-gray-300 rounded px-2 py-1"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-sm text-gray-600 block mb-1">Statement Date</label>
                  <input
                    type="date"
                    value={statementDate}
                    onChange={e => setStatementDate(e.target.value)}
                    className="w-full border border-gray-300 rounded px-2 py-1"
                  />
                </div>
                <div className="flex items-end">
                  <button
                    onClick={validateStatement}
                    disabled={isValidating || !openingBalance || !closingBalance}
                    className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
                  >
                    {isValidating ? (
                      <RefreshCw className="w-4 h-4 animate-spin" />
                    ) : (
                      <Check className="w-4 h-4" />
                    )}
                    Validate
                  </button>
                </div>
              </div>
            </div>

            {/* Validation Result */}
            {validationResult && (
              <div className={`p-4 rounded-lg mb-4 ${
                validationResult!.valid
                  ? 'bg-green-50 border border-green-200'
                  : 'bg-red-50 border border-red-200'
              }`}>
                <div className="flex items-center gap-2">
                  {validationResult!.valid ? (
                    <CheckCircle className="w-5 h-5 text-green-600" />
                  ) : (
                    <AlertCircle className="w-5 h-5 text-red-600" />
                  )}
                  <span className={`font-medium ${validationResult!.valid ? 'text-green-800' : 'text-red-800'}`}>
                    {validationResult!.valid
                      ? 'Opening balance validated - ready to reconcile'
                      : 'Opening balance mismatch'}
                  </span>
                </div>
                {!validationResult!.valid && validationResult!.error_message && (
                  <p className="mt-2 text-sm text-red-700">{validationResult!.error_message}</p>
                )}
                {validationResult!.valid && validationResult!.next_statement_number && (
                  <p className="mt-2 text-sm text-green-700">
                    Statement number: {validationResult!.next_statement_number}
                  </p>
                )}
              </div>
            )}

            {/* Matching Results - Simple Statement Lines View */}
            {renderMatchingResults()}
          </div>

          {/* No results message */}
          {!statementResult && !isProcessing && !matchingResult && (
            <div className="bg-white border border-gray-200 rounded-lg p-8 text-center text-gray-500">
              <FileText className="w-12 h-12 mx-auto mb-3 text-gray-300" />
              <p>Process a bank statement above, or enter opening/closing balance to validate and run matching</p>
            </div>
          )}
        </div>
      ) : (
        /* ==================== MANUAL MODE ==================== */
        <div>
          {isLoadingFromDb && (
            <div className="bg-white border border-blue-200 rounded-lg p-8 text-center text-blue-600">
              <RefreshCw className="w-8 h-8 animate-spin mx-auto mb-3" />
              <p className="font-medium">Loading statement transactions...</p>
            </div>
          )}
          {!isLoadingFromDb && importedStatementData ? (
            /* Statement-centric view: mirrors the Process & Import reconcile screen */
            <div className="space-y-4">
              {/* Matching status indicator */}
              {(pendingAutoMatch || isRefreshing) && (
                <div className="flex items-center gap-2 text-sm text-blue-600">
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>Matching statement transactions with Opera cashbook...</span>
                </div>
              )}

              {/* Statement Transactions Table — always visible when data loaded */}
              {importedStatementData.statement_transactions?.length > 0 && (() => {
                try {
                  const stmtTxns = importedStatementData.statement_transactions;
                  const stmtNo = parseInt(statementNumber) || (statusQuery.data?.last_stmt_no || 0) + 1;
                  const postedCount = stmtTxns.filter((t: any) => t.posted_entry_number).length;
                  const safeCurrency = (v: any) => { const n = Number(v); return isNaN(n) ? '0.00' : n.toFixed(2); };

                  // Build match info from matchingResult if available.
                  // already_reconciled lines are also treated as 'matched'
                  // for display purposes — they show ✓ in the Match column
                  // alongside auto/suggested matches, because from the
                  // operator's point of view they're done.
                  const matchedLines = new Set<number>();
                  const alreadyReconciledLines = new Set<number>();
                  const matchedEntryByLine = new Map<number, string>();
                  if (matchingResult) {
                    matchingResult.auto_matched?.forEach(m => {
                      matchedLines.add(m.statement_line);
                      matchedEntryByLine.set(m.statement_line, m.entry_number);
                    });
                    matchingResult.suggested_matched?.forEach(m => {
                      matchedLines.add(m.statement_line);
                      matchedEntryByLine.set(m.statement_line, m.entry_number);
                    });
                    matchingResult.already_reconciled?.forEach(m => {
                      matchedLines.add(m.statement_line);
                      alreadyReconciledLines.add(m.statement_line);
                      matchedEntryByLine.set(m.statement_line, m.entry_number);
                    });
                  }

                  return (
                    <div className="bg-white rounded border border-green-200 overflow-hidden">
                      <div className="px-3 py-2 bg-green-100 border-b border-green-200 flex justify-between items-center">
                        <span className="text-sm font-medium text-green-800">
                          Statement {stmtNo} — {stmtTxns.length} transactions
                          {matchingResult ? (
                            matchingResult.summary != null && matchingResult.summary.unmatched_statement_count === 0
                              ? <span className="ml-2 text-green-600">
                                  • All {stmtTxns.length} matched to Opera
                                  {alreadyReconciledLines.size > 0 && (
                                    <span className="text-green-700"> ({alreadyReconciledLines.size} already reconciled)</span>
                                  )}
                                </span>
                              : <span className="ml-2">
                                  <span className="text-green-600">• {matchedLines.size} matched</span>
                                  {alreadyReconciledLines.size > 0 && (
                                    <span className="text-green-700"> ({alreadyReconciledLines.size} already reconciled)</span>
                                  )}
                                  <span className="text-red-600 ml-1">• {matchingResult.summary?.unmatched_statement_count || 0} unmatched</span>
                                </span>
                          ) : postedCount > 0 ? (
                            <span className="ml-2 text-green-600">• {postedCount} posted to Opera</span>
                          ) : null}
                        </span>
                      </div>
                      <div className="max-h-[500px] overflow-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-green-50 sticky top-0">
                            <tr>
                              <th className="px-2 py-2 text-center text-green-800 font-bold w-16">Line #</th>
                              <th className="px-2 py-2 text-left text-green-800">Date</th>
                              <th className="px-2 py-2 text-left text-green-800">Description</th>
                              <th className="px-2 py-2 text-right text-green-800">Payments</th>
                              <th className="px-2 py-2 text-right text-green-800">Receipts</th>
                              <th className="px-2 py-2 text-right text-green-800">Balance</th>
                              <th className="px-2 py-2 text-left text-green-800">Opera Entry</th>
                              <th className="px-2 py-2 text-center text-green-800 w-20">Match</th>
                            </tr>
                          </thead>
                          <tbody>
                            {stmtTxns.map((txn: any, idx: number) => {
                              const lineNumber = (Number(txn.line_number) || idx + 1) * 10;
                              const amt = Number(txn.amount) || 0;
                              const isPosted = !!txn.posted_entry_number;
                              const stmtLineNum = Number(txn.line_number) || idx + 1;
                              const isMatched = matchingResult ? matchedLines.has(stmtLineNum) : false;
                              const matchedEntry = txn.posted_entry_number || matchedEntryByLine.get(stmtLineNum);

                              return (
                                <tr key={idx} className={`border-t border-green-100 ${isPosted || isMatched ? 'bg-white' : 'bg-gray-50'}`}>
                                  <td className="px-2 py-2 text-center font-bold text-green-700 bg-green-50">
                                    {lineNumber}
                                  </td>
                                  <td className="px-2 py-2 whitespace-nowrap">
                                    {typeof txn.date === 'string' ? txn.date.split('T')[0] : txn.date || '-'}
                                  </td>
                                  <td className="px-2 py-2 truncate max-w-[300px]" title={txn.description || ''}>
                                    {txn.description || '-'}
                                  </td>
                                  <td className="px-2 py-2 text-right font-mono text-red-600">
                                    {amt < 0 ? `£${safeCurrency(Math.abs(amt))}` : ''}
                                  </td>
                                  <td className="px-2 py-2 text-right font-mono text-green-600">
                                    {amt > 0 ? `£${safeCurrency(amt)}` : ''}
                                  </td>
                                  <td className="px-2 py-2 text-right font-mono text-gray-700">
                                    {txn.balance != null ? `£${safeCurrency(txn.balance)}` : ''}
                                  </td>
                                  <td className="px-2 py-2 font-mono text-xs text-blue-600">
                                    {matchedEntry || <span className="text-gray-400">—</span>}
                                  </td>
                                  <td className="px-2 py-2 text-center">
                                    {isPosted || isMatched ? (
                                      <CheckCircle className="w-4 h-4 text-green-500 mx-auto" />
                                    ) : matchingResult ? (
                                      <XCircle className="w-4 h-4 text-red-400 mx-auto" />
                                    ) : (
                                      <span className="text-gray-400 text-xs">—</span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                } catch (err) {
                  return (
                    <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
                      <p className="font-medium">Error rendering statement table</p>
                      <p className="mt-1 font-mono text-xs">{String(err)}</p>
                    </div>
                  );
                }
              })()}

              {/* Matching results detail (Update Cashbook button etc.) */}
              {renderMatchingResults()}

              {/* Run Matching button — only when no matching result yet (buttons in renderMatchingResults handle re-match) */}
              {!pendingAutoMatch && !isRefreshing && !matchingResult && (
                <div className="flex items-center gap-3">
                  <button
                    onClick={async () => {
                      setIsRefreshing(true);
                      try {
                        await runMatchingFromUnreconciled();
                      } finally {
                        setIsRefreshing(false);
                      }
                    }}
                    disabled={isRefreshing}
                    className="px-3 py-1.5 border border-blue-300 text-blue-700 rounded hover:bg-blue-50 disabled:opacity-50 flex items-center gap-2 text-sm"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Run Matching
                  </button>
                </div>
              )}
            </div>
          ) : (
            /* Old manual view for standalone reconciliation (no imported statement) */
            <div>

          {/* Search */}
          <div className="mb-2 flex items-center gap-4">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-gray-700">Statement #:</label>
              <input
                type="number"
                value={statementNumber}
                onChange={e => setStatementNumber(e.target.value)}
                placeholder={String((statusQuery.data?.last_stmt_no || 0) + 1)}
                className="border border-gray-400 rounded px-2 py-1 w-24 bg-white"
              />
            </div>
            <div className="relative">
              <Search className="w-4 h-4 absolute left-2 top-1/2 transform -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="Search..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="pl-8 pr-3 py-1 border border-gray-400 rounded w-48 text-sm"
              />
            </div>
            <button
              onClick={toggleAll}
              className="px-2 py-1 text-xs border border-gray-400 rounded hover:bg-gray-100 flex items-center gap-1"
            >
              {filteredEntries.length === selectedEntries.size ? (
                <CheckSquare className="w-3 h-3" />
              ) : (
                <Square className="w-3 h-3" />
              )}
              {filteredEntries.length === selectedEntries.size ? 'Untick All' : 'Tick All'}
            </button>
          </div>

          {orphanTmpstatQuery.data?.success && orphanTmpstatQuery.data.count > 0 && (
            <div className="my-3 p-3 bg-amber-50 border border-amber-300 rounded-md">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-semibold text-amber-900">
                    {orphanTmpstatQuery.data.count} orphan partial-reconcile reservation{orphanTmpstatQuery.data.count === 1 ? '' : 's'}
                  </p>
                  <p className="text-xs text-amber-800 mt-1">
                    These entries have a ae_tmpstat marker from an earlier reconcile
                    attempt that did not finalise. Until cleared, they block the
                    entries from being reconciled normally.
                  </p>
                  <details className="mt-2 text-xs">
                    <summary className="cursor-pointer text-amber-900">Show entries</summary>
                    <ul className="mt-1 ml-4 list-disc text-amber-800">
                      {(orphanTmpstatQuery.data.entries || []).map((e: any) => (
                        <li key={e.entry}>
                          <span className="font-mono">{e.entry}</span> · {e.date} · £{Number(e.value).toFixed(2)} · tmpstat={e.tmpstat}
                        </li>
                      ))}
                    </ul>
                  </details>
                </div>
                <button
                  onClick={() => clearOrphanTmpstatMutation.mutate()}
                  disabled={clearOrphanTmpstatMutation.isPending}
                  className="px-3 py-1.5 text-sm font-medium bg-amber-200 hover:bg-amber-300 border border-amber-400 rounded disabled:opacity-50"
                >
                  {clearOrphanTmpstatMutation.isPending ? 'Clearing…' : 'Clear all'}
                </button>
              </div>
              {clearOrphanTmpstatMutation.isSuccess && (
                <p className="text-xs text-green-700 mt-2">
                  Cleared {clearOrphanTmpstatMutation.data?.cleared || 0} reservation(s).
                </p>
              )}
              {clearOrphanTmpstatMutation.isError && (
                <p className="text-xs text-red-700 mt-2">
                  {clearOrphanTmpstatMutation.error?.message}
                </p>
              )}
            </div>
          )}

          {/* Entries Table */}
          <div className="border border-gray-400 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-200 border-b border-gray-400">
                  <th className="w-8 px-1 py-2 text-center border-r border-gray-300"></th>
                  <th
                    className="px-2 py-2 text-left font-medium text-gray-700 border-r border-gray-300 cursor-pointer hover:bg-gray-300"
                    onClick={() => handleSort('ae_lstdate')}
                  >
                    <div className="flex items-center gap-1">
                      Date
                      <ArrowUpDown className="w-3 h-3" />
                    </div>
                  </th>
                  <th
                    className="px-2 py-2 text-left font-medium text-gray-700 border-r border-gray-300 cursor-pointer hover:bg-gray-300"
                    onClick={() => handleSort('ae_entry')}
                  >
                    <div className="flex items-center gap-1">
                      Reference
                      <ArrowUpDown className="w-3 h-3" />
                    </div>
                  </th>
                  <th className="px-2 py-2 text-left font-medium text-gray-700 border-r border-gray-300">
                    Cashbook Type
                  </th>
                  <th
                    className="px-2 py-2 text-right font-medium text-gray-700 border-r border-gray-300 cursor-pointer hover:bg-gray-300"
                    onClick={() => handleSort('value_pounds')}
                  >
                    <div className="flex items-center justify-end gap-1">
                      Payments
                      <ArrowUpDown className="w-3 h-3" />
                    </div>
                  </th>
                  <th className="px-2 py-2 text-right font-medium text-gray-700 border-r border-gray-300">
                    Receipts
                  </th>
                  <th className="px-2 py-2 text-right font-medium text-gray-700 border-r border-gray-300">
                    Balance
                  </th>
                  <th className="px-2 py-2 text-right font-medium text-gray-700 w-16">
                    Line
                  </th>
                </tr>
              </thead>
              <tbody>
                {entriesQuery.isLoading ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                      <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2" />
                      Loading...
                    </td>
                  </tr>
                ) : filteredEntries.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                      <CheckCircle className="w-5 h-5 mx-auto mb-2 text-green-500" />
                      No unreconciled entries
                    </td>
                  </tr>
                ) : (
                  entriesWithBalance.map((entry, idx) => {
                    const isSelected = selectedEntries.has(entry.ae_entry);
                    const isPayment = entry.value_pounds < 0;

                    return (
                      <tr
                        key={entry.ae_entry}
                        className={`border-b border-gray-200 cursor-pointer ${
                          isSelected ? 'bg-blue-100' : idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'
                        } hover:bg-blue-50`}
                        onClick={() => toggleEntry(entry.ae_entry)}
                      >
                        <td className="px-1 py-1 text-center border-r border-gray-200">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleEntry(entry.ae_entry)}
                            onClick={e => e.stopPropagation()}
                            className="rounded border-gray-400"
                          />
                        </td>
                        <td className="px-2 py-1 border-r border-gray-200 text-gray-700">
                          {formatDate(entry.ae_lstdate)}
                        </td>
                        <td className="px-2 py-1 border-r border-gray-200 text-gray-900">
                          {entry.ae_entref?.trim() || entry.ae_entry}
                        </td>
                        <td className="px-2 py-1 border-r border-gray-200 text-gray-700">
                          {entry.ae_cbtype?.trim() || '-'}
                        </td>
                        <td className="px-2 py-1 border-r border-gray-200 text-right text-gray-900">
                          {isPayment ? formatCurrency(entry.value_pounds) : ''}
                        </td>
                        <td className="px-2 py-1 border-r border-gray-200 text-right text-gray-900">
                          {!isPayment ? formatCurrency(entry.value_pounds) : ''}
                        </td>
                        <td className="px-2 py-1 border-r border-gray-200 text-right text-gray-900">
                          {isSelected ? formatCurrency(entry.runningBalance) : ''}
                        </td>
                        <td className="px-2 py-1 text-right text-gray-900">
                          {entry.lineNumber || ''}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Footer */}
          <div className="bg-gray-100 border border-t-0 border-gray-400 px-4 py-3 flex justify-between items-center">
            <div className="flex gap-8">
              <div>
                <span className="text-sm text-gray-600">Statement Balance: </span>
                <span className="font-medium">{formatCurrency(totals.statementBalance)}</span>
              </div>
              <div>
                <span className="text-sm text-gray-600">Reconciled: </span>
                <span className="font-medium">{formatCurrency(totals.reconciled)}</span>
              </div>
              <div>
                <span className="text-sm text-gray-600">Difference: </span>
                <span className={`font-medium ${Math.abs(totals.difference) < 0.01 ? 'text-green-600' : 'text-red-600'}`}>
                  {formatCurrency(totals.difference)}
                </span>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => markReconciledMutation.mutate()}
                disabled={selectedEntries.size === 0 || markReconciledMutation.isPending}
                className="px-4 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 text-sm"
              >
                {markReconciledMutation.isPending ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <CheckCircle className="w-4 h-4" />
                )}
                Post (F5)
              </button>
              <button
                onClick={() => setSelectedEntries(new Set())}
                className="px-4 py-1.5 border border-gray-400 rounded hover:bg-gray-100 text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
            </div>
          )}
        </div>
      )}

      {/* Status Messages */}
      {markReconciledMutation.isSuccess && (
        <div className="mt-3 p-3 bg-green-50 border border-green-200 text-green-800 rounded text-sm">
          {markReconciledMutation.data?.message}
        </div>
      )}

      {markReconciledMutation.isError && (
        <div className="mt-3 p-3 bg-red-50 border border-red-200 text-red-800 rounded text-sm">
          Error: {markReconciledMutation.error?.message}
        </div>
      )}

      {/* Summary Info */}
      <div className="mt-4 text-xs text-gray-500">
        <span>{filteredEntries.length} unreconciled entries</span>
        {selectedEntries.size > 0 && (
          <span className="ml-4">{selectedEntries.size} selected for reconciliation</span>
        )}
      </div>

      {/* Archived Statements */}
      <div className="mt-6 border border-gray-200 rounded-lg">
        <button
          onClick={() => setShowArchive(!showArchive)}
          className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 rounded-lg"
        >
          <div className="flex items-center gap-2">
            <Archive className="w-4 h-4 text-gray-500" />
            <span>Archived Statements</span>
            {archiveQuery.data?.count != null && showArchive && (
              <span className="text-xs text-gray-400">({archiveQuery.data.count})</span>
            )}
          </div>
          {showArchive ? (
            <ChevronDown className="w-4 h-4 text-gray-400" />
          ) : (
            <ChevronRight className="w-4 h-4 text-gray-400" />
          )}
        </button>

        {showArchive && (
          <div className="border-t border-gray-200 px-4 py-3">
            {archiveQuery.isLoading && (
              <div className="flex items-center gap-2 text-sm text-gray-500 py-4 justify-center">
                <RefreshCw className="w-4 h-4 animate-spin" />
                Loading archive history...
              </div>
            )}

            {archiveQuery.isError && (
              <div className="text-sm text-red-600 py-2">
                Failed to load archive history: {archiveQuery.error?.message}
              </div>
            )}

            {archiveQuery.data && archiveQuery.data.history.length === 0 && (
              <div className="text-sm text-gray-500 py-4 text-center">
                No archived statements yet. Statements are archived after successful reconciliation.
              </div>
            )}

            {archiveQuery.data && archiveQuery.data.history.length > 0 && (
              <div className="max-h-80 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Filename</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Archived</th>
                      <th className="px-3 py-2 text-right text-xs font-medium text-gray-500">Txns</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Status</th>
                      <th className="px-3 py-2 text-right text-xs font-medium text-gray-500"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {archiveQuery.data.history.map((entry: ArchiveLogEntry, idx: number) => (
                      <tr key={idx} className="border-t border-gray-100 hover:bg-gray-50">
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1.5">
                            <FileText className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                            <span className="font-medium text-gray-900 truncate max-w-[200px]" title={entry.filename}>
                              {entry.filename}
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-gray-600 whitespace-nowrap">
                          {new Date(entry.archived_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                        </td>
                        <td className="px-3 py-2 text-right text-gray-600">
                          {String(entry.metadata?.transactions_reconciled ?? entry.metadata?.transactions_extracted ?? '-')}
                        </td>
                        <td className="px-3 py-2">
                          {entry.restored_at ? (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded text-xs">
                              <RotateCcw className="w-3 h-3" /> Restored
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded text-xs">
                              <Archive className="w-3 h-3" /> Archived
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {!entry.restored_at && (
                            <button
                              onClick={async () => {
                                setRestoringPath(entry.archive_path);
                                try {
                                  const response = await apiClient.restoreArchivedFile(entry.archive_path);
                                  if (response.data.success) {
                                    archiveQuery.refetch();
                                  }
                                } catch (err: any) {
                                  alert(`Restore failed: ${err?.response?.data?.detail || err.message}`);
                                } finally {
                                  setRestoringPath(null);
                                }
                              }}
                              disabled={restoringPath === entry.archive_path}
                              className="text-xs text-blue-600 hover:text-blue-800 disabled:opacity-50 flex items-center gap-1"
                              title={`Restore to ${entry.original_path}`}
                            >
                              {restoringPath === entry.archive_path ? (
                                <RefreshCw className="w-3 h-3 animate-spin" />
                              ) : (
                                <RotateCcw className="w-3 h-3" />
                              )}
                              Restore
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Custom Dialog Modal */}
      {dialogState.open && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm-xl max-w-md w-full mx-4">
            <div className={`px-5 py-4 border-b flex items-center gap-3 ${
              dialogState.type === 'success' ? 'bg-green-50 border-green-200' :
              dialogState.type === 'error' ? 'bg-red-50 border-red-200' :
              dialogState.type === 'warning' ? 'bg-amber-50 border-amber-200' :
              dialogState.type === 'confirm' ? 'bg-blue-50 border-blue-200' :
              'bg-gray-50 border-gray-200'
            }`}>
              <span className="text-xl">
                {dialogState.type === 'success' ? '\u2705' :
                 dialogState.type === 'error' ? '\u274C' :
                 dialogState.type === 'warning' ? '\u26A0\uFE0F' :
                 dialogState.type === 'confirm' ? '\u2753' : '\u2139\uFE0F'}
              </span>
              <h3 className="font-semibold text-gray-900">{dialogState.title}</h3>
            </div>
            <div className="px-5 py-4">
              <p className="text-sm text-gray-700 whitespace-pre-line">{dialogState.message}</p>
            </div>
            <div className="px-5 py-3 border-t bg-gray-50 flex justify-end gap-2 rounded-b-lg">
              {dialogState.type === 'confirm' && dialogState.onConfirm ? (
                <>
                  <button
                    onClick={closeDialog}
                    className="px-4 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50"
                  >
                    {dialogState.cancelLabel || 'Cancel'}
                  </button>
                  <button
                    onClick={dialogState.onConfirm}
                    className="px-4 py-2 text-sm text-white bg-blue-600 rounded hover:bg-blue-700"
                  >
                    {dialogState.confirmLabel || 'Confirm'}
                  </button>
                </>
              ) : (
                <button
                  onClick={dialogState.onConfirm || closeDialog}
                  className={`px-4 py-2 text-sm text-white rounded ${
                    dialogState.type === 'success' ? 'bg-green-600 hover:bg-green-700' :
                    dialogState.type === 'error' ? 'bg-red-600 hover:bg-red-700' :
                    'bg-blue-600 hover:bg-blue-700'
                  }`}
                >
                  {dialogState.confirmLabel || 'OK'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Create Entry Modal */}
      {createEntryModal.open && createEntryModal.statementLine && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm-xl w-full max-w-md">
            <div className="px-4 py-3 border-b border-gray-200 flex justify-between items-center">
              <h3 className="font-medium text-gray-900">Create Cashbook Entry</h3>
              <button
                onClick={() => setCreateEntryModal({ open: false, statementLine: null })}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              {/* Statement Line Info */}
              <div className="bg-gray-50 rounded p-3 text-sm">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <span className="text-gray-500">Date:</span>{' '}
                    <span className="font-medium">{formatDate(createEntryModal.statementLine.statement_date)}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">Amount:</span>{' '}
                    <span className={`font-medium ${createEntryModal.statementLine.statement_amount < 0 ? 'text-red-600' : 'text-green-600'}`}>
                      {createEntryModal.statementLine.statement_amount < 0 ? '-' : '+'}
                      £{formatCurrency(createEntryModal.statementLine.statement_amount)}
                    </span>
                  </div>
                </div>
                <div className="mt-1">
                  <span className="text-gray-500">Reference:</span>{' '}
                  <span className="font-medium font-mono text-xs">{createEntryModal.statementLine.statement_reference || '-'}</span>
                </div>
                {createEntryModal.statementLine.statement_description && (
                  <div className="mt-1">
                    <span className="text-gray-500">Description:</span>{' '}
                    <span className="text-gray-700">{createEntryModal.statementLine.statement_description}</span>
                  </div>
                )}
              </div>

              {/* Account Type */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Entry Type</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setNewEntryForm({ ...newEntryForm, accountType: 'customer', accountCode: '', nominalCode: '', destBank: '', projectCode: '', departmentCode: '' })}
                    className={`px-3 py-2 rounded border text-sm ${
                      newEntryForm.accountType === 'customer'
                        ? 'bg-blue-100 border-blue-500 text-blue-700'
                        : 'border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    Customer
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewEntryForm({ ...newEntryForm, accountType: 'supplier', accountCode: '', nominalCode: '', destBank: '', projectCode: '', departmentCode: '' })}
                    className={`px-3 py-2 rounded border text-sm ${
                      newEntryForm.accountType === 'supplier'
                        ? 'bg-blue-100 border-blue-500 text-blue-700'
                        : 'border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    Supplier
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewEntryForm({ ...newEntryForm, accountType: 'bank_transfer', accountCode: '', nominalCode: '', destBank: '', projectCode: '', departmentCode: '' })}
                    className={`px-3 py-2 rounded border text-sm ${
                      newEntryForm.accountType === 'bank_transfer'
                        ? 'bg-purple-100 border-purple-500 text-purple-700'
                        : 'border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    Bank Transfer
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewEntryForm({ ...newEntryForm, accountType: 'nominal', accountCode: '', destBank: '' })}
                    className={`px-3 py-2 rounded border text-sm ${
                      newEntryForm.accountType === 'nominal'
                        ? 'bg-blue-100 border-blue-500 text-blue-700'
                        : 'border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    Nominal
                  </button>
                </div>
              </div>

              {/* Bank Transfer - Destination Bank */}
              {newEntryForm.accountType === 'bank_transfer' && (
                <div className="space-y-3">
                  <div className="bg-purple-50 border border-purple-200 rounded p-3">
                    <div className="flex items-start gap-2">
                      <Landmark className="w-4 h-4 text-purple-600 mt-0.5" />
                      <div className="text-sm text-purple-800">
                        <strong>Bank Transfer</strong>: Creates paired entries in both bank accounts.
                        {createEntryModal.statementLine && createEntryModal.statementLine.statement_amount < 0 ? (
                          <span> Money going <strong>OUT</strong> from {selectedBank}.</span>
                        ) : (
                          <span> Money coming <strong>IN</strong> to {selectedBank}.</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {createEntryModal.statementLine && createEntryModal.statementLine.statement_amount < 0
                        ? 'Destination Bank (receiving)'
                        : 'Source Bank (sending)'}
                    </label>
                    <select
                      value={newEntryForm.destBank}
                      onChange={e => setNewEntryForm({ ...newEntryForm, destBank: e.target.value })}
                      className="w-full border border-gray-300 rounded px-3 py-2"
                    >
                      <option value="">Select bank account...</option>
                      {bankAccounts
                        .filter(b => b.code !== selectedBank)
                        .map(b => (
                          <option key={b.code} value={b.code}>
                            {b.code} - {b.name}
                          </option>
                        ))}
                    </select>
                  </div>
                </div>
              )}

              {/* Account Code - Customer/Supplier */}
              {(newEntryForm.accountType === 'customer' || newEntryForm.accountType === 'supplier') && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {newEntryForm.accountType === 'customer' ? 'Customer' : 'Supplier'} Code
                  </label>
                  <input
                    type="text"
                    value={newEntryForm.accountCode}
                    onChange={e => setNewEntryForm({ ...newEntryForm, accountCode: e.target.value.toUpperCase() })}
                    placeholder={newEntryForm.accountType === 'customer' ? 'e.g. A001' : 'e.g. SUP001'}
                    className="w-full border border-gray-300 rounded px-3 py-2"
                  />
                </div>
              )}

              {/* Nominal Account Selection */}
              {newEntryForm.accountType === 'nominal' && (
                <div className="space-y-3">
                  <div className="bg-blue-50 border border-blue-200 rounded p-3">
                    <div className="flex items-start gap-2">
                      <HelpCircle className="w-4 h-4 text-blue-600 mt-0.5" />
                      <div className="text-sm text-blue-800">
                        <strong>NL Posting</strong>: Posts directly to a nominal account without going through customer/supplier ledger.
                        {createEntryModal.statementLine && createEntryModal.statementLine.statement_amount < 0 ? (
                          <span> Money going <strong>OUT</strong> (e.g., bank charges, fees).</span>
                        ) : (
                          <span> Money coming <strong>IN</strong> (e.g., interest received).</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Nominal Account</label>
                    <select
                      value={newEntryForm.nominalCode}
                      onChange={e => {
                        const code = e.target.value;
                        const acc = nominalAccounts.find(n => n.code === code);
                        setNewEntryForm({
                          ...newEntryForm,
                          nominalCode: code,
                          projectCode: acc?.default_project?.trim() || '',
                          departmentCode: acc?.default_department?.trim() || '',
                        });
                      }}
                      className="w-full border border-gray-300 rounded px-3 py-2"
                    >
                      <option value="">Select nominal account...</option>
                      {nominalAccounts.map(acc => (
                        <option key={acc.code} value={acc.code}>
                          {acc.code} - {acc.description}
                        </option>
                      ))}
                    </select>
                  </div>
                  {/* Project/Department dropdowns (conditional on company config + nominal account settings) */}
                  {(() => {
                    const selectedNominal = nominalAccounts.find(n => n.code === newEntryForm.nominalCode);
                    // Opera values: 1=Do Not Use, 2=Optional, 3=Mandatory
                    const showProject = advancedNominalConfig.project_enabled && selectedNominal && (selectedNominal.allow_project || 0) > 1;
                    const showDept = advancedNominalConfig.department_enabled && selectedNominal && (selectedNominal.allow_department || 0) > 1;
                    const projectRequired = (selectedNominal?.allow_project || 0) === 3;
                    const deptRequired = (selectedNominal?.allow_department || 0) === 3;
                    return (
                      <>
                        {showProject && (
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              {advancedNominalConfig.project_label}{projectRequired && <span className="text-red-500 ml-1">*</span>}
                            </label>
                            <select
                              value={newEntryForm.projectCode}
                              onChange={e => setNewEntryForm({ ...newEntryForm, projectCode: e.target.value })}
                              className="w-full border border-gray-300 rounded px-3 py-2"
                            >
                              <option value="">{projectRequired ? `Select ${advancedNominalConfig.project_label.toLowerCase()} (required)...` : `No ${advancedNominalConfig.project_label.toLowerCase()}`}</option>
                              {projectCodes.map(p => (
                                <option key={p.code} value={p.code}>{p.code} - {p.description}</option>
                              ))}
                            </select>
                          </div>
                        )}
                        {showDept && (
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              {advancedNominalConfig.department_label}{deptRequired && <span className="text-red-500 ml-1">*</span>}
                            </label>
                            <select
                              value={newEntryForm.departmentCode}
                              onChange={e => setNewEntryForm({ ...newEntryForm, departmentCode: e.target.value })}
                              className="w-full border border-gray-300 rounded px-3 py-2"
                            >
                              <option value="">{deptRequired ? `Select ${advancedNominalConfig.department_label.toLowerCase()} (required)...` : `No ${advancedNominalConfig.department_label.toLowerCase()}`}</option>
                              {departmentCodes.map(d => (
                                <option key={d.code} value={d.code}>{d.code} - {d.description}</option>
                              ))}
                            </select>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
              )}

              {/* Reference */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Reference</label>
                <input
                  type="text"
                  value={newEntryForm.reference}
                  onChange={e => setNewEntryForm({ ...newEntryForm, reference: e.target.value })}
                  className="w-full border border-gray-300 rounded px-3 py-2"
                />
              </div>

              {/* Description */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <input
                  type="text"
                  value={newEntryForm.description}
                  onChange={e => setNewEntryForm({ ...newEntryForm, description: e.target.value })}
                  className="w-full border border-gray-300 rounded px-3 py-2"
                />
              </div>
            </div>

            <div className="px-4 py-3 border-t border-gray-200 flex justify-end gap-2">
              <button
                onClick={() => setCreateEntryModal({ open: false, statementLine: null })}
                className="px-4 py-2 border border-gray-300 rounded hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={createCashbookEntry}
                disabled={
                  isCreatingEntry ||
                  (newEntryForm.accountType === 'customer' && !newEntryForm.accountCode) ||
                  (newEntryForm.accountType === 'supplier' && !newEntryForm.accountCode) ||
                  (newEntryForm.accountType === 'nominal' && !newEntryForm.nominalCode) ||
                  (newEntryForm.accountType === 'bank_transfer' && !newEntryForm.destBank) ||
                  (newEntryForm.accountType === 'nominal' && (() => {
                    const acc = nominalAccounts.find(n => n.code === newEntryForm.nominalCode);
                    if (advancedNominalConfig.project_enabled && (acc?.allow_project || 0) === 3 && !newEntryForm.projectCode) return true;
                    if (advancedNominalConfig.department_enabled && (acc?.allow_department || 0) === 3 && !newEntryForm.departmentCode) return true;
                    return false;
                  })())
                }
                className={`px-4 py-2 text-white rounded disabled:opacity-50 flex items-center gap-2 ${
                  newEntryForm.accountType === 'bank_transfer'
                    ? 'bg-purple-600 hover:bg-purple-700'
                    : 'bg-blue-600 hover:bg-blue-700'
                }`}
              >
                {isCreatingEntry ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : newEntryForm.accountType === 'bank_transfer' ? (
                  <Landmark className="w-4 h-4" />
                ) : (
                  <Plus className="w-4 h-4" />
                )}
                {newEntryForm.accountType === 'bank_transfer' ? 'Create Transfer' : 'Create Entry'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Ignore Transaction Confirmation Modal */}
      {ignoreConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm-xl max-w-md w-full mx-4">
            <div className="px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Ignore Transaction?</h3>
            </div>
            <div className="p-6">
              <p className="text-gray-600 mb-4">
                This will permanently ignore this transaction for future bank reconciliations.
                Use this for transactions already entered in Opera (e.g., manual GoCardless receipts).
              </p>
              <div className="bg-gray-50 rounded-lg p-4 mb-4">
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="text-gray-500">Date:</div>
                  <div className="font-medium">{formatDate(ignoreConfirm.date)}</div>
                  <div className="text-gray-500">Amount:</div>
                  <div className={`font-medium ${ignoreConfirm.amount < 0 ? 'text-red-600' : 'text-green-600'}`}>
                    {ignoreConfirm.amount < 0 ? '-' : '+'}£{formatCurrency(ignoreConfirm.amount)}
                  </div>
                  <div className="text-gray-500">Description:</div>
                  <div className="font-medium text-xs">{ignoreConfirm.description}</div>
                </div>
              </div>
              <p className="text-sm text-orange-600 mb-4">
                ⚠️ This action cannot be undone from this screen.
              </p>
            </div>
            <div className="px-6 py-4 bg-gray-50 flex justify-end gap-3 rounded-b-lg">
              <button
                onClick={() => setIgnoreConfirm(null)}
                disabled={isIgnoring}
                className="px-4 py-2 border border-gray-300 rounded hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                onClick={handleIgnoreTransaction}
                disabled={isIgnoring}
                className="px-4 py-2 bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-50 flex items-center gap-2"
              >
                {isIgnoring ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <X className="w-4 h-4" />
                )}
                Yes, Ignore Transaction
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Error boundary to prevent white screen crashes
class ReconcileErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('BankStatementReconcile crash:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-6 max-w-3xl mx-auto">
          <div className="bg-red-50 border-2 border-red-300 rounded-lg p-6">
            <h2 className="text-lg font-bold text-red-800 mb-2">Reconcile Error</h2>
            <p className="text-sm text-red-700 mb-3">
              The reconciliation view encountered an error. This is usually caused by unexpected data.
            </p>
            <pre className="bg-red-100 rounded p-3 text-xs text-red-900 overflow-auto max-h-40 mb-4">
              {this.state.error?.message}
              {'\n'}
              {this.state.error?.stack?.split('\n').slice(0, 5).join('\n')}
            </pre>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 text-sm"
            >
              Try Again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// Wrap exported component in error boundary
export function BankStatementReconcileWithBoundary(props: BankStatementReconcileProps) {
  return (
    <ReconcileErrorBoundary>
      <BankStatementReconcile {...props} />
    </ReconcileErrorBoundary>
  );
}

export default BankStatementReconcileWithBoundary;

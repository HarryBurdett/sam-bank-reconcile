import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText, CheckCircle, XCircle, AlertCircle, Loader2, Receipt, CreditCard, FileSpreadsheet, BookOpen, Landmark, /* Upload - kept for CSV upload if re-enabled */ Edit3, RefreshCw, Search, RotateCcw, X, History, ChevronDown, ChevronRight, ArrowRight, FolderOpen, Clock } from 'lucide-react';
import apiClient, { authFetch } from './api-shim';
import { LIVE_VERSION } from './PageHeader';

interface ImportResult {
  success: boolean;
  validate_only: boolean;
  records_processed: number;
  records_imported: number;
  records_failed: number;
  errors: string[];
  details: string[];
}

interface BankAccount {
  code: string;
  description: string;
  sort_code: string;
  account_number: string;
}

interface OperaAccount {
  code: string;
  name: string;
  display: string;
}

interface DuplicateCandidate {
  table: string;
  record_id: string;
  match_type: string;
  confidence: number;
}

type TransactionType = 'sales_receipt' | 'purchase_payment' | 'sales_refund' | 'purchase_refund' | 'nominal_receipt' | 'nominal_payment' | 'bank_transfer' | 'ignore';

// Nominal posting detail for VAT entry
interface NominalPostingDetail {
  nominalCode: string;
  nominalDescription?: string;
  vatCode: string;
  vatRate: number;
  netAmount: number;
  vatAmount: number;
  grossAmount: number;
  projectCode?: string;
  departmentCode?: string;
}

// VAT code from Opera
interface VatCode {
  code: string;
  description: string;
  rate: number;
}

interface BankImportTransaction {
  row: number;
  date: string;
  type?: string;
  amount: number;
  name: string;
  reference?: string;
  memo?: string;
  fit_id?: string;
  account?: string;
  account_name?: string;
  match_score?: number;
  match_source?: string;
  action?: string;
  reason?: string;
  fingerprint?: string;
  is_duplicate?: boolean;
  duplicate_candidates?: DuplicateCandidate[];
  transaction_type?: TransactionType;
  refund_credit_note?: string;
  refund_credit_amount?: number;
  // Repeat entry fields
  repeat_entry_ref?: string;
  repeat_entry_desc?: string;
  repeat_entry_next_date?: string;
  repeat_entry_posted?: number;  // Times posted
  repeat_entry_total?: number;   // Times to post (0=unlimited)
  repeat_entry_freq?: string;    // Frequency code (D/W/M/Q/Y)
  repeat_entry_every?: number;   // Every N periods
  outstanding_postings?: { date: string; period_valid: boolean; period_error?: string; period: number; year: number }[];
  outstanding_count?: number;
  outstanding_blocked?: number;
  outstanding_open?: number;
  // For editable preview
  manual_account?: string;
  manual_ledger_type?: 'C' | 'S';
  isEdited?: boolean;
  // Period validation
  period_valid?: boolean;
  period_error?: string;
  original_date?: string;
  // Date override (user modified date)
  date_override?: string;
  // Nominal posting detail (for nominal_receipt/nominal_payment)
  nominal_detail?: NominalPostingDetail;
  // Auto-detected bank transfer details
  bank_transfer_details?: {
    dest_bank: string;
  };
  // GoCardless FX detection fields
  gc_fx_currency?: string;
  gc_fx_original_amount?: number;
  gc_fx_gbp_amount?: number;
  gc_fx_reference?: string;
  // Similarity grouping for "apply to all similar"
  similarity_key?: string;
  similar_count?: number;
}

interface PeriodViolation {
  row: number;
  date: string;
  name?: string;
  amount?: number;
  action?: string;
  ledger_type?: string;
  ledger_name?: string;
  error: string;
  year?: number;
  period?: number;
  transaction_year?: number;
  transaction_period?: number;
  current_year?: number;
  current_period?: number;
}

interface StatementBankInfo {
  bank_name?: string;
  account_number?: string;
  sort_code?: string;
  statement_date?: string;
  opening_balance?: number;
  closing_balance?: number;
  matched_opera_bank?: string;
  matched_opera_name?: string;
  bank_mismatch?: boolean;
}

interface EnhancedBankImportPreview {
  success: boolean;
  filename: string;
  detected_format?: string;
  total_transactions: number;
  matched_receipts: BankImportTransaction[];
  matched_payments: BankImportTransaction[];
  matched_refunds: BankImportTransaction[];
  repeat_entries: BankImportTransaction[];
  unmatched: BankImportTransaction[];
  already_posted: BankImportTransaction[];
  skipped: BankImportTransaction[];
  summary?: {
    to_import: number;
    refund_count: number;
    repeat_entry_count: number;
    unmatched_count: number;
    already_posted_count: number;
    skipped_count: number;
  };
  errors: string[];
  // Period validation
  period_info?: {
    current_year: number;
    current_period: number;
    open_period_accounting: boolean;
  };
  period_violations?: PeriodViolation[];
  has_period_violations?: boolean;
  // Statement metadata (from AI extraction)
  statement_bank_info?: StatementBankInfo;
  // Raw statement transactions for reconcile screen
  statement_transactions?: any[];
  statement_info?: any;
}

interface RecurringEntry {
  entry_ref: string;
  base_entry_ref?: string;
  type: number;
  type_desc: string;
  description: string;
  account: string;
  account_desc: string;
  cbtype: string;
  amount_pence: number;
  amount_pounds: number;
  next_post_date: string;
  posted_count: number;
  total_posts: number;
  frequency: string;
  project: string;
  department: string;
  can_post: boolean;
  blocked_reason: string | null;
  comment: string;
}

type PreviewTab = 'receipts' | 'payments' | 'refunds' | 'repeat' | 'unmatched' | 'skipped';

// Relative URL: samFetch (standalone shell at public/index.html)
// prepends the plugin mount point '/api/apps/bank-reconcile', so a
// call like `${API_BASE}/bank-import/preview-from-pdf` lands at
// /api/apps/bank-reconcile/api/bank-import/preview-from-pdf — the
// dispatcher-routed plugin endpoint. The absolute localhost:8000
// URL was a vendoring artefact from the legacy Python FastAPI host
// and broke every Imports call in standalone mode (path got
// concatenated literally and 404'd through the dispatcher).
const API_BASE = '/api';

type ImportType = 'bank-statement' | 'sales-receipt' | 'purchase-payment' | 'sales-invoice' | 'purchase-invoice' | 'nominal-journal';

type DataSource = 'opera-sql' | 'opera3';

// Stage Section component for consistent numbered containers
interface StageSectionProps {
  number: number;
  title: string;
  subtitle?: string;
  isComplete?: boolean;
  color: 'blue' | 'green' | 'amber' | 'indigo' | 'purple';
  children: React.ReactNode;
}

const StageSection: React.FC<StageSectionProps> = ({
  number, title, subtitle, isComplete, color, children
}) => {
  const colors = {
    blue: { bg: 'bg-blue-50', border: 'border-blue-300', text: 'text-blue-900', subtext: 'text-blue-600', circle: 'bg-blue-600' },
    green: { bg: 'bg-green-50', border: 'border-green-300', text: 'text-green-900', subtext: 'text-green-600', circle: 'bg-green-600' },
    amber: { bg: 'bg-amber-50', border: 'border-amber-300', text: 'text-amber-900', subtext: 'text-amber-600', circle: 'bg-amber-600' },
    indigo: { bg: 'bg-indigo-50', border: 'border-indigo-300', text: 'text-indigo-900', subtext: 'text-indigo-600', circle: 'bg-indigo-600' },
    purple: { bg: 'bg-purple-50', border: 'border-purple-300', text: 'text-purple-900', subtext: 'text-purple-600', circle: 'bg-purple-600' },
  };
  const c = colors[color];

  return (
    <div className={`border-2 ${c.border} rounded-lg overflow-hidden mb-4`}>
      <div className={`${c.bg} px-4 py-3 border-b ${c.border} flex items-center gap-3`}>
        <div className={`w-8 h-8 rounded-full ${isComplete ? 'bg-green-500' : c.circle} text-white flex items-center justify-center font-bold text-sm`}>
          {isComplete ? '✓' : number}
        </div>
        <div className="flex items-center gap-2">
          <h3 className={`font-semibold ${c.text}`}>{title}</h3>
          {subtitle && <span className={`text-sm ${c.subtext}`}>— {subtitle}</span>}
        </div>
      </div>
      <div className="p-4 bg-white">
        {children}
      </div>
    </div>
  );
};

export interface ImportsProps {
  bankRecOnly?: boolean;
  initialStatement?: {
    bankCode: string;
    bankDescription?: string;
    emailId?: number;
    attachmentId?: string;
    filename: string;
    source: 'email' | 'pdf';
    fullPath?: string;
  } | null;
  resumeImportId?: number;
  onImportComplete?: (data: {
    bank_code: string;
    statement_transactions: any[];
    statement_info: any;
    source: string;
    filename?: string;
    import_id?: number;
    email_id?: number;
    full_path?: string;
  }) => void;
}

export function Imports({ bankRecOnly = false, initialStatement = null, resumeImportId, onImportComplete }: ImportsProps = {}) {
  const [activeType, setActiveType] = useState<ImportType>('bank-statement');
  const [loading, setLoading] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [sequenceError, setSequenceError] = useState<string | null>(null);

  // Raw file preview state
  const [rawFilePreview, setRawFilePreview] = useState<string[] | null>(null);
  const [showRawPreview, setShowRawPreview] = useState(false);
  const [validateOnly, setValidateOnly] = useState(true);


  // Data source derived from Opera settings configuration
  const { data: operaConfigData } = useQuery({
    queryKey: ['operaConfig'],
    queryFn: async () => {
      const res = await authFetch(`${API_BASE}/config/opera`);
      return res.json();
    },
  });
  const dataSource: DataSource = operaConfigData?.version === 'opera3' ? 'opera3' : 'opera-sql';

  // Get current company for company-specific localStorage keys
  const { data: companiesData } = useQuery({
    queryKey: ['companies'],
    queryFn: async () => {
      const response = await apiClient.getCompanies();
      return response.data;
    },
  });
  const currentCompanyId = companiesData?.current_company?.id || '';

  // Bank statement import state
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  // Don't initialize from localStorage - wait for company to load
  const [selectedBankCode, setSelectedBankCode] = useState<string>('');
  const [csvDirectory, setCsvDirectory] = useState(() =>
    localStorage.getItem('bankImport_csvDirectory') || ''
  );
  const [csvFileName, setCsvFileName] = useState('');
  const [opera3DataPath, setOpera3DataPath] = useState(() =>
    localStorage.getItem('bankImport_opera3DataPath') || ''
  );

  // Auto-populate Opera 3 data path from settings if not already set
  useEffect(() => {
    if (operaConfigData && !opera3DataPath) {
      const serverPath = operaConfigData.opera3_server_path;
      const basePath = operaConfigData.opera3_base_path;
      if (serverPath) {
        setOpera3DataPath(serverPath);
      } else if (basePath) {
        setOpera3DataPath(basePath);
      }
    }
  }, [operaConfigData, opera3DataPath]);

  // Helper to convert Map to array for JSON serialization
  const mapToArray = <K, V>(map: Map<K, V>): [K, V][] => Array.from(map.entries());

  const [bankPreview, setBankPreview] = useState<EnhancedBankImportPreview | null>(null);
  const [bankImportResult, setBankImportResult] = useState<any>(null);

  // New state for editable preview
  const [editedTransactions, setEditedTransactions] = useState<Map<number, BankImportTransaction>>(new Map());

  // Tabbed preview state
  const [activePreviewTab, setActivePreviewTab] = useState<PreviewTab>('receipts');
  const [tabSearchFilter, setTabSearchFilter] = useState('');

  // Skipped items inclusion state
  const [includedSkipped, setIncludedSkipped] = useState<Map<number, {
    account: string;
    ledger_type: 'C' | 'S';
    transaction_type: TransactionType;
  }>>(new Map());

  // Transaction type overrides for unmatched items
  const [transactionTypeOverrides, setTransactionTypeOverrides] = useState<Map<number, TransactionType>>(new Map());

  // Opera cashbook type overrides (from atype table - e.g., 'R1', 'P2')
  const [cbtypeOverrides, setCbtypeOverrides] = useState<Map<number, string>>(new Map());

  // Available Opera cashbook types (fetched from API)
  const [receiptTypes, setReceiptTypes] = useState<Array<{code: string; description: string}>>([]);
  const [paymentTypes, setPaymentTypes] = useState<Array<{code: string; description: string}>>([]);

  // Refund overrides (for changing type/account on auto-detected refunds)
  const [refundOverrides, setRefundOverrides] = useState<Map<number, {
    transaction_type?: TransactionType;
    account?: string;
    ledger_type?: 'C' | 'S';
    rejected?: boolean;
  }>>(new Map());

  // Auto-allocate is always enabled globally - per-row overrides via autoAllocateDisabled set
  const autoAllocate = true;

  // Show reconcile prompt after successful import
  const [showReconcilePrompt, setShowReconcilePrompt] = useState(false);


  // Selection state for import - tracks which rows are selected for import across ALL tabs
  const [selectedForImport, setSelectedForImport] = useState<Set<number>>(new Set());

  // Already-posted rows (from resume/continue import) - these are grayed out and excluded
  const [alreadyPostedRows, setAlreadyPostedRows] = useState<Map<number, string>>(new Map()); // row -> entry_number

  // Date overrides for period violations - maps row number to new date
  const [dateOverrides, setDateOverrides] = useState<Map<number, string>>(new Map());

  // Per-row auto-allocate overrides - defaults to true (follow global setting), can be disabled per row
  // Only tracks rows where user explicitly disabled auto-allocate for that specific transaction
  const [autoAllocateDisabled, setAutoAllocateDisabled] = useState<Set<number>>(new Set());

  // Track repeat entries that have had their dates updated (ready for Opera processing)
  const [updatedRepeatEntries, setUpdatedRepeatEntries] = useState<Set<string>>(new Set());
  const [updatingRepeatEntry, setUpdatingRepeatEntry] = useState<string | null>(null);
  const [repeatEntriesProcessed, setRepeatEntriesProcessed] = useState(false);

  // Recurring entries processing state
  const [recurringEntries, setRecurringEntries] = useState<RecurringEntry[]>([]);
  const [, setRecurringMode] = useState<'process' | 'warn'>('process');
  const [showRecurringModal, setShowRecurringModal] = useState(false);
  const [showRecurringWarning, setShowRecurringWarning] = useState(false);
  const [recurringSelected, setRecurringSelected] = useState<Set<string>>(new Set());
  const [recurringOverrideDates, setRecurringOverrideDates] = useState<Record<string, string>>({});
  const [postingRecurring, setPostingRecurring] = useState(false);
  const [recurringPostResults, setRecurringPostResults] = useState<Array<{entry_ref: string; success: boolean; message?: string; error?: string}>>([]);
  // When launched from BankStatementHub with initialStatement, the hub already
  // checked recurring entries — skip the duplicate check in Imports
  const [recurringCheckDone, setRecurringCheckDone] = useState(bankRecOnly && !!initialStatement);
  const [recurringCheckBank, setRecurringCheckBank] = useState<string>(''); // tracks which bank was checked

  // Ignore transaction confirmation state
  const [ignoreConfirm, setIgnoreConfirm] = useState<{
    row: number;
    date: string;
    description: string;
    amount: number;
  } | null>(null);
  const [isIgnoring, setIsIgnoring] = useState(false);
  // Track which transactions are marked as ignored (by row number)
  const [ignoredTransactions, setIgnoredTransactions] = useState<Set<number>>(new Set());

  // Track which unmatched rows the user has deferred (not posted, not permanently ignored, reappears on next scan)
  const [deferredRows, setDeferredRows] = useState<Set<number>>(new Set());

  // Auto-undefer any row that the matcher now pairs with Opera. Fires every
  // time the bank preview changes (after Analyse, after a fresh scan, after
  // any re-match). Also clears the corresponding row from the persisted
  // deferred_transactions audit DB so deferred_count drops to 0 in the
  // Bank Hub on the next scan. Operator's mental model: "deferred items
  // now in Opera should just be processed". No UI action required.
  useEffect(() => {
    if (!bankPreview) return;
    const allMatched: any[] = [
      ...(bankPreview.matched_receipts || []),
      ...(bankPreview.matched_payments || []),
      ...((bankPreview.matched_refunds || [])),
      ...(((bankPreview as any).already_posted || [])),
    ];
    const matchedRowSet = new Set<number>(allMatched.map(t => t.row));
    setDeferredRows(prev => {
      let changed = false;
      const next = new Set<number>(prev);
      const matchedAndCleared: any[] = [];
      for (const r of prev) {
        if (matchedRowSet.has(r)) {
          next.delete(r);
          changed = true;
          const txn = allMatched.find((t: any) => t.row === r);
          if (txn) matchedAndCleared.push(txn);
        }
      }
      if (changed) {
        console.info(`[deferred] auto-undefer: ${prev.size - next.size} rows now matched in Opera`);
        // Also clear the audit row(s) so the Bank Hub's deferred_count
        // drops to 0 on the next scan. Fire-and-forget.
        if (selectedBankCode && matchedAndCleared.length > 0) {
          authFetch(`${API_BASE}/reconcile/bank/${selectedBankCode}/deferred-items`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              match: matchedAndCleared.map((t: any) => ({
                statement_date: t.date || '',
                amount: t.amount || 0,
                description: t.memo || t.name || '',
              })),
            }),
          }).catch(err => console.warn('Auto-clean defer audit failed (non-blocking):', err));
        }
      }
      return changed ? next : prev;
    });
  }, [bankPreview, selectedBankCode]);

  // (persistDeferDecisions defined below — needs selectedPdfFile + selectedEmailStatement to be declared first)

  // =====================
  // EMAIL SCANNING STATE
  // =====================
  type StatementSource = 'file' | 'email' | 'pdf' | 'folder';
  const [statementSource, setStatementSource] = useState<StatementSource>('email');
  const [, setEmailScanLoading] = useState(false);
  const [emailScanDaysBack] = useState(30);
  const [, setEmailStatements] = useState<Array<{
    email_id: number;
    message_id: string;
    subject: string;
    from_address: string;
    from_name?: string;
    received_at: string;
    attachments: Array<{
      attachment_id: string;
      filename: string;
      size_bytes: number;
      content_type?: string;
      already_processed: boolean;
      statement_date?: string;
    }>;
    detected_bank: string | null;
    already_processed: boolean;
    import_sequence?: number;
    statement_date?: string;
  }>>([]);
  const [, setEmailScanMessage] = useState<string | null>(null);
  const [, setEmailScanHasRun] = useState(false);
  const [, setDuplicatesArchived] = useState(0);
  const [selectedEmailStatement, setSelectedEmailStatement] = useState<{
    emailId: number;
    attachmentId: string;
    filename: string;
  } | null>(null);

  // =====================
  // FOLDER SCANNING STATE
  // =====================
  const [folderScanLoading, setFolderScanLoading] = useState(false);
  const [analysing, setAnalysing] = useState(false);
  const [folderStatements, setFolderStatements] = useState<Array<{
    filename: string;
    full_path: string;
    source: string;
    status: string;
    is_imported: boolean;
    file_size: number;
    file_modified: string;
    opening_balance?: number;
    closing_balance?: number;
    period_start?: string;
    period_end?: string;
    bank_name?: string;
    account_number?: string;
    sort_code?: string;
    import_sequence?: number;
  }>>([]);
  const [folderScanMessage, setFolderScanMessage] = useState<string | null>(null);
  const [folderScanHasRun, setFolderScanHasRun] = useState(false);
  const [folderEnabled, setFolderEnabled] = useState(false);
  const [, setFolderSettingsLoaded] = useState(false);

  // Load folder settings on mount to know if unified folder source should be available
  useEffect(() => {
    authFetch('/api/bank-import/folder-settings')
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          const enabled = data.folder_enabled || false;
          setFolderEnabled(enabled);
          // Default to unified folder view when folders are configured —
          // but ONLY when this Imports component wasn't opened from the
          // Hub via initialStatement. When the Hub passes initialStatement,
          // the statementSource is authoritative ('email' / 'pdf') and
          // must not be overridden to 'folder' by this async effect.
          // Previously, the override caused the Import button dispatch to
          // fall through to handleBankImport (CSV path) for email-source
          // imports — the FE would then POST /import-with-overrides
          // with an empty filepath and the user saw "file_path or bytes
          // is required" instead of the import succeeding.
          if (enabled && !initialStatement) {
            setStatementSource('folder');
          }
        }
        setFolderSettingsLoaded(true);
      })
      .catch(() => setFolderSettingsLoaded(true));
    // initialStatement is intentionally read once at effect setup time —
    // the dependency is empty because we only want this fetch to fire
    // on mount, not whenever initialStatement changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // =====================
  // IMPORT HISTORY STATE
  // =====================
  const [showImportHistory, setShowImportHistory] = useState(false);
  const [importHistoryData, setImportHistoryData] = useState<Array<{
    id: number;
    filename: string;
    source: 'email' | 'file';
    bank_code: string;
    total_receipts: number;
    total_payments: number;
    transactions_imported: number;
    target_system: string;
    import_date: string;
    imported_by: string;
    email_subject?: string;
    email_from?: string;
  }>>([]);
  const [importHistoryLoading, setImportHistoryLoading] = useState(false);
  const [historyLimit, setHistoryLimit] = useState(50);
  const [historyFromDate, setHistoryFromDate] = useState('');
  const [historyToDate, setHistoryToDate] = useState('');
  const [isClearing, setIsClearing] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showClearStatementConfirm, setShowClearStatementConfirm] = useState(false);
  const [reImportRecord, setReImportRecord] = useState<{ id: number; filename: string; amount: number } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [expandedHistoryId, setExpandedHistoryId] = useState<number | null>(null);
  const [statementReview, setStatementReview] = useState<{
    import_id: number;
    filename?: string;
    bank_code?: string;
    opening_balance?: number;
    closing_balance?: number;
    transactions: Array<{
      line_number: number;
      date: string;
      description: string;
      amount: number;
      balance: number | null;
      posted_entry_number: string | null;
      is_reconciled: boolean | null;
    }>;
    summary: { total: number; reconciled: number; unreconciled: number; not_imported: number };
  } | null>(null);
  const [statementReviewLoading, setStatementReviewLoading] = useState(false);
  const [statementReviewError, setStatementReviewError] = useState<string | null>(null);
  const [showUnreconciledOnly, setShowUnreconciledOnly] = useState(false);

  // =====================
  // PDF UPLOAD STATE
  // =====================
  const [pdfDirectory, setPdfDirectory] = useState(() =>
    localStorage.getItem('bankImport_pdfDirectory') || ''
  );
  const [_pdfFileName, _setPdfFileName] = useState(''); // Reserved for future use
  const [, setPdfFilesList] = useState<Array<{
    filename: string;
    modified: string;
    size_display: string;
    already_processed: boolean;
    statement_date?: string;
    import_sequence?: number;
  }> | null>(null);
  const [, setPdfFilesLoading] = useState(false);
  const [selectedPdfFile, setSelectedPdfFile] = useState<{
    filename: string;
    fullPath: string;
  } | null>(null);
  const [, setFolderSourcePath] = useState<string | null>(null);

  // Persist defer decisions to the backend immediately on Defer/Undo. Writes
  // both the deferred_transactions audit row AND the bank_statement_imports
  // tracking row so Sequential Statement Gating sees the statement as
  // 'imported' without requiring an explicit Import-button click.
  const persistDeferDecisions = useCallback((rows: Set<number>) => {
    if (!selectedBankCode) return;
    const filename = selectedPdfFile?.filename || selectedEmailStatement?.filename || '';
    if (!filename) return;
    const allTxns = [
      ...(bankPreview?.matched_receipts || []),
      ...(bankPreview?.matched_payments || []),
      ...(bankPreview?.matched_refunds || []),
      ...(bankPreview?.unmatched || []),
      ...(bankPreview?.skipped || []),
    ];
    const deferredList = Array.from(rows)
      .map(r => allTxns.find((t: any) => t.row === r))
      .filter(Boolean)
      .map((t: any) => ({
        date: t.date,
        amount: t.amount,
        description: t.memo || t.name || '',
      }));
    const stmtInfo = bankPreview?.statement_info || bankPreview?.statement_bank_info || {};
    authFetch(`${API_BASE}/bank-import/persist-decisions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bank_code: selectedBankCode,
        filename,
        source: selectedEmailStatement ? 'email' : 'pdf',
        statement_info: {
          opening_balance: (stmtInfo as any)?.opening_balance,
          closing_balance: (stmtInfo as any)?.closing_balance,
          statement_date: (stmtInfo as any)?.statement_date,
          period_start: (stmtInfo as any)?.period_start,
          period_end: (stmtInfo as any)?.period_end,
          account_number: (stmtInfo as any)?.account_number,
          sort_code: (stmtInfo as any)?.sort_code,
        },
        deferred_transactions: deferredList,
      }),
    }).catch((err) => {
      console.warn('persist-decisions failed', err);
    });
  }, [selectedBankCode, selectedPdfFile, selectedEmailStatement, bankPreview]);

  // =====================
  // SESSION STORAGE PERSISTENCE - Keep data when switching tabs/pages
  // =====================
  const STORAGE_KEY = currentCompanyId ? `bankImportState_${currentCompanyId}` : 'bankImportState';
  const hasRestoredFromSession = useRef(false);
  const sessionRestoreComplete = useRef(false);

  // Load persisted state on mount
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        // Restore only navigation context — preview data comes from backend drafts
        hasRestoredFromSession.current = true;

        if (parsed.csvFileName) setCsvFileName(parsed.csvFileName);
        if (parsed.csvDirectory) setCsvDirectory(parsed.csvDirectory);
        if (parsed.selectedBankCode) setSelectedBankCode(parsed.selectedBankCode);
        if (parsed.statementSource) setStatementSource(parsed.statementSource);
        if (parsed.selectedEmailStatement) setSelectedEmailStatement(parsed.selectedEmailStatement);
        if (parsed.selectedPdfFile) setSelectedPdfFile(parsed.selectedPdfFile);

        console.log('Restored bank import navigation from session');
      }
    } catch (e) {
      console.warn('Failed to load bank import state from session storage:', e);
    }
    // Mark restore as complete after a small delay to let state updates settle
    setTimeout(() => {
      sessionRestoreComplete.current = true;
    }, 100);
  }, []);

  // Auto-populate from initialStatement prop (when used from BankStatementHub)
  const [autoPreviewTriggered, setAutoPreviewTriggered] = useState(false);
  useEffect(() => {
    if (!initialStatement) return;

    // Check if session already has state for this exact statement — if so, keep it
    const isSameStatement = hasRestoredFromSession.current && bankPreview && selectedBankCode === initialStatement.bankCode && (
      (initialStatement.source === 'email' && selectedEmailStatement?.emailId === initialStatement.emailId && selectedEmailStatement?.attachmentId === initialStatement.attachmentId) ||
      (initialStatement.source === 'pdf' && selectedPdfFile?.fullPath === initialStatement.fullPath)
    );

    if (isSameStatement) {
      // Same statement already loaded from session — skip clear and re-preview
      setAutoPreviewTriggered(true);
      return;
    }

    // Different statement — clear stale state so auto-preview can fire
    setBankPreview(null);
    setBankImportResult(null);
    setEditedTransactions(new Map());
    setIncludedSkipped(new Map());
    setTransactionTypeOverrides(new Map());
    setRefundOverrides(new Map());
    setSelectedForImport(new Set());
    setIgnoredTransactions(new Set());
    setDeferredRows(new Set());
    setNominalPostingDetails(new Map());
    setBankTransferDetails(new Map());
    setDateOverrides(new Map());
    setAutoAllocateDisabled(new Set());
    setCbtypeOverrides(new Map());
    setAlreadyPostedRows(new Map());
    setShowReconcilePrompt(false);
    setSequenceError(null);
    setTabSearchFilter('');
    // Reset recurring entries check so it re-fires for the new statement
    // (but skip if bankRecOnly — the hub already checked)
    setRecurringCheckBank('');
    if (!bankRecOnly) setRecurringCheckDone(false);
    setShowRecurringWarning(false);
    setRecurringEntries([]);
    setRepeatEntriesProcessed(false);
    setUpdatedRepeatEntries(new Set());
    // Set bank code
    setSelectedBankCode(initialStatement.bankCode);
    // Set source type
    setStatementSource(initialStatement.source);
    // Set the selected statement, and — critically — clear the OTHER
    // source's selection. Without this, if sessionStorage restored a
    // stale `selectedPdfFile` from a previous statement, it would
    // linger alongside the freshly-set `selectedEmailStatement` and
    // confuse downstream dispatches (e.g. the retry-after-overlap
    // button checks `selectedPdfFile` first and would route the
    // import via the PDF endpoint with an empty file_path — that's
    // the source of the "file_path or bytes is required" error
    // operators were hitting on email-sourced statements like the
    // 15-MAY-26 BC010 case).
    if (initialStatement.source === 'email' && initialStatement.emailId && initialStatement.attachmentId) {
      setSelectedEmailStatement({
        emailId: initialStatement.emailId,
        attachmentId: initialStatement.attachmentId,
        filename: initialStatement.filename,
      });
      setSelectedPdfFile(null);
      setPdfDirectory('');
    } else if (initialStatement.source === 'pdf' && initialStatement.fullPath) {
      setSelectedPdfFile({
        filename: initialStatement.filename,
        fullPath: initialStatement.fullPath,
      });
      setSelectedEmailStatement(null);
      // Set pdfDirectory from the full path so handlePdfPreview can find the file
      const lastSlash = Math.max(initialStatement.fullPath.lastIndexOf('/'), initialStatement.fullPath.lastIndexOf('\\'));
      if (lastSlash > 0) {
        setPdfDirectory(initialStatement.fullPath.substring(0, lastSlash));
      }
    } else {
      // Unknown / incomplete initialStatement — clear both so we
      // don't carry stale state across the navigation.
      setSelectedEmailStatement(null);
      setSelectedPdfFile(null);
    }
    setAutoPreviewTriggered(false);
  }, [initialStatement]);

  // Auto-trigger preview (scan PDF) when initialStatement sets the selection
  // Must wait for selectedBankCode, pdfDirectory, AND recurring entries check to complete
  useEffect(() => {
    if (!initialStatement || autoPreviewTriggered || bankPreview) return;
    if (!selectedBankCode) return; // Wait for bank code state to be applied
    if (!recurringCheckDone) return; // Wait for recurring entries check to complete (modal resolved)
    if (initialStatement.source === 'email' && initialStatement.emailId && initialStatement.attachmentId) {
      setAutoPreviewTriggered(true);
      handleEmailPreview(initialStatement.emailId, initialStatement.attachmentId, initialStatement.filename);
    } else if (initialStatement.source === 'pdf' && initialStatement.fullPath && pdfDirectory) {
      setAutoPreviewTriggered(true);
      handlePdfPreview(initialStatement.filename);
    }
  }, [initialStatement, autoPreviewTriggered, bankPreview, selectedBankCode, pdfDirectory, recurringCheckDone]);

  // Fetch already-posted lines when resuming a partial import
  useEffect(() => {
    if (!resumeImportId) return;
    (async () => {
      try {
        const resp = await authFetch(`${API_BASE}/bank-reconciliation/statement-transactions/${resumeImportId}`);
        const data = await resp.json();
        if (data.success && data.transactions) {
          const posted = new Map<number, string>();
          for (const t of data.transactions) {
            if (t.posted_entry_number) {
              posted.set(t.line_number, t.posted_entry_number);
            }
          }
          setAlreadyPostedRows(posted);
          // Remove posted rows from selection
          setSelectedForImport(prev => {
            const updated = new Set(prev);
            posted.forEach((_, row) => updated.delete(row));
            return updated;
          });
        }
      } catch (err) {
        console.error('Failed to load posted lines for resume:', err);
      }
    })();
  }, [resumeImportId]);

  // Clear persisted state after successful import
  const clearPersistedState = useCallback(() => {
    sessionStorage.removeItem(STORAGE_KEY);
  }, []);

  // Helper: build draft query params for the current statement
  const buildDraftParams = useCallback((): URLSearchParams | null => {
    if (!selectedBankCode) return null;
    const params = new URLSearchParams();
    params.set('bank_code', selectedBankCode);
    if (selectedEmailStatement) {
      params.set('source', 'email');
      params.set('email_id', String(selectedEmailStatement.emailId));
      params.set('attachment_id', selectedEmailStatement.attachmentId);
      params.set('filename', selectedEmailStatement.filename);
    } else if (selectedPdfFile) {
      params.set('source', 'pdf');
      params.set('filename', selectedPdfFile.filename);
    } else {
      return null;
    }
    return params;
  }, [selectedBankCode, selectedEmailStatement, selectedPdfFile]);

  // Helper: delete draft for current statement (fire-and-forget)
  const deleteDraftForCurrentStatement = useCallback(() => {
    // Cancel any pending auto-save so it doesn't re-create the draft
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    const params = buildDraftParams();
    if (!params) return;
    authFetch(`${API_BASE}/bank-import/draft?${params.toString()}`, { method: 'DELETE' }).catch(() => {});
  }, [buildDraftParams]);

  // Ref for debounced auto-save timer
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Holds draft user edits to be merged after fresh analysis completes
  const pendingDraftEditsRef = useRef<any>(null);
  // Suppresses auto-save during the import+refresh window; cleared once refresh completes
  const draftSuppressedRef = useRef<boolean>(false);

  // Fetch customers and suppliers using react-query (auto-refreshes on company switch)
  const { data: customersData } = useQuery({
    queryKey: ['bank-import-customers'],
    queryFn: async () => {
      const res = await authFetch(`${API_BASE}/bank-import/accounts/customers`);
      return res.json();
    },
  });

  const { data: suppliersData } = useQuery({
    queryKey: ['bank-import-suppliers'],
    queryFn: async () => {
      const res = await authFetch(`${API_BASE}/bank-import/accounts/suppliers`);
      return res.json();
    },
  });

  const customers: OperaAccount[] = customersData?.success ? customersData.accounts : [];
  const suppliers: OperaAccount[] = suppliersData?.success ? suppliersData.accounts : [];

  // Fetch nominal accounts for NL posting
  const { data: nominalAccountsData } = useQuery({
    queryKey: ['bank-import-nominals'],
    queryFn: async () => {
      const res = await authFetch(`${API_BASE}/gocardless/nominal-accounts`);
      return res.json();
    },
  });

  interface NominalAccount {
    code: string;
    description: string;
    allow_project?: number;
    allow_department?: number;
    default_project?: string;
    default_department?: string;
  }
  const nominalAccounts: NominalAccount[] = nominalAccountsData?.success ? nominalAccountsData.accounts : [];

  // Fetch advanced nominal config (project/department enabled)
  const { data: advancedNominalData } = useQuery({
    queryKey: ['advanced-nominal-config', dataSource, opera3DataPath],
    queryFn: async () => {
      const url = dataSource === 'opera3'
        ? `${API_BASE}/opera3/nominal/advanced-config?data_path=${encodeURIComponent(opera3DataPath)}`
        : `${API_BASE}/nominal/advanced-config`;
      const res = await authFetch(url);
      return res.json();
    },
    enabled: dataSource !== 'opera3' || !!opera3DataPath,
  });
  const advNomConfig = advancedNominalData?.success
    ? {
        project_enabled: advancedNominalData.project_enabled,
        department_enabled: advancedNominalData.department_enabled,
        project_label: advancedNominalData.project_label || 'Project',
        department_label: advancedNominalData.department_label || 'Department',
      }
    : { project_enabled: false, department_enabled: false, project_label: 'Project', department_label: 'Department' };

  const { data: projectCodesData } = useQuery({
    queryKey: ['nominal-projects', dataSource, opera3DataPath],
    queryFn: async () => {
      const url = dataSource === 'opera3'
        ? `${API_BASE}/opera3/nominal/projects?data_path=${encodeURIComponent(opera3DataPath)}`
        : `${API_BASE}/nominal/projects`;
      const res = await authFetch(url);
      return res.json();
    },
    enabled: advNomConfig.project_enabled && (dataSource !== 'opera3' || !!opera3DataPath),
  });
  const projectCodes: { code: string; description: string }[] = projectCodesData?.success ? projectCodesData.projects : [];

  const { data: deptCodesData } = useQuery({
    queryKey: ['nominal-departments', dataSource, opera3DataPath],
    queryFn: async () => {
      const url = dataSource === 'opera3'
        ? `${API_BASE}/opera3/nominal/departments?data_path=${encodeURIComponent(opera3DataPath)}`
        : `${API_BASE}/nominal/departments`;
      const res = await authFetch(url);
      return res.json();
    },
    enabled: advNomConfig.department_enabled && (dataSource !== 'opera3' || !!opera3DataPath),
  });
  const departmentCodes: { code: string; description: string }[] = deptCodesData?.success ? deptCodesData.departments : [];

  // Fetch VAT codes for nominal postings
  const { data: vatCodesData } = useQuery({
    queryKey: ['bank-import-vat-codes'],
    queryFn: async () => {
      const res = await authFetch(`${API_BASE}/gocardless/vat-codes`);
      return res.json();
    },
  });
  const vatCodes: VatCode[] = vatCodesData?.success ? vatCodesData.codes : [];

  // Nominal detail modal state
  const [nominalDetailModal, setNominalDetailModal] = useState<{
    open: boolean;
    transaction: BankImportTransaction | null;
    transactionType: TransactionType | null;
    source: 'unmatched' | 'refund' | 'skipped' | 'receipts' | 'payments';
  }>({ open: false, transaction: null, transactionType: null, source: 'unmatched' });

  // Nominal posting details - maps row number to detail
  const [nominalPostingDetails, setNominalPostingDetails] = useState<Map<number, NominalPostingDetail>>(new Map());

  // "Apply to all similar" confirmation banner state
  const [applyAllSimilar, setApplyAllSimilar] = useState<{
    show: boolean;
    similarityKey: string;
    sourceRow: number;
    count: number;
    accountCode: string;
    ledgerType: 'C' | 'S' | 'N';
    accountName: string;
    transactionType?: TransactionType;
    nominalDetail?: NominalPostingDetail;
  } | null>(null);

  // Bank transfer modal state
  const [bankTransferModal, setBankTransferModal] = useState<{
    open: boolean;
    transaction: BankImportTransaction | null;
    source: 'unmatched' | 'refund' | 'skipped' | 'receipts' | 'payments';
  }>({ open: false, transaction: null, source: 'unmatched' });

  // Bank transfer details - maps row number to full transfer info
  const [bankTransferDetails, setBankTransferDetails] = useState<Map<number, {
    destBankCode: string;
    destBankName: string;
    cashbookType: string;
    reference: string;
    comment: string;
    date: string;
  }>>(new Map());

  // Modal form state (at component level to avoid hooks-in-render issues)
  const [modalNominalCode, setModalNominalCode] = useState('');
  const [modalNominalSearch, setModalNominalSearch] = useState('');
  const [modalNominalDropdownOpen, setModalNominalDropdownOpen] = useState(false);
  const [modalNominalHighlightIndex, setModalNominalHighlightIndex] = useState(0);
  const [modalVatCode, setModalVatCode] = useState('');
  const [modalVatSearch, setModalVatSearch] = useState('');
  const [modalVatDropdownOpen, setModalVatDropdownOpen] = useState(false);
  const [modalVatHighlightIndex, setModalVatHighlightIndex] = useState(0);
  const [modalNetAmount, setModalNetAmount] = useState('');
  const [modalVatAmount, setModalVatAmount] = useState('');
  const [modalProjectCode, setModalProjectCode] = useState('');
  const [modalDepartmentCode, setModalDepartmentCode] = useState('');
  // Bank transfer modal fields
  const [modalDestBank, setModalDestBank] = useState('');
  const [modalDestBankSearch, setModalDestBankSearch] = useState('');
  const [modalDestBankDropdownOpen, setModalDestBankDropdownOpen] = useState(false);
  const [modalDestBankHighlightIndex, setModalDestBankHighlightIndex] = useState(0);
  const [modalCashbookType, setModalCashbookType] = useState('');
  const [modalReference, setModalReference] = useState('');
  const [modalComment, setModalComment] = useState('');
  const [modalDate, setModalDate] = useState('');

  // Refs for modal form focus management (fast keyboard entry)
  const modalVatInputRef = useRef<HTMLInputElement>(null);
  const modalNetAmountRef = useRef<HTMLInputElement>(null);
  const modalSaveButtonRef = useRef<HTMLButtonElement>(null);
  const modalDestBankInputRef = useRef<HTMLInputElement>(null);
  const modalBankTransferSaveRef = useRef<HTMLButtonElement>(null);

  // Refs for auto-scrolling between workflow stages
  const stage2Ref = useRef<HTMLDivElement>(null);
  const importResultRef = useRef<HTMLDivElement>(null);

  // Inline account search state (for table dropdowns)
  const [inlineAccountSearch, setInlineAccountSearch] = useState<{ row: number; section: string } | null>(null);
  const [inlineAccountSearchText, setInlineAccountSearchText] = useState('');
  const [inlineAccountHighlightIndex, setInlineAccountHighlightIndex] = useState(0);

  // Save state to sessionStorage whenever key data changes (placed after all state declarations)
  useEffect(() => {
    // Don't save until restore is complete (prevents overwriting with empty state)
    if (!sessionRestoreComplete.current) return;

    // Only save navigation context to session storage (bank, source, statement selection)
    // Preview data and user edits are persisted via backend drafts, not session storage
    try {
      const toSave = {
        csvFileName,
        csvDirectory,
        selectedBankCode,
        statementSource,
        selectedEmailStatement,
        selectedPdfFile,
      };
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
    } catch (e) {
      console.warn('Failed to save bank import state to session storage:', e);
    }
  }, [csvFileName, csvDirectory, selectedBankCode, statementSource, selectedEmailStatement, selectedPdfFile]);

  // Debounced auto-save to backend (persists across browser sessions)
  useEffect(() => {
    if (!sessionRestoreComplete.current) return;
    if (!bankPreview || !selectedBankCode) return;
    // Don't auto-save if all items are already in Opera or import+refresh is in progress
    if (allTransactionsImported || draftSuppressedRef.current) return;

    // Clear any pending save
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);

    draftSaveTimerRef.current = setTimeout(() => {
      const params = buildDraftParams();
      if (!params) return;

      const userEdits = {
        editedTransactions: mapToArray(editedTransactions),
        selectedForImport: Array.from(selectedForImport),
        dateOverrides: Array.from(dateOverrides.entries()),
        transactionTypeOverrides: Array.from(transactionTypeOverrides.entries()),
        includedSkipped: Array.from(includedSkipped.entries()),
        refundOverrides: Array.from(refundOverrides.entries()),
        nominalPostingDetails: mapToArray(nominalPostingDetails),
        bankTransferDetails: mapToArray(bankTransferDetails),
        autoAllocateDisabled: Array.from(autoAllocateDisabled),
        cbtypeOverrides: Array.from(cbtypeOverrides.entries()),
        ignoredTransactions: Array.from(ignoredTransactions),
        deferredRows: Array.from(deferredRows),
      };

      authFetch(`${API_BASE}/bank-import/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bank_code: selectedBankCode,
          source: selectedEmailStatement ? 'email' : 'pdf',
          email_id: selectedEmailStatement?.emailId,
          attachment_id: selectedEmailStatement?.attachmentId,
          filename: selectedEmailStatement?.filename || selectedPdfFile?.filename || '',
          preview_data: bankPreview,
          user_edits: userEdits,
          target_system: dataSource === 'opera3' ? 'opera3' : 'opera_se',
        }),
      }).catch(() => {}); // Silent failure — sessionStorage is fallback
    }, 2000);

    return () => {
      if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    };
  }, [bankPreview, editedTransactions, selectedForImport, dateOverrides, transactionTypeOverrides, includedSkipped, refundOverrides, nominalPostingDetails, bankTransferDetails, autoAllocateDisabled, cbtypeOverrides, ignoredTransactions, deferredRows, selectedBankCode, selectedEmailStatement, selectedPdfFile, buildDraftParams, dataSource, mapToArray]);

  // Helper function to determine smart default transaction type for unmatched transactions
  // Defaults to nominal unless there's a pattern suggestion or clear customer/supplier hint
  const getSmartDefaultTransactionType = useCallback((txn: BankImportTransaction): TransactionType => {
    const isPositive = txn.amount > 0;

    // Check if any actual customer/supplier name appears in the transaction text
    // Pattern learner suggestions (suggested_account/suggested_type) are used for
    // pre-filling the account dropdown, but NOT for the transaction type default.
    // Unmatched items default to nominal unless a real name match is found.
    const name = (txn.name || '').toLowerCase();
    const memo = (txn.memo || '').toLowerCase();
    const reference = (txn.reference || '').toLowerCase();
    const combined = `${name} ${memo} ${reference}`;

    if (isPositive && customers.length > 0) {
      for (const cust of customers) {
        const custName = (cust.name || '').toLowerCase();
        if (custName.length >= 3 && combined.includes(custName)) {
          return 'sales_receipt';
        }
      }
    }

    if (!isPositive && suppliers.length > 0) {
      for (const supp of suppliers) {
        const suppName = (supp.name || '').toLowerCase();
        if (suppName.length >= 3 && combined.includes(suppName)) {
          return 'purchase_payment';
        }
      }
    }

    // Refund cases — opposite sign-direction matches.
    // Negative amount + customer match → we are refunding the customer
    // (overpayment, mistaken collection, or credit-note repayment).
    if (!isPositive && customers.length > 0) {
      for (const cust of customers) {
        const custName = (cust.name || '').toLowerCase();
        if (custName.length >= 3 && combined.includes(custName)) {
          return 'sales_refund';
        }
      }
    }

    // Positive amount + supplier match → supplier is refunding us
    // (overpayment recovered, returned goods, etc.).
    if (isPositive && suppliers.length > 0) {
      for (const supp of suppliers) {
        const suppName = (supp.name || '').toLowerCase();
        if (suppName.length >= 3 && combined.includes(suppName)) {
          return 'purchase_refund';
        }
      }
    }

    // Default to nominal - if no customer/supplier name found, it's likely a bank charge,
    // fee, interest, or other nominal entry
    return isPositive ? 'nominal_receipt' : 'nominal_payment';
  }, [customers, suppliers]);

  // Smart default cashbook type (cbtype) selection based on transaction action, statement description, and atype descriptions
  const getBestCbtype = useCallback((action: string | undefined, types: Array<{code: string; description: string}>, txnDescription?: string): string => {
    if (types.length === 0) return '';
    if (types.length === 1) return types[0].code;

    // Keywords to match against atype descriptions based on transaction action
    const actionKeywords: Record<string, string[]> = {
      'sales_receipt': ['receipt', 'sales', 'customer', 'income'],
      'purchase_refund': ['refund', 'purchase', 'supplier', 'credit note'],
      'purchase_payment': ['payment', 'purchase', 'supplier', 'creditor'],
      'sales_refund': ['refund', 'sales', 'customer'],
      'nominal_receipt': ['nominal', 'other', 'misc', 'sundry', 'general'],
      'nominal_payment': ['nominal', 'other', 'misc', 'charge', 'fee', 'general'],
    };

    // Extract meaningful phrases from the statement description (e.g., "Direct Credit", "Card Payment", "BACS")
    const descWords: string[] = [];
    if (txnDescription) {
      const desc = txnDescription.toLowerCase();
      // Match common bank statement payment method phrases against atype descriptions
      const phrases = [
        'direct credit', 'direct debit', 'card payment', 'card', 'bacs',
        'faster payment', 'standing order', 'cheque', 'chq', 'cash',
        'transfer', 'dd', 'so', 'bgc', 'credit', 'debit',
        'online', 'pos', 'atm', 'wire', 'swift', 'chaps'
      ];
      for (const phrase of phrases) {
        if (desc.includes(phrase)) descWords.push(phrase);
      }
    }

    const actionTerms = actionKeywords[action || ''] || [];

    // Score each type by matching both action keywords and statement description
    let bestScore = -1;
    let bestCode = types[0].code;
    for (const t of types) {
      const typeDesc = t.description.toLowerCase();
      let score = 0;
      // Action keyword matches (weight: 1 each)
      for (const term of actionTerms) {
        if (typeDesc.includes(term)) score += 1;
      }
      // Statement description matches (weight: 3 each - stronger signal)
      for (const word of descWords) {
        if (typeDesc.includes(word)) score += 3;
      }
      if (score > bestScore) {
        bestScore = score;
        bestCode = t.code;
      }
    }
    return bestCode;
  }, []);

  // Filter cbtype options by transaction action to prevent mismatched types
  // (e.g., 'PR' Purchase Refund should not appear when action is 'sales_receipt')
  const filterCbtypesForAction = useCallback((types: Array<{code: string; description: string}>, action: string): Array<{code: string; description: string}> => {
    if (!action || types.length === 0) return types;
    const isRefundAction = action === 'purchase_refund' || action === 'sales_refund';
    const filtered = types.filter(t => {
      const desc = t.description.toLowerCase();
      const code = t.code.trim().toUpperCase();
      const looksLikeRefund = desc.includes('refund') || desc.includes('credit note') ||
                               code === 'PR' || code === 'SR';
      return isRefundAction ? looksLikeRefund : !looksLikeRefund;
    });
    // Fallback: if filter removes everything, show all types
    return filtered.length > 0 ? filtered : types;
  }, []);

  // Bank account selector search state
  const [bankSelectSearch, setBankSelectSearch] = useState('');
  const [bankSelectOpen, setBankSelectOpen] = useState<string | null>(null); // 'email' | 'pdf' | 'csv' | null
  const [bankSelectHighlightIndex, setBankSelectHighlightIndex] = useState(0);

  // Fetch CSV files in the selected directory
  const { data: csvFilesData } = useQuery({
    queryKey: ['csv-files', csvDirectory],
    queryFn: async () => {
      const res = await authFetch(`${API_BASE}/bank-import/list-csv?directory=${encodeURIComponent(csvDirectory)}`);
      return res.json();
    },
    enabled: !!csvDirectory,
  });
  const csvFilesList = csvFilesData?.success ? csvFilesData.files : [];

  // Scan PDF files function - called on button click (mirrors email scan)
  const handleScanPdfFiles = async () => {
    if (!pdfDirectory) return;

    setPdfFilesLoading(true);
    setPdfFilesList(null);

    try {
      const res = await authFetch(
        `${API_BASE}/bank-import/list-pdf?directory=${encodeURIComponent(pdfDirectory)}&bank_code=${selectedBankCode}`
      );
      const data = await res.json();

      if (data.success) {
        setPdfFilesList(data.files || []);
      } else {
        setPdfFilesList([]);
      }
    } catch (err) {
      console.error('Failed to scan PDF files:', err);
      setPdfFilesList([]);
    } finally {
      setPdfFilesLoading(false);
    }
  };

  // Build full CSV file path from directory + filename
  const csvFilePath = csvDirectory && csvFileName
    ? (csvDirectory.endsWith('/') || csvDirectory.endsWith('\\')
        ? csvDirectory + csvFileName
        : csvDirectory + '/' + csvFileName)
    : csvFileName;

  // State for detected bank from file
  const [detectedBank, setDetectedBank] = useState<{
    detected: boolean;
    bank_code: string | null;
    bank_description: string;
    sort_code: string;
    account_number: string;
    message: string;
    loading: boolean;
  } | null>(null);

  // Auto-detect bank when file path changes
  useEffect(() => {
    const detectBank = async () => {
      if (!csvFilePath || !csvFilePath.trim()) {
        setDetectedBank(null);
        return;
      }

      setDetectedBank(prev => prev ? { ...prev, loading: true } : { detected: false, bank_code: null, bank_description: '', sort_code: '', account_number: '', message: 'Detecting...', loading: true });

      try {
        const response = await authFetch(`${API_BASE}/bank-import/detect-bank?filepath=${encodeURIComponent(csvFilePath)}`, {
          method: 'POST'
        });
        const data = await response.json();

        if (data.success && data.detected) {
          setDetectedBank({
            detected: true,
            bank_code: data.bank_code,
            bank_description: data.bank_description || data.bank_code,
            sort_code: data.sort_code || '',
            account_number: data.account_number || '',
            message: data.message || `Detected: ${data.bank_code}`,
            loading: false
          });
          // Auto-select the detected bank
          if (data.bank_code) {
            setSelectedBankCode(data.bank_code);
          }
        } else if (data.success && !data.detected) {
          setDetectedBank({
            detected: false,
            bank_code: null,
            bank_description: '',
            sort_code: '',
            account_number: '',
            message: data.message || 'Could not detect bank from file',
            loading: false
          });
        } else {
          setDetectedBank({
            detected: false,
            bank_code: null,
            bank_description: '',
            sort_code: '',
            account_number: '',
            message: data.error || 'Detection failed',
            loading: false
          });
        }
      } catch (error) {
        setDetectedBank({
          detected: false,
          bank_code: null,
          bank_description: '',
          sort_code: '',
          account_number: '',
          message: error instanceof Error ? error.message : 'Detection error',
          loading: false
        });
      }
    };

    detectBank();
  }, [csvFilePath]);

  // Persist CSV directory to localStorage
  useEffect(() => {
    if (csvDirectory) {
      localStorage.setItem('bankImport_csvDirectory', csvDirectory);
    }
  }, [csvDirectory]);

  // Save bank code to company-specific localStorage key
  useEffect(() => {
    if (selectedBankCode && currentCompanyId) {
      localStorage.setItem(`bankImport_bankCode_${currentCompanyId}`, selectedBankCode);
    }
  }, [selectedBankCode, currentCompanyId]);

  useEffect(() => {
    if (opera3DataPath) {
      localStorage.setItem('bankImport_opera3DataPath', opera3DataPath);
    }
  }, [opera3DataPath]);

  // Persist PDF directory to localStorage
  useEffect(() => {
    if (pdfDirectory) {
      localStorage.setItem('bankImport_pdfDirectory', pdfDirectory);
    }
  }, [pdfDirectory]);

  // Fetch bank accounts using react-query (auto-refreshes on company switch).
  // Endpoint moved to /api/cashbook/bank-accounts when the cashbook
  // sub-routes were consolidated; the old /opera-sql/bank-accounts path
  // 404s, leaving bankAccounts empty and the bank-transfer dropdown
  // unsearchable.
  const { data: bankAccountsData } = useQuery({
    queryKey: ['bank-accounts'],
    queryFn: async () => {
      const res = await authFetch(`${API_BASE}/cashbook/bank-accounts`);
      return res.json();
    },
  });

  // Track previous company to detect company switches
  // Use null to distinguish "never set" from "empty string"
  const previousCompanyRef = useRef<string | null>(null);
  const hasInitializedBankCode = useRef<boolean>(false);

  // Update bank accounts state when data changes or company changes
  useEffect(() => {
    // The cashbook endpoint returns the array under the key `banks`;
    // older code expected `bank_accounts`. Accept either so a future
    // BE change doesn't silently empty the dropdown again.
    const banksFromResp =
      bankAccountsData?.banks ?? bankAccountsData?.bank_accounts ?? null;
    if (bankAccountsData?.success && Array.isArray(banksFromResp) && currentCompanyId) {
      const accounts = banksFromResp.map((b: any) => ({
        code: b.code,
        description: b.description,
        sort_code: b.sort_code || '',
        account_number: b.account_number || ''
      }));
      setBankAccounts(accounts);

      // Detect if company has ACTUALLY changed (not initial load)
      // previousCompanyRef.current === null means this is first load
      const previousCompany = previousCompanyRef.current;
      const isInitialLoad = previousCompany === null;
      const companyChanged = !isInitialLoad && previousCompany !== currentCompanyId;

      // Update ref after checking
      previousCompanyRef.current = currentCompanyId;

      // Only set bank code on initial load or company change
      // BUT skip if we restored from session (session bank code takes priority)
      if ((!hasInitializedBankCode.current || companyChanged) && !hasRestoredFromSession.current) {
        hasInitializedBankCode.current = true;

        // Load bank code from company-specific localStorage key
        const savedBankCode = localStorage.getItem(`bankImport_bankCode_${currentCompanyId}`);
        const savedBankCodeValid = savedBankCode ? accounts.some((a: BankAccount) => a.code === savedBankCode) : false;

        if (savedBankCodeValid) {
          setSelectedBankCode(savedBankCode!);
        } else if (accounts.length > 0) {
          setSelectedBankCode(accounts[0].code);
        }
      } else if (hasRestoredFromSession.current) {
        // Mark as initialized even if we skipped (session had the value)
        hasInitializedBankCode.current = true;
      }

      // Clear ALL reconciliation state ONLY when company actually changes (NOT on initial load)
      if (companyChanged) {
        console.log(`Company changed from ${previousCompany} to ${currentCompanyId} - clearing all reconciliation state`);
        // Clear bank preview and transaction state
        setBankPreview(null);
        setBankImportResult(null);
        setEditedTransactions(new Map());
        setSelectedForImport(new Set());
        setIncludedSkipped(new Map());
        setTransactionTypeOverrides(new Map());
        setRefundOverrides(new Map());
        setAutoAllocateDisabled(new Set());
        setDateOverrides(new Map());
        setNominalPostingDetails(new Map());
        setBankTransferDetails(new Map());
        setUpdatedRepeatEntries(new Set());
        setRepeatEntriesProcessed(false);
        // Clear email/PDF selections
        setSelectedEmailStatement(null);
        setEmailStatements([]);
        setSelectedPdfFile(null);
        setPdfFilesList([]);
        // Clear file selections
        setCsvFileName('');
        // Clear detected bank
        setDetectedBank(null);
        // Clear UI state
        setShowRawPreview(false);
        setRawFilePreview(null);
        setShowReconcilePrompt(false);
        setShowImportHistory(false);
        setImportHistoryData([]);
        // Reset tabs
        setActivePreviewTab('receipts');
        setTabSearchFilter('');
        // Clear session storage and backend draft for old company
        clearPersistedState();
        deleteDraftForCurrentStatement();
      }
    }
  }, [bankAccountsData, currentCompanyId]);

  // Fetch available Opera cashbook types (Receipt and Payment categories)
  useEffect(() => {
    const fetchCashbookTypes = async () => {
      try {
        const [receiptRes, paymentRes] = await Promise.all([
          authFetch(`${API_BASE}/bank-import/cashbook-types?category=R`),
          authFetch(`${API_BASE}/bank-import/cashbook-types?category=P`)
        ]);
        const receiptData = await receiptRes.json();
        const paymentData = await paymentRes.json();
        if (receiptData.success) setReceiptTypes(receiptData.types || []);
        if (paymentData.success) setPaymentTypes(paymentData.types || []);
      } catch (e) {
        console.warn('Failed to fetch cashbook types:', e);
      }
    };
    fetchCashbookTypes();
  }, []);


  // Query for reconciliation-in-progress status
  const { data: reconciliationStatus } = useQuery({
    queryKey: ['bank-reconciliation-status', selectedBankCode, dataSource, opera3DataPath, selectedPdfFile?.filename, selectedEmailStatement?.filename],
    queryFn: async () => {
      if (!selectedBankCode) return null;
      const currentFn = selectedPdfFile?.filename || selectedEmailStatement?.filename || '';
      const fnParam = currentFn ? `&current_filename=${encodeURIComponent(currentFn)}` : '';
      if (dataSource === 'opera3') {
        if (!opera3DataPath) return null;
        const res = await authFetch(`${API_BASE}/opera3/reconcile/bank/${selectedBankCode}/status?data_path=${encodeURIComponent(opera3DataPath)}${fnParam}`);
        return res.json();
      } else {
        const res = await authFetch(`${API_BASE}/reconcile/bank/${selectedBankCode}/status?_=1${fnParam}`);
        return res.json();
      }
    },
    enabled: !!selectedBankCode && (dataSource !== 'opera3' || !!opera3DataPath),
    refetchOnWindowFocus: true,
    staleTime: 30000, // 30 seconds
  });

  // =====================
  // IMPORT HISTORY FUNCTIONS
  // =====================

  // Fetch import history - uses Opera 3 endpoint if configured
  const fetchImportHistory = useCallback(async (limit: number = historyLimit, fromDate?: string, toDate?: string) => {
    setImportHistoryLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(limit) });
      if (fromDate) params.append('from_date', fromDate);
      if (toDate) params.append('to_date', toDate);
      const historyUrl = dataSource === 'opera3'
        ? `/api/opera3/bank-import/import-history?${params}`
        : `/api/bank-import/import-history?${params}`;
      const response = await authFetch(historyUrl);
      const data = await response.json();
      if (data.success) {
        setImportHistoryData(data.imports || []);
      }
    } catch (error) {
      console.error('Failed to fetch import history:', error);
    } finally {
      setImportHistoryLoading(false);
    }
  }, [dataSource, historyLimit]);

  // Fetch statement review data for expanded history row
  const fetchStatementReview = useCallback(async (importId: number) => {
    setStatementReviewLoading(true);
    setStatementReviewError(null);
    setStatementReview(null);
    setShowUnreconciledOnly(false);
    try {
      const url = dataSource === 'opera3'
        ? `/api/opera3/bank-import/statement-review/${importId}`
        : `/api/bank-import/statement-review/${importId}`;
      const response = await authFetch(url);
      const data = await response.json();
      if (data.success) {
        setStatementReview(data);
      } else {
        setStatementReviewError(data.error || 'Failed to load statement review');
      }
    } catch (error) {
      console.error('Failed to fetch statement review:', error);
      setStatementReviewError('Failed to load statement review');
    } finally {
      setStatementReviewLoading(false);
    }
  }, [dataSource]);

  // Toggle expanded history row, clearing review state when switching
  const toggleHistoryRow = useCallback((id: number) => {
    setExpandedHistoryId(prev => {
      const newId = prev === id ? null : id;
      if (newId !== prev) {
        setStatementReview(null);
        setStatementReviewError(null);
        setShowUnreconciledOnly(false);
      }
      return newId;
    });
  }, []);

  // Clear import history
  const clearImportHistory = async () => {
    setShowClearConfirm(false);
    setIsClearing(true);
    try {
      const params = new URLSearchParams();
      if (historyFromDate) params.append('from_date', historyFromDate);
      if (historyToDate) params.append('to_date', historyToDate);
      const url = dataSource === 'opera3'
        ? `/api/opera3/bank-import/import-history?${params}`
        : `/api/bank-import/import-history?${params}`;
      const response = await authFetch(url, { method: 'DELETE' });
      const data = await response.json();
      if (data.success) {
        alert(`Cleared ${data.deleted_count} records`);
        fetchImportHistory(historyLimit, historyFromDate, historyToDate);
      } else {
        alert(`Error: ${data.error}`);
      }
    } catch (error) {
      console.error('Failed to clear history:', error);
      alert('Failed to clear history');
    } finally {
      setIsClearing(false);
    }
  };

  // Delete single history record to allow re-import
  const deleteHistoryRecord = async () => {
    if (!reImportRecord) return;
    setIsDeleting(true);
    try {
      const url = dataSource === 'opera3'
        ? `/api/opera3/bank-import/import-history/${reImportRecord.id}`
        : `/api/bank-import/import-history/${reImportRecord.id}`;
      const response = await authFetch(url, { method: 'DELETE' });
      const data = await response.json();
      if (data.success) {
        fetchImportHistory(historyLimit, historyFromDate, historyToDate);
        setReImportRecord(null);
      } else {
        alert(`Error: ${data.error}`);
      }
    } catch (error) {
      console.error('Failed to delete history record:', error);
      alert('Failed to delete history record');
    } finally {
      setIsDeleting(false);
    }
  };

  // Load history when modal opens
  useEffect(() => {
    if (showImportHistory) {
      fetchImportHistory(historyLimit, historyFromDate, historyToDate);
    }
  }, [showImportHistory, fetchImportHistory, historyLimit, historyFromDate, historyToDate]);

  // Common fields
  const [bankAccount, setBankAccount] = useState('');
  const [postDate, setPostDate] = useState(new Date().toISOString().split('T')[0]);
  const [inputBy, setInputBy] = useState('IMPORT');
  const [reference, setReference] = useState('');

  // Sales Receipt fields
  const [customerAccount, setCustomerAccount] = useState('');
  const [receiptAmount, setReceiptAmount] = useState('');

  // Purchase Payment fields
  const [supplierAccount, setSupplierAccount] = useState('');
  const [paymentAmount, setPaymentAmount] = useState('');

  // Invoice fields
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [netAmount, setNetAmount] = useState('');
  const [vatAmount, setVatAmount] = useState('');
  const [nominalAccount, setNominalAccount] = useState('');
  const [description, setDescription] = useState('');

  // Nominal Journal fields
  const [journalLines, setJournalLines] = useState([
    { account: '', amount: '', description: '' },
    { account: '', amount: '', description: '' }
  ]);

  const resetForm = () => {
    setResult(null);
    setReference('');
    setCustomerAccount('');
    setReceiptAmount('');
    setSupplierAccount('');
    setPaymentAmount('');
    setInvoiceNumber('');
    setNetAmount('');
    setVatAmount('');
    setDescription('');
    setJournalLines([
      { account: '', amount: '', description: '' },
      { account: '', amount: '', description: '' }
    ]);
    // Bank statement reset - keep csvFilePath as it's persisted
    setBankPreview(null);
    setBankImportResult(null);
    clearPersistedState(); // Clear sessionStorage when form is reset
  };

  // Shared helper: apply pattern learning suggestions to unmatched/skipped items and auto-select them
  const applySuggestionsAndAutoSelect = (
    enhancedPreview: EnhancedBankImportPreview,
    preSelected: Set<number>
  ) => {
    const newEditedTransactions = new Map<number, BankImportTransaction>();
    const newTransactionTypeOverrides = new Map<number, TransactionType>();
    const newIncludedSkipped = new Map<number, { account: string; ledger_type: 'C' | 'S'; transaction_type: TransactionType }>();
    const newNominalPostingDetails = new Map<number, NominalPostingDetail>();
    const newBankTransferDetails = new Map<number, {
      destBankCode: string; destBankName: string; cashbookType: string;
      reference: string; comment: string; date: string;
    }>();

    // Auto-populate bank transfer details from matched receipts/payments
    for (const txn of [...enhancedPreview.matched_receipts, ...enhancedPreview.matched_payments]) {
      if (txn.action === 'bank_transfer' && txn.bank_transfer_details?.dest_bank) {
        newBankTransferDetails.set(txn.row, {
          destBankCode: txn.bank_transfer_details.dest_bank,
          destBankName: txn.account_name || '',
          cashbookType: 'TRF',
          reference: txn.reference || '',
          comment: '',
          date: txn.date || ''
        });
        newTransactionTypeOverrides.set(txn.row, 'bank_transfer');
      }
    }

    // Apply suggestions to UNMATCHED transactions
    for (const txn of enhancedPreview.unmatched) {
      const suggestion = (txn as any);
      if (suggestion.suggested_account && suggestion.suggested_ledger_type) {
        newEditedTransactions.set(txn.row, {
          ...txn,
          manual_account: suggestion.suggested_account,
          manual_ledger_type: suggestion.suggested_ledger_type,
          account_name: suggestion.suggested_account_name || '',
          isEdited: true
        });
        if (suggestion.suggested_type) {
          const typeMap: Record<string, TransactionType> = {
            'SI': 'sales_receipt', 'PI': 'purchase_payment',
            'SC': 'sales_refund', 'PC': 'purchase_refund',
            'NP': 'nominal_payment', 'NR': 'nominal_receipt',
            'BT': 'bank_transfer'
          };
          const mappedType = typeMap[suggestion.suggested_type];
          if (mappedType) newTransactionTypeOverrides.set(txn.row, mappedType);
        }
        if (suggestion.suggested_type === 'NP' || suggestion.suggested_type === 'NR') {
          if (suggestion.suggested_nominal_code) {
            const grossAmount = Math.abs(txn.amount);
            newNominalPostingDetails.set(txn.row, {
              nominalCode: suggestion.suggested_nominal_code,
              vatCode: suggestion.suggested_vat_code || 'N/A',
              vatRate: 0,
              netAmount: grossAmount,
              vatAmount: 0,
              grossAmount: grossAmount
            });
          }
        }
        if (!txn.is_duplicate) preSelected.add(txn.row);
      }
    }

    // Apply suggestions to SKIPPED transactions
    for (const txn of enhancedPreview.skipped) {
      const suggestion = (txn as any);
      if (suggestion.suggested_account && suggestion.suggested_ledger_type) {
        let transactionType: TransactionType = txn.amount > 0 ? 'sales_receipt' : 'purchase_payment';
        if (suggestion.suggested_type) {
          const typeMap: Record<string, TransactionType> = {
            'SI': 'sales_receipt', 'PI': 'purchase_payment',
            'SC': 'sales_refund', 'PC': 'purchase_refund',
            'NP': 'nominal_payment', 'NR': 'nominal_receipt',
            'BT': 'bank_transfer'
          };
          transactionType = typeMap[suggestion.suggested_type] || transactionType;
        }
        newIncludedSkipped.set(txn.row, {
          account: suggestion.suggested_account,
          ledger_type: suggestion.suggested_ledger_type,
          transaction_type: transactionType
        });
        if (!txn.is_duplicate) preSelected.add(txn.row);
      }
    }

    return { newEditedTransactions, newTransactionTypeOverrides, newIncludedSkipped, newNominalPostingDetails, newBankTransferDetails };
  };

  // Snapshot all user assignments keyed by row number (for refresh preservation)
  interface UserAssignmentSnapshot {
    editedTransactions: Map<number, BankImportTransaction>;
    transactionTypeOverrides: Map<number, TransactionType>;
    includedSkipped: Map<number, { account: string; ledger_type: 'C' | 'S'; transaction_type: TransactionType }>;
    nominalPostingDetails: Map<number, NominalPostingDetail>;
    bankTransferDetails: Map<number, { destBankCode: string; destBankName: string; cashbookType: string; reference: string; comment: string; date: string }>;
    refundOverrides: Map<number, { transaction_type?: TransactionType; account?: string; ledger_type?: 'C' | 'S'; rejected?: boolean }>;
    dateOverrides: Map<number, string>;
    autoAllocateDisabled: Set<number>;
    cbtypeOverrides: Map<number, string>;
    rowFingerprints: Map<number, string>;
    selectedForImport: Set<number>;
  }

  const snapshotUserAssignments = (): UserAssignmentSnapshot => {
    // Build fingerprint map from current preview data
    const rowFingerprints = new Map<number, string>();
    if (bankPreview) {
      const allTxns = [
        ...(bankPreview.matched_receipts || []),
        ...(bankPreview.matched_payments || []),
        ...(bankPreview.matched_refunds || []),
        ...(bankPreview.repeat_entries || []),
        ...(bankPreview.unmatched || []),
        ...(bankPreview.already_posted || []),
        ...(bankPreview.skipped || []),
      ];
      for (const txn of allTxns) {
        if (txn.fingerprint) {
          rowFingerprints.set(txn.row, txn.fingerprint);
        }
      }
    }
    return {
      editedTransactions: new Map(editedTransactions),
      transactionTypeOverrides: new Map(transactionTypeOverrides),
      includedSkipped: new Map(includedSkipped),
      nominalPostingDetails: new Map(nominalPostingDetails),
      bankTransferDetails: new Map(bankTransferDetails),
      refundOverrides: new Map(refundOverrides),
      dateOverrides: new Map(dateOverrides),
      autoAllocateDisabled: new Set(autoAllocateDisabled),
      cbtypeOverrides: new Map(cbtypeOverrides),
      rowFingerprints,
      selectedForImport: new Set(selectedForImport),
    };
  };

  // Merge user assignments back after a refresh, dropping assignments for rows now matched
  const mergeUserAssignments = (
    newPreview: EnhancedBankImportPreview,
    snapshot: UserAssignmentSnapshot,
    baseEdited: Map<number, BankImportTransaction>,
    baseTxnTypes: Map<number, TransactionType>,
    baseIncSkipped: Map<number, { account: string; ledger_type: 'C' | 'S'; transaction_type: TransactionType }>,
    baseNominal: Map<number, NominalPostingDetail>,
    baseBankTransfer: Map<number, { destBankCode: string; destBankName: string; cashbookType: string; reference: string; comment: string; date: string }>,
    baseSelected: Set<number>,
  ) => {
    // Build set of rows that are now auto-matched (receipts, payments, refunds, repeat, already_posted)
    const nowMatched = new Set<number>();
    for (const txn of [
      ...(newPreview.matched_receipts || []),
      ...(newPreview.matched_payments || []),
      ...(newPreview.matched_refunds || []),
      ...(newPreview.repeat_entries || []),
      ...(newPreview.already_posted || []),
    ]) {
      nowMatched.add(txn.row);
    }

    // Build fingerprint map for new preview
    const newFingerprints = new Map<number, string>();
    for (const txn of [
      ...(newPreview.matched_receipts || []),
      ...(newPreview.matched_payments || []),
      ...(newPreview.matched_refunds || []),
      ...(newPreview.repeat_entries || []),
      ...(newPreview.unmatched || []),
      ...(newPreview.already_posted || []),
      ...(newPreview.skipped || []),
    ]) {
      if (txn.fingerprint) {
        newFingerprints.set(txn.row, txn.fingerprint);
      }
    }

    // Start from the baseline (suggestion-applied) state
    const mergedEdited = new Map(baseEdited);
    const mergedTxnTypes = new Map(baseTxnTypes);
    const mergedIncSkipped = new Map(baseIncSkipped);
    const mergedNominal = new Map(baseNominal);
    const mergedBankTransfer = new Map(baseBankTransfer);
    const mergedRefundOverrides = new Map<number, { transaction_type?: TransactionType; account?: string; ledger_type?: 'C' | 'S'; rejected?: boolean }>();
    const mergedDateOverrides = new Map<number, string>();
    const mergedAutoAllocDisabled = new Set<number>();
    const mergedCbtypeOverrides = new Map<number, string>();
    const mergedSelected = new Set(baseSelected);

    // Helper: check if fingerprint is stable for a row
    const isFingerprintStable = (row: number): boolean => {
      const oldFp = snapshot.rowFingerprints.get(row);
      const newFp = newFingerprints.get(row);
      // If either side has no fingerprint, allow (best effort)
      if (!oldFp || !newFp) return true;
      return oldFp === newFp;
    };

    // Re-apply user assignments from snapshot for rows that are NOT now matched and have stable fingerprints
    for (const [row, txn] of snapshot.editedTransactions) {
      if (!nowMatched.has(row) && isFingerprintStable(row)) {
        mergedEdited.set(row, txn);
      }
    }
    for (const [row, type] of snapshot.transactionTypeOverrides) {
      if (!nowMatched.has(row) && isFingerprintStable(row)) {
        mergedTxnTypes.set(row, type);
      }
    }
    for (const [row, inc] of snapshot.includedSkipped) {
      if (!nowMatched.has(row) && isFingerprintStable(row)) {
        mergedIncSkipped.set(row, inc);
      }
    }
    for (const [row, detail] of snapshot.nominalPostingDetails) {
      if (!nowMatched.has(row) && isFingerprintStable(row)) {
        mergedNominal.set(row, detail);
      }
    }
    for (const [row, detail] of snapshot.bankTransferDetails) {
      if (!nowMatched.has(row) && isFingerprintStable(row)) {
        mergedBankTransfer.set(row, detail);
      }
    }
    for (const [row, override] of snapshot.refundOverrides) {
      if (!nowMatched.has(row) && isFingerprintStable(row)) {
        mergedRefundOverrides.set(row, override);
      }
    }
    for (const [row, date] of snapshot.dateOverrides) {
      if (!nowMatched.has(row) && isFingerprintStable(row)) {
        mergedDateOverrides.set(row, date);
      }
    }
    for (const row of snapshot.autoAllocateDisabled) {
      if (!nowMatched.has(row) && isFingerprintStable(row)) {
        mergedAutoAllocDisabled.add(row);
      }
    }
    for (const [row, cbtype] of snapshot.cbtypeOverrides) {
      if (!nowMatched.has(row) && isFingerprintStable(row)) {
        mergedCbtypeOverrides.set(row, cbtype);
      }
    }

    // Re-apply selection state from snapshot for rows not now-matched
    for (const row of snapshot.selectedForImport) {
      if (!nowMatched.has(row) && isFingerprintStable(row)) {
        mergedSelected.add(row);
      }
    }
    // Deselect rows that were NOT selected in snapshot (user explicitly deselected) and are still unmatched
    for (const txn of [...(newPreview.unmatched || []), ...(newPreview.skipped || [])]) {
      if (!nowMatched.has(txn.row) && isFingerprintStable(txn.row)) {
        // If the row existed in the old snapshot data and was NOT selected, honour that
        const wasInOldData = snapshot.rowFingerprints.has(txn.row) ||
          snapshot.editedTransactions.has(txn.row) ||
          snapshot.includedSkipped.has(txn.row);
        if (wasInOldData && !snapshot.selectedForImport.has(txn.row)) {
          mergedSelected.delete(txn.row);
        }
      }
    }

    return {
      mergedEdited,
      mergedTxnTypes,
      mergedIncSkipped,
      mergedNominal,
      mergedBankTransfer,
      mergedRefundOverrides,
      mergedDateOverrides,
      mergedAutoAllocDisabled,
      mergedCbtypeOverrides,
      mergedSelected,
    };
  };

  // Refresh matching against Opera without losing user assignments
  const handleRefreshPreview = async () => {
    if (!bankPreview?.success) return;

    // 1. Snapshot current user state
    const snapshot = snapshotUserAssignments();

    setIsRefreshing(true);

    try {
      // 2. Determine which API to call based on current source
      let url: string;
      if (statementSource === 'email' && selectedEmailStatement) {
        if (dataSource === 'opera3') {
          url = `${API_BASE}/opera3/bank-import/preview-from-email?email_id=${selectedEmailStatement.emailId}&attachment_id=${encodeURIComponent(selectedEmailStatement.attachmentId)}&data_path=${encodeURIComponent(opera3DataPath)}&bank_code=${selectedBankCode}`;
        } else {
          url = `${API_BASE}/bank-import/preview-from-email?email_id=${selectedEmailStatement.emailId}&attachment_id=${encodeURIComponent(selectedEmailStatement.attachmentId)}&bank_code=${selectedBankCode}`;
        }
      } else if (selectedPdfFile) {
        // Covers both 'pdf' and 'folder' sources — both use preview-from-pdf with file on disk
        if (dataSource === 'opera3') {
          url = `${API_BASE}/opera3/bank-import/preview-from-pdf?file_path=${encodeURIComponent(selectedPdfFile.fullPath)}&data_path=${encodeURIComponent(opera3DataPath)}&bank_code=${selectedBankCode}`;
        } else {
          url = `${API_BASE}/bank-import/preview-from-pdf?file_path=${encodeURIComponent(selectedPdfFile.fullPath)}&bank_code=${selectedBankCode}`;
        }
      } else if (csvFilePath) {
        const isPdfFile = csvFilePath.toLowerCase().endsWith('.pdf');
        if (dataSource === 'opera3') {
          url = isPdfFile
            ? `${API_BASE}/opera3/bank-import/preview-from-pdf?file_path=${encodeURIComponent(csvFilePath)}&data_path=${encodeURIComponent(opera3DataPath)}&bank_code=${selectedBankCode}`
            : `${API_BASE}/opera3/bank-import/preview?filepath=${encodeURIComponent(csvFilePath)}&data_path=${encodeURIComponent(opera3DataPath)}`;
        } else {
          url = isPdfFile
            ? `${API_BASE}/bank-import/preview-from-pdf?file_path=${encodeURIComponent(csvFilePath)}&bank_code=${selectedBankCode}`
            : `${API_BASE}/bank-import/preview-multiformat?filepath=${encodeURIComponent(csvFilePath)}&bank_code=${selectedBankCode}`;
        }
      } else {
        // No source available
        setIsRefreshing(false);
        return;
      }

      // 3. Call the preview endpoint
      const response = await authFetch(url, { method: 'POST' });
      const data = await response.json();

      // If the response indicates an error/mismatch/sequence issue, keep existing state
      if (data.bank_mismatch || data.status === 'skipped' || data.status === 'pending' || data.status === 'out_of_sequence') {
        console.warn('Refresh returned non-success status, keeping existing state');
        setIsRefreshing(false);
        return;
      }

      if (!data.success) {
        console.warn('Refresh returned success=false, keeping existing state');
        setIsRefreshing(false);
        return;
      }

      // 4. Build enhanced preview
      const filename = bankPreview.filename;
      const enhancedPreview: EnhancedBankImportPreview = {
        success: data.success,
        filename: data.filename || filename,
        detected_format: data.detected_format || bankPreview.detected_format,
        total_transactions: data.total_transactions || 0,
        matched_receipts: data.matched_receipts || [],
        matched_payments: data.matched_payments || [],
        matched_refunds: data.matched_refunds || [],
        repeat_entries: data.repeat_entries || [],
        unmatched: data.unmatched || [],
        already_posted: data.already_posted || [],
        skipped: data.skipped || [],
        summary: data.summary,
        errors: data.errors || [],
        period_info: data.period_info,
        period_violations: data.period_violations,
        has_period_violations: data.has_period_violations,
        statement_bank_info: data.statement_bank_info ? {
          bank_name: data.statement_bank_info.bank_name,
          account_number: data.statement_bank_info.account_number,
          sort_code: data.statement_bank_info.sort_code,
          statement_date: data.statement_bank_info.statement_date,
          opening_balance: data.statement_bank_info.opening_balance,
          closing_balance: data.statement_bank_info.closing_balance,
          matched_opera_bank: data.statement_bank_info.matched_opera_bank,
          matched_opera_name: data.statement_bank_info.matched_opera_name,
        } : undefined,
        statement_transactions: data.statement_transactions || [],
        statement_info: data.statement_info || null,
      };

      // 5. Apply suggestions baseline, then merge user assignments
      const preSelected = new Set<number>();
      enhancedPreview.matched_receipts.filter(t => !t.is_duplicate).forEach(t => preSelected.add(t.row));
      enhancedPreview.matched_payments.filter(t => !t.is_duplicate).forEach(t => preSelected.add(t.row));
      (enhancedPreview.matched_refunds || []).filter(t => !t.is_duplicate).forEach(t => preSelected.add(t.row));

      const { newEditedTransactions, newTransactionTypeOverrides, newIncludedSkipped, newNominalPostingDetails, newBankTransferDetails } =
        applySuggestionsAndAutoSelect(enhancedPreview, preSelected);

      if (alreadyPostedRows.size > 0) {
        alreadyPostedRows.forEach((_, row) => preSelected.delete(row));
      }

      // 6. Merge preserved user work over the baseline
      const merged = mergeUserAssignments(
        enhancedPreview,
        snapshot,
        newEditedTransactions,
        newTransactionTypeOverrides,
        newIncludedSkipped,
        newNominalPostingDetails,
        newBankTransferDetails,
        preSelected,
      );

      // 7. Apply all merged state
      setBankPreview(enhancedPreview);
      setEditedTransactions(merged.mergedEdited);
      setTransactionTypeOverrides(merged.mergedTxnTypes);
      setIncludedSkipped(merged.mergedIncSkipped);
      setNominalPostingDetails(merged.mergedNominal);
      setBankTransferDetails(merged.mergedBankTransfer);
      setRefundOverrides(merged.mergedRefundOverrides);
      setDateOverrides(merged.mergedDateOverrides);
      setAutoAllocateDisabled(merged.mergedAutoAllocDisabled);
      setCbtypeOverrides(merged.mergedCbtypeOverrides);
      setSelectedForImport(merged.mergedSelected);

      // 8. Reload ignored transactions
      await loadIgnoredTransactions(enhancedPreview);

    } catch (error) {
      // On error, keep all existing state intact — no reset
      console.error('Refresh preview failed, keeping existing state:', error);
    } finally {
      setIsRefreshing(false);
    }
  };

  // Check for recurring entries — fires immediately when bank is selected
  const checkRecurringEntries = useCallback(async (bankCode: string) => {
    if (!bankCode) return;
    try {
      const checkUrl = dataSource === 'opera3'
        ? `${API_BASE}/opera3/recurring-entries/check/${bankCode}?data_path=${encodeURIComponent(opera3DataPath)}`
        : `${API_BASE}/recurring-entries/check/${bankCode}`;
      const [checkRes, configRes] = await Promise.all([
        authFetch(checkUrl),
        authFetch(`${API_BASE}/recurring-entries/config`)
      ]);
      const checkData = await checkRes.json();
      const configData = await configRes.json();

      const mode = configData?.mode || 'process';
      setRecurringMode(mode);

      if (checkData.success && checkData.entries?.length > 0) {
        setRecurringEntries(checkData.entries);

        if (mode === 'process') {
          // Default: ticked ON unless any occurrence of the same record is blocked
          const dates: Record<string, string> = {};
          const blockedRefs = new Set(checkData.entries.filter((e: any) => !e.can_post).map((e: any) => (e.base_entry_ref || e.entry_ref.split(':')[0])));
          const autoSelected = new Set<string>();
          for (const e of checkData.entries) {
            if (e.next_post_date) {
              dates[e.entry_ref] = e.next_post_date;
            }
            if (e.can_post && !blockedRefs.has(e.base_entry_ref || e.entry_ref.split(':')[0])) {
              autoSelected.add(e.entry_ref);
            }
          }
          setRecurringSelected(autoSelected);
          setRecurringOverrideDates(dates);
          setRecurringPostResults([]);
          setShowRecurringModal(true);
          // Don't set recurringCheckDone yet — modal must be resolved first
        } else {
          // Warn mode — show warning banner and mark check as done
          setShowRecurringWarning(true);
          setRecurringCheckDone(true);
        }
      } else {
        // No entries — mark check as done
        setRecurringCheckDone(true);
      }
      setRecurringCheckBank(bankCode);
    } catch (err) {
      console.error('Failed to check recurring entries:', err);
      // On error, allow preview to proceed
      setRecurringCheckDone(true);
      setRecurringCheckBank(bankCode);
    }
  }, [dataSource, opera3DataPath]);

  // Handle posting recurring entries from the modal
  const handlePostRecurringEntries = async () => {
    if (recurringSelected.size === 0) return;
    setPostingRecurring(true);
    setRecurringPostResults([]);
    try {
      const postUrl = dataSource === 'opera3'
        ? `${API_BASE}/opera3/recurring-entries/post`
        : `${API_BASE}/recurring-entries/post`;
      const entries = Array.from(recurringSelected).map(ref => ({
        entry_ref: ref,
        override_date: recurringOverrideDates[ref] || null
      }));
      const body: any = { bank_code: selectedBankCode, entries };
      if (dataSource === 'opera3') {
        body.data_path = opera3DataPath;
      }
      const res = await authFetch(postUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();

      if (data.results) {
        setRecurringPostResults(data.results);
      }

      // Close modal after brief delay to show results, then allow preview to proceed
      setTimeout(() => {
        setShowRecurringModal(false);
        setRecurringEntries([]);
        setRecurringCheckDone(true);
      }, data.failed_count > 0 ? 3000 : 1500);
    } catch (err: any) {
      setRecurringPostResults([{ entry_ref: '', success: false, error: err.message || 'Network error' }]);
    } finally {
      setPostingRecurring(false);
    }
  };

  // Handle skipping recurring entries modal — allow preview to proceed
  const handleSkipRecurringEntries = () => {
    setShowRecurringModal(false);
    setRecurringEntries([]);
    setRecurringCheckDone(true);
  };

  // Fire recurring entries check immediately when bank code is set
  useEffect(() => {
    if (!selectedBankCode) return;
    // Only check once per bank code (reset when bank changes)
    if (recurringCheckBank === selectedBankCode) return;
    setRecurringCheckDone(false);
    setShowRecurringWarning(false);
    setRecurringEntries([]);
    checkRecurringEntries(selectedBankCode);
  }, [selectedBankCode, recurringCheckBank, checkRecurringEntries]);

  // Bank statement preview with enhanced format detection
  const handleBankPreview = async () => {
    setIsPreviewing(true);
    setBankPreview(null);
    setRawFilePreview(null);
    setShowRawPreview(false);
    setBankImportResult(null);
    setEditedTransactions(new Map());
    setIncludedSkipped(new Map());
    setTransactionTypeOverrides(new Map());
    setRefundOverrides(new Map());
    setTabSearchFilter('');
    try {
      let url: string;
      const isPdfFile = csvFilePath.toLowerCase().endsWith('.pdf');

      if (dataSource === 'opera-sql') {
        // Check if it's a PDF file - route to PDF endpoint for AI extraction
        if (isPdfFile) {
          url = `${API_BASE}/bank-import/preview-from-pdf?file_path=${encodeURIComponent(csvFilePath)}&bank_code=${selectedBankCode}`;
        } else {
          // Use enhanced multi-format preview for CSV/OFX/QIF/MT940
          url = `${API_BASE}/bank-import/preview-multiformat?filepath=${encodeURIComponent(csvFilePath)}&bank_code=${selectedBankCode}`;
        }
      } else {
        // Opera 3 data source
        if (isPdfFile) {
          url = `${API_BASE}/opera3/bank-import/preview-from-pdf?file_path=${encodeURIComponent(csvFilePath)}&data_path=${encodeURIComponent(opera3DataPath)}&bank_code=${selectedBankCode}`;
        } else {
          url = `${API_BASE}/opera3/bank-import/preview?filepath=${encodeURIComponent(csvFilePath)}&data_path=${encodeURIComponent(opera3DataPath)}`;
        }
      }
      const response = await authFetch(url, { method: 'POST' });
      const data = await response.json();

      // Check for bank mismatch error
      if (data.bank_mismatch) {
        setBankPreview({
          success: false,
          filename: csvFilePath,
          total_transactions: 0,
          matched_receipts: [],
          matched_payments: [],
          matched_refunds: [],
          repeat_entries: [],
          unmatched: [],
          already_posted: [],
          skipped: [],
          errors: [
            `Bank account mismatch: The CSV file is for bank ${data.detected_bank}, but you selected ${data.selected_bank}.`,
            'Please select the correct bank account and try again.'
          ]
        });
        return;
      }

      // Handle statement sequence validation responses
      if (data.status === 'skipped') {
        // This statement has already been processed (opening balance < reconciled balance)
        setBankPreview({
          success: false,
          filename: csvFilePath,
          total_transactions: 0,
          matched_receipts: [],
          matched_payments: [],
          matched_refunds: [],
          repeat_entries: [],
          unmatched: [],
          already_posted: [],
          skipped: [],
          errors: [
            `Statement already processed or superseded.`,
            `The statement opening balance (£${data.statement_info?.opening_balance?.toFixed(2) || '?'}) is less than Opera's reconciled balance (£${data.reconciled_balance?.toFixed(2) || '?'}).`,
            `This statement covers a period that has already been reconciled (possibly manually).`
          ]
        });
        return;
      }

      if (data.status === 'pending') {
        // Future statement - missing one in between
        setBankPreview({
          success: false,
          filename: csvFilePath,
          total_transactions: 0,
          matched_receipts: [],
          matched_payments: [],
          matched_refunds: [],
          repeat_entries: [],
          unmatched: [],
          already_posted: [],
          skipped: [],
          errors: [
            `Statement out of sequence - missing earlier statement.`,
            `Statement opening balance: £${data.statement_info?.opening_balance?.toFixed(2) || '?'}`,
            `Opera reconciled balance: £${data.reconciled_balance?.toFixed(2) || '?'}`,
            `Please import the missing statement(s) first, or manually reconcile to £${data.statement_info?.opening_balance?.toFixed(2) || '?'} in Opera.`
          ]
        });
        return;
      }

      // Handle enhanced response format
      // Determine default format based on file extension if backend doesn't specify
      const defaultFormat = isPdfFile ? 'PDF' : 'CSV';
      const enhancedPreview: EnhancedBankImportPreview = {
        success: data.success,
        filename: data.filename,
        detected_format: data.detected_format || defaultFormat,
        total_transactions: data.total_transactions,
        matched_receipts: data.matched_receipts || [],
        matched_payments: data.matched_payments || [],
        matched_refunds: data.matched_refunds || [],
        repeat_entries: data.repeat_entries || [],
        unmatched: data.unmatched || [],
        already_posted: data.already_posted || [],
        skipped: data.skipped || [],
        summary: data.summary,
        errors: data.errors || (data.error ? [data.error] : []),
        // Include statement bank info from AI extraction (for PDF statements)
        statement_bank_info: data.statement_bank_info ? {
          bank_name: data.statement_bank_info.bank_name,
          account_number: data.statement_bank_info.account_number,
          sort_code: data.statement_bank_info.sort_code,
          statement_date: data.statement_bank_info.statement_date,
          opening_balance: data.statement_bank_info.opening_balance,
          closing_balance: data.statement_bank_info.closing_balance,
          matched_opera_bank: data.statement_bank_info.matched_opera_bank,
          matched_opera_name: data.statement_bank_info.matched_opera_name
        } : undefined,
        // Raw statement transactions and info for reconcile screen
        statement_transactions: data.statement_transactions || [],
        statement_info: data.statement_info || null
      };

      setBankPreview(enhancedPreview);

      // Auto-scroll to the preview/match stage
      setTimeout(() => {
        stage2Ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 150);

      // Initialize selectedForImport - auto-select all items with complete data (not duplicates)
      const preSelected = new Set<number>();
      // Receipts - always have account, select if not duplicate
      enhancedPreview.matched_receipts.filter(t => !t.is_duplicate).forEach(t => preSelected.add(t.row));
      // Payments - always have account, select if not duplicate
      enhancedPreview.matched_payments.filter(t => !t.is_duplicate).forEach(t => preSelected.add(t.row));
      // Refunds - have account from matching, select if not duplicate
      (enhancedPreview.matched_refunds || []).filter(t => !t.is_duplicate).forEach(t => preSelected.add(t.row));
      // Repeat entries - NOT pre-selected (handled separately by Opera)

      // Apply pattern learning suggestions to unmatched/skipped items
      const { newEditedTransactions, newTransactionTypeOverrides, newIncludedSkipped, newNominalPostingDetails, newBankTransferDetails } =
        applySuggestionsAndAutoSelect(enhancedPreview, preSelected);

      // Remove already-posted rows (from resume/continue import)
      if (alreadyPostedRows.size > 0) {
        alreadyPostedRows.forEach((_, row) => preSelected.delete(row));
      }
      setSelectedForImport(preSelected);

      // Apply the pre-filled data
      setEditedTransactions(newEditedTransactions);
      setTransactionTypeOverrides(newTransactionTypeOverrides);
      setNominalPostingDetails(newNominalPostingDetails);
      setBankTransferDetails(newBankTransferDetails);
      setIncludedSkipped(newIncludedSkipped);

      // Load previously ignored transactions from database
      await loadIgnoredTransactions(enhancedPreview);

      // Clear remaining state
      setDateOverrides(new Map());
      setRefundOverrides(new Map());
      setUpdatedRepeatEntries(new Set());
      setRepeatEntriesProcessed(false);

      // Auto-select best tab (filter out duplicates from matched tabs)
      if (enhancedPreview.matched_receipts.filter((t: any) => !t.is_duplicate).length > 0) setActivePreviewTab('receipts');
      else if (enhancedPreview.matched_payments.filter((t: any) => !t.is_duplicate).length > 0) setActivePreviewTab('payments');
      else if (enhancedPreview.matched_refunds?.filter((t: any) => !t.is_duplicate).length > 0) setActivePreviewTab('refunds');
      else if (enhancedPreview.repeat_entries?.length > 0) setActivePreviewTab('repeat');
      else if (enhancedPreview.unmatched.length > 0) setActivePreviewTab('unmatched');
      else setActivePreviewTab('skipped');
    } catch (error) {
      setBankPreview({
        success: false,
        filename: csvFilePath,
        total_transactions: 0,
        matched_receipts: [],
        matched_payments: [],
        matched_refunds: [],
        repeat_entries: [],
        unmatched: [],
        already_posted: [],
        skipped: [],
        errors: [error instanceof Error ? error.message : 'Unknown error']
      });
    } finally {
      setIsPreviewing(false);
    }
  };

  // Open PDF in a new browser tab from base64 data (preserves current page state)
  const openPdfInNewTab = (base64Data: string, _filename: string) => {
    try {
      const byteChars = atob(base64Data);
      const byteNumbers = new Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) {
        byteNumbers[i] = byteChars.charCodeAt(i);
      }
      const blob = new Blob([new Uint8Array(byteNumbers)], { type: 'application/pdf' });
      const blobUrl = URL.createObjectURL(blob);
      window.open(blobUrl, '_blank');
      // Clean up blob URL after a delay (browser needs time to load it)
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    } catch {
      // Fallback: open as data URL (less reliable but works in most browsers)
      window.open(`data:application/pdf;base64,${base64Data}`, '_blank');
    }
  };

  // Preview raw file contents (first 50 lines) - works for all source types
  // PDFs open in a new tab so the analysis page is not disrupted
  const handleRawFilePreview = async () => {
    try {
      let response;

      if (statementSource === 'email' && selectedEmailStatement) {
        // Email source - use email attachment preview endpoint
        response = await authFetch(`${API_BASE}/bank-import/raw-preview-email?email_id=${selectedEmailStatement.emailId}&attachment_id=${encodeURIComponent(selectedEmailStatement.attachmentId)}&lines=50`);
        const data = await response.json();
        if (data.success) {
          if (data.is_pdf && data.pdf_data) {
            // PDF - open in new tab to preserve analysis state
            openPdfInNewTab(data.pdf_data, data.filename || 'document.pdf');
          } else {
            setRawFilePreview(data.lines);
            setShowRawPreview(true);
          }
        } else {
          setRawFilePreview([`Error: ${data.error || 'Failed to read attachment'}`]);
          setShowRawPreview(true);
        }
      } else if (selectedPdfFile) {
        // PDF/folder source - open in new tab to preserve analysis state
        response = await authFetch(`${API_BASE}/bank-import/pdf-content?filename=${encodeURIComponent(selectedPdfFile.filename)}`);
        const data = await response.json();
        if (data.success && data.pdf_data) {
          openPdfInNewTab(data.pdf_data, selectedPdfFile.filename);
        } else {
          setRawFilePreview([`Error: ${data.error || 'Failed to read PDF'}`]);
          setShowRawPreview(true);
        }
      } else if (csvFilePath) {
        // File source - use raw preview endpoint
        response = await authFetch(`${API_BASE}/bank-import/raw-preview?filepath=${encodeURIComponent(csvFilePath)}&lines=50`);
        const data = await response.json();
        if (data.success) {
          setRawFilePreview(data.lines);
          setShowRawPreview(true);
        } else {
          setRawFilePreview([`Error: ${data.error || 'Failed to read file'}`]);
          setShowRawPreview(true);
        }
      }
    } catch (error) {
      setRawFilePreview([`Error: ${error instanceof Error ? error.message : 'Failed to read file'}`]);
      setShowRawPreview(true);
    }
  };

  // Handle account change for a transaction
  const handleAccountChange = useCallback((txn: BankImportTransaction, accountCode: string, ledgerType: 'C' | 'S' | 'N') => {
    const updated = new Map(editedTransactions);
    let accountName = '';

    if (ledgerType === 'C') {
      accountName = customers.find(c => c.code === accountCode)?.name || '';
    } else if (ledgerType === 'S') {
      accountName = suppliers.find(s => s.code === accountCode)?.name || '';
    } else if (ledgerType === 'N') {
      accountName = nominalAccounts.find(n => n.code === accountCode)?.description || '';
    }

    updated.set(txn.row, {
      ...txn,
      manual_account: accountCode,
      manual_ledger_type: ledgerType as 'C' | 'S',  // Cast for type compatibility - N is handled specially
      account_name: accountName,
      isEdited: true
    });
    setEditedTransactions(updated);

    // Auto-select for import when account is assigned
    setSelectedForImport(prev => new Set(prev).add(txn.row));

    // Check for similar unmatched transactions (by similarity_key)
    if (txn.similarity_key && (txn.similar_count || 0) > 1 && bankPreview?.unmatched) {
      const similarItems = bankPreview.unmatched.filter((u: BankImportTransaction) =>
        u.similarity_key === txn.similarity_key &&
        u.row !== txn.row &&
        !editedTransactions.has(u.row) &&  // Not already assigned
        !updated.has(u.row)
      );
      if (similarItems.length > 0) {
        const currentTxnType = transactionTypeOverrides.get(txn.row);
        setApplyAllSimilar({
          show: true,
          similarityKey: txn.similarity_key,
          sourceRow: txn.row,
          count: similarItems.length,
          accountCode,
          ledgerType,
          accountName,
          transactionType: currentTxnType,
        });
      }
    }
  }, [editedTransactions, customers, suppliers, nominalAccounts, bankPreview, transactionTypeOverrides]);

  // Suggest account based on transaction name and type
  // Apply assignment to all similar unmatched transactions
  const handleApplyToAllSimilar = useCallback(() => {
    if (!applyAllSimilar || !bankPreview?.unmatched) return;

    const { similarityKey, sourceRow, accountCode, ledgerType, accountName, transactionType, nominalDetail } = applyAllSimilar;
    const updated = new Map(editedTransactions);
    const updatedNominals = new Map(nominalPostingDetails);
    const updatedTypes = new Map(transactionTypeOverrides);
    const updatedSelected = new Set(selectedForImport);

    const similarItems = bankPreview.unmatched.filter((u: BankImportTransaction) =>
      u.similarity_key === similarityKey &&
      u.row !== sourceRow &&
      !updated.has(u.row)
    );

    for (const item of similarItems) {
      updated.set(item.row, {
        ...item,
        manual_account: accountCode,
        manual_ledger_type: ledgerType as 'C' | 'S',
        account_name: accountName,
        isEdited: true,
        nominal_detail: nominalDetail,
      });
      updatedSelected.add(item.row);

      if (transactionType) {
        updatedTypes.set(item.row, transactionType);
      }

      // Copy nominal posting details if this is a nominal assignment
      if (nominalDetail) {
        // Scale net/vat amounts proportionally to each item's gross amount
        const grossAmount = Math.abs(item.amount);
        const hasVat = nominalDetail.vatCode && nominalDetail.vatCode !== 'N/A' && nominalDetail.vatAmount > 0;
        let itemNet = grossAmount;
        let itemVat = 0;
        if (hasVat && nominalDetail.netAmount > 0) {
          const vatRate = nominalDetail.vatAmount / nominalDetail.netAmount;
          itemNet = parseFloat((grossAmount / (1 + vatRate)).toFixed(2));
          itemVat = parseFloat((grossAmount - itemNet).toFixed(2));
        }
        updatedNominals.set(item.row, {
          ...nominalDetail,
          netAmount: itemNet,
          vatAmount: itemVat,
        });
      }
    }

    setEditedTransactions(updated);
    setNominalPostingDetails(updatedNominals);
    setTransactionTypeOverrides(updatedTypes);
    setSelectedForImport(updatedSelected);
    setApplyAllSimilar(null);
  }, [applyAllSimilar, bankPreview, editedTransactions, nominalPostingDetails, transactionTypeOverrides, selectedForImport]);

  const suggestAccountForTransaction = useCallback(async (txn: BankImportTransaction, transactionType: TransactionType) => {
    // Only suggest for customer/supplier types, not nominal or bank transfer
    const isCustomerType = transactionType === 'sales_receipt' || transactionType === 'sales_refund';
    const isSupplierType = transactionType === 'purchase_payment' || transactionType === 'purchase_refund';

    if (!isCustomerType && !isSupplierType) return;

    const searchName = txn.name || txn.reference || '';
    if (!searchName.trim()) return;

    try {
      const response = await authFetch(
        `${API_BASE}/bank-import/suggest-account?name=${encodeURIComponent(searchName)}&transaction_type=${transactionType}&limit=1`
      );
      const data = await response.json();

      if (data.success && data.suggestions && data.suggestions.length > 0) {
        const suggestion = data.suggestions[0];
        // Only auto-apply if confidence is high enough (>= 70%)
        if (suggestion.score >= 70) {
          handleAccountChange(txn, suggestion.code, data.ledger_type as 'C' | 'S');
        }
      }
    } catch (error) {
      console.error('Error suggesting account:', error);
    }
  }, [authFetch, handleAccountChange]);

  // Note: handleRowSelect and handleBulkAssign removed - will be re-added when bulk operations feature is implemented

  // Check if a nominal posting is complete (code + mandatory project/department filled)
  const isNominalPostingComplete = useCallback((row: number): boolean => {
    const nomDetail = nominalPostingDetails.get(row);
    if (!nomDetail?.nominalCode) return false;
    const nom = nominalAccounts.find(n => n.code === nomDetail.nominalCode);
    if (!nom) return true; // Can't validate without account info
    // Opera values: 1=Do Not Use, 2=Optional, 3=Mandatory
    if (advNomConfig.project_enabled && (nom.allow_project || 0) === 3 && !nomDetail.projectCode) return false;
    if (advNomConfig.department_enabled && (nom.allow_department || 0) === 3 && !nomDetail.departmentCode) return false;
    return true;
  }, [nominalPostingDetails, nominalAccounts, advNomConfig]);

  // Calculate import readiness - which transactions are selected AND have all mandatory data
  const importReadiness = (() => {
    if (!bankPreview) return null;

    // Matched receipts - selected and have account (account may be overridden or from original match)
    const receiptsSelected = (bankPreview.matched_receipts || []).filter(t => selectedForImport.has(t.row) && !t.is_duplicate);
    const receiptsReady = receiptsSelected.filter(t => {
      const editedTxn = editedTransactions.get(t.row);
      const txnType = transactionTypeOverrides.get(t.row);
      const isNlOrTransfer = txnType === 'bank_transfer' || txnType === 'nominal_receipt' || txnType === 'nominal_payment';
      if (isNlOrTransfer) {
        if (txnType === 'nominal_receipt' || txnType === 'nominal_payment') return isNominalPostingComplete(t.row);
        if (txnType === 'bank_transfer') return !!bankTransferDetails.get(t.row)?.destBankCode;
      }
      const currentAccount = editedTxn ? editedTxn.manual_account : t.account;
      return !!currentAccount;
    }).length;
    const receiptsTotal = (bankPreview.matched_receipts || []).length;

    // Matched payments - selected and have account (account may be overridden or from original match)
    const paymentsSelected = (bankPreview.matched_payments || []).filter(t => selectedForImport.has(t.row) && !t.is_duplicate);
    const paymentsReady = paymentsSelected.filter(t => {
      const editedTxn = editedTransactions.get(t.row);
      const txnType = transactionTypeOverrides.get(t.row);
      const isNlOrTransfer = txnType === 'bank_transfer' || txnType === 'nominal_receipt' || txnType === 'nominal_payment';
      if (isNlOrTransfer) {
        if (txnType === 'nominal_receipt' || txnType === 'nominal_payment') return isNominalPostingComplete(t.row);
        if (txnType === 'bank_transfer') return !!bankTransferDetails.get(t.row)?.destBankCode;
      }
      const currentAccount = editedTxn ? editedTxn.manual_account : t.account;
      return !!currentAccount;
    }).length;
    const paymentsTotal = (bankPreview.matched_payments || []).length;

    // Refunds - selected and have account
    const refunds = bankPreview.matched_refunds || [];
    const refundsSelected = refunds.filter(t => {
      if (!selectedForImport.has(t.row) || t.is_duplicate) return false;
      const override = refundOverrides.get(t.row);
      // Has account (either matched or overridden)
      const hasAccount = t.account || override?.account;
      return hasAccount;
    });
    const refundsReady = refundsSelected.length;
    const refundsTotal = refunds.length;

    // Unmatched - selected and have account assigned (all types now require account selection)
    // Filter out ignored transactions from unmatched
    const unmatchedNotIgnored = (bankPreview.unmatched || []).filter(t => !ignoredTransactions.has(t.row));
    const unmatchedSelected = unmatchedNotIgnored.filter(t => selectedForImport.has(t.row));
    const unmatchedWithAccount = unmatchedSelected.filter(t => {
      const editedTxn = editedTransactions.get(t.row);
      const currentTxnType = transactionTypeOverrides.get(t.row) || getSmartDefaultTransactionType(t);
      const isNominal = currentTxnType === 'nominal_receipt' || currentTxnType === 'nominal_payment';
      const isBankTransfer = currentTxnType === 'bank_transfer';
      // Nominal requires a nominal code + mandatory project/department in nominalPostingDetails
      if (isNominal) {
        return isNominalPostingComplete(t.row);
      }
      // Bank transfer requires a destination bank in bankTransferDetails
      if (isBankTransfer) {
        const btDetail = bankTransferDetails.get(t.row);
        return !!btDetail?.destBankCode;
      }
      // Customer/supplier requires manual_account
      return !!editedTxn?.manual_account;
    });
    const unmatchedReady = unmatchedWithAccount.length;
    const unmatchedIncomplete = unmatchedSelected.length - unmatchedReady; // Selected but missing required account
    const unmatchedTotal = unmatchedNotIgnored.length;

    // Skipped included - selected (via includedSkipped) and have account assigned
    const skippedIncluded = includedSkipped.size;
    const skippedWithAccount = Array.from(includedSkipped.entries()).filter(([, v]) => {
      return v.account;
    });
    const skippedReady = skippedWithAccount.length;
    const skippedIncomplete = skippedIncluded - skippedReady;

    const totalReady = receiptsReady + paymentsReady + refundsReady + unmatchedReady + skippedReady;
    const totalIncomplete = unmatchedIncomplete + skippedIncomplete; // Items selected but missing account

    // Count period violations for selected transactions (that haven't been fixed with date overrides)
    const allSelectedTransactions = [
      ...receiptsSelected,
      ...paymentsSelected,
      ...refundsSelected,
      ...unmatchedWithAccount,
      ...Array.from(includedSkipped.keys()).map(row => {
        const skipped = (bankPreview.skipped || []).find(t => t.row === row);
        return skipped;
      }).filter(Boolean) as BankImportTransaction[]
    ];

    const periodViolationsCount = allSelectedTransactions.filter(t => {
      // Check if this transaction has a period violation and hasn't been fixed
      if (!t.period_valid && t.period_error) {
        // Check if user has provided a date override
        return !dateOverrides.has(t.row);
      }
      return false;
    }).length;

    // Count unhandled repeat entries - these must be processed in Opera before importing
    const repeatEntries = bankPreview.repeat_entries || [];
    const unhandledRepeatEntries = repeatEntries.filter(t =>
      !updatedRepeatEntries.has(t.repeat_entry_ref || '') && !repeatEntriesProcessed
    ).length;
    const hasUnhandledRepeatEntries = unhandledRepeatEntries > 0;

    // Debug logging
    return {
      receiptsReady, receiptsTotal,
      paymentsReady, paymentsTotal,
      refundsReady, refundsTotal,
      unmatchedReady, unmatchedTotal, unmatchedIncomplete,
      skippedReady, skippedIncluded, skippedIncomplete,
      totalReady,
      totalIncomplete,
      periodViolationsCount,
      hasPeriodViolations: periodViolationsCount > 0,
      repeatEntriesTotal: repeatEntries.length,
      unhandledRepeatEntries,
      hasUnhandledRepeatEntries,
      canImport: totalReady > 0 && totalIncomplete === 0 && periodViolationsCount === 0 && !hasUnhandledRepeatEntries
    };
  })();

  // Computed import state variables (used in both top button bar and bottom import section)
  const isEmailSource = statementSource === 'email';
  const isPdfSource = statementSource === 'pdf';
  const isFolderSource = statementSource === 'folder';
  const bankReady = (isEmailSource || isPdfSource || isFolderSource) ? !!selectedBankCode : (detectedBank?.detected || selectedBankCode);
  const noBankSelected = !bankReady;
  const noPreview = !bankPreview;
  const hasIncomplete = !!(importReadiness?.totalIncomplete && importReadiness.totalIncomplete > 0);
  const hasNothingToImport = !!(importReadiness && importReadiness.totalReady === 0);
  const hasPeriodViolations = !!(importReadiness?.hasPeriodViolations);
  const hasUnhandledRepeatEntries = !!(importReadiness?.hasUnhandledRepeatEntries);

  // Check if ALL statement transactions have been imported (not just "an import succeeded")
  // True when: import succeeded AND nothing left to select (no unposted rows remain)
  const allTransactionsImported = (() => {
    if (!bankImportResult?.success) return false;
    const importedRows = new Set((bankImportResult?.imported_transactions || []).map((t: any) => t.row));
    if (importedRows.size === 0) return false;
    // Check if any non-ignored, non-duplicate rows remain unimported
    const allReceipts = bankPreview?.matched_receipts || [];
    const allPayments = bankPreview?.matched_payments || [];
    const allRefunds = bankPreview?.matched_refunds || [];
    const allUnmatched = bankPreview?.unmatched || [];
    const remainingUnimported = [...allReceipts, ...allPayments, ...allRefunds, ...allUnmatched]
      .filter(t => !ignoredTransactions.has(t.row) && !t.is_duplicate && !importedRows.has(t.row))
      .length;
    return remainingUnimported === 0;
  })();

  // Check if all statement items are already in Opera (nothing to import, but can reconcile)
  const allAlreadyInOpera = (() => {
    if (!bankPreview || allTransactionsImported) return false;
    if (bankImportResult?.success) return false;
    const receipts = bankPreview.matched_receipts || [];
    const payments = bankPreview.matched_payments || [];
    const refunds = bankPreview.matched_refunds || [];
    const unmatched = bankPreview.unmatched || [];
    const allItems = [...receipts, ...payments, ...refunds, ...unmatched];
    // Check if any unmatched items have an assigned action (bank transfer, nominal, etc.)
    // These NEED importing even in bankRecOnly mode
    const unmatchedWithAction = unmatched.filter(t =>
      !ignoredTransactions.has(t.row) && !deferredRows.has(t.row) && !t.is_duplicate && t.action
    );
    // If there are assigned unmatched items, they need importing — not "all in Opera"
    if (unmatchedWithAction.length > 0) return false;

    const needsImport = allItems.filter(t => !ignoredTransactions.has(t.row) && !deferredRows.has(t.row) && !t.is_duplicate);
    const needsImportExcludingUnmatched = bankRecOnly
      ? [...receipts, ...payments, ...refunds].filter(t => !ignoredTransactions.has(t.row) && !deferredRows.has(t.row) && !t.is_duplicate)
      : needsImport;
    const duplicateCount = allItems.filter(t => !ignoredTransactions.has(t.row) && !deferredRows.has(t.row) && t.is_duplicate).length;
    if (bankRecOnly && (bankPreview.already_posted?.length || 0) > 0 && unmatchedWithAction.length === 0) {
      // BUT only when there are no matched receipts/payments/refunds
      // still waiting to import. The original early-return ignored
      // these and skipped straight to Reconcile when ANY already-
      // posted entry existed — operator couldn't import the other
      // rows because the button label flipped to "Proceed to
      // Reconcile". A real bank-statement run often has 1-2
      // already-posted entries (e.g. GoCardless transfers already in
      // Opera) AND many fresh transactions that still need posting.
      const matchedNeedingImport = [...receipts, ...payments, ...refunds].filter(t =>
        !ignoredTransactions.has(t.row) && !deferredRows.has(t.row) && !t.is_duplicate
      );
      if (matchedNeedingImport.length === 0) return true;
    }
    return needsImportExcludingUnmatched.length === 0 && (duplicateCount > 0 || (bankPreview.already_posted?.length || 0) > 0);
  })();

  // All items are accounted for (imported, in Opera, or ignored) — user can proceed to reconcile
  const allItemsHandled = (() => {
    if (!bankPreview) return false;
    const receipts = bankPreview.matched_receipts || [];
    const payments = bankPreview.matched_payments || [];
    const refunds = bankPreview.matched_refunds || [];
    const unmatched = bankPreview.unmatched || [];
    const allItems = [...receipts, ...payments, ...refunds, ...unmatched];
    if (allItems.length === 0 && (bankPreview.already_posted?.length || 0) > 0) return true;
    if (allItems.length === 0) return false;
    // Check if any unmatched items have an assigned action — they still need importing
    const unmatchedWithAction2 = unmatched.filter(t =>
      !ignoredTransactions.has(t.row) && !deferredRows.has(t.row) && !t.is_duplicate && t.action
    );
    if (unmatchedWithAction2.length > 0) return false;

    const itemsToCheck = bankRecOnly
      ? [...receipts, ...payments, ...refunds]
      : allItems;
    const unhandled = itemsToCheck.filter(t => !ignoredTransactions.has(t.row) && !deferredRows.has(t.row) && !t.is_duplicate);
    return unhandled.length === 0;
  })();

  // Import button disabled — but NOT when all items are already in Opera or handled (allow reconcile)
  const importDisabled = isImporting || dataSource === 'opera3' || noBankSelected || noPreview || hasIncomplete || (hasNothingToImport && !allAlreadyInOpera && !allItemsHandled) || hasPeriodViolations || hasUnhandledRepeatEntries;

  // Count of duplicate transactions for display
  const duplicateTransactionCount = (() => {
    if (!bankPreview) return 0;
    const receipts = bankPreview.matched_receipts || [];
    const payments = bankPreview.matched_payments || [];
    const refunds = bankPreview.matched_refunds || [];
    const unmatched = bankPreview.unmatched || [];
    return [...receipts, ...payments, ...refunds, ...unmatched]
      .filter(t => !ignoredTransactions.has(t.row) && t.is_duplicate).length;
  })();

  // Count of rows that are settled in Opera (already_posted + flagged duplicates) — used for messaging.
  const alreadyInOperaCount = (() => {
    if (!bankPreview) return 0;
    const alreadyPosted = (bankPreview.already_posted || []).length;
    return alreadyPosted + duplicateTransactionCount;
  })();

  // Build tooltip message for import button
  const importTitle = (() => {
    if (noBankSelected) return 'Select a bank account first';
    if (noPreview) return selectedPdfFile || isEmailSource ? 'Select a statement to preview' : 'Run Analyse Transactions first to review';
    if (dataSource === 'opera3') return 'Import not available for Opera 3 (read-only)';
    if (hasUnhandledRepeatEntries) return 'Cannot import - update repeat entry dates, run Opera Recurring Entries, then re-preview';
    if (hasPeriodViolations) return 'Cannot import - some transactions have dates outside the allowed posting period. Correct the dates below.';
    if (hasIncomplete) return 'Cannot import - some included items are missing required account assignment';
    if (hasNothingToImport) return 'No transactions ready to import';
    return '';
  })();

  // Bank statement import with manual overrides
  const handleBankImport = async () => {
    setIsImporting(true);
    setBankImportResult(null);

    try {
      if (dataSource === 'opera3') {
        setBankImportResult({
          success: false,
          error: 'Import not available for Opera 3. Opera 3 data is read-only.'
        });
        setIsImporting(false);
        return;
      }

      // Prepare overrides - include transactions with account OR those that don't need account (nominal/bank transfer)
      const unmatchedOverrides = Array.from(selectedForImport).map(row => {
        const editedTxn = editedTransactions.get(row);
        const txnType = transactionTypeOverrides.get(row);
        const isNlOrTransfer = txnType === 'bank_transfer' || txnType === 'nominal_receipt' || txnType === 'nominal_payment';
        if (editedTxn?.manual_account || isNlOrTransfer) {
          const override: any = {
            row,
            account: editedTxn?.manual_account || '',
            ledger_type: editedTxn?.manual_ledger_type || 'C',
            // Sign-aware default: a -£X bank line going to a customer is
            // a sales_refund (we paid them back), not a sales_receipt; a
            // +£X line going to a supplier is a purchase_refund (they
            // refunded us), not a purchase_payment. The previous default
            // hard-coded sales_receipt/purchase_payment regardless of
            // direction, so the post-time duplicate check fired against
            // the wrong stran/ptran type filter and blocked legitimate
            // refund imports.
            transaction_type: txnType || (() => {
              const ledger = editedTxn?.manual_ledger_type;
              const allRows: any[] = [
                ...(bankPreview?.unmatched || []),
                ...(bankPreview?.matched_receipts || []),
                ...(bankPreview?.matched_payments || []),
                ...(bankPreview?.matched_refunds || []),
                ...(bankPreview?.skipped || []),
                ...(bankPreview?.already_posted || []),
              ];
              const txn = allRows.find(t => t?.row === row);
              const amt = Number(editedTxn?.manual_amount ?? txn?.amount ?? 0);
              if (ledger === 'C') return amt >= 0 ? 'sales_receipt' : 'sales_refund';
              if (ledger === 'S') return amt <= 0 ? 'purchase_payment' : 'purchase_refund';
              return 'sales_receipt';
            })()
          };
          // Include bank transfer details when type is bank_transfer
          if (txnType === 'bank_transfer') {
            const btDetails = bankTransferDetails.get(row);
            if (btDetails) {
              override.bank_transfer_details = {
                dest_bank: btDetails.destBankCode,
                cashbook_type: btDetails.cashbookType || 'TRF',
                reference: btDetails.reference || '',
                comment: btDetails.comment || '',
                date: btDetails.date || ''
              };
            }
          }
          // Include nominal posting details for pattern learning
          const nomDetail = nominalPostingDetails.get(row);
          if (nomDetail?.nominalCode) override.nominal_code = nomDetail.nominalCode;
          if (nomDetail?.vatCode) override.vat_code = nomDetail.vatCode;
          if (nomDetail?.projectCode) override.project_code = nomDetail.projectCode;
          if (nomDetail?.departmentCode) override.department_code = nomDetail.departmentCode;
          return override;
        }
        return null;
      }).filter(Boolean);

      // Prepare overrides from included skipped items (only those with accounts assigned)
      const skippedOverrides = Array.from(includedSkipped.entries())
        .filter(([, data]) => {
          const isNlOrTransfer = data.transaction_type === 'bank_transfer' || data.transaction_type === 'nominal_receipt' || data.transaction_type === 'nominal_payment';
          return data.account || isNlOrTransfer;
        })
        .map(([row, data]) => {
          const override: any = {
            row,
            account: data.account || '',
            ledger_type: data.ledger_type,
            transaction_type: data.transaction_type
          };
          if (data.transaction_type === 'bank_transfer') {
            const btDetails = bankTransferDetails.get(row);
            if (btDetails) {
              override.bank_transfer_details = {
                dest_bank: btDetails.destBankCode,
                cashbook_type: btDetails.cashbookType || 'TRF',
                reference: btDetails.reference || '',
                comment: btDetails.comment || '',
                date: btDetails.date || ''
              };
            }
          }
          // Include nominal posting details for pattern learning
          const nomDetail = nominalPostingDetails.get(row);
          if (nomDetail?.nominalCode) override.nominal_code = nomDetail.nominalCode;
          if (nomDetail?.vatCode) override.vat_code = nomDetail.vatCode;
          if (nomDetail?.projectCode) override.project_code = nomDetail.projectCode;
          if (nomDetail?.departmentCode) override.department_code = nomDetail.departmentCode;
          return override;
        });

      // Prepare overrides from modified refunds (changed type/account)
      const refundOverridesList = Array.from(refundOverrides.entries())
        .filter(([row, data]) => selectedForImport.has(row) && (data.transaction_type || data.account))
        .map(([row, data]) => {
          const override: any = {
            row,
            account: data.account,
            ledger_type: data.ledger_type,
            transaction_type: data.transaction_type
          };
          // Include nominal posting details for pattern learning
          const nomDetail = nominalPostingDetails.get(row);
          if (nomDetail?.nominalCode) override.nominal_code = nomDetail.nominalCode;
          if (nomDetail?.vatCode) override.vat_code = nomDetail.vatCode;
          if (nomDetail?.projectCode) override.project_code = nomDetail.projectCode;
          if (nomDetail?.departmentCode) override.department_code = nomDetail.departmentCode;
          return override;
        });

      // Include cashbook type (cbtype) overrides for any rows with user-selected Opera types
      const cbtypeOverridesList = Array.from(cbtypeOverrides.entries())
        .filter(([row]) => selectedForImport.has(row))
        .map(([row, cbtype]) => ({ row, cbtype }));

      // MATCHED ROWS — see comment at the other import call site. Without
      // passing the auto-matched action+account as an override, the backend
      // executor defaults the action to 'skip' and silently drops the row.
      // The override must ALSO carry any operator-supplied VAT / nominal /
      // project / department / net_amount / bank_transfer_details so the
      // BE's VAT-split + bank-transfer branches receive the data they need.
      // Audit 2026-05-14 HIGH defect: previously only row/account/ledger_type/
      // transaction_type/cbtype were echoed, silently dropping VAT etc.
      const matchedRowsForOverride = [
        ...(bankPreview?.matched_receipts || []),
        ...(bankPreview?.matched_payments || []),
        ...(bankPreview?.matched_refunds || []),
      ];
      const matchedOverrides = matchedRowsForOverride
        .filter((t: any) =>
          t && selectedForImport.has(t.row) && t.action && t.action !== 'skip' && t.action !== 'defer',
        )
        .map((t: any) => {
          const row = t.row as number;
          const override: any = {
            row,
            account: (t.account ?? '') as string,
            ledger_type:
              (t.matched_ledger_type as string | undefined) ??
              (t.action === 'sales_receipt' || t.action === 'sales_refund'
                ? 'C'
                : t.action === 'purchase_payment' || t.action === 'purchase_refund'
                  ? 'S'
                  : t.action?.startsWith('nominal_') || t.action === 'bank_transfer'
                    ? 'N'
                    : 'C'),
            transaction_type: t.action as string,
            cbtype: (t.cbtype as string | undefined) ?? undefined,
          };
          // Per-row nominal posting details (operator-edited via the
          // Nominal Detail modal on a matched row).
          const nomDetail = nominalPostingDetails.get(row);
          if (nomDetail?.nominalCode) override.nominal_code = nomDetail.nominalCode;
          if (nomDetail?.vatCode) override.vat_code = nomDetail.vatCode;
          if (nomDetail?.projectCode) override.project_code = nomDetail.projectCode;
          if (nomDetail?.departmentCode) override.department_code = nomDetail.departmentCode;
          // Bank-transfer destination (operator opens a matched row in
          // the BT modal and converts it to a transfer).
          if (t.action === 'bank_transfer') {
            const btDetails = bankTransferDetails.get(row);
            if (btDetails) {
              override.bank_transfer_details = {
                dest_bank: btDetails.destBankCode,
                cashbook_type: btDetails.cashbookType || 'TRF',
                reference: btDetails.reference || '',
                comment: btDetails.comment || '',
                date: btDetails.date || '',
              };
            }
          }
          return override;
        });

      const allOverrides = [
        ...unmatchedOverrides,
        ...skippedOverrides,
        ...refundOverridesList,
        ...matchedOverrides,
      ];

      // Merge cbtype overrides into allOverrides (add cbtype to existing overrides or create new ones)
      for (const cbo of cbtypeOverridesList) {
        const existing = allOverrides.find(o => o && (o as any).row === cbo.row);
        if (existing) {
          (existing as any).cbtype = cbo.cbtype;
        } else {
          allOverrides.push({ row: cbo.row, cbtype: cbo.cbtype } as any);
        }
      }

      // Append override entries for deferred rows so backend records audit + skips posting
      deferredRows.forEach((row) => {
        allOverrides.push({ row, transaction_type: 'defer' } as any);
      });

      // Convert selectedForImport to array for the API
      const selectedRowsArray = Array.from(selectedForImport);

      // Convert date overrides to array for the API
      const dateOverridesList = Array.from(dateOverrides.entries()).map(([row, date]) => ({
        row,
        date
      }));

      const rejectedRefundRows = Array.from(refundOverrides.entries())
        .filter(([row, data]) => data.rejected && !selectedForImport.has(row))
        .map(([row]) => row);

      // Always use import-with-overrides endpoint with selected rows
      // Include per-row auto-allocate disabled flags - only send rows that are selected AND have auto-allocate disabled
      const autoAllocateDisabledRows = Array.from(autoAllocateDisabled).filter(row => selectedRowsArray.includes(row));

      const url = `${API_BASE}/bank-import/import-with-overrides?filepath=${encodeURIComponent(csvFilePath)}&bank_code=${selectedBankCode}&auto_allocate=${autoAllocate}&auto_reconcile=false`;
      const options: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          overrides: allOverrides,
          selected_rows: selectedRowsArray,
          date_overrides: dateOverridesList,
          rejected_refund_rows: rejectedRefundRows,
          auto_allocate_disabled_rows: autoAllocateDisabledRows
        })
      };

      const response = await authFetch(url, options);
      if (!response.ok) {
        let errorMsg = `Server error (${response.status})`;
        try { const errData = await response.json(); errorMsg = errData.detail || errData.error || errorMsg; } catch { /* use default */ }
        throw new Error(errorMsg);
      }
      const data = await response.json();
      setBankImportResult(data);

      // Clear only the imported rows - keep unimported rows editable for later import
      if (data.success) {
        const importedRowSet = new Set<number>((data.imported_transactions || []).map((t: any) => t.row as number));

        // Only remove imported rows from selections and overrides
        setSelectedForImport(prev => {
          const updated = new Set(prev);
          importedRowSet.forEach(r => updated.delete(r));
          return updated;
        });
        setEditedTransactions(prev => {
          const updated = new Map(prev);
          importedRowSet.forEach(r => updated.delete(r));
          return updated;
        });
        setTransactionTypeOverrides(prev => {
          const updated = new Map(prev);
          importedRowSet.forEach(r => updated.delete(r));
          return updated;
        });
        setDateOverrides(prev => {
          const updated = new Map(prev);
          importedRowSet.forEach(r => updated.delete(r));
          return updated;
        });
        setAutoAllocateDisabled(prev => {
          const updated = new Set(prev);
          importedRowSet.forEach(r => updated.delete(r));
          return updated;
        });
        setRefundOverrides(prev => {
          const updated = new Map(prev);
          importedRowSet.forEach(r => updated.delete(r));
          return updated;
        });
        setIncludedSkipped(prev => {
          const updated = new Map(prev);
          importedRowSet.forEach(r => updated.delete(r));
          return updated;
        });
        setDeferredRows(new Set());
        // Note: Do NOT clear bankPreview - keep it visible for summary until user clicks "Clear Statement"
        // Clear sessionStorage + backend draft so next visit gets fresh analysis (not stale pre-import data)
        // Suppress auto-save during refresh to prevent re-creating deleted draft
        draftSuppressedRef.current = true;
        clearPersistedState();
        deleteDraftForCurrentStatement();
        // Import is done — stop the spinner before async refresh
        setIsImporting(false);
        // Always show reconcile section to display imported transactions in statement order
        setShowReconcilePrompt(true);
        // Re-analyse the statement so imported items move to "In Opera" tab
        // and remaining items stay in their tabs with user edits preserved
        await handleRefreshPreview();
        // Re-enable auto-save for remaining items (partial import case)
        draftSuppressedRef.current = false;
        // Auto-scroll to import results so user sees outcome + reconcile prompt
        setTimeout(() => {
          importResultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 150);
      }
    } catch (error) {
      draftSuppressedRef.current = false;
      setBankImportResult({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    } finally {
      setIsImporting(false);
    }
  };

  // Scan emails for bank statements
  const handleScanEmails = async () => {
    setEmailScanLoading(true);
    setEmailStatements([]);
    setEmailScanMessage(null);
    setDuplicatesArchived(0);

    try {
      // Use appropriate endpoint based on data source
      let url: string;
      if (dataSource === 'opera3') {
        if (!opera3DataPath) {
          setEmailScanLoading(false);
          return;
        }
        url = `${API_BASE}/opera3/bank-import/scan-emails?bank_code=${selectedBankCode}&data_path=${encodeURIComponent(opera3DataPath)}&days_back=${emailScanDaysBack}&include_processed=false&validate_balances=true`;
      } else {
        url = `${API_BASE}/bank-import/scan-emails?bank_code=${selectedBankCode}&days_back=${emailScanDaysBack}&include_processed=false&validate_balances=true`;
      }

      const response = await authFetch(url);
      const data = await response.json();

      if (data.success) {
        setEmailStatements(data.statements_found || []);
        setEmailScanMessage(data.message || null);
        setDuplicatesArchived(data.duplicates_archived || 0);
      }
    } catch (error) {
      console.error('Error scanning emails:', error);
      setEmailScanMessage('Error scanning inbox. Please try again.');
    } finally {
      setEmailScanLoading(false);
      setEmailScanHasRun(true);
    }
  };

  // Scan folder for bank statements
  const handleScanFolder = async () => {
    setFolderScanLoading(true);
    setFolderStatements([]);
    setFolderScanMessage(null);

    try {
      const baseUrl = dataSource === 'opera3'
        ? `${API_BASE}/opera3/bank-import/scan-folder`
        : `${API_BASE}/bank-import/scan-folder`;
      const url = `${baseUrl}?bank_code=${selectedBankCode}&validate_balances=true`;

      const response = await authFetch(url);
      const data = await response.json();

      if (data.success) {
        setFolderStatements(data.statements_found || []);
        setFolderScanMessage(data.message || null);
      } else {
        setFolderScanMessage(data.error || 'Error scanning folder.');
      }
    } catch (error) {
      console.error('Error scanning folder:', error);
      setFolderScanMessage('Error scanning folder. Please check settings.');
    } finally {
      setFolderScanLoading(false);
      setFolderScanHasRun(true);
    }
  };

  // Fetch email attachments to the bank folder, then refresh the folder scan
  const [emailFetchLoading, setEmailFetchLoading] = useState(false);
  const [emailFetchMessage, setEmailFetchMessage] = useState<string | null>(null);

  const handleFetchEmailsToFolder = async () => {
    if (!selectedBankCode) return;
    setEmailFetchLoading(true);
    setEmailFetchMessage(null);

    try {
      const baseUrl = dataSource === 'opera3'
        ? `${API_BASE}/opera3/bank-import/fetch-emails-to-folder`
        : `${API_BASE}/bank-import/fetch-emails-to-folder`;
      const url = `${baseUrl}?bank_code=${selectedBankCode}&days_back=${emailScanDaysBack}`;

      const response = await authFetch(url, { method: 'POST' });
      const data = await response.json();

      if (data.success) {
        setEmailFetchMessage(data.message || null);
        // Refresh folder scan to show new files
        if (data.saved_count > 0) {
          await handleScanFolder();
        }
      } else {
        setEmailFetchMessage(data.error || 'Error fetching emails.');
      }
    } catch (error) {
      console.error('Error fetching email statements:', error);
      setEmailFetchMessage('Error checking email. Please try again.');
    } finally {
      setEmailFetchLoading(false);
    }
  };

  // Preview bank statement from folder PDF (reuses preview-from-pdf endpoint)
  const handleFolderPreview = async (filePath: string, filename: string) => {
    setSequenceError(null);

    try {
      setAnalysing(true);

      const baseUrl = dataSource === 'opera3'
        ? `${API_BASE}/opera3/bank-import/preview-from-pdf`
        : `${API_BASE}/bank-import/preview-from-pdf`;
      const params = new URLSearchParams({
        file_path: filePath,
        bank_code: selectedBankCode,
      });

      const response = await authFetch(`${baseUrl}?${params.toString()}`, { method: 'POST' });
      const data = await response.json();

      if (data.success) {
        setBankPreview(data);
        // Set selectedPdfFile so handlePdfImport works for folder-sourced PDFs
        setSelectedPdfFile({ filename, fullPath: filePath });
        // Store folder source path for archiving after import
        setFolderSourcePath(filePath);
      } else {
        if (data.status === 'skipped') {
          setFolderStatements(prev => prev.filter(s => s.full_path !== filePath));
          setFolderScanMessage(data.reason || 'Statement already processed');
        } else if (data.status === 'pending') {
          setSequenceError(data.reason || 'Import previous statement first');
        } else {
          setFolderScanMessage(data.error || 'Failed to analyse statement');
        }
      }
    } catch (error) {
      console.error('Error analysing folder statement:', error);
      setFolderScanMessage('Error analysing statement');
    } finally {
      setAnalysing(false);
    }
  };

  // Preview bank statement from email attachment
  const handleEmailPreview = async (emailId: number, attachmentId: string, filename: string) => {
    setSequenceError(null);
    setSelectedEmailStatement({ emailId, attachmentId, filename });

    // Check for saved draft before re-analysing
    try {
      const draftParams = new URLSearchParams({
        bank_code: selectedBankCode,
        source: 'email',
        email_id: String(emailId),
        attachment_id: attachmentId,
        filename: filename,
      });
      const draftRes = await authFetch(`${API_BASE}/bank-import/draft?${draftParams.toString()}`);
      const draftData = await draftRes.json();
      if (draftData.success && draftData.has_draft && draftData.draft?.preview_data) {
        // Draft exists — save user edits to a ref so fresh analysis can merge them
        pendingDraftEditsRef.current = draftData.draft.user_edits || {};
        // Fall through to fresh analysis below (don't use stale preview data)
      }
    } catch (e) {
      console.debug('Draft check failed, proceeding with fresh analysis:', e);
    }

    setIsPreviewing(true);
    setBankPreview(null);
    setRawFilePreview(null);
    setShowRawPreview(false);
    setBankImportResult(null);
    setEditedTransactions(new Map());
    setIncludedSkipped(new Map());
    setTransactionTypeOverrides(new Map());
    setRefundOverrides(new Map());
    setTabSearchFilter('');

    try {
      // Use appropriate endpoint based on data source
      let url: string;
      if (dataSource === 'opera3') {
        if (!opera3DataPath) {
          setBankPreview({
            success: false,
            filename: filename,
            total_transactions: 0,
            matched_receipts: [],
            matched_payments: [],
            matched_refunds: [],
            repeat_entries: [],
            unmatched: [],
            already_posted: [],
            skipped: [],
            errors: ['Opera 3 data path is required. Please configure it above.']
          });
          setIsPreviewing(false);
          return;
        }
        url = `${API_BASE}/opera3/bank-import/preview-from-email?email_id=${emailId}&attachment_id=${encodeURIComponent(attachmentId)}&data_path=${encodeURIComponent(opera3DataPath)}&bank_code=${selectedBankCode}`;
      } else {
        url = `${API_BASE}/bank-import/preview-from-email?email_id=${emailId}&attachment_id=${encodeURIComponent(attachmentId)}&bank_code=${selectedBankCode}`;
      }
      const response = await authFetch(url, { method: 'POST' });
      const data = await response.json();

      if (data.bank_mismatch) {
        setBankPreview({
          success: false,
          filename: filename,
          total_transactions: 0,
          matched_receipts: [],
          matched_payments: [],
          matched_refunds: [],
          repeat_entries: [],
          unmatched: [],
          already_posted: [],
          skipped: [],
          errors: [
            `Bank account mismatch: The statement is for bank ${data.detected_bank}, but you selected ${data.selected_bank}.`,
            'Please select the correct bank account and try again.'
          ]
        });
        return;
      }

      // Handle statement sequence validation responses — show as banner, return to list
      if (data.status === 'skipped') {
        const errorMsg = (data.errors && data.errors[0]) ||
          `Statement already processed or superseded. Opening balance (£${data.statement_info?.opening_balance?.toFixed(2) || '?'}) is less than Opera's reconciled balance (£${data.reconciled_balance?.toFixed(2) || '?'}).`;
        setSequenceError(errorMsg);
        setEmailStatements(prev => prev.filter(e => e.email_id !== emailId));
        setSelectedEmailStatement(null);
        return;
      }

      if (data.status === 'pending') {
        setSequenceError(
          `Statement out of sequence — opening balance £${data.statement_info?.opening_balance?.toFixed(2) || '?'} does not match Opera's reconciled balance £${data.reconciled_balance?.toFixed(2) || '?'}. Please import the missing statement(s) first.`
        );
        setSelectedEmailStatement(null);
        return;
      }

      // Determine default format based on file extension if backend doesn't specify
      const isEmailPdf = filename.toLowerCase().endsWith('.pdf');
      const emailDefaultFormat = isEmailPdf ? 'PDF' : 'CSV';
      const enhancedPreview: EnhancedBankImportPreview = {
        success: data.success,
        filename: data.filename,
        detected_format: data.detected_format || emailDefaultFormat,
        total_transactions: data.total_transactions,
        matched_receipts: data.matched_receipts || [],
        matched_payments: data.matched_payments || [],
        matched_refunds: data.matched_refunds || [],
        repeat_entries: data.repeat_entries || [],
        unmatched: data.unmatched || [],
        already_posted: data.already_posted || [],
        skipped: data.skipped || [],
        summary: data.summary,
        errors: data.errors || (data.error ? [data.error] : []),
        // Include statement bank info from AI extraction (for PDF statements)
        statement_bank_info: data.statement_bank_info ? {
          bank_name: data.statement_bank_info.bank_name,
          account_number: data.statement_bank_info.account_number,
          sort_code: data.statement_bank_info.sort_code,
          statement_date: data.statement_bank_info.statement_date,
          opening_balance: data.statement_bank_info.opening_balance,
          closing_balance: data.statement_bank_info.closing_balance,
          matched_opera_bank: data.statement_bank_info.matched_opera_bank,
          matched_opera_name: data.statement_bank_info.matched_opera_name
        } : undefined,
        // Raw statement transactions and info for reconcile screen
        statement_transactions: data.statement_transactions || [],
        statement_info: data.statement_info || null
      };

      setBankPreview(enhancedPreview);

      // Initialize selectedForImport
      const preSelected = new Set<number>();
      enhancedPreview.matched_receipts.filter(t => !t.is_duplicate).forEach(t => preSelected.add(t.row));
      enhancedPreview.matched_payments.filter(t => !t.is_duplicate).forEach(t => preSelected.add(t.row));
      (enhancedPreview.matched_refunds || []).filter(t => !t.is_duplicate).forEach(t => preSelected.add(t.row));

      // Apply pattern learning suggestions to unmatched/skipped items
      const { newEditedTransactions, newTransactionTypeOverrides, newIncludedSkipped, newNominalPostingDetails, newBankTransferDetails } =
        applySuggestionsAndAutoSelect(enhancedPreview, preSelected);

      if (alreadyPostedRows.size > 0) {
        alreadyPostedRows.forEach((_, row) => preSelected.delete(row));
      }
      setSelectedForImport(preSelected);

      // Apply the pre-filled data from suggestions
      setEditedTransactions(newEditedTransactions);
      setTransactionTypeOverrides(newTransactionTypeOverrides);
      setNominalPostingDetails(newNominalPostingDetails);
      setBankTransferDetails(newBankTransferDetails);
      setIncludedSkipped(newIncludedSkipped);

      // Load previously ignored transactions from database
      await loadIgnoredTransactions(enhancedPreview);

      setDateOverrides(new Map());
      setRefundOverrides(new Map());
      setUpdatedRepeatEntries(new Set());
      setRepeatEntriesProcessed(false);

      // If we have pending draft edits (user returning to in-progress statement),
      // merge them over the fresh analysis results
      if (pendingDraftEditsRef.current) {
        const edits = pendingDraftEditsRef.current;
        pendingDraftEditsRef.current = null;
        if (edits.editedTransactions) setEditedTransactions(new Map(edits.editedTransactions));
        if (edits.selectedForImport) setSelectedForImport(new Set(edits.selectedForImport));
        if (edits.dateOverrides) setDateOverrides(new Map(edits.dateOverrides));
        if (edits.transactionTypeOverrides) setTransactionTypeOverrides(new Map(edits.transactionTypeOverrides));
        if (edits.includedSkipped) setIncludedSkipped(new Map(edits.includedSkipped));
        if (edits.refundOverrides) setRefundOverrides(new Map(edits.refundOverrides));
        if (edits.nominalPostingDetails) setNominalPostingDetails(new Map(edits.nominalPostingDetails));
        if (edits.bankTransferDetails) setBankTransferDetails(new Map(edits.bankTransferDetails));
        if (edits.autoAllocateDisabled) setAutoAllocateDisabled(new Set(edits.autoAllocateDisabled));
        if (edits.cbtypeOverrides) setCbtypeOverrides(new Map(edits.cbtypeOverrides));
        if (edits.ignoredTransactions) setIgnoredTransactions(new Set(edits.ignoredTransactions));
        if (edits.deferredRows) {
          // Restore the deferred set, then drop any row that the matcher now
          // pairs with an Opera entry — including duplicates (rows the user
          // has since entered in Opera manually) and already-posted rows.
          // Operator's mental model: "deferred items that are now in Opera
          // should just be processed".
          const allMatched = new Set<number>([
            ...enhancedPreview.matched_receipts.map((t: any) => t.row),
            ...enhancedPreview.matched_payments.map((t: any) => t.row),
            ...((enhancedPreview.matched_refunds || []).map((t: any) => t.row)),
            ...((enhancedPreview.already_posted || []).map((t: any) => t.row)),
          ]);
          const restoredDeferred = new Set<number>(edits.deferredRows as number[]);
          let cleared = 0;
          for (const r of restoredDeferred) {
            if (allMatched.has(r)) {
              restoredDeferred.delete(r);
              cleared++;
            }
          }
          setDeferredRows(restoredDeferred);
          if (cleared > 0) {
            console.info(`[deferred] ${cleared} previously-deferred rows are now in Opera — un-deferred so they import / reconcile normally`);
          }
        }
      }

      if (enhancedPreview.matched_receipts.filter((t: any) => !t.is_duplicate).length > 0) setActivePreviewTab('receipts');
      else if (enhancedPreview.matched_payments.filter((t: any) => !t.is_duplicate).length > 0) setActivePreviewTab('payments');
      else if (enhancedPreview.matched_refunds?.filter((t: any) => !t.is_duplicate).length > 0) setActivePreviewTab('refunds');
      else if (enhancedPreview.repeat_entries?.length > 0) setActivePreviewTab('repeat');
      else if (enhancedPreview.unmatched.length > 0) setActivePreviewTab('unmatched');
      else setActivePreviewTab('skipped');
    } catch (error) {
      pendingDraftEditsRef.current = null;
      setBankPreview({
        success: false,
        filename: filename,
        total_transactions: 0,
        matched_receipts: [],
        matched_payments: [],
        matched_refunds: [],
        repeat_entries: [],
        unmatched: [],
        already_posted: [],
        skipped: [],
        errors: [error instanceof Error ? error.message : 'Unknown error']
      });
    } finally {
      setIsPreviewing(false);
    }
  };

  // Preview bank statement from PDF file (similar to email preview)
  const handlePdfPreview = async (filename: string) => {
    if (!pdfDirectory || !filename) return;

    const fullPath = pdfDirectory.endsWith('/') || pdfDirectory.endsWith('\\')
      ? pdfDirectory + filename
      : pdfDirectory + '/' + filename;

    setSelectedPdfFile({ filename, fullPath });
    setSelectedEmailStatement(null);
    setSequenceError(null);

    // Check for saved draft before re-analysing
    try {
      const draftParams = new URLSearchParams({
        bank_code: selectedBankCode,
        source: 'pdf',
        filename: filename,
      });
      const draftRes = await authFetch(`${API_BASE}/bank-import/draft?${draftParams.toString()}`);
      const draftData = await draftRes.json();
      if (draftData.success && draftData.has_draft && draftData.draft?.preview_data) {
        // Draft exists — save user edits to ref so fresh analysis can merge them
        pendingDraftEditsRef.current = draftData.draft.user_edits || {};
        // Fall through to fresh analysis (don't use stale preview data)
      }
    } catch (e) {
      console.debug('Draft check failed, proceeding with fresh analysis:', e);
    }

    setIsPreviewing(true);
    setBankPreview(null);
    setRawFilePreview(null);
    setShowRawPreview(false);
    setBankImportResult(null);
    setEditedTransactions(new Map());
    setIncludedSkipped(new Map());
    setTransactionTypeOverrides(new Map());
    setRefundOverrides(new Map());
    setTabSearchFilter('');

    try {
      // Use appropriate endpoint based on data source
      let url: string;
      if (dataSource === 'opera3') {
        if (!opera3DataPath) {
          setBankPreview({
            success: false,
            filename: filename,
            total_transactions: 0,
            matched_receipts: [],
            matched_payments: [],
            matched_refunds: [],
            repeat_entries: [],
            unmatched: [],
            already_posted: [],
            skipped: [],
            errors: ['Opera 3 data path is required. Please configure it in Settings.']
          });
          setIsPreviewing(false);
          return;
        }
        url = `${API_BASE}/opera3/bank-import/preview-from-pdf?file_path=${encodeURIComponent(fullPath)}&data_path=${encodeURIComponent(opera3DataPath)}&bank_code=${selectedBankCode}`;
      } else {
        url = `${API_BASE}/bank-import/preview-from-pdf?file_path=${encodeURIComponent(fullPath)}&bank_code=${selectedBankCode}`;
      }
      const response = await authFetch(url, { method: 'POST' });
      const data = await response.json();

      if (data.bank_mismatch) {
        setBankPreview({
          success: false,
          filename: filename,
          total_transactions: 0,
          matched_receipts: [],
          matched_payments: [],
          matched_refunds: [],
          repeat_entries: [],
          unmatched: [],
          already_posted: [],
          skipped: [],
          errors: [
            `Bank account mismatch: The statement is for bank ${data.detected_bank}, but you selected ${data.selected_bank}.`,
            'Please select the correct bank account and try again.'
          ]
        });
        return;
      }

      // Handle statement sequence validation responses — show as banner, return to list
      if (data.status === 'skipped') {
        setSequenceError(data.message || 'This statement appears to have already been processed.');
        setSelectedPdfFile(null);
        // Refresh PDF list to pick up any changes
        if (pdfDirectory) handleScanPdfFiles();
        return;
      }

      if (data.status === 'out_of_sequence') {
        setSequenceError(
          `${data.message || 'Statement is out of sequence.'} Opening balance: £${data.statement_info?.opening_balance?.toLocaleString('en-GB', { minimumFractionDigits: 2 }) || '?'}, reconciled balance: £${data.reconciled_balance?.toLocaleString('en-GB', { minimumFractionDigits: 2 }) || '?'}.`
        );
        setSelectedPdfFile(null);
        return;
      }

      // Success - build preview
      const enhancedPreview: EnhancedBankImportPreview = {
        success: data.success,
        filename: filename,
        detected_format: data.detected_format || 'PDF',
        total_transactions: data.total_transactions || 0,
        matched_receipts: data.matched_receipts || [],
        matched_payments: data.matched_payments || [],
        matched_refunds: data.matched_refunds || [],
        repeat_entries: data.repeat_entries || [],
        unmatched: data.unmatched || [],
        already_posted: data.already_posted || [],
        skipped: data.skipped || [],
        summary: data.summary,
        errors: data.errors || [],
        period_info: data.period_info,
        period_violations: data.period_violations,
        has_period_violations: data.has_period_violations,
        statement_bank_info: data.statement_bank_info ? {
          bank_name: data.statement_bank_info.bank_name,
          account_number: data.statement_bank_info.account_number,
          sort_code: data.statement_bank_info.sort_code,
          statement_date: data.statement_bank_info.statement_date,
          opening_balance: data.statement_bank_info.opening_balance,
          closing_balance: data.statement_bank_info.closing_balance,
          matched_opera_bank: data.statement_bank_info.matched_opera_bank,
          matched_opera_name: data.statement_bank_info.matched_opera_name
        } : undefined,
        // Raw statement transactions and info for reconcile screen
        statement_transactions: data.statement_transactions || [],
        statement_info: data.statement_info || null
      };

      setBankPreview(enhancedPreview);

      // Initialize selectedForImport
      const preSelected = new Set<number>();
      enhancedPreview.matched_receipts.filter(t => !t.is_duplicate).forEach(t => preSelected.add(t.row));
      enhancedPreview.matched_payments.filter(t => !t.is_duplicate).forEach(t => preSelected.add(t.row));
      (enhancedPreview.matched_refunds || []).filter(t => !t.is_duplicate).forEach(t => preSelected.add(t.row));

      // Apply pattern learning suggestions to unmatched/skipped items
      const { newEditedTransactions, newTransactionTypeOverrides, newIncludedSkipped, newNominalPostingDetails, newBankTransferDetails } =
        applySuggestionsAndAutoSelect(enhancedPreview, preSelected);

      if (alreadyPostedRows.size > 0) {
        alreadyPostedRows.forEach((_, row) => preSelected.delete(row));
      }
      setSelectedForImport(preSelected);

      // Apply the pre-filled data from suggestions
      setEditedTransactions(newEditedTransactions);
      setTransactionTypeOverrides(newTransactionTypeOverrides);
      setNominalPostingDetails(newNominalPostingDetails);
      setBankTransferDetails(newBankTransferDetails);
      setIncludedSkipped(newIncludedSkipped);

      // Load previously ignored transactions from database
      await loadIgnoredTransactions(enhancedPreview);

      setDateOverrides(new Map());
      setRefundOverrides(new Map());
      setUpdatedRepeatEntries(new Set());
      setRepeatEntriesProcessed(false);

      // If we have pending draft edits (user returning to in-progress statement),
      // merge them over the fresh analysis results
      if (pendingDraftEditsRef.current) {
        const edits = pendingDraftEditsRef.current;
        pendingDraftEditsRef.current = null;
        if (edits.editedTransactions) setEditedTransactions(new Map(edits.editedTransactions));
        if (edits.selectedForImport) setSelectedForImport(new Set(edits.selectedForImport));
        if (edits.dateOverrides) setDateOverrides(new Map(edits.dateOverrides));
        if (edits.transactionTypeOverrides) setTransactionTypeOverrides(new Map(edits.transactionTypeOverrides));
        if (edits.includedSkipped) setIncludedSkipped(new Map(edits.includedSkipped));
        if (edits.refundOverrides) setRefundOverrides(new Map(edits.refundOverrides));
        if (edits.nominalPostingDetails) setNominalPostingDetails(new Map(edits.nominalPostingDetails));
        if (edits.bankTransferDetails) setBankTransferDetails(new Map(edits.bankTransferDetails));
        if (edits.autoAllocateDisabled) setAutoAllocateDisabled(new Set(edits.autoAllocateDisabled));
        if (edits.cbtypeOverrides) setCbtypeOverrides(new Map(edits.cbtypeOverrides));
        if (edits.ignoredTransactions) setIgnoredTransactions(new Set(edits.ignoredTransactions));
        if (edits.deferredRows) {
          // Restore the deferred set, then drop any row that the matcher now
          // pairs with an Opera entry — including duplicates (rows the user
          // has since entered in Opera manually) and already-posted rows.
          // Operator's mental model: "deferred items that are now in Opera
          // should just be processed".
          const allMatched = new Set<number>([
            ...enhancedPreview.matched_receipts.map((t: any) => t.row),
            ...enhancedPreview.matched_payments.map((t: any) => t.row),
            ...((enhancedPreview.matched_refunds || []).map((t: any) => t.row)),
            ...((enhancedPreview.already_posted || []).map((t: any) => t.row)),
          ]);
          const restoredDeferred = new Set<number>(edits.deferredRows as number[]);
          let cleared = 0;
          for (const r of restoredDeferred) {
            if (allMatched.has(r)) {
              restoredDeferred.delete(r);
              cleared++;
            }
          }
          setDeferredRows(restoredDeferred);
          if (cleared > 0) {
            console.info(`[deferred] ${cleared} previously-deferred rows are now in Opera — un-deferred so they import / reconcile normally`);
          }
        }
      }

      if (enhancedPreview.matched_receipts.filter((t: any) => !t.is_duplicate).length > 0) setActivePreviewTab('receipts');
      else if (enhancedPreview.matched_payments.filter((t: any) => !t.is_duplicate).length > 0) setActivePreviewTab('payments');
      else if (enhancedPreview.matched_refunds?.filter((t: any) => !t.is_duplicate).length > 0) setActivePreviewTab('refunds');
      else if (enhancedPreview.repeat_entries?.length > 0) setActivePreviewTab('repeat');
      else if (enhancedPreview.unmatched.length > 0) setActivePreviewTab('unmatched');
      else setActivePreviewTab('skipped');
    } catch (error) {
      pendingDraftEditsRef.current = null;
      setBankPreview({
        success: false,
        filename: filename,
        total_transactions: 0,
        matched_receipts: [],
        matched_payments: [],
        matched_refunds: [],
        repeat_entries: [],
        unmatched: [],
        already_posted: [],
        skipped: [],
        errors: [error instanceof Error ? error.message : 'Unknown error']
      });
    } finally {
      setIsPreviewing(false);
    }
  };

  // Import bank statement from PDF file
  const handlePdfImport = async () => {
    if (!selectedPdfFile) {
      console.error('handlePdfImport called but selectedPdfFile is null');
      setBankImportResult({
        success: false,
        error: 'No PDF file selected. Please select a PDF file and run preview first.'
      });
      return;
    }
    if (!selectedPdfFile.fullPath || !selectedPdfFile.fullPath.trim()) {
      // Stale selectedPdfFile with empty fullPath. Used to surface as
      // "file_path or bytes is required" from the BE — replace with a
      // clearer FE-side message + dispatch hint. If the user came from
      // the Hub with an email-source statement, route them through
      // the email path instead.
      console.error('handlePdfImport called with empty fullPath; selectedPdfFile=', selectedPdfFile);
      if (selectedEmailStatement) {
        console.warn('Falling back to email-import path since selectedEmailStatement is set');
        await handleEmailImport();
        return;
      }
      setBankImportResult({
        success: false,
        error:
          'Internal: the selected PDF has no file path. Go back to the ' +
          'Bank Statement Hub and click Process again to re-select the ' +
          'statement.',
      });
      return;
    }

    setIsImporting(true);
    setBankImportResult(null);

    try {
      // Prepare overrides - include transactions with account OR those that don't need account (nominal/bank transfer)
      const unmatchedOverrides = Array.from(selectedForImport).map(row => {
        const editedTxn = editedTransactions.get(row);
        const txnType = transactionTypeOverrides.get(row);
        const isNlOrTransfer = txnType === 'bank_transfer' || txnType === 'nominal_receipt' || txnType === 'nominal_payment';
        if (editedTxn?.manual_account || isNlOrTransfer) {
          const override: any = {
            row,
            account: editedTxn?.manual_account || '',
            ledger_type: editedTxn?.manual_ledger_type || 'C',
            // Sign-aware default: a -£X bank line going to a customer is
            // a sales_refund (we paid them back), not a sales_receipt; a
            // +£X line going to a supplier is a purchase_refund (they
            // refunded us), not a purchase_payment. The previous default
            // hard-coded sales_receipt/purchase_payment regardless of
            // direction, so the post-time duplicate check fired against
            // the wrong stran/ptran type filter and blocked legitimate
            // refund imports.
            transaction_type: txnType || (() => {
              const ledger = editedTxn?.manual_ledger_type;
              const allRows: any[] = [
                ...(bankPreview?.unmatched || []),
                ...(bankPreview?.matched_receipts || []),
                ...(bankPreview?.matched_payments || []),
                ...(bankPreview?.matched_refunds || []),
                ...(bankPreview?.skipped || []),
                ...(bankPreview?.already_posted || []),
              ];
              const txn = allRows.find(t => t?.row === row);
              const amt = Number(editedTxn?.manual_amount ?? txn?.amount ?? 0);
              if (ledger === 'C') return amt >= 0 ? 'sales_receipt' : 'sales_refund';
              if (ledger === 'S') return amt <= 0 ? 'purchase_payment' : 'purchase_refund';
              return 'sales_receipt';
            })()
          };
          // Include bank transfer details when type is bank_transfer
          if (txnType === 'bank_transfer') {
            const btDetails = bankTransferDetails.get(row);
            if (btDetails) {
              override.bank_transfer_details = {
                dest_bank: btDetails.destBankCode,
                cashbook_type: btDetails.cashbookType || 'TRF',
                reference: btDetails.reference || '',
                comment: btDetails.comment || '',
                date: btDetails.date || ''
              };
            }
          }
          // Include nominal posting details for pattern learning
          const nomDetail = nominalPostingDetails.get(row);
          if (nomDetail?.nominalCode) override.nominal_code = nomDetail.nominalCode;
          if (nomDetail?.vatCode) override.vat_code = nomDetail.vatCode;
          if (nomDetail?.projectCode) override.project_code = nomDetail.projectCode;
          if (nomDetail?.departmentCode) override.department_code = nomDetail.departmentCode;
          return override;
        }
        return null;
      }).filter(Boolean);

      const skippedOverrides = Array.from(includedSkipped.entries())
        .filter(([, data]) => {
          const isNlOrTransfer = data.transaction_type === 'bank_transfer' || data.transaction_type === 'nominal_receipt' || data.transaction_type === 'nominal_payment';
          return data.account || isNlOrTransfer;
        })
        .map(([row, data]) => {
          const override: any = {
            row,
            account: data.account || '',
            ledger_type: data.ledger_type,
            transaction_type: data.transaction_type
          };
          if (data.transaction_type === 'bank_transfer') {
            const btDetails = bankTransferDetails.get(row);
            if (btDetails) {
              override.bank_transfer_details = {
                dest_bank: btDetails.destBankCode,
                cashbook_type: btDetails.cashbookType || 'TRF',
                reference: btDetails.reference || '',
                comment: btDetails.comment || '',
                date: btDetails.date || ''
              };
            }
          }
          // Include nominal posting details for pattern learning
          const nomDetail = nominalPostingDetails.get(row);
          if (nomDetail?.nominalCode) override.nominal_code = nomDetail.nominalCode;
          if (nomDetail?.vatCode) override.vat_code = nomDetail.vatCode;
          if (nomDetail?.projectCode) override.project_code = nomDetail.projectCode;
          if (nomDetail?.departmentCode) override.department_code = nomDetail.departmentCode;
          return override;
        });

      const refundOverridesList = Array.from(refundOverrides.entries())
        .filter(([row, data]) => selectedForImport.has(row) && (data.transaction_type || data.account))
        .map(([row, data]) => {
          const override: any = {
            row,
            account: data.account,
            ledger_type: data.ledger_type,
            transaction_type: data.transaction_type
          };
          // Include nominal posting details for pattern learning
          const nomDetail = nominalPostingDetails.get(row);
          if (nomDetail?.nominalCode) override.nominal_code = nomDetail.nominalCode;
          if (nomDetail?.vatCode) override.vat_code = nomDetail.vatCode;
          if (nomDetail?.projectCode) override.project_code = nomDetail.projectCode;
          if (nomDetail?.departmentCode) override.department_code = nomDetail.departmentCode;
          return override;
        });

      // Include cashbook type (cbtype) overrides for any rows with user-selected Opera types
      const cbtypeOverridesList = Array.from(cbtypeOverrides.entries())
        .filter(([row]) => selectedForImport.has(row))
        .map(([row, cbtype]) => ({ row, cbtype }));

      // MATCHED ROWS — every row the matcher resolved (sales_receipt /
      // sales_refund / purchase_payment / purchase_refund / bank_transfer
      // / nominal_*) needs its action + matched_account passed through as
      // an override, otherwise the backend executor defaults the action
      // to 'skip' and the row is silently dropped (records_imported=0).
      // Only the `unmatchedOverrides` array above covers manually-assigned
      // rows; auto-matched receipts/payments fall through that filter
      // because they have no `editedTxn.manual_account`.
      const matchedRowsForOverride = [
        ...(bankPreview?.matched_receipts || []),
        ...(bankPreview?.matched_payments || []),
        ...(bankPreview?.matched_refunds || []),
      ];
      const matchedOverrides = matchedRowsForOverride
        .filter((t: any) =>
          t && selectedForImport.has(t.row) && t.action && t.action !== 'skip' && t.action !== 'defer',
        )
        .map((t: any) => {
          const row = t.row as number;
          const override: any = {
            row,
            account: (t.account ?? '') as string,
            ledger_type:
              (t.matched_ledger_type as string | undefined) ??
              (t.action === 'sales_receipt' || t.action === 'sales_refund'
                ? 'C'
                : t.action === 'purchase_payment' || t.action === 'purchase_refund'
                  ? 'S'
                  : t.action?.startsWith('nominal_') || t.action === 'bank_transfer'
                    ? 'N'
                    : 'C'),
            transaction_type: t.action as string,
            cbtype: (t.cbtype as string | undefined) ?? undefined,
          };
          const nomDetail = nominalPostingDetails.get(row);
          if (nomDetail?.nominalCode) override.nominal_code = nomDetail.nominalCode;
          if (nomDetail?.vatCode) override.vat_code = nomDetail.vatCode;
          if (nomDetail?.projectCode) override.project_code = nomDetail.projectCode;
          if (nomDetail?.departmentCode) override.department_code = nomDetail.departmentCode;
          if (t.action === 'bank_transfer') {
            const btDetails = bankTransferDetails.get(row);
            if (btDetails) {
              override.bank_transfer_details = {
                dest_bank: btDetails.destBankCode,
                cashbook_type: btDetails.cashbookType || 'TRF',
                reference: btDetails.reference || '',
                comment: btDetails.comment || '',
                date: btDetails.date || '',
              };
            }
          }
          return override;
        });

      const allOverrides = [
        ...unmatchedOverrides,
        ...skippedOverrides,
        ...refundOverridesList,
        ...matchedOverrides,
      ];

      // Merge cbtype overrides into allOverrides (add cbtype to existing overrides or create new ones)
      for (const cbo of cbtypeOverridesList) {
        const existing = allOverrides.find(o => o.row === cbo.row);
        if (existing) {
          (existing as any).cbtype = cbo.cbtype;
        } else {
          allOverrides.push({ row: cbo.row, cbtype: cbo.cbtype } as any);
        }
      }

      // Append override entries for deferred rows so backend records audit + skips posting
      deferredRows.forEach((row) => {
        allOverrides.push({ row, transaction_type: 'defer' } as any);
      });

      const selectedRowsList = Array.from(selectedForImport);
      const dateOverridesList = Array.from(dateOverrides.entries()).map(([row, date]) => ({ row, date }));
      const rejectedRefundRows = Array.from(refundOverrides.entries())
        .filter(([row, data]) => data.rejected && !selectedForImport.has(row))
        .map(([row]) => row);

      // Include per-row auto-allocate disabled flags
      const autoAllocateDisabledRows = Array.from(autoAllocateDisabled).filter(row => selectedRowsList.includes(row));

      let url: string;
      const resumeParam = resumeImportId ? `&resume_import_id=${resumeImportId}` : '';
      // Belt-and-braces: append email coords when present so the BE
      // can fall back to the email path if file_path is unusable.
      // The BE has a server-side rescue that converts /import-from-pdf
      // calls with empty file_path + valid email_id+attachment_id
      // into /import-from-email calls. This protects against stale
      // FE bundles that haven't picked up the dispatch fixes yet.
      const emailCoordsParam = selectedEmailStatement
        ? `&email_id=${selectedEmailStatement.emailId}&attachment_id=${encodeURIComponent(selectedEmailStatement.attachmentId)}`
        : '';
      if (dataSource === 'opera3') {
        url = `${API_BASE}/opera3/bank-import/import-from-pdf?file_path=${encodeURIComponent(selectedPdfFile.fullPath)}&data_path=${encodeURIComponent(opera3DataPath)}&bank_code=${selectedBankCode}&auto_allocate=${autoAllocate}&auto_reconcile=false${resumeParam}${emailCoordsParam}`;
      } else {
        url = `${API_BASE}/bank-import/import-from-pdf?file_path=${encodeURIComponent(selectedPdfFile.fullPath)}&bank_code=${selectedBankCode}&auto_allocate=${autoAllocate}&auto_reconcile=false${resumeParam}${emailCoordsParam}`;
      }

      const response = await authFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          overrides: allOverrides,
          selected_rows: selectedRowsList,
          date_overrides: dateOverridesList,
          rejected_refund_rows: rejectedRefundRows,
          skip_overlap_check: !!resumeImportId,  // Bypass overlap check when resuming
          auto_allocate_disabled_rows: autoAllocateDisabledRows  // Rows to skip auto-allocation
        })
      });

      if (!response.ok) {
        let errorMsg = `Server error (${response.status})`;
        try { const errData = await response.json(); errorMsg = errData.detail || errData.error || errorMsg; } catch { /* use default */ }
        throw new Error(errorMsg);
      }
      const data = await response.json();
      setBankImportResult(data);

      if (data.success) {
        const importedRowSet = new Set<number>((data.imported_transactions || []).map((t: any) => t.row as number));
        // Only remove imported rows from selections and overrides
        setSelectedForImport(prev => {
          const updated = new Set(prev);
          importedRowSet.forEach(r => updated.delete(r));
          return updated;
        });
        setEditedTransactions(prev => {
          const updated = new Map(prev);
          importedRowSet.forEach(r => updated.delete(r));
          return updated;
        });
        setTransactionTypeOverrides(prev => {
          const updated = new Map(prev);
          importedRowSet.forEach(r => updated.delete(r));
          return updated;
        });
        setDateOverrides(prev => {
          const updated = new Map(prev);
          importedRowSet.forEach(r => updated.delete(r));
          return updated;
        });
        setAutoAllocateDisabled(prev => {
          const updated = new Set(prev);
          importedRowSet.forEach(r => updated.delete(r));
          return updated;
        });
        setRefundOverrides(prev => {
          const updated = new Map(prev);
          importedRowSet.forEach(r => updated.delete(r));
          return updated;
        });
        setIncludedSkipped(prev => {
          const updated = new Map(prev);
          importedRowSet.forEach(r => updated.delete(r));
          return updated;
        });
        setDeferredRows(new Set());
        // Clear sessionStorage + backend draft so next visit gets fresh analysis
        // Suppress auto-save during refresh to prevent re-creating deleted draft
        draftSuppressedRef.current = true;
        clearPersistedState();
        deleteDraftForCurrentStatement();
        // Import is done — stop the spinner before async refresh
        setIsImporting(false);
        // Always show reconcile section to display imported transactions in statement order
        setShowReconcilePrompt(true);
        // Refresh statement list to show as processed
        if (isFolderSource) {
          handleScanFolder();
        } else {
          handleScanPdfFiles();
        }
        // Re-analyse the statement so imported items move to "In Opera" tab
        // and remaining items stay in their tabs with user edits preserved
        await handleRefreshPreview();
        // Re-enable auto-save for remaining items (partial import case)
        draftSuppressedRef.current = false;
        // Auto-scroll to import results so user sees outcome + reconcile prompt
        setTimeout(() => {
          importResultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 150);
      }
    } catch (error) {
      draftSuppressedRef.current = false;
      setBankImportResult({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    } finally {
      setIsImporting(false);
    }
  };

  // Import bank statement from email attachment
  const handleEmailImport = async () => {
    if (!selectedEmailStatement) {
      console.error('handleEmailImport called but selectedEmailStatement is null');
      setBankImportResult({
        success: false,
        error: 'No email statement selected. Please select an email attachment and run preview first.'
      });
      return;
    }

    setIsImporting(true);
    setBankImportResult(null);

    try {
      // Prepare overrides - include transactions with account OR those that don't need account (nominal/bank transfer)
      const unmatchedOverrides = Array.from(selectedForImport).map(row => {
        const editedTxn = editedTransactions.get(row);
        const txnType = transactionTypeOverrides.get(row);
        const isNlOrTransfer = txnType === 'bank_transfer' || txnType === 'nominal_receipt' || txnType === 'nominal_payment';
        if (editedTxn?.manual_account || isNlOrTransfer) {
          const override: any = {
            row,
            account: editedTxn?.manual_account || '',
            ledger_type: editedTxn?.manual_ledger_type || 'C',
            // Sign-aware default: a -£X bank line going to a customer is
            // a sales_refund (we paid them back), not a sales_receipt; a
            // +£X line going to a supplier is a purchase_refund (they
            // refunded us), not a purchase_payment. The previous default
            // hard-coded sales_receipt/purchase_payment regardless of
            // direction, so the post-time duplicate check fired against
            // the wrong stran/ptran type filter and blocked legitimate
            // refund imports.
            transaction_type: txnType || (() => {
              const ledger = editedTxn?.manual_ledger_type;
              const allRows: any[] = [
                ...(bankPreview?.unmatched || []),
                ...(bankPreview?.matched_receipts || []),
                ...(bankPreview?.matched_payments || []),
                ...(bankPreview?.matched_refunds || []),
                ...(bankPreview?.skipped || []),
                ...(bankPreview?.already_posted || []),
              ];
              const txn = allRows.find(t => t?.row === row);
              const amt = Number(editedTxn?.manual_amount ?? txn?.amount ?? 0);
              if (ledger === 'C') return amt >= 0 ? 'sales_receipt' : 'sales_refund';
              if (ledger === 'S') return amt <= 0 ? 'purchase_payment' : 'purchase_refund';
              return 'sales_receipt';
            })()
          };
          // Include bank transfer details when type is bank_transfer
          if (txnType === 'bank_transfer') {
            const btDetails = bankTransferDetails.get(row);
            if (btDetails) {
              override.bank_transfer_details = {
                dest_bank: btDetails.destBankCode,
                cashbook_type: btDetails.cashbookType || 'TRF',
                reference: btDetails.reference || '',
                comment: btDetails.comment || '',
                date: btDetails.date || ''
              };
            }
          }
          // Include nominal posting details for pattern learning
          const nomDetail = nominalPostingDetails.get(row);
          if (nomDetail?.nominalCode) override.nominal_code = nomDetail.nominalCode;
          if (nomDetail?.vatCode) override.vat_code = nomDetail.vatCode;
          if (nomDetail?.projectCode) override.project_code = nomDetail.projectCode;
          if (nomDetail?.departmentCode) override.department_code = nomDetail.departmentCode;
          return override;
        }
        return null;
      }).filter(Boolean);

      const skippedOverrides = Array.from(includedSkipped.entries())
        .filter(([, data]) => {
          const isNlOrTransfer = data.transaction_type === 'bank_transfer' || data.transaction_type === 'nominal_receipt' || data.transaction_type === 'nominal_payment';
          return data.account || isNlOrTransfer;
        })
        .map(([row, data]) => {
          const override: any = {
            row,
            account: data.account || '',
            ledger_type: data.ledger_type,
            transaction_type: data.transaction_type
          };
          if (data.transaction_type === 'bank_transfer') {
            const btDetails = bankTransferDetails.get(row);
            if (btDetails) {
              override.bank_transfer_details = {
                dest_bank: btDetails.destBankCode,
                cashbook_type: btDetails.cashbookType || 'TRF',
                reference: btDetails.reference || '',
                comment: btDetails.comment || '',
                date: btDetails.date || ''
              };
            }
          }
          // Include nominal posting details for pattern learning
          const nomDetail = nominalPostingDetails.get(row);
          if (nomDetail?.nominalCode) override.nominal_code = nomDetail.nominalCode;
          if (nomDetail?.vatCode) override.vat_code = nomDetail.vatCode;
          if (nomDetail?.projectCode) override.project_code = nomDetail.projectCode;
          if (nomDetail?.departmentCode) override.department_code = nomDetail.departmentCode;
          return override;
        });

      const refundOverridesList = Array.from(refundOverrides.entries())
        .filter(([row, data]) => selectedForImport.has(row) && (data.transaction_type || data.account))
        .map(([row, data]) => {
          const override: any = {
            row,
            account: data.account,
            ledger_type: data.ledger_type,
            transaction_type: data.transaction_type
          };
          // Include nominal posting details for pattern learning
          const nomDetail = nominalPostingDetails.get(row);
          if (nomDetail?.nominalCode) override.nominal_code = nomDetail.nominalCode;
          if (nomDetail?.vatCode) override.vat_code = nomDetail.vatCode;
          if (nomDetail?.projectCode) override.project_code = nomDetail.projectCode;
          if (nomDetail?.departmentCode) override.department_code = nomDetail.departmentCode;
          return override;
        });

      // Include cashbook type (cbtype) overrides for any rows with user-selected Opera types
      const cbtypeOverridesList = Array.from(cbtypeOverrides.entries())
        .filter(([row]) => selectedForImport.has(row))
        .map(([row, cbtype]) => ({ row, cbtype }));

      // MATCHED ROWS — see comment at the other import call site.
      const matchedRowsForOverride = [
        ...(bankPreview?.matched_receipts || []),
        ...(bankPreview?.matched_payments || []),
        ...(bankPreview?.matched_refunds || []),
      ];
      const matchedOverrides = matchedRowsForOverride
        .filter((t: any) =>
          t && selectedForImport.has(t.row) && t.action && t.action !== 'skip' && t.action !== 'defer',
        )
        .map((t: any) => {
          const row = t.row as number;
          const override: any = {
            row,
            account: (t.account ?? '') as string,
            ledger_type:
              (t.matched_ledger_type as string | undefined) ??
              (t.action === 'sales_receipt' || t.action === 'sales_refund'
                ? 'C'
                : t.action === 'purchase_payment' || t.action === 'purchase_refund'
                  ? 'S'
                  : t.action?.startsWith('nominal_') || t.action === 'bank_transfer'
                    ? 'N'
                    : 'C'),
            transaction_type: t.action as string,
            cbtype: (t.cbtype as string | undefined) ?? undefined,
          };
          const nomDetail = nominalPostingDetails.get(row);
          if (nomDetail?.nominalCode) override.nominal_code = nomDetail.nominalCode;
          if (nomDetail?.vatCode) override.vat_code = nomDetail.vatCode;
          if (nomDetail?.projectCode) override.project_code = nomDetail.projectCode;
          if (nomDetail?.departmentCode) override.department_code = nomDetail.departmentCode;
          if (t.action === 'bank_transfer') {
            const btDetails = bankTransferDetails.get(row);
            if (btDetails) {
              override.bank_transfer_details = {
                dest_bank: btDetails.destBankCode,
                cashbook_type: btDetails.cashbookType || 'TRF',
                reference: btDetails.reference || '',
                comment: btDetails.comment || '',
                date: btDetails.date || '',
              };
            }
          }
          return override;
        });

      const allOverrides = [
        ...unmatchedOverrides,
        ...skippedOverrides,
        ...refundOverridesList,
        ...matchedOverrides,
      ];

      // Merge cbtype overrides into allOverrides (add cbtype to existing overrides or create new ones)
      for (const cbo of cbtypeOverridesList) {
        const existing = allOverrides.find(o => o && (o as any).row === cbo.row);
        if (existing) {
          (existing as any).cbtype = cbo.cbtype;
        } else {
          allOverrides.push({ row: cbo.row, cbtype: cbo.cbtype } as any);
        }
      }

      // Append override entries for deferred rows so backend records audit + skips posting
      deferredRows.forEach((row) => {
        allOverrides.push({ row, transaction_type: 'defer' } as any);
      });

      const selectedRowsArray = Array.from(selectedForImport);
      const dateOverridesList = Array.from(dateOverrides.entries()).map(([row, date]) => ({
        row,
        date
      }));

      const rejectedRefundRows = Array.from(refundOverrides.entries())
        .filter(([row, data]) => data.rejected && !selectedForImport.has(row))
        .map(([row]) => row);

      // Include per-row auto-allocate disabled flags
      const autoAllocateDisabledRows = Array.from(autoAllocateDisabled).filter(row => selectedRowsArray.includes(row));

      const emailResumeParam = resumeImportId ? `&resume_import_id=${resumeImportId}` : '';
      const url = `${API_BASE}/bank-import/import-from-email?email_id=${selectedEmailStatement.emailId}&attachment_id=${encodeURIComponent(selectedEmailStatement.attachmentId)}&bank_code=${selectedBankCode}&auto_allocate=${autoAllocate}&auto_reconcile=false${emailResumeParam}`;
      const response = await authFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          overrides: allOverrides,
          selected_rows: selectedRowsArray,
          date_overrides: dateOverridesList,
          rejected_refund_rows: rejectedRefundRows,
          skip_overlap_check: !!resumeImportId,
          auto_allocate_disabled_rows: autoAllocateDisabledRows
        })
      });
      if (!response.ok) {
        let errorMsg = `Server error (${response.status})`;
        try { const errData = await response.json(); errorMsg = errData.detail || errData.error || errorMsg; } catch { /* use default */ }
        throw new Error(errorMsg);
      }
      const data = await response.json();
      setBankImportResult(data);

      if (data.success) {
        const importedRowSet = new Set<number>((data.imported_transactions || []).map((t: any) => t.row as number));
        // Only remove imported rows from selections and overrides
        setSelectedForImport(prev => {
          const updated = new Set(prev);
          importedRowSet.forEach(r => updated.delete(r));
          return updated;
        });
        setEditedTransactions(prev => {
          const updated = new Map(prev);
          importedRowSet.forEach(r => updated.delete(r));
          return updated;
        });
        setTransactionTypeOverrides(prev => {
          const updated = new Map(prev);
          importedRowSet.forEach(r => updated.delete(r));
          return updated;
        });
        setDateOverrides(prev => {
          const updated = new Map(prev);
          importedRowSet.forEach(r => updated.delete(r));
          return updated;
        });
        setAutoAllocateDisabled(prev => {
          const updated = new Set(prev);
          importedRowSet.forEach(r => updated.delete(r));
          return updated;
        });
        setRefundOverrides(prev => {
          const updated = new Map(prev);
          importedRowSet.forEach(r => updated.delete(r));
          return updated;
        });
        setIncludedSkipped(prev => {
          const updated = new Map(prev);
          importedRowSet.forEach(r => updated.delete(r));
          return updated;
        });
        setDeferredRows(new Set());
        // Clear sessionStorage + backend draft so next visit gets fresh analysis
        // Suppress auto-save during refresh to prevent re-creating deleted draft
        draftSuppressedRef.current = true;
        clearPersistedState();
        deleteDraftForCurrentStatement();
        // Import is done — stop the spinner before async refresh
        setIsImporting(false);
        // Refresh email list to show updated processed state
        handleScanEmails();
        // Always show reconcile section to display imported transactions in statement order
        setShowReconcilePrompt(true);
        // Re-analyse the statement so imported items move to "In Opera" tab
        // and remaining items stay in their tabs with user edits preserved
        await handleRefreshPreview();
        // Re-enable auto-save for remaining items (partial import case)
        draftSuppressedRef.current = false;
        // Auto-scroll to import results so user sees outcome + reconcile prompt
        setTimeout(() => {
          importResultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 150);
      }
    } catch (error) {
      draftSuppressedRef.current = false;
      setBankImportResult({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    } finally {
      setIsImporting(false);
    }
  };

  const handleImport = async () => {
    setLoading(true);
    setResult(null);

    try {
      let endpoint = '';
      let body: any = {};

      switch (activeType) {
        case 'sales-receipt':
          endpoint = '/opera-sql/sales-receipt';
          body = {
            bank_account: bankAccount,
            customer_account: customerAccount,
            amount: parseFloat(receiptAmount),
            reference: reference,
            post_date: postDate,
            input_by: inputBy,
            validate_only: validateOnly
          };
          break;

        case 'purchase-payment':
          endpoint = '/opera-sql/purchase-payment';
          body = {
            bank_account: bankAccount,
            supplier_account: supplierAccount,
            amount: parseFloat(paymentAmount),
            reference: reference,
            post_date: postDate,
            input_by: inputBy,
            validate_only: validateOnly
          };
          break;

        case 'sales-invoice':
          endpoint = '/opera-sql/sales-invoice';
          body = {
            customer_account: customerAccount,
            invoice_number: invoiceNumber,
            net_amount: parseFloat(netAmount),
            vat_amount: parseFloat(vatAmount || '0'),
            post_date: postDate,
            nominal_account: nominalAccount,
            input_by: inputBy,
            description: description,
            validate_only: validateOnly
          };
          break;

        case 'purchase-invoice':
          endpoint = '/opera-sql/purchase-invoice';
          body = {
            supplier_account: supplierAccount,
            invoice_number: invoiceNumber,
            net_amount: parseFloat(netAmount),
            vat_amount: parseFloat(vatAmount || '0'),
            post_date: postDate,
            nominal_account: nominalAccount,
            input_by: inputBy,
            description: description,
            validate_only: validateOnly
          };
          break;

        case 'nominal-journal':
          endpoint = '/opera-sql/nominal-journal';
          body = {
            lines: journalLines
              .filter(l => l.account && l.amount)
              .map(l => ({
                account: l.account,
                amount: parseFloat(l.amount),
                description: l.description
              })),
            reference: reference,
            post_date: postDate,
            input_by: inputBy,
            description: description,
            validate_only: validateOnly
          };
          break;
      }

      const response = await authFetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      const data = await response.json();
      setResult(data);
    } catch (error) {
      setResult({
        success: false,
        validate_only: validateOnly,
        records_processed: 0,
        records_imported: 0,
        records_failed: 1,
        errors: [error instanceof Error ? error.message : 'Unknown error'],
        details: []
      });
    } finally {
      setLoading(false);
    }
  };

  const addJournalLine = () => {
    setJournalLines([...journalLines, { account: '', amount: '', description: '' }]);
  };

  const updateJournalLine = (index: number, field: string, value: string) => {
    const newLines = [...journalLines];
    newLines[index] = { ...newLines[index], [field]: value };
    setJournalLines(newLines);
  };

  const removeJournalLine = (index: number) => {
    if (journalLines.length > 2) {
      setJournalLines(journalLines.filter((_, i) => i !== index));
    }
  };

  const journalTotal = journalLines.reduce((sum, l) => sum + (parseFloat(l.amount) || 0), 0);

  const importTypes = [
    { id: 'bank-statement' as ImportType, label: 'Bank Statement Import', icon: Landmark, color: 'emerald' },
    { id: 'sales-receipt' as ImportType, label: 'Sales Receipt', icon: Receipt, color: 'green' },
    { id: 'purchase-payment' as ImportType, label: 'Purchase Payment', icon: CreditCard, color: 'red' },
    { id: 'sales-invoice' as ImportType, label: 'Sales Invoice', icon: FileText, color: 'blue' },
    { id: 'purchase-invoice' as ImportType, label: 'Purchase Invoice', icon: FileSpreadsheet, color: 'orange' },
    { id: 'nominal-journal' as ImportType, label: 'Nominal Journal', icon: BookOpen, color: 'purple' }
  ];

  // Handle ignoring a transaction (mark it so it won't appear in future reconciliations)
  const handleIgnoreTransaction = async () => {
    if (!ignoreConfirm || !selectedBankCode) {
      alert('Missing bank code or transaction details');
      return;
    }

    setIsIgnoring(true);
    try {
      const params = new URLSearchParams();
      params.append('transaction_date', ignoreConfirm.date);
      params.append('amount', ignoreConfirm.amount.toString());
      if (ignoreConfirm.description) {
        params.append('description', ignoreConfirm.description);
      }
      params.append('reason', 'Already entered in Opera');

      const url = `${API_BASE}/reconcile/bank/${encodeURIComponent(selectedBankCode)}/ignore-transaction?${params.toString()}`;
      console.log('Ignore transaction URL:', url);

      const response = await authFetch(url, { method: 'POST' });
      const data = await response.json();

      if (data.success) {
        // Mark this row as ignored
        setIgnoredTransactions(prev => new Set([...prev, ignoreConfirm.row]));
        // Also deselect it from import
        setSelectedForImport(prev => {
          const newSet = new Set(prev);
          newSet.delete(ignoreConfirm.row);
          return newSet;
        });
        setIgnoreConfirm(null);
      } else {
        alert(`Error: ${data.error || data.detail || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('Ignore transaction error:', error);
      alert(`Failed to ignore transaction: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsIgnoring(false);
    }
  };

  // Load ignored transactions from database and match them to current preview
  const loadIgnoredTransactions = async (preview: EnhancedBankImportPreview) => {
    if (!selectedBankCode) return;

    try {
      const response = await authFetch(`${API_BASE}/reconcile/bank/${encodeURIComponent(selectedBankCode)}/ignored-transactions?limit=500`);
      const data = await response.json();

      if (data.success && data.transactions) {
        // Get all transactions from the preview
        const allTxns = [
          ...(preview.matched_receipts || []),
          ...(preview.matched_payments || []),
          ...(preview.matched_refunds || []),
          ...(preview.unmatched || []),
          ...(preview.skipped || []),
        ];

        // Match ignored transactions by date, amount, and description
        const ignoredRows = new Set<number>();
        for (const ignoredTxn of data.transactions) {
          // Find matching transaction in preview
          const match = allTxns.find(t => {
            const txnDate = t.date.includes('T') ? t.date.split('T')[0] : t.date;
            const ignoredDate = ignoredTxn.transaction_date;
            const amountMatch = Math.abs(t.amount - ignoredTxn.amount) < 0.01;
            // Also check description if available for more precise matching
            const txnDesc = (t.name || t.reference || '').toLowerCase().replace(/[\n\r]/g, ' ').trim();
            const ignoredDesc = (ignoredTxn.description || '').toLowerCase().trim();
            // Description match: either both empty, or one contains the other (partial match)
            const descMatch = !ignoredDesc || !txnDesc ||
              txnDesc.includes(ignoredDesc) || ignoredDesc.includes(txnDesc);
            return txnDate === ignoredDate && amountMatch && descMatch;
          });
          if (match) {
            ignoredRows.add(match.row);
          }
        }

        if (ignoredRows.size > 0) {
          console.log(`Loaded ${ignoredRows.size} previously ignored transactions`);
          setIgnoredTransactions(ignoredRows);
          // Also remove them from selectedForImport
          setSelectedForImport(prev => {
            const newSet = new Set(prev);
            ignoredRows.forEach(row => newSet.delete(row));
            return newSet;
          });
        }
      }
    } catch (error) {
      console.error('Failed to load ignored transactions:', error);
    }
  };

  // Open ignore confirmation modal
  const openIgnoreConfirm = (txn: BankImportTransaction) => {
    // Extract just the date part (YYYY-MM-DD) if it contains a timestamp
    const dateOnly = txn.date.includes('T') ? txn.date.split('T')[0] : txn.date;
    // Clean description - remove newlines
    const cleanDescription = (txn.name || txn.reference || '').replace(/[\n\r]/g, ' ').trim();
    setIgnoreConfirm({
      row: txn.row,
      date: dateOnly,
      description: cleanDescription,
      amount: txn.amount
    });
  };

  // Open nominal detail modal when selecting nominal type
  const openNominalDetailModal = (txn: BankImportTransaction, txnType: TransactionType, source: 'unmatched' | 'refund' | 'skipped' | 'receipts' | 'payments') => {
    // Initialize form state from existing detail or defaults
    const existingDetail = nominalPostingDetails.get(txn.row);
    const grossAmount = Math.abs(txn.amount);
    setModalNominalCode(existingDetail?.nominalCode || '');
    // Initialize search with existing nominal display if editing
    const existingNominal = existingDetail?.nominalCode
      ? nominalAccounts.find(n => n.code === existingDetail.nominalCode)
      : null;
    setModalNominalSearch(existingNominal ? `${existingNominal.code} - ${existingNominal.description}` : '');
    setModalNominalDropdownOpen(false);
    // Default VAT code to N/A for nominal postings
    setModalVatCode(existingDetail?.vatCode || 'N/A');
    // Initialize VAT search
    const existingVat = existingDetail?.vatCode && existingDetail.vatCode !== 'N/A'
      ? vatCodes.find(v => v.code === existingDetail.vatCode)
      : null;
    setModalVatSearch(existingDetail?.vatCode && existingDetail.vatCode !== 'N/A' && existingVat
      ? `${existingVat.code} - ${existingVat.description} (${existingVat.rate}%)`
      : 'N/A');
    setModalVatDropdownOpen(false);
    setModalNetAmount(existingDetail?.netAmount?.toString() || grossAmount.toFixed(2));
    setModalVatAmount(existingDetail?.vatAmount?.toString() || '0.00');
    setModalProjectCode(existingDetail?.projectCode || '');
    setModalDepartmentCode(existingDetail?.departmentCode || '');

    setNominalDetailModal({
      open: true,
      transaction: txn,
      transactionType: txnType,
      source
    });
  };

  // Handle saving nominal detail from modal
  const handleSaveNominalDetail = (detail: NominalPostingDetail) => {
    if (!nominalDetailModal.transaction) return;

    const row = nominalDetailModal.transaction.row;
    const txn = nominalDetailModal.transaction;
    const source = nominalDetailModal.source;
    const txnType = nominalDetailModal.transactionType;

    // Save the nominal detail
    setNominalPostingDetails(prev => {
      const updated = new Map(prev);
      updated.set(row, detail);
      return updated;
    });

    // Also update the edited transaction with the nominal account
    if (source === 'unmatched' || source === 'receipts' || source === 'payments') {
      const updated = new Map(editedTransactions);
      updated.set(row, {
        ...txn,
        manual_account: detail.nominalCode,
        manual_ledger_type: 'S' as const, // N for nominal, but type doesn't have N
        account_name: detail.nominalDescription || '',
        isEdited: true,
        nominal_detail: detail
      });
      setEditedTransactions(updated);

      // Set transaction type override
      if (txnType) {
        setTransactionTypeOverrides(prev => {
          const updated = new Map(prev);
          updated.set(row, txnType);
          return updated;
        });
      }

      // Auto-select for import
      setSelectedForImport(prev => new Set(prev).add(row));
    } else if (source === 'refund') {
      // Update refund overrides
      setRefundOverrides(prev => {
        const updated = new Map(prev);
        const current = updated.get(row) || {};
        updated.set(row, {
          ...current,
          transaction_type: txnType || undefined,
          account: detail.nominalCode,
          ledger_type: 'S' as const
        });
        return updated;
      });
      setSelectedForImport(prev => new Set(prev).add(row));
    } else if (source === 'skipped') {
      // Update included skipped
      setIncludedSkipped(prev => {
        const updated = new Map(prev);
        updated.set(row, {
          account: detail.nominalCode,
          ledger_type: 'S' as const,
          transaction_type: txnType || 'nominal_receipt'
        });
        return updated;
      });
      setSelectedForImport(prev => new Set(prev).add(row));
    }

    // Check for similar unmatched transactions (by similarity_key) — nominal assignments
    if (source === 'unmatched' && txn.similarity_key && (txn.similar_count || 0) > 1 && bankPreview?.unmatched) {
      const similarItems = bankPreview.unmatched.filter((u: BankImportTransaction) =>
        u.similarity_key === txn.similarity_key &&
        u.row !== txn.row &&
        !editedTransactions.has(u.row)
      );
      if (similarItems.length > 0) {
        setApplyAllSimilar({
          show: true,
          similarityKey: txn.similarity_key,
          sourceRow: txn.row,
          count: similarItems.length,
          accountCode: detail.nominalCode,
          ledgerType: 'N',
          accountName: detail.nominalDescription || '',
          transactionType: txnType || undefined,
          nominalDetail: detail,
        });
      }
    }

    // Close modal
    setNominalDetailModal({ open: false, transaction: null, transactionType: null, source: 'unmatched' });
  };

  // Open bank transfer modal
  const openBankTransferModal = (txn: BankImportTransaction, source: 'unmatched' | 'refund' | 'skipped' | 'receipts' | 'payments') => {
    // Initialize form state from existing detail or defaults from transaction
    const existingDetail = bankTransferDetails.get(txn.row);
    setModalDestBank(existingDetail?.destBankCode || '');
    // Initialize bank search
    const existingBank = existingDetail?.destBankCode
      ? bankAccounts.find(b => b.code === existingDetail.destBankCode)
      : null;
    setModalDestBankSearch(existingBank ? `${existingBank.code} - ${existingBank.description}` : '');
    setModalDestBankDropdownOpen(false);
    setModalCashbookType(existingDetail?.cashbookType || 'TRF');
    setModalReference(existingDetail?.reference || txn.name?.substring(0, 20) || '');
    setModalComment(existingDetail?.comment || txn.name || '');
    setModalDate(existingDetail?.date || txn.date || '');

    setBankTransferModal({ open: true, transaction: txn, source });
  };

  // Handle saving bank transfer detail
  const handleSaveBankTransfer = () => {
    if (!bankTransferModal.transaction) return;

    const row = bankTransferModal.transaction.row;
    const txn = bankTransferModal.transaction;
    const source = bankTransferModal.source;
    // Defensive: if modalDestBank wasn't set via dropdown selection
    // but modalDestBankSearch exact-matches a bank code (operator
    // paste / autofill / browser autocomplete that bypassed
    // onChange), resolve it here at save time. Same rule as the
    // input's onChange handler.
    let destBankCode = modalDestBank;
    if (!destBankCode && modalDestBankSearch) {
      const trimmed = modalDestBankSearch.trim().toUpperCase();
      const exactMatch = bankAccounts.find(
        (b) =>
          b.code.toUpperCase() === trimmed && b.code !== selectedBankCode,
      );
      if (exactMatch) destBankCode = exactMatch.code;
    }
    const destBankName = bankAccounts.find(b => b.code === destBankCode)?.description || '';

    // Save the bank transfer detail with all fields
    setBankTransferDetails(prev => {
      const updated = new Map(prev);
      updated.set(row, {
        destBankCode,
        destBankName,
        cashbookType: modalCashbookType,
        reference: modalReference,
        comment: modalComment,
        date: modalDate
      });
      return updated;
    });

    // Update the appropriate state based on source
    if (source === 'unmatched' || source === 'receipts' || source === 'payments') {
      const updated = new Map(editedTransactions);
      updated.set(row, {
        ...txn,
        manual_account: destBankCode,
        manual_ledger_type: 'S' as const,
        account_name: destBankName,
        isEdited: true
      });
      setEditedTransactions(updated);

      // Set transaction type override
      setTransactionTypeOverrides(prev => {
        const updated = new Map(prev);
        updated.set(row, 'bank_transfer');
        return updated;
      });

      setSelectedForImport(prev => new Set(prev).add(row));
    } else if (source === 'refund') {
      setRefundOverrides(prev => {
        const updated = new Map(prev);
        const current = updated.get(row) || {};
        updated.set(row, {
          ...current,
          transaction_type: 'bank_transfer',
          account: destBankCode,
          ledger_type: 'S' as const
        });
        return updated;
      });
      setSelectedForImport(prev => new Set(prev).add(row));
    } else if (source === 'skipped') {
      setIncludedSkipped(prev => {
        const updated = new Map(prev);
        updated.set(row, {
          account: destBankCode,
          ledger_type: 'S' as const,
          transaction_type: 'bank_transfer'
        });
        return updated;
      });
      setSelectedForImport(prev => new Set(prev).add(row));
    }

    setBankTransferModal({ open: false, transaction: null, source: 'unmatched' });
  };

  // Render Bank Transfer Modal
  const renderBankTransferModal = () => {
    if (!bankTransferModal.open || !bankTransferModal.transaction) return null;

    const txn = bankTransferModal.transaction;
    const amount = txn.amount;
    const isOutgoing = amount < 0;

    // Use component-level state (initialized in openBankTransferModal)
    const selectedDestBank = bankAccounts.find(b => b.code === modalDestBank);
    const canSave = !!modalDestBank && !!modalReference && !!modalDate;

    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm-xl w-full max-w-md mx-4 max-h-[90vh] overflow-y-auto">
          {/* Header */}
          <div className={`px-6 py-4 border-b ${isOutgoing ? 'bg-red-50 border-red-200' : 'bg-green-50 border-green-200'}`}>
            <div className="flex justify-between items-center">
              <h3 className={`text-lg font-semibold ${isOutgoing ? 'text-red-800' : 'text-green-800'}`}>
                Bank Transfer {isOutgoing ? 'Out' : 'In'}
              </h3>
              <button
                onClick={() => setBankTransferModal({ open: false, transaction: null, source: 'unmatched' })}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="mt-2 text-sm text-gray-600">
              <div className="flex justify-between">
                <span>{txn.name}</span>
                <span className={`font-medium ${isOutgoing ? 'text-red-700' : 'text-green-700'}`}>
                  {isOutgoing ? '-' : '+'}£{Math.abs(amount).toFixed(2)}
                </span>
              </div>
              <div className="text-xs text-gray-500 mt-1">{txn.date}</div>
            </div>
          </div>

          {/* Form */}
          <div className="px-6 py-4 space-y-4">
            {/* Transfer direction explanation */}
            <div className={`p-3 rounded ${isOutgoing ? 'bg-red-50' : 'bg-green-50'}`}>
              <div className="flex items-center gap-2 text-sm">
                <Landmark className={`h-4 w-4 ${isOutgoing ? 'text-red-600' : 'text-green-600'}`} />
                <span className={isOutgoing ? 'text-red-700' : 'text-green-700'}>
                  {isOutgoing
                    ? `Transferring FROM ${selectedBankCode} TO another bank`
                    : `Transferring INTO ${selectedBankCode} FROM another bank`
                  }
                </span>
              </div>
            </div>

            {/* Header fields row */}
            <div className="grid grid-cols-2 gap-4">
              {/* Cashbook Type */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Cashbook Type <span className="text-red-500">*</span>
                </label>
                <select
                  value={modalCashbookType}
                  onChange={(e) => setModalCashbookType(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="TRF">TRF - Transfer</option>
                  <option value="CHQ">CHQ - Cheque</option>
                  <option value="CSH">CSH - Cash</option>
                  <option value="DDR">DDR - Direct Debit</option>
                  <option value="BGC">BGC - Bank Giro Credit</option>
                  <option value="STO">STO - Standing Order</option>
                </select>
              </div>

              {/* Date */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Date <span className="text-red-500">*</span>
                </label>
                <input
                  type="date"
                  value={modalDate}
                  onChange={(e) => setModalDate(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>

            {/* Reference */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Reference <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={modalReference}
                onChange={(e) => setModalReference(e.target.value)}
                maxLength={20}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="Max 20 characters"
              />
            </div>

            {/* Comment */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Comment
              </label>
              <input
                type="text"
                value={modalComment}
                onChange={(e) => setModalComment(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="Description/memo"
              />
            </div>

            {/* Destination/Source Bank - Searchable */}
            {(() => {
              const filteredDestBanks = bankAccounts
                .filter(b => b.code !== selectedBankCode)
                .filter(b => {
                  if (!modalDestBankSearch) return true;
                  const search = modalDestBankSearch.toLowerCase();
                  return b.code.toLowerCase().includes(search) ||
                         b.description.toLowerCase().includes(search) ||
                         (b.sort_code && b.sort_code.includes(search)) ||
                         (b.account_number && b.account_number.includes(search));
                });
              return (
            <div className="relative">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {isOutgoing ? 'Destination Bank' : 'Source Bank'} <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={modalDestBankSearch}
                onChange={(e) => {
                  const v = e.target.value;
                  setModalDestBankSearch(v);
                  setModalDestBankDropdownOpen(true);
                  setModalDestBankHighlightIndex(0);
                  // Auto-resolve when the typed text exactly matches a
                  // bank code (case-insensitive). Without this, the
                  // operator typing "BB010" sees the summary stay at
                  // "?" because `modalDestBank` only gets set when
                  // they click/Enter/Tab on a dropdown option.
                  const trimmed = v.trim().toUpperCase();
                  const exactMatch = bankAccounts.find(
                    (b) =>
                      b.code.toUpperCase() === trimmed &&
                      b.code !== selectedBankCode,
                  );
                  if (exactMatch) {
                    setModalDestBank(exactMatch.code);
                  } else if (modalDestBank) {
                    // Edits that no longer exact-match clear the
                    // selection (existing behaviour).
                    setModalDestBank('');
                  }
                }}
                onFocus={() => {
                  setModalDestBankDropdownOpen(true);
                  setModalDestBankHighlightIndex(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    if (!modalDestBankDropdownOpen) {
                      setModalDestBankDropdownOpen(true);
                    } else {
                      setModalDestBankHighlightIndex(prev => Math.min(prev + 1, filteredDestBanks.length - 1));
                    }
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setModalDestBankHighlightIndex(prev => Math.max(prev - 1, 0));
                  } else if (e.key === 'Enter' && modalDestBankDropdownOpen && filteredDestBanks.length > 0) {
                    e.preventDefault();
                    const selected = filteredDestBanks[modalDestBankHighlightIndex];
                    if (selected) {
                      setModalDestBank(selected.code);
                      setModalDestBankSearch(`${selected.code} - ${selected.description}`);
                      setModalDestBankDropdownOpen(false);
                      // Auto-focus Save button after selection
                      setTimeout(() => modalBankTransferSaveRef.current?.focus(), 50);
                    }
                  } else if (e.key === 'Escape') {
                    setModalDestBankDropdownOpen(false);
                  } else if (e.key === 'Tab' && modalDestBankDropdownOpen && filteredDestBanks.length > 0) {
                    // Select highlighted item on Tab, then let normal tab behavior move focus
                    const selected = filteredDestBanks[modalDestBankHighlightIndex];
                    if (selected) {
                      setModalDestBank(selected.code);
                      setModalDestBankSearch(`${selected.code} - ${selected.description}`);
                    }
                    setModalDestBankDropdownOpen(false);
                  } else if (e.key === 'Tab') {
                    setModalDestBankDropdownOpen(false);
                  }
                }}
                placeholder="Search by code, name or sort code..."
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                ref={modalDestBankInputRef}
              />
              {modalDestBankDropdownOpen && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setModalDestBankDropdownOpen(false)}
                  />
                  <div className="absolute z-[60] w-full mt-1 bg-white border border-gray-300 rounded-md shadow-lg max-h-48 overflow-y-auto" style={{ bottom: '100%', marginBottom: '4px', marginTop: 0 }}>
                    {filteredDestBanks.map((b, idx) => (
                        <button
                          key={b.code}
                          type="button"
                          onClick={() => {
                            setModalDestBank(b.code);
                            setModalDestBankSearch(`${b.code} - ${b.description}`);
                            setModalDestBankDropdownOpen(false);
                          }}
                          className={`w-full text-left px-3 py-2 text-sm ${
                            idx === modalDestBankHighlightIndex ? 'bg-blue-100' : 'hover:bg-blue-50'
                          } ${modalDestBank === b.code ? 'text-blue-800' : ''}`}
                        >
                          <div>
                            <span className="font-medium">{b.code}</span>
                            <span className="text-gray-600"> - {b.description}</span>
                          </div>
                          {b.sort_code && (
                            <div className="text-xs text-gray-500">
                              Sort: {b.sort_code} {b.account_number && `| Acc: ${b.account_number}`}
                            </div>
                          )}
                        </button>
                      ))}
                    {filteredDestBanks.length === 0 && (
                      <div className="px-3 py-2 text-sm text-gray-500">No matching bank accounts found</div>
                    )}
                  </div>
                </>
              )}
              {selectedDestBank && (
                <div className="mt-2 text-xs text-gray-500">
                  {selectedDestBank.sort_code && <span>Sort: {selectedDestBank.sort_code} </span>}
                  {selectedDestBank.account_number && <span>Acc: {selectedDestBank.account_number}</span>}
                </div>
              )}
            </div>
              );
            })()}

            {/* Summary */}
            <div className="pt-2 border-t border-gray-200">
              <div className="flex justify-between items-center text-sm">
                <span className="text-gray-600">From:</span>
                <span className="font-medium">{isOutgoing ? selectedBankCode : modalDestBank || '?'}</span>
              </div>
              <div className="flex justify-between items-center text-sm mt-1">
                <span className="text-gray-600">To:</span>
                <span className="font-medium">{isOutgoing ? modalDestBank || '?' : selectedBankCode}</span>
              </div>
              <div className="flex justify-between items-center mt-2">
                <span className="text-gray-600">Amount:</span>
                <span className="text-lg font-bold text-blue-600">£{Math.abs(amount).toFixed(2)}</span>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 flex justify-end gap-3">
            <button
              onClick={() => setBankTransferModal({ open: false, transaction: null, source: 'unmatched' })}
              className="px-4 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              ref={modalBankTransferSaveRef}
              onClick={() => handleSaveBankTransfer()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSave) {
                  e.preventDefault();
                  handleSaveBankTransfer();
                }
              }}
              disabled={!canSave}
              className={`px-4 py-2 text-sm text-white rounded-md ${
                canSave
                  ? 'bg-blue-600 hover:bg-blue-700 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2'
                  : 'bg-gray-300 cursor-not-allowed'
              }`}
            >
              Save & Include
            </button>
          </div>
        </div>
      </div>
    );
  };

  // Render the Nominal Detail Modal
  const renderNominalDetailModal = () => {
    if (!nominalDetailModal.open || !nominalDetailModal.transaction) return null;

    const txn = nominalDetailModal.transaction;
    const grossAmount = Math.abs(txn.amount);
    const isReceipt = nominalDetailModal.transactionType === 'nominal_receipt';

    // Use component-level state (initialized in openNominalDetailModal)
    const selectedVat = vatCodes.find(v => v.code === modalVatCode);
    const vatRate = selectedVat?.rate || 0;

    // Calculate VAT by extracting from gross (bank statement amount) when VAT code changes
    const handleVatCodeChange = (code: string) => {
      setModalVatCode(code);
      // N/A means no VAT applicable - reset to gross with zero VAT
      if (code === 'N/A') {
        setModalNetAmount(grossAmount.toFixed(2));
        setModalVatAmount('0.00');
        return;
      }
      const vat = vatCodes.find(v => v.code === code);
      if (vat && vat.rate > 0) {
        // Extract VAT from gross: vat = gross * rate / (100 + rate)
        const vatAmt = grossAmount * vat.rate / (100 + vat.rate);
        const netAmt = grossAmount - vatAmt;
        setModalNetAmount(netAmt.toFixed(2));
        setModalVatAmount(vatAmt.toFixed(2));
      } else {
        setModalNetAmount(grossAmount.toFixed(2));
        setModalVatAmount('0.00');
      }
    };

    // Recalculate VAT when net amount is manually edited (VAT = gross - net)
    const handleNetAmountChange = (value: string) => {
      setModalNetAmount(value);
      const net = parseFloat(value) || 0;
      // VAT is the remainder: gross - net
      const vatAmt = Math.max(0, grossAmount - net);
      setModalVatAmount(vatAmt.toFixed(2));
    };

    // Calculate net from gross (reverse VAT calculation)
    const calculateNetFromGross = () => {
      if (selectedVat) {
        const net = grossAmount / (1 + selectedVat.rate / 100);
        setModalNetAmount(net.toFixed(2));
        setModalVatAmount((grossAmount - net).toFixed(2));
      }
    };

    const calculatedGross = (parseFloat(modalNetAmount) || 0) + (parseFloat(modalVatAmount) || 0);
    const nominalDesc = nominalAccounts.find(n => n.code === modalNominalCode)?.description || '';

    const selectedNominalForModal = nominalAccounts.find(n => n.code === modalNominalCode);
    // Opera values: 1=Do Not Use, 2=Optional, 3=Mandatory
    const showModalProject = advNomConfig.project_enabled && selectedNominalForModal && (selectedNominalForModal.allow_project || 0) > 1;
    const showModalDept = advNomConfig.department_enabled && selectedNominalForModal && (selectedNominalForModal.allow_department || 0) > 1;
    const modalProjectRequired = (selectedNominalForModal?.allow_project || 0) === 3;
    const modalDeptRequired = (selectedNominalForModal?.allow_department || 0) === 3;
    const canSave = modalNominalCode && modalVatCode && parseFloat(modalNetAmount) > 0
      && !(advNomConfig.project_enabled && modalProjectRequired && !modalProjectCode)
      && !(advNomConfig.department_enabled && modalDeptRequired && !modalDepartmentCode);

    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm-xl w-full max-w-lg mx-4">
          {/* Header */}
          <div className={`px-6 py-4 border-b ${isReceipt ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
            <div className="flex justify-between items-center">
              <h3 className={`text-lg font-semibold ${isReceipt ? 'text-green-800' : 'text-red-800'}`}>
                {isReceipt ? 'Nominal Receipt' : 'Nominal Payment'} Details
              </h3>
              <button
                onClick={() => setNominalDetailModal({ open: false, transaction: null, transactionType: null, source: 'unmatched' })}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="mt-2 text-sm text-gray-600">
              <div className="flex justify-between">
                <span>{txn.name}</span>
                <span className={`font-medium ${isReceipt ? 'text-green-700' : 'text-red-700'}`}>
                  £{grossAmount.toFixed(2)}
                </span>
              </div>
              <div className="text-xs text-gray-500 mt-1">{txn.date}</div>
            </div>
          </div>

          {/* Form */}
          <div className="px-6 py-4 space-y-4">
            {/* Nominal Account - Searchable */}
            {(() => {
              const filteredNominals = nominalAccounts
                .filter(n => {
                  if (!modalNominalSearch) return true;
                  const search = modalNominalSearch.toLowerCase();
                  return n.code.toLowerCase().includes(search) ||
                         n.description.toLowerCase().includes(search);
                })
                .slice(0, 50);
              return (
            <div className="relative">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Nominal Account <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={modalNominalSearch}
                onChange={(e) => {
                  setModalNominalSearch(e.target.value);
                  setModalNominalDropdownOpen(true);
                  setModalNominalHighlightIndex(0);
                  // Clear selection if user edits the text
                  if (modalNominalCode) {
                    const selected = nominalAccounts.find(n => n.code === modalNominalCode);
                    if (selected && e.target.value !== `${selected.code} - ${selected.description}`) {
                      setModalNominalCode('');
                    }
                  }
                }}
                onFocus={() => {
                  setModalNominalDropdownOpen(true);
                  setModalNominalHighlightIndex(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    if (!modalNominalDropdownOpen) {
                      setModalNominalDropdownOpen(true);
                    } else {
                      setModalNominalHighlightIndex(prev => Math.min(prev + 1, filteredNominals.length - 1));
                    }
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setModalNominalHighlightIndex(prev => Math.max(prev - 1, 0));
                  } else if (e.key === 'Enter' && modalNominalDropdownOpen && filteredNominals.length > 0) {
                    e.preventDefault();
                    const selected = filteredNominals[modalNominalHighlightIndex];
                    if (selected) {
                      setModalNominalCode(selected.code);
                      setModalNominalSearch(`${selected.code} - ${selected.description}`);
                      setModalNominalDropdownOpen(false);
                      // Auto-fill project/department defaults from nominal account
                      setModalProjectCode(selected.default_project?.trim() || '');
                      setModalDepartmentCode(selected.default_department?.trim() || '');
                      // Auto-focus next field (VAT code)
                      setTimeout(() => modalVatInputRef.current?.focus(), 50);
                    }
                  } else if (e.key === 'Escape') {
                    setModalNominalDropdownOpen(false);
                  } else if (e.key === 'Tab' && modalNominalDropdownOpen && filteredNominals.length > 0) {
                    // Select highlighted item on Tab, then let normal tab behavior move focus
                    const selected = filteredNominals[modalNominalHighlightIndex];
                    if (selected) {
                      setModalNominalCode(selected.code);
                      setModalNominalSearch(`${selected.code} - ${selected.description}`);
                      setModalProjectCode(selected.default_project?.trim() || '');
                      setModalDepartmentCode(selected.default_department?.trim() || '');
                    }
                    setModalNominalDropdownOpen(false);
                  } else if (e.key === 'Tab') {
                    setModalNominalDropdownOpen(false);
                  }
                }}
                placeholder="Search by code or description..."
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                autoFocus
                tabIndex={1}
              />
              {modalNominalDropdownOpen && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setModalNominalDropdownOpen(false)}
                  />
                  <div className="absolute z-50 w-full mt-1 bg-white border border-gray-300 rounded-md shadow-lg max-h-60 overflow-y-auto">
                    {filteredNominals.map((n, idx) => (
                        <button
                          key={n.code}
                          type="button"
                          onClick={() => {
                            setModalNominalCode(n.code);
                            setModalNominalSearch(`${n.code} - ${n.description}`);
                            setModalNominalDropdownOpen(false);
                            // Auto-fill project/department defaults from nominal account
                            setModalProjectCode(n.default_project?.trim() || '');
                            setModalDepartmentCode(n.default_department?.trim() || '');
                          }}
                          className={`w-full text-left px-3 py-2 text-sm ${
                            idx === modalNominalHighlightIndex ? 'bg-blue-100' : 'hover:bg-blue-50'
                          } ${modalNominalCode === n.code ? 'text-blue-800' : ''}`}
                        >
                          <span className="font-medium">{n.code}</span>
                          <span className="text-gray-600"> - {n.description}</span>
                        </button>
                      ))}
                    {filteredNominals.length === 0 && (
                      <div className="px-3 py-2 text-sm text-gray-500">No matching accounts found</div>
                    )}
                  </div>
                </>
              )}
            </div>
              );
            })()}

            {/* VAT Code - Searchable */}
            {(() => {
              // Include N/A as first option if it matches search
              const showNa = !modalVatSearch || 'n/a'.includes(modalVatSearch.toLowerCase());
              const filteredVatCodes = vatCodes.filter(v => {
                if (!modalVatSearch) return true;
                const search = modalVatSearch.toLowerCase();
                return v.code.toLowerCase().includes(search) ||
                       v.description.toLowerCase().includes(search);
              });
              // Build combined list for keyboard navigation (N/A first if shown, then VAT codes)
              const allOptions: Array<{ code: string; label: string; isNa?: boolean }> = [];
              if (showNa) {
                allOptions.push({ code: 'N/A', label: 'N/A - No VAT applicable', isNa: true });
              }
              filteredVatCodes.forEach(v => {
                allOptions.push({ code: v.code, label: `${v.code} - ${v.description} (${v.rate}%)` });
              });
              return (
            <div className="relative">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                VAT Code <span className="text-red-500">*</span>
              </label>
              <input
                ref={modalVatInputRef}
                type="text"
                value={modalVatSearch}
                onChange={(e) => {
                  setModalVatSearch(e.target.value);
                  setModalVatDropdownOpen(true);
                  setModalVatHighlightIndex(0);
                  // Clear selection if user edits the text
                  if (modalVatCode) {
                    setModalVatCode('');
                  }
                }}
                onFocus={(e) => {
                  e.target.select();
                  setModalVatDropdownOpen(true);
                  setModalVatHighlightIndex(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    if (!modalVatDropdownOpen) {
                      setModalVatDropdownOpen(true);
                    } else {
                      setModalVatHighlightIndex(prev => Math.min(prev + 1, allOptions.length - 1));
                    }
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setModalVatHighlightIndex(prev => Math.max(prev - 1, 0));
                  } else if (e.key === 'Enter' && modalVatDropdownOpen && allOptions.length > 0) {
                    e.preventDefault();
                    const selected = allOptions[modalVatHighlightIndex];
                    if (selected) {
                      handleVatCodeChange(selected.code);
                      setModalVatSearch(selected.label);
                      setModalVatDropdownOpen(false);
                      // Auto-focus next field (Net Amount)
                      setTimeout(() => modalNetAmountRef.current?.focus(), 50);
                    }
                  } else if (e.key === 'Escape') {
                    setModalVatDropdownOpen(false);
                  } else if (e.key === 'Tab' && modalVatDropdownOpen && allOptions.length > 0) {
                    // Select highlighted item on Tab, then let normal tab behavior move focus
                    const selected = allOptions[modalVatHighlightIndex];
                    if (selected) {
                      handleVatCodeChange(selected.code);
                      setModalVatSearch(selected.label);
                    }
                    setModalVatDropdownOpen(false);
                  } else if (e.key === 'Tab') {
                    setModalVatDropdownOpen(false);
                  }
                }}
                placeholder="Search by code or description..."
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                tabIndex={2}
              />
              {modalVatDropdownOpen && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setModalVatDropdownOpen(false)}
                  />
                  <div className="absolute z-50 w-full mt-1 bg-white border border-gray-300 rounded-md shadow-lg max-h-60 overflow-y-auto">
                    {allOptions.map((opt, idx) => (
                      <button
                        key={opt.code}
                        type="button"
                        onClick={() => {
                          handleVatCodeChange(opt.code);
                          setModalVatSearch(opt.label);
                          setModalVatDropdownOpen(false);
                        }}
                        className={`w-full text-left px-3 py-2 text-sm ${
                          idx === modalVatHighlightIndex ? 'bg-blue-100' : 'hover:bg-blue-50'
                        } ${modalVatCode === opt.code ? 'text-blue-800' : ''}`}
                      >
                        <span className="font-medium">{opt.code}</span>
                        <span className="text-gray-600"> - {opt.isNa ? 'No VAT applicable' : opt.label.split(' - ')[1]}</span>
                      </button>
                    ))}
                    {allOptions.length === 0 && (
                      <div className="px-3 py-2 text-sm text-gray-500">No matching VAT codes found</div>
                    )}
                  </div>
                </>
              )}
            </div>
              );
            })()}

            {/* Net Amount */}
            <div className="flex gap-4">
              <div className="flex-1">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Net Amount <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-2 text-gray-500">£</span>
                  <input
                    ref={modalNetAmountRef}
                    type="number"
                    step="0.01"
                    value={modalNetAmount}
                    onChange={(e) => handleNetAmountChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        // Focus Save button when pressing Enter on Net Amount
                        modalSaveButtonRef.current?.focus();
                      }
                    }}
                    className="w-full pl-7 pr-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    tabIndex={3}
                  />
                </div>
              </div>

              <div className="flex-1">
                <label className={`block text-sm font-medium mb-1 ${modalVatCode === 'N/A' ? 'text-gray-400' : 'text-gray-700'}`}>
                  VAT Amount
                </label>
                <div className="relative">
                  <span className={`absolute left-3 top-2 ${modalVatCode === 'N/A' ? 'text-gray-300' : 'text-gray-500'}`}>£</span>
                  <input
                    type="number"
                    step="0.01"
                    value={modalVatAmount}
                    onChange={(e) => setModalVatAmount(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        modalSaveButtonRef.current?.focus();
                      }
                    }}
                    disabled={modalVatCode === 'N/A'}
                    className={`w-full pl-7 pr-3 py-2 border rounded-md ${
                      modalVatCode === 'N/A'
                        ? 'bg-gray-100 border-gray-200 text-gray-400 cursor-not-allowed'
                        : 'border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-blue-500'
                    }`}
                    tabIndex={4}
                  />
                </div>
              </div>
            </div>

            {/* Quick calc button */}
            {selectedVat && selectedVat.rate > 0 && (
              <button
                type="button"
                onClick={calculateNetFromGross}
                className="text-sm text-blue-600 hover:text-blue-800 underline"
              >
                Calculate net from gross (£{grossAmount.toFixed(2)} @ {selectedVat.rate}% VAT)
              </button>
            )}

            {/* Project/Department (conditional on config + nominal account settings) */}
            {(showModalProject || showModalDept) && (
              <div className="space-y-3 pt-2 border-t border-gray-200">
                {showModalProject && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {advNomConfig.project_label}{modalProjectRequired && <span className="text-red-500 ml-1">*</span>}
                    </label>
                    <select
                      value={modalProjectCode}
                      onChange={e => setModalProjectCode(e.target.value)}
                      className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                    >
                      <option value="">{modalProjectRequired ? `Select ${advNomConfig.project_label.toLowerCase()} (required)...` : `No ${advNomConfig.project_label.toLowerCase()}`}</option>
                      {projectCodes.map(p => (
                        <option key={p.code} value={p.code}>{p.code} - {p.description}</option>
                      ))}
                    </select>
                  </div>
                )}
                {showModalDept && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {advNomConfig.department_label}{modalDeptRequired && <span className="text-red-500 ml-1">*</span>}
                    </label>
                    <select
                      value={modalDepartmentCode}
                      onChange={e => setModalDepartmentCode(e.target.value)}
                      className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                    >
                      <option value="">{modalDeptRequired ? `Select ${advNomConfig.department_label.toLowerCase()} (required)...` : `No ${advNomConfig.department_label.toLowerCase()}`}</option>
                      {departmentCodes.map(d => (
                        <option key={d.code} value={d.code}>{d.code} - {d.description}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}

            {/* Gross total */}
            <div className="flex justify-between items-center pt-2 border-t border-gray-200">
              <span className="text-sm font-medium text-gray-600">Gross Total:</span>
              <span className={`text-lg font-bold ${
                Math.abs(calculatedGross - grossAmount) < 0.01 ? 'text-green-600' : 'text-orange-600'
              }`}>
                £{calculatedGross.toFixed(2)}
                {Math.abs(calculatedGross - grossAmount) >= 0.01 && (
                  <span className="text-xs font-normal ml-2 text-orange-500">
                    (Txn: £{grossAmount.toFixed(2)})
                  </span>
                )}
              </span>
            </div>
          </div>

          {/* Footer */}
          <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 flex justify-end gap-3">
            <button
              onClick={() => setNominalDetailModal({ open: false, transaction: null, transactionType: null, source: 'unmatched' })}
              className="px-4 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
              tabIndex={6}
            >
              Cancel
            </button>
            <button
              ref={modalSaveButtonRef}
              disabled={!canSave}
              onClick={() => canSave && handleSaveNominalDetail({
                nominalCode: modalNominalCode,
                nominalDescription: nominalDesc,
                vatCode: modalVatCode,
                vatRate: vatRate,
                netAmount: parseFloat(modalNetAmount) || 0,
                vatAmount: parseFloat(modalVatAmount) || 0,
                grossAmount: calculatedGross,
                projectCode: modalProjectCode || undefined,
                departmentCode: modalDepartmentCode || undefined,
              })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSave) {
                  e.preventDefault();
                  handleSaveNominalDetail({
                    nominalCode: modalNominalCode,
                    nominalDescription: nominalDesc,
                    vatCode: modalVatCode,
                    vatRate: vatRate,
                    netAmount: parseFloat(modalNetAmount) || 0,
                    vatAmount: parseFloat(modalVatAmount) || 0,
                    grossAmount: calculatedGross,
                    projectCode: modalProjectCode || undefined,
                    departmentCode: modalDepartmentCode || undefined,
                  });
                }
              }}
              className={`px-4 py-2 text-sm text-white rounded-md ${
                canSave
                  ? 'bg-blue-600 hover:bg-blue-700 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2'
                  : 'bg-gray-300 cursor-not-allowed'
              }`}
              tabIndex={5}
            >
              Save & Include
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Nominal Detail Modal */}
      {renderNominalDetailModal()}
      {/* Bank Transfer Modal */}
      {renderBankTransferModal()}

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center">
          <Landmark className="h-5 w-5 text-blue-600" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-gray-900">
            {bankRecOnly ? (initialStatement ? 'Bank Statement Processing' : 'Bank Statement Import') : 'Imports'}
            <span className="ml-2 text-xs font-medium text-gray-400">
              Live Version {LIVE_VERSION}
            </span>
          </h1>
          <p className="text-sm text-gray-500">{initialStatement ? 'Review and import transactions from the selected statement' : 'Import and reconcile bank statement transactions'}</p>
        </div>
      </div>

      {/* Warning: Reconciliation in progress in Opera.
          When sequential_gating is true, the partial markers belong to a prior
          statement awaiting a deferred-row resolution. We render an amber
          informational banner with one of two headings:
            - sequential_gating_self === true  → user is on THE deferred-row
                statement → "Awaiting deferred row resolution"
            - sequential_gating_self === false → user is on a SUBSEQUENT
                statement → "Reconciliation will wait on prior statement"
          Genuinely-abandoned reconciliations still get the red alarming banner. */}
      {reconciliationStatus?.reconciliation_in_progress && (
        reconciliationStatus.sequential_gating ? (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-amber-800">
                {reconciliationStatus.sequential_gating_self
                  ? 'Awaiting deferred row resolution'
                  : 'Reconciliation will wait on prior statement'}
              </h3>
              <p className="text-sm text-amber-700 mt-0.5">
                {reconciliationStatus.reconciliation_in_progress_message}
              </p>
            </div>
          </div>
        ) : (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-red-800">Reconciliation In Progress in Opera</h3>
              <p className="text-sm text-red-700 mt-0.5">
                {reconciliationStatus.reconciliation_in_progress_message ||
                 `There are ${reconciliationStatus.partial_entries || 0} entries marked as reconciled but not yet posted in Opera. Please complete or clear the reconciliation in Opera before importing new statements.`}
              </p>
            </div>
          </div>
        )
      )}

      {/* Import Type Selector - hidden in bankRecOnly mode */}
      {!bankRecOnly && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
          <div className="flex flex-wrap gap-2">
            {importTypes.map(type => {
              const Icon = type.icon;
              const isActive = activeType === type.id;
              return (
                <button
                  key={type.id}
                  onClick={() => { setActiveType(type.id); resetForm(); }}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
                    isActive
                      ? `bg-${type.color}-100 text-${type.color}-700 border-2 border-${type.color}-500`
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200 border-2 border-transparent'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {type.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Bank Statement Import Form */}
      {activeType === 'bank-statement' && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            {initialStatement ? 'Bank Statement Processing' : 'Bank Statement Import'}
          </h2>


          <div className="space-y-6">
            {/* Selected statement info (when coming from Hub) */}
            {initialStatement && (
              <div className="p-4 bg-blue-50 border-2 border-blue-300 rounded-lg">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-blue-600 rounded-full flex items-center justify-center flex-shrink-0">
                    <FileText className="w-5 h-5 text-white" />
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-blue-900">{initialStatement.filename}</h3>
                    <div className="flex items-center gap-4 text-sm text-blue-700 mt-0.5">
                      <span>Bank: <strong>{initialStatement.bankCode}{initialStatement.bankDescription ? ` - ${initialStatement.bankDescription}` : ''}</strong></span>
                      <span>Source: <strong>{initialStatement.source === 'email' ? 'Email' : 'PDF Upload'}</strong></span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Data source indicator - hidden when statement pre-selected */}
            {!initialStatement && (
            <div className="flex items-center gap-2 p-3 bg-gray-50 rounded-lg">
              <span className="text-sm font-medium text-gray-700">Data Source:</span>
              <span className="text-sm font-semibold text-blue-700">
                {dataSource === 'opera-sql' ? 'Opera SQL SE' : 'Opera 3 (FoxPro)'}
              </span>
              <span className="text-xs text-gray-500">(configured in Settings)</span>
            </div>
            )}

            {/* Action bar - hidden when statement pre-selected */}
            {!initialStatement && (
            <div className="flex items-center justify-end gap-2 p-3 bg-gray-50 border border-gray-200 rounded-lg">
              {/* History Button */}
              <button
                onClick={() => setShowImportHistory(true)}
                className="px-4 py-1.5 rounded-md text-sm font-medium bg-gray-100 text-gray-700 border border-gray-300 hover:bg-gray-200 flex items-center gap-2"
              >
                <History className="h-4 w-4" />
                View History
              </button>
              {/* Clear Statement Button - only show when there's a statement loaded */}
              {(bankPreview || bankImportResult) && (
                <button
                  onClick={() => setShowClearStatementConfirm(true)}
                  className="px-4 py-1.5 rounded-md text-sm font-medium bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 flex items-center gap-2"
                  title="Clear statement and start fresh"
                >
                  <RotateCcw className="h-4 w-4" />
                  Clear Statement
                </button>
              )}
            </div>
            )}

            {/* ===== STAGE 1: SELECT STATEMENT (Unified) ===== */}
            {!initialStatement && statementSource !== 'file' && folderEnabled && (
              <StageSection
                number={1}
                title="Select Statement"
                subtitle="Scan folder for statements or check email for new ones"
                isComplete={!!bankPreview}
                color="blue"
              >
                <div className="space-y-4">
                {/* Bank Selection + Action Buttons */}
                <div className="grid grid-cols-2 gap-4">
                  {(() => {
                    const filteredBanks = bankAccounts.filter(bank => {
                      if (!bankSelectSearch) return true;
                      const search = bankSelectSearch.toLowerCase();
                      return bank.code.toLowerCase().includes(search) ||
                             bank.description.toLowerCase().includes(search) ||
                             (bank.sort_code && bank.sort_code.includes(search));
                    });
                    return (
                  <div className="relative">
                    <label className="block text-sm font-medium text-gray-700 mb-1">Bank Account</label>
                    <input
                      type="text"
                      value={bankSelectOpen === 'folder' ? bankSelectSearch : (
                        bankAccounts.find(b => b.code === selectedBankCode)
                          ? `${selectedBankCode} - ${bankAccounts.find(b => b.code === selectedBankCode)?.description}`
                          : ''
                      )}
                      onChange={(e) => {
                        setBankSelectSearch(e.target.value);
                        setBankSelectHighlightIndex(0);
                        if (bankSelectOpen !== 'folder') setBankSelectOpen('folder');
                      }}
                      onFocus={() => {
                        setBankSelectOpen('folder');
                        setBankSelectSearch('');
                        setBankSelectHighlightIndex(0);
                      }}
                      onKeyDown={(e) => {
                        if (bankSelectOpen !== 'folder') return;
                        if (e.key === 'ArrowDown') {
                          e.preventDefault();
                          setBankSelectHighlightIndex(prev => Math.min(prev + 1, filteredBanks.length - 1));
                        } else if (e.key === 'ArrowUp') {
                          e.preventDefault();
                          setBankSelectHighlightIndex(prev => Math.max(prev - 1, 0));
                        } else if (e.key === 'Enter' && filteredBanks.length > 0) {
                          e.preventDefault();
                          const selectedBank = filteredBanks[bankSelectHighlightIndex];
                          if (selectedBank) {
                            setSelectedBankCode(selectedBank.code);
                            setBankSelectOpen(null);
                            setBankSelectSearch('');
                          }
                        } else if (e.key === 'Escape') {
                          setBankSelectOpen(null);
                          setBankSelectSearch('');
                        }
                      }}
                      placeholder="Search bank account..."
                      className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                    />
                    {bankSelectOpen === 'folder' && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => { setBankSelectOpen(null); setBankSelectSearch(''); }} />
                        <div className="absolute z-50 w-full mt-1 bg-white border border-gray-300 rounded-md shadow-lg max-h-60 overflow-y-auto">
                          {filteredBanks.map((bank, idx) => (
                              <button
                                key={bank.code}
                                type="button"
                                onClick={() => {
                                  setSelectedBankCode(bank.code);
                                  setBankSelectOpen(null);
                                  setBankSelectSearch('');
                                }}
                                className={`w-full text-left px-3 py-2 text-sm ${
                                  idx === bankSelectHighlightIndex ? 'bg-blue-100' : 'hover:bg-blue-50'
                                } ${selectedBankCode === bank.code ? 'text-blue-800' : ''}`}
                              >
                                <span className="font-medium">{bank.code}</span>
                                <span className="text-gray-600"> - {bank.description}</span>
                                {bank.sort_code && (
                                  <span className="text-gray-400 text-xs block">Sort: {bank.sort_code}</span>
                                )}
                              </button>
                            ))}
                        </div>
                      </>
                    )}
                  </div>
                    );
                  })()}
                  <div className="flex items-end gap-2">
                    <button
                      onClick={handleScanFolder}
                      disabled={folderScanLoading || !selectedBankCode || !!bankPreview}
                      className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                      title={bankPreview ? 'Clear current statement first' : !selectedBankCode ? 'Select a bank account first' : 'Scan statement folder for PDFs'}
                    >
                      {folderScanLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <FolderOpen className="h-4 w-4" />
                      )}
                      Scan Folder
                    </button>
                    <button
                      onClick={handleFetchEmailsToFolder}
                      disabled={emailFetchLoading || !selectedBankCode || !!bankPreview}
                      className="flex-1 px-4 py-2 bg-white text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                      title={bankPreview ? 'Clear current statement first' : !selectedBankCode ? 'Select a bank account first' : 'Check email inbox for new statement attachments'}
                    >
                      {emailFetchLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <FileText className="h-4 w-4" />
                      )}
                      Check Email
                    </button>
                  </div>
                </div>

                {/* Email fetch message */}
                {emailFetchMessage && (
                  <div className="p-2.5 bg-blue-50 border border-blue-200 rounded-lg flex items-center gap-2">
                    <FileText className="h-4 w-4 text-blue-500 flex-shrink-0" />
                    <p className="text-sm text-blue-700 flex-1">{emailFetchMessage}</p>
                    <button onClick={() => setEmailFetchMessage(null)} className="text-blue-400 hover:text-blue-600 text-lg leading-none">&times;</button>
                  </div>
                )}

                {/* Sequence error banner */}
                {sequenceError && !bankPreview && (
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2">
                    <span className="text-amber-500 mt-0.5">&#9888;</span>
                    <div className="flex-1">
                      <p className="text-sm text-amber-800">{sequenceError}</p>
                    </div>
                    <button onClick={() => setSequenceError(null)} className="text-amber-400 hover:text-amber-600 text-lg leading-none">&times;</button>
                  </div>
                )}

                {/* Statements List */}
                {folderStatements.length > 0 && !bankPreview && (() => {
                  const nextToImport = folderStatements.find(s => !s.is_imported && s.status !== 'already_processed');
                  return (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 px-3 py-2 bg-blue-50 rounded-lg">
                        <FolderOpen className="h-4 w-4 text-blue-600" />
                        <span className="text-sm font-medium text-blue-800">
                          {folderScanMessage || `Found ${folderStatements.length} statement(s) — import in order`}
                        </span>
                      </div>
                      {folderStatements.map((stmt, idx) => {
                        const isNext = nextToImport === stmt;
                        const isProcessed = stmt.is_imported || stmt.status === 'already_processed';
                        return (
                          <div
                            key={stmt.filename}
                            className={`flex items-center gap-3 p-3 rounded-lg border ${
                              isProcessed
                                ? 'bg-gray-50 border-gray-200 opacity-60'
                                : isNext
                                  ? 'bg-white border-blue-300 shadow-sm'
                                  : 'bg-white border-gray-200'
                            }`}
                          >
                            {/* Sequence badge */}
                            <div className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                              isProcessed ? 'bg-green-100 text-green-700' : isNext ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500'
                            }`}>
                              {isProcessed ? <CheckCircle className="w-4 h-4" /> : stmt.import_sequence || (idx + 1)}
                            </div>

                            {/* Statement info */}
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-gray-900 truncate">{stmt.filename}</p>
                              <div className="flex items-center gap-3 text-xs text-gray-500">
                                {stmt.bank_name && <span>{stmt.bank_name}</span>}
                                {stmt.period_start && stmt.period_end && (
                                  <span>{stmt.period_start} — {stmt.period_end}</span>
                                )}
                                {stmt.file_modified && (
                                  <span>Modified: {new Date(stmt.file_modified).toLocaleDateString('en-GB')}</span>
                                )}
                              </div>
                            </div>

                            {/* Balances */}
                            {stmt.opening_balance !== undefined && (
                              <div className="text-right text-xs">
                                <div className="text-gray-500">Open: <span className="font-medium text-gray-700">
                                  {stmt.opening_balance?.toLocaleString('en-GB', { style: 'currency', currency: 'GBP' })}
                                </span></div>
                                <div className="text-gray-500">Close: <span className="font-medium text-gray-700">
                                  {stmt.closing_balance?.toLocaleString('en-GB', { style: 'currency', currency: 'GBP' })}
                                </span></div>
                              </div>
                            )}

                            {/* Action */}
                            <div className="flex-shrink-0">
                              {isProcessed ? (
                                <span className="text-xs text-green-600 font-medium">Imported</span>
                              ) : isNext ? (
                                <button
                                  onClick={() => handleFolderPreview(stmt.full_path, stmt.filename)}
                                  disabled={analysing}
                                  className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:bg-gray-400 flex items-center gap-1"
                                >
                                  {analysing ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowRight className="h-3 w-3" />}
                                  Analyse
                                </button>
                              ) : (
                                <span className="text-xs text-gray-400">Queued</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}

                {/* Empty state */}
                {folderStatements.length === 0 && !bankPreview && (
                  <div className="text-center py-8 text-gray-500 text-sm">
                    {folderScanHasRun ? (
                      <>
                        <FolderOpen className="h-12 w-12 mx-auto text-gray-300 mb-3" />
                        <p>{folderScanMessage || 'No statements found in folder'}</p>
                        <p className="text-xs text-gray-400 mt-1">Try "Check Email" to download new statements from your inbox</p>
                      </>
                    ) : (
                      <>
                        <FolderOpen className="h-12 w-12 mx-auto text-gray-300 mb-3" />
                        <p>Select a bank account and click "Scan Folder" to find statements</p>
                        <p className="text-xs text-gray-400 mt-1">Use "Check Email" to download new statements from your inbox into the folder</p>
                      </>
                    )}
                  </div>
                )}
                </div>
              </StageSection>
            )}

            {/* CSV File Selection - FIRST (file contains bank details) */}
            {statementSource === 'file' && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">CSV Folder Path</label>
                  <input
                    type="text"
                    value={csvDirectory}
                    onChange={e => setCsvDirectory(e.target.value)}
                    className="w-full px-3 py-2 bg-white border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                    placeholder="e.g. C:\Downloads"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">CSV File</label>
                  {csvFilesList && csvFilesList.length > 0 ? (
                    <select
                      value={csvFileName}
                      onChange={e => setCsvFileName(e.target.value)}
                      className="w-full px-3 py-2 bg-white border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                    >
                      <option value="">Select a CSV file...</option>
                      {csvFilesList.map((f: any) => (
                        <option key={f.filename} value={f.filename}>
                          {f.filename} — {f.modified} ({f.size_display})
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={csvFileName}
                      onChange={e => setCsvFileName(e.target.value)}
                      className="w-full px-3 py-2 bg-white border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                      placeholder="Enter filename or enter folder path above"
                    />
                  )}
                </div>
              </div>

              {/* Bank Account Display - Auto-detected from file */}
              {dataSource === 'opera-sql' ? (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Bank Account (from file)</label>
                  {detectedBank?.loading ? (
                    <div className="flex items-center gap-2 px-3 py-2 bg-blue-50 border border-blue-200 rounded-md text-blue-700">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Detecting bank from file...</span>
                    </div>
                  ) : detectedBank?.detected ? (
                    <div className="px-3 py-2 bg-green-50 border border-green-300 rounded-md">
                      <div className="flex items-center gap-2">
                        <CheckCircle className="h-5 w-5 text-green-600" />
                        <div>
                          <div className="font-semibold text-green-800">
                            {detectedBank.bank_code} - {detectedBank.bank_description}
                          </div>
                          {(detectedBank.sort_code || detectedBank.account_number) && (
                            <div className="text-xs text-green-600">
                              {detectedBank.sort_code} | {detectedBank.account_number}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : csvFilePath ? (
                    <div className="space-y-2">
                      <div className="px-3 py-2 bg-amber-50 border border-amber-300 rounded-md">
                        <div className="flex items-center gap-2 text-amber-700">
                          <AlertCircle className="h-4 w-4" />
                          <span className="text-sm">{detectedBank?.message || 'Could not detect bank from file'}</span>
                        </div>
                      </div>
                      {(() => {
                        const filteredBanks = bankAccounts.filter(bank => {
                          if (!bankSelectSearch) return true;
                          const search = bankSelectSearch.toLowerCase();
                          return bank.code.toLowerCase().includes(search) ||
                                 bank.description.toLowerCase().includes(search) ||
                                 (bank.sort_code && bank.sort_code.includes(search));
                        });
                        return (
                      <div className="relative">
                        <input
                          type="text"
                          value={bankSelectOpen === 'csv' ? bankSelectSearch : (
                            selectedBankCode && bankAccounts.find(b => b.code === selectedBankCode)
                              ? `${selectedBankCode} - ${bankAccounts.find(b => b.code === selectedBankCode)?.description}`
                              : ''
                          )}
                          onChange={(e) => {
                            setBankSelectSearch(e.target.value);
                            setBankSelectHighlightIndex(0);
                            if (bankSelectOpen !== 'csv') setBankSelectOpen('csv');
                          }}
                          onFocus={() => {
                            setBankSelectOpen('csv');
                            setBankSelectSearch('');
                            setBankSelectHighlightIndex(0);
                          }}
                          onKeyDown={(e) => {
                            if (bankSelectOpen !== 'csv') return;
                            if (e.key === 'ArrowDown') {
                              e.preventDefault();
                              setBankSelectHighlightIndex(prev => Math.min(prev + 1, filteredBanks.length - 1));
                            } else if (e.key === 'ArrowUp') {
                              e.preventDefault();
                              setBankSelectHighlightIndex(prev => Math.max(prev - 1, 0));
                            } else if (e.key === 'Enter' && filteredBanks.length > 0) {
                              e.preventDefault();
                              const selectedBank = filteredBanks[bankSelectHighlightIndex];
                              if (selectedBank) {
                                setSelectedBankCode(selectedBank.code);
                                setBankSelectOpen(null);
                                setBankSelectSearch('');
                              }
                            } else if (e.key === 'Escape') {
                              setBankSelectOpen(null);
                              setBankSelectSearch('');
                            }
                          }}
                          placeholder="Search bank account..."
                          className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                        />
                        {bankSelectOpen === 'csv' && (
                          <>
                            <div className="fixed inset-0 z-40" onClick={() => { setBankSelectOpen(null); setBankSelectSearch(''); }} />
                            <div className="absolute z-50 w-full mt-1 bg-white border border-gray-300 rounded-md shadow-lg max-h-60 overflow-y-auto">
                              {filteredBanks.map((bank, idx) => (
                                  <button
                                    key={bank.code}
                                    type="button"
                                    onClick={() => {
                                      setSelectedBankCode(bank.code);
                                      setBankSelectOpen(null);
                                      setBankSelectSearch('');
                                    }}
                                    className={`w-full text-left px-3 py-2 text-sm ${
                                      idx === bankSelectHighlightIndex ? 'bg-blue-100' : 'hover:bg-blue-50'
                                    } ${selectedBankCode === bank.code ? 'text-blue-800' : ''}`}
                                  >
                                    <span className="font-medium">{bank.code}</span>
                                    <span className="text-gray-600"> - {bank.description}</span>
                                    {bank.sort_code && (
                                      <span className="text-gray-400 text-xs block">Sort: {bank.sort_code}</span>
                                    )}
                                  </button>
                                ))}
                            </div>
                          </>
                        )}
                      </div>
                        );
                      })()}
                    </div>
                  ) : (
                    <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded-md text-gray-500">
                      Select a CSV file to detect bank account
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Opera 3 Data Path</label>
                  <input
                    type="text"
                    value={opera3DataPath}
                    onChange={e => setOpera3DataPath(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                    placeholder="/path/to/opera3/company/data"
                  />
                </div>
              )}
            </div>
            )}

            {/* Recurring Entries Warning Banner (warn mode) */}
            {showRecurringWarning && recurringEntries.length > 0 && (
              <div className="bg-red-50 border border-red-200 border-l-4 border-l-red-500 rounded-xl p-4 flex items-start gap-3">
                <AlertCircle className="h-5 w-5 text-red-500 mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-red-800">Recurring Entries Due</p>
                  <p className="text-sm text-red-700 mt-0.5">
                    {recurringEntries.length} recurring {recurringEntries.length === 1 ? 'entry is' : 'entries are'} due for this bank.
                    Run recurring entries in Opera before processing to avoid duplicate postings.
                  </p>
                </div>
              </div>
            )}

            {/* Preview / Import Buttons */}
            {(() => {
              // For email/pdf/folder source, use different handlers
              const handlePreviewClick = isEmailSource && selectedEmailStatement
                ? () => handleEmailPreview(selectedEmailStatement.emailId, selectedEmailStatement.attachmentId, selectedEmailStatement.filename)
                : selectedPdfFile
                  ? () => handlePdfPreview(selectedPdfFile.filename)
                  : handleBankPreview;

              // Preview button disabled state - only disable while actively previewing or when prerequisites missing
              const previewDisabled = showRecurringModal || (isEmailSource
                ? (isPreviewing || noBankSelected || !selectedEmailStatement)
                : selectedPdfFile
                  ? (isPreviewing || noBankSelected)
                  : (isPreviewing || noBankSelected || !csvFilePath));

              return (
                <div className="space-y-3">
                  {/* Show source info when preview is loaded */}
                  {bankPreview && selectedPdfFile && (
                    <div className="flex items-center gap-2 px-3 py-2 bg-blue-50 border border-blue-200 rounded-md text-sm">
                      <FileText className="h-4 w-4 text-blue-600" />
                      <span className="text-blue-700">
                        Previewing: <strong>{selectedPdfFile.filename}</strong>
                      </span>
                    </div>
                  )}
                  {bankPreview && isEmailSource && selectedEmailStatement && !selectedPdfFile && (
                    <div className="flex items-center gap-2 px-3 py-2 bg-blue-50 border border-blue-200 rounded-md text-sm">
                      <FileText className="h-4 w-4 text-blue-600" />
                      <span className="text-blue-700">
                        Previewing: <strong>{selectedEmailStatement.filename}</strong> from email
                      </span>
                    </div>
                  )}

                  {/* Statement Summary Table */}
                  {bankPreview?.statement_bank_info && (
                    <div className="bg-gray-50 border border-gray-200 rounded-lg overflow-hidden">
                      <div className="bg-gray-100 px-4 py-2 border-b border-gray-200">
                        <h4 className="font-medium text-gray-700 text-sm">Statement Summary</h4>
                      </div>
                      <div className="p-4">
                        <table className="w-full text-sm">
                          <tbody className="divide-y divide-gray-100">
                            {bankPreview.statement_bank_info.bank_name && (
                              <tr>
                                <td className="py-1.5 text-gray-500 w-40">Bank</td>
                                <td className="py-1.5 text-gray-900 font-medium">{bankPreview.statement_bank_info.bank_name}</td>
                              </tr>
                            )}
                            {(bankPreview.statement_bank_info.sort_code || bankPreview.statement_bank_info.account_number) && (
                              <tr>
                                <td className="py-1.5 text-gray-500">Account</td>
                                <td className="py-1.5 text-gray-900 font-mono">
                                  {bankPreview.statement_bank_info.sort_code && <span>{bankPreview.statement_bank_info.sort_code}</span>}
                                  {bankPreview.statement_bank_info.sort_code && bankPreview.statement_bank_info.account_number && ' / '}
                                  {bankPreview.statement_bank_info.account_number && <span>{bankPreview.statement_bank_info.account_number}</span>}
                                </td>
                              </tr>
                            )}
                            {bankPreview.statement_bank_info.statement_date && (
                              <tr>
                                <td className="py-1.5 text-gray-500">Statement Date</td>
                                <td className="py-1.5 text-gray-900">{(() => {
                                  const dateStr = bankPreview.statement_bank_info.statement_date || '';
                                  const datePart = dateStr.split(' ')[0].split('T')[0];
                                  return new Date(datePart + 'T12:00:00').toLocaleDateString('en-GB');
                                })()}</td>
                              </tr>
                            )}
                            {bankPreview.statement_bank_info.opening_balance !== undefined && (
                              <tr>
                                <td className="py-1.5 text-gray-500">Opening Balance</td>
                                <td className="py-1.5 text-gray-900 font-medium">
                                  £{bankPreview.statement_bank_info.opening_balance?.toLocaleString('en-GB', { minimumFractionDigits: 2 })}
                                </td>
                              </tr>
                            )}
                            {bankPreview.statement_bank_info.closing_balance !== undefined && (
                              <tr>
                                <td className="py-1.5 text-gray-500">Closing Balance</td>
                                <td className="py-1.5 text-gray-900 font-medium text-green-700">
                                  £{bankPreview.statement_bank_info.closing_balance?.toLocaleString('en-GB', { minimumFractionDigits: 2 })}
                                </td>
                              </tr>
                            )}
                            {bankPreview.statement_bank_info.matched_opera_bank && (
                              <tr>
                                <td className="py-1.5 text-gray-500">Opera Bank</td>
                                <td className="py-1.5">
                                  <span className="px-2 py-0.5 bg-green-100 text-green-700 rounded text-xs font-medium">
                                    {bankPreview.statement_bank_info.matched_opera_bank}
                                  </span>
                                  {bankPreview.statement_bank_info.matched_opera_name && (
                                    <span className="ml-2 text-gray-600">{bankPreview.statement_bank_info.matched_opera_name}</span>
                                  )}
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  <div className="flex gap-4">
                    {/* View File button for CSV source only (before analysis) */}
                    {!selectedPdfFile && !isEmailSource && csvFilePath && (
                      <button
                        onClick={handleRawFilePreview}
                        disabled={!csvFilePath}
                        className="px-4 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 disabled:bg-gray-50 disabled:text-gray-400 disabled:cursor-not-allowed flex items-center gap-2 border border-gray-300"
                        title="View raw file contents before processing"
                      >
                        <FileText className="h-4 w-4" />
                        View File
                      </button>
                    )}
                    {/* View Statement button for PDF/folder/email source */}
                    {(selectedPdfFile || (isEmailSource && selectedEmailStatement)) && (
                      <button
                        onClick={handleRawFilePreview}
                        className="px-4 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 flex items-center gap-2 border border-gray-300"
                        title="View the statement"
                      >
                        <FileText className="h-4 w-4" />
                        View Statement
                      </button>
                    )}
                    {/* Analyse Transactions button */}
                    <button
                      onClick={handlePreviewClick}
                      disabled={previewDisabled}
                      className={`px-6 py-2 rounded-md flex items-center gap-2 ${
                        previewDisabled
                          ? 'bg-gray-400 text-white cursor-not-allowed'
                          : 'bg-blue-600 text-white hover:bg-blue-700'
                      }`}
                      title={noBankSelected ? 'Select a bank account first' : 'Analyse the statement and extract transactions'}
                    >
                      {isPreviewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                      {isPreviewing ? 'Analysing...' : 'Analyse Statement'}
                    </button>
                    {/* Step 3 indicator - Update transactions (done in tables below) */}
                    {bankPreview && (
                      <div className="flex items-center gap-2 px-4 py-2 bg-amber-50 border-2 border-amber-300 rounded-md text-amber-800">
                        <Edit3 className="h-4 w-4" />
                        <span className="text-sm">Review & update transactions below, then Import</span>
                        <span className="text-xs text-amber-600 ml-2">→ then Import at bottom</span>
                      </div>
                    )}
                  </div>

                  {/* Raw File Preview Modal */}
                  {showRawPreview && rawFilePreview && (
                    <div className="bg-gray-50 border border-gray-200 rounded-lg overflow-hidden">
                      <div className="bg-gray-100 px-4 py-2 border-b border-gray-200 flex items-center justify-between">
                        <h4 className="font-medium text-gray-700 text-sm flex items-center gap-2">
                          <FileText className="h-4 w-4" />
                          Raw File Contents (first 50 lines)
                        </h4>
                        <button
                          onClick={() => setShowRawPreview(false)}
                          className="text-gray-500 hover:text-gray-700"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                      <div className="p-2 max-h-80 overflow-auto">
                        <pre className="text-xs font-mono text-gray-600 whitespace-pre-wrap">
                          {rawFilePreview.map((line, i) => (
                            <div key={i} className="hover:bg-gray-100 py-0.5 px-2">
                              <span className="text-gray-400 mr-3 select-none">{String(i + 1).padStart(3, ' ')}</span>
                              {line}
                            </div>
                          ))}
                        </pre>
                      </div>
                    </div>
                  )}


                  {/* Import Readiness Summary */}
                  {importReadiness && bankPreview && (
                    <div className={`p-3 rounded-lg text-sm ${
                      hasUnhandledRepeatEntries ? 'bg-purple-50 border border-purple-200' :
                      hasPeriodViolations ? 'bg-orange-50 border border-orange-200' :
                      hasIncomplete ? 'bg-red-50 border border-red-200' :
                      importReadiness.totalReady > 0 ? 'bg-green-50 border border-green-200' :
                      'bg-gray-50 border border-gray-200'
                    }`}>
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="font-medium">
                          {hasUnhandledRepeatEntries ? (
                            <span className="text-purple-700 flex items-center gap-1">
                              <RefreshCw className="h-4 w-4" /> Repeat Entries Pending
                            </span>
                          ) : hasPeriodViolations ? (
                            <span className="text-orange-700 flex items-center gap-1">
                              <AlertCircle className="h-4 w-4" /> Period Violations
                            </span>
                          ) : hasIncomplete ? (
                            <span className="text-red-700 flex items-center gap-1">
                              <XCircle className="h-4 w-4" /> Cannot Import
                            </span>
                          ) : importReadiness.totalReady > 0 ? (
                            <span className="text-green-700 flex items-center gap-1">
                              <CheckCircle className="h-4 w-4" /> Ready to Import:
                            </span>
                          ) : (
                            <span className="text-gray-600">No transactions to import</span>
                          )}
                        </span>
                        {importReadiness.totalReady > 0 && (
                          <div className="flex flex-wrap gap-2 text-xs">
                            {importReadiness.receiptsReady > 0 && (
                              <span className="bg-green-100 text-green-800 px-2 py-1 rounded">
                                {importReadiness.receiptsReady} receipt{importReadiness.receiptsReady !== 1 ? 's' : ''}
                              </span>
                            )}
                            {importReadiness.paymentsReady > 0 && (
                              <span className="bg-red-100 text-red-800 px-2 py-1 rounded">
                                {importReadiness.paymentsReady} payment{importReadiness.paymentsReady !== 1 ? 's' : ''}
                              </span>
                            )}
                            {importReadiness.refundsReady > 0 && (
                              <span className="bg-orange-100 text-orange-800 px-2 py-1 rounded">
                                {importReadiness.refundsReady} refund{importReadiness.refundsReady !== 1 ? 's' : ''}
                              </span>
                            )}
                            {importReadiness.unmatchedReady > 0 && (
                              <span className="bg-amber-100 text-amber-800 px-2 py-1 rounded">
                                {importReadiness.unmatchedReady} manually assigned
                              </span>
                            )}
                            {importReadiness.skippedReady > 0 && (
                              <span className="bg-gray-100 text-gray-800 px-2 py-1 rounded">
                                {importReadiness.skippedReady} from skipped
                              </span>
                            )}
                          </div>
                        )}
                        {hasUnhandledRepeatEntries && (
                          <span className="text-purple-600 text-xs">
                            {importReadiness.unhandledRepeatEntries} repeat entr{importReadiness.unhandledRepeatEntries !== 1 ? 'ies need' : 'y needs'} processing - update dates in Repeat Entries tab, run Opera's Recurring Entries, then re-preview
                          </span>
                        )}
                        {hasPeriodViolations && !hasUnhandledRepeatEntries && (
                          <span className="text-orange-600 text-xs">
                            {importReadiness.periodViolationsCount} transaction{importReadiness.periodViolationsCount !== 1 ? 's have dates' : ' has a date'} outside the allowed posting period - correct dates below or deselect
                          </span>
                        )}
                        {hasIncomplete && !hasPeriodViolations && !hasUnhandledRepeatEntries && (
                          <span className="text-red-600 text-xs">
                            {importReadiness.skippedIncomplete} skipped item{importReadiness.skippedIncomplete !== 1 ? 's' : ''} included but missing account - assign account or uncheck to proceed
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Preview Results - Tabbed UI */}
            {bankPreview && (
              <div className="space-y-4">
                {/* ===== STAGE 2: PREVIEW STATEMENT ===== */}
                <div ref={stage2Ref} className={`p-4 rounded-lg border-2 ${bankPreview.success ? 'bg-green-50 border-green-300' : 'bg-red-50 border-red-300'}`}>
                  <div className="flex justify-between items-start mb-3">
                    <h3 className="font-semibold text-green-900 flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-green-600 text-white flex items-center justify-center text-sm font-bold flex-shrink-0">2</div>
                      Preview Statement: {bankPreview.filename}
                    </h3>
                    <div className="flex items-center gap-2">
                      {bankPreview.period_info && (
                        <span className="text-xs px-2 py-1 bg-purple-100 text-purple-700 rounded-full">
                          Current Period: {bankPreview.period_info.current_period}/{bankPreview.period_info.current_year}
                        </span>
                      )}
                      {bankPreview.detected_format && (
                        <span className="text-xs px-2 py-1 bg-blue-100 text-blue-700 rounded-full">
                          Format: {bankPreview.detected_format}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Resume Mode Banner */}
                  {resumeImportId && alreadyPostedRows.size > 0 && (
                    <div className="mb-4 p-3 bg-orange-50 border border-orange-300 rounded-lg">
                      <div className="flex items-start gap-2">
                        <AlertCircle className="h-5 w-5 text-orange-600 flex-shrink-0 mt-0.5" />
                        <div className="flex-1">
                          <h4 className="font-medium text-orange-800">Continue Import — {alreadyPostedRows.size} lines already posted</h4>
                          <p className="text-sm text-orange-700 mt-1">
                            Lines already posted to Opera are shown with a green "Posted" badge and are excluded from import.
                            Assign the remaining unposted lines to nominal codes, customers, or suppliers, then click Import.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Period Violations Warning */}
                  {bankPreview.has_period_violations && bankPreview.period_violations && bankPreview.period_violations.length > 0 && (
                    <div className="mb-4 p-3 bg-orange-50 border border-orange-300 rounded-lg">
                      <div className="flex items-start gap-2">
                        <AlertCircle className="h-5 w-5 text-orange-600 flex-shrink-0 mt-0.5" />
                        <div className="flex-1">
                          <h4 className="font-medium text-orange-800">Period Validation Errors</h4>
                          <p className="text-sm text-orange-700 mt-1">
                            {bankPreview.period_violations.length} transaction{bankPreview.period_violations.length !== 1 ? 's are' : ' is'} in blocked periods.
                            {bankPreview.period_info && (
                              <span> Current period is <strong>{bankPreview.period_info.current_period}/{bankPreview.period_info.current_year}</strong>
                              {!bankPreview.period_info.open_period_accounting && <span className="text-orange-500"> (Open Period Accounting is disabled)</span>}.
                              </span>
                            )}
                          </p>
                          <div className="mt-2 text-sm text-orange-700">
                            <ul className="list-disc list-inside space-y-1">
                              {bankPreview.period_violations.slice(0, 5).map((v, idx) => (
                                <li key={idx}>
                                  <strong>{v.name || `Row ${v.row}`}</strong> ({v.date}) -
                                  {v.ledger_name && <span className="text-orange-600"> {v.ledger_name}</span>} blocked for period {v.period || v.transaction_period}/{v.year || v.transaction_year}
                                </li>
                              ))}
                              {bankPreview.period_violations.length > 5 && (
                                <li className="text-orange-500">...and {bankPreview.period_violations.length - 5} more</li>
                              )}
                            </ul>
                          </div>
                          <div className="flex items-center gap-3 mt-3">
                            <button
                              onClick={() => {
                                const today = new Date().toISOString().split('T')[0];
                                setDateOverrides(prev => {
                                  const updated = new Map(prev);
                                  bankPreview.period_violations?.forEach(v => {
                                    updated.set(v.row, today);
                                  });
                                  return updated;
                                });
                              }}
                              className="px-3 py-1.5 bg-orange-600 text-white text-sm rounded hover:bg-orange-700 flex items-center gap-1"
                            >
                              Set All to Today
                            </button>
                            <span className="text-sm text-orange-600">
                              or correct dates individually below, open the periods in Opera, or deselect these transactions
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* ===== STAGE 3: MATCH TRANSACTIONS ===== */}
                  <div className="mt-4 p-3 bg-amber-50 border-2 border-amber-300 rounded-lg">
                    <h3 className="font-semibold text-amber-900 flex items-center gap-2">
                      <div className={`w-8 h-8 rounded-full ${bankImportResult?.success ? 'bg-green-500' : 'bg-amber-600'} text-white flex items-center justify-center text-sm font-bold flex-shrink-0`}>
                        {bankImportResult?.success ? '✓' : '3'}
                      </div>
                      Match Transactions
                      <span className="font-normal text-sm text-amber-600 ml-2">— Review and adjust account matching</span>
                    </h3>
                  </div>

                  {/* All already in Opera banner */}
                  {allAlreadyInOpera && (
                    <div className="mt-2 p-3 bg-green-100 border border-green-300 rounded-lg flex items-start gap-3">
                      <CheckCircle className="h-5 w-5 text-green-600 mt-0.5 flex-shrink-0" />
                      <div>
                        <p className="text-sm font-semibold text-green-800">
                          All transactions already in Opera
                        </p>
                        <p className="text-sm text-green-700 mt-1">
                          Nothing to import — proceed directly to reconciliation.
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Tab Bar with counts and monetary values */}
                  {(() => {
                    // Filter is_duplicate items from matched tabs into "In Opera"
                    const receipts = (bankPreview.matched_receipts || []).filter((t: any) => !t.is_duplicate);
                    const payments = (bankPreview.matched_payments || []).filter((t: any) => !t.is_duplicate);
                    const refunds = (bankPreview.matched_refunds || []).filter((t: any) => !t.is_duplicate);
                    const repeatEntries = bankPreview.repeat_entries || [];
                    const allUnmatched = bankPreview.unmatched || [];
                    // Filter out ignored transactions from unmatched count
                    const unmatched = allUnmatched.filter((t: { row: number }) => !ignoredTransactions.has(t.row));
                    // Collect all already-in-Opera items: explicit already_posted + duplicates from matched tabs
                    const duplicatesFromMatched = [
                      ...(bankPreview.matched_receipts || []).filter((t: any) => t.is_duplicate),
                      ...(bankPreview.matched_payments || []).filter((t: any) => t.is_duplicate),
                      ...(bankPreview.matched_refunds || []).filter((t: any) => t.is_duplicate),
                    ];
                    const skipped = [...(bankPreview.already_posted || []), ...(bankPreview.skipped || []), ...duplicatesFromMatched];

                    const receiptsTotal = receipts.reduce((sum: number, t: { amount: number }) => sum + Math.abs(t.amount), 0);
                    const paymentsTotal = payments.reduce((sum: number, t: { amount: number }) => sum + Math.abs(t.amount), 0);
                    const refundsTotal = refunds.reduce((sum: number, t: { amount: number }) => sum + Math.abs(t.amount), 0);
                    const repeatTotal = repeatEntries.reduce((sum: number, t: { amount: number }) => sum + Math.abs(t.amount), 0);
                    const unmatchedTotal = unmatched.reduce((sum: number, t: { amount: number }) => sum + Math.abs(t.amount), 0);
                    const skippedTotal = skipped.reduce((sum: number, t: { amount: number }) => sum + Math.abs(t.amount), 0);
                    const grandTotal = receiptsTotal + paymentsTotal + refundsTotal + repeatTotal + unmatchedTotal + skippedTotal;

                    return (
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => { setActivePreviewTab('receipts'); setTabSearchFilter(''); }}
                          className={`flex flex-col items-center px-4 py-2 rounded-lg text-sm font-medium transition-colors min-w-[100px] ${
                            activePreviewTab === 'receipts'
                              ? 'bg-green-100 text-green-800 border-2 border-green-400'
                              : 'bg-green-50 text-green-700 border border-green-200 hover:bg-green-100'
                          }`}
                        >
                          <span className="flex items-center gap-1">Receipts <span className="bg-green-200 text-green-900 px-1.5 py-0.5 rounded-full text-xs font-bold">{receipts.length}</span></span>
                          <span className="text-sm font-bold">£{receiptsTotal.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </button>
                        <button
                          onClick={() => { setActivePreviewTab('payments'); setTabSearchFilter(''); }}
                          className={`flex flex-col items-center px-4 py-2 rounded-lg text-sm font-medium transition-colors min-w-[100px] ${
                            activePreviewTab === 'payments'
                              ? 'bg-red-100 text-red-800 border-2 border-red-400'
                              : 'bg-red-50 text-red-700 border border-red-200 hover:bg-red-100'
                          }`}
                        >
                          <span className="flex items-center gap-1">Payments <span className="bg-red-200 text-red-900 px-1.5 py-0.5 rounded-full text-xs font-bold">{payments.length}</span></span>
                          <span className="text-sm font-bold">£{paymentsTotal.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </button>
                        {refunds.length > 0 && (
                          <button
                            onClick={() => { setActivePreviewTab('refunds'); setTabSearchFilter(''); }}
                            className={`flex flex-col items-center px-4 py-2 rounded-lg text-sm font-medium transition-colors min-w-[100px] ${
                              activePreviewTab === 'refunds'
                                ? 'bg-orange-100 text-orange-800 border-2 border-orange-400'
                                : 'bg-orange-50 text-orange-700 border border-orange-200 hover:bg-orange-100'
                            }`}
                          >
                            <span className="flex items-center gap-1">Refunds <span className="bg-orange-200 text-orange-900 px-1.5 py-0.5 rounded-full text-xs font-bold">{refunds.length}</span></span>
                            <span className="text-sm font-bold">£{refundsTotal.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                          </button>
                        )}
                        {repeatEntries.length > 0 && (
                          <button
                            onClick={() => { setActivePreviewTab('repeat'); setTabSearchFilter(''); }}
                            className={`flex flex-col items-center px-4 py-2 rounded-lg text-sm font-medium transition-colors min-w-[100px] ${
                              activePreviewTab === 'repeat'
                                ? 'bg-purple-100 text-purple-800 border-2 border-purple-400'
                                : 'bg-purple-50 text-purple-700 border border-purple-200 hover:bg-purple-100'
                            }`}
                          >
                            <span className="flex items-center gap-1">Repeat <span className="bg-purple-200 text-purple-900 px-1.5 py-0.5 rounded-full text-xs font-bold">{repeatEntries.length}</span></span>
                            <span className="text-sm font-bold">£{repeatTotal.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                          </button>
                        )}
                        <button
                          onClick={() => { setActivePreviewTab('unmatched'); setTabSearchFilter(''); }}
                          className={`flex flex-col items-center px-4 py-2 rounded-lg text-sm font-medium transition-colors min-w-[100px] ${
                            activePreviewTab === 'unmatched'
                              ? 'bg-amber-100 text-amber-800 border-2 border-amber-400'
                              : 'bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100'
                          }`}
                        >
                          <span className="flex items-center gap-1">Unmatched <span className="bg-amber-200 text-amber-900 px-1.5 py-0.5 rounded-full text-xs font-bold">{unmatched.length}</span></span>
                          <span className="text-sm font-bold">£{unmatchedTotal.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </button>
                        <button
                          onClick={() => { setActivePreviewTab('skipped'); setTabSearchFilter(''); }}
                          className={`flex flex-col items-center px-4 py-2 rounded-lg text-sm font-medium transition-colors min-w-[100px] ${
                            activePreviewTab === 'skipped'
                              ? 'bg-gray-200 text-gray-800 border-2 border-gray-400'
                              : 'bg-gray-50 text-gray-600 border border-gray-200 hover:bg-gray-100'
                          }`}
                        >
                          <span className="flex items-center gap-1">In Opera <span className="bg-gray-200 text-gray-800 px-1.5 py-0.5 rounded-full text-xs font-bold">{skipped.length}</span></span>
                          <span className="text-sm font-bold">£{skippedTotal.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </button>
                        <div className="ml-auto flex flex-col items-center justify-center px-4 py-2 bg-blue-50 border border-blue-200 rounded-lg min-w-[120px]">
                          <span className="text-xs text-blue-600">Statement Total</span>
                          <span className="text-lg font-bold text-blue-700">£{grandTotal.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </div>
                      </div>
                    );
                  })()}
                </div>

                {/* Search bar for active tab */}
                {bankPreview.success && (
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                      <input
                        type="text"
                        placeholder="Search by name or reference..."
                        value={tabSearchFilter}
                        onChange={(e) => setTabSearchFilter(e.target.value)}
                        className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-blue-500 focus:border-blue-500"
                      />
                      {tabSearchFilter && (
                        <button
                          onClick={() => setTabSearchFilter('')}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                        >
                          <XCircle className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* ===== RECEIPTS TAB ===== */}
                {activePreviewTab === 'receipts' && (bankPreview.matched_receipts?.filter((t: any) => !t.is_duplicate)?.length || 0) > 0 && (() => {
                  const allReceipts = (bankPreview.matched_receipts || []).filter((t: any) => !t.is_duplicate);
                  const filtered = allReceipts.filter(txn =>
                    !tabSearchFilter || txn.name.toLowerCase().includes(tabSearchFilter.toLowerCase()) ||
                    (txn.reference || '').toLowerCase().includes(tabSearchFilter.toLowerCase())
                  );
                  const selectedCount = filtered.filter(t => selectedForImport.has(t.row)).length;
                  const isImported = bankImportResult?.success;
                  const importedRows = new Set((bankImportResult?.imported_transactions || []).map((t: any) => t.row));
                  return (
                    <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                      <div className="flex justify-between items-center mb-2">
                        <h4 className="font-medium text-green-800">
                          {isImported
                            ? `Receipts — ${importedRows.size > 0 ? filtered.filter(t => importedRows.has(t.row)).length : 0} posted to Opera`
                            : `Receipts (${filtered.length} records / ${selectedCount} to import)`
                          }
                        </h4>
                      </div>
                      <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 bg-green-100 z-10">
                            <tr>
                              <th className="p-1.5 w-12 text-center">
                                <div className="flex flex-col items-center gap-1">
                                  <span className="text-xs">Incl</span>
                                  {!isImported && (
                                    <input
                                      type="checkbox"
                                      checked={filtered.filter(t => !t.is_duplicate).length > 0 && filtered.filter(t => !t.is_duplicate).every(t => selectedForImport.has(t.row))}
                                      onChange={(e) => {
                                        const updated = new Set(selectedForImport);
                                        if (e.target.checked) {
                                          filtered.filter(t => !t.is_duplicate).forEach(t => updated.add(t.row));
                                        } else {
                                          filtered.forEach(t => updated.delete(t.row));
                                        }
                                        setSelectedForImport(updated);
                                      }}
                                      className="rounded border-green-400 text-green-600 focus:ring-green-500"
                                      title="Select/deselect all"
                                    />
                                  )}
                                </div>
                              </th>
                              <th className="text-left p-1.5 w-24">Date</th>
                              <th className="text-left p-1.5">Name</th>
                              <th className="text-right p-1.5 w-24">Amount</th>
                              <th className="text-left p-1.5 w-32">Type</th>
                              <th className="text-left p-1.5 w-28">CB Type</th>
                              <th className="text-left p-1.5 min-w-[150px]">Assign Account</th>
                              <th className="text-center p-1.5 w-16" title="Auto-allocate to invoices after import">
                                <div className="flex flex-col items-center gap-1">
                                  <span className="text-xs">Alloc</span>
                                  {!isImported && (
                                    <input
                                      type="checkbox"
                                      checked={filtered.length > 0 && filtered.every(t => !autoAllocateDisabled.has(t.row))}
                                      onChange={(e) => {
                                        const updated = new Set(autoAllocateDisabled);
                                        if (e.target.checked) {
                                          filtered.forEach(t => updated.delete(t.row));
                                        } else {
                                          filtered.forEach(t => updated.add(t.row));
                                        }
                                        setAutoAllocateDisabled(updated);
                                      }}
                                      className="rounded border-green-400 text-green-600 focus:ring-green-500"
                                      title="Enable/disable allocation for all"
                                    />
                                  )}
                                </div>
                              </th>
                              <th className="text-left p-1.5 w-20">Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filtered.map((txn, idx) => {
                              const rowImported = (isImported && importedRows.has(txn.row)) || alreadyPostedRows.has(txn.row);
                              const editedTxn = editedTransactions.get(txn.row);
                              const isPositive = txn.amount > 0;
                              const defaultTxnType = (txn.action || 'sales_receipt') as TransactionType;
                              const currentTxnType = transactionTypeOverrides.get(txn.row) || defaultTxnType;
                              const showCustomers = currentTxnType === 'sales_receipt' || currentTxnType === 'sales_refund';
                              const isNominal = currentTxnType === 'nominal_receipt' || currentTxnType === 'nominal_payment';
                              const isBankTransfer = currentTxnType === 'bank_transfer';
                              const isNlOrTransfer = isNominal || isBankTransfer;
                              const isTypeOverridden = transactionTypeOverrides.has(txn.row);
                              const displayAccount = editedTxn?.manual_account || (!isTypeOverridden ? txn.account : '');
                              const displayAccountName = editedTxn?.account_name || (!isTypeOverridden ? (txn.account_name || '') : '');
                              const hasAccount = isNlOrTransfer || !!displayAccount;
                              const isIncluded = selectedForImport.has(txn.row);
                              const filteredCbtypes = filterCbtypesForAction(isPositive ? receiptTypes : paymentTypes, currentTxnType);
                              const defaultCbtype = getBestCbtype(currentTxnType, filteredCbtypes, txn.name || txn.memo);
                              const currentCbtype = cbtypeOverrides.get(txn.row) || defaultCbtype;
                              return (
                              <tr key={idx} className={`border-t border-green-200 ${rowImported ? 'bg-green-50' : txn.is_duplicate ? 'bg-amber-50' : isIncluded ? (editedTxn?.isEdited ? 'bg-green-50' : '') : 'opacity-50'}`}>
                                <td className="p-2 text-center">
                                  {rowImported ? (
                                    <span className="inline-flex items-center gap-1 text-green-700 text-xs font-medium">
                                      <CheckCircle className="h-3.5 w-3.5" /> Posted
                                    </span>
                                  ) : txn.is_duplicate ? (
                                    <span className="inline-flex items-center gap-1 text-amber-600 text-xs font-medium" title="This transaction is already in Opera">
                                      <AlertCircle className="h-3.5 w-3.5" /> Already in Opera
                                    </span>
                                  ) : (
                                  <input
                                    type="checkbox"
                                    checked={isIncluded}
                                    disabled={!hasAccount}
                                    onChange={(e) => {
                                      const updated = new Set(selectedForImport);
                                      if (e.target.checked) updated.add(txn.row);
                                      else updated.delete(txn.row);
                                      setSelectedForImport(updated);
                                    }}
                                    className="rounded border-green-400"
                                    title={!hasAccount ? 'Assign an account first to include in import' : ''}
                                  />
                                  )}
                                </td>
                                <td className="p-2">
                                  {txn.period_valid === false && !isImported ? (
                                    <div className="flex items-center gap-1">
                                      <input
                                        type="date"
                                        value={dateOverrides.get(txn.row) || txn.date}
                                        onChange={(e) => {
                                          const newDate = e.target.value;
                                          setDateOverrides(prev => {
                                            const updated = new Map(prev);
                                            if (newDate && newDate !== txn.date) {
                                              updated.set(txn.row, newDate);
                                            } else {
                                              updated.delete(txn.row);
                                            }
                                            return updated;
                                          });
                                        }}
                                        className={`w-32 text-xs border rounded px-1 py-0.5 ${
                                          dateOverrides.has(txn.row) ? 'border-green-400 bg-green-50' : 'border-orange-400 bg-orange-50'
                                        }`}
                                        title={txn.period_error || 'Date outside allowed posting period'}
                                      />
                                      <button
                                        onClick={() => {
                                          const today = new Date().toISOString().split('T')[0];
                                          setDateOverrides(prev => {
                                            const updated = new Map(prev);
                                            updated.set(txn.row, today);
                                            return updated;
                                          });
                                        }}
                                        className="text-xs px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
                                        title="Set to today's date"
                                      >
                                        Today
                                      </button>
                                      {!dateOverrides.has(txn.row) && (
                                        <span title={txn.period_error || 'Date outside allowed posting period'}><AlertCircle className="h-4 w-4 text-orange-500" /></span>
                                      )}
                                      {dateOverrides.has(txn.row) && (
                                        <span title="Date corrected"><CheckCircle className="h-4 w-4 text-green-500" /></span>
                                      )}
                                    </div>
                                  ) : (
                                    txn.date
                                  )}
                                </td>
                                <td className="p-2">
                                  <div className="max-w-xs truncate" title={txn.name}>{txn.name}</div>
                                  {txn.reference && (
                                    <div className="text-xs text-gray-500 truncate" title={txn.reference}>Ref: {txn.reference}</div>
                                  )}
                                </td>
                                <td className="p-2 text-right font-medium text-green-700 whitespace-nowrap">+£{Math.abs(txn.amount).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                                <td className="p-2">
                                  {rowImported ? (
                                    <span className="text-xs text-gray-700">
                                      {currentTxnType === 'sales_receipt' ? 'Sales Receipt'
                                        : currentTxnType === 'purchase_refund' ? 'Purchase Refund'
                                        : currentTxnType === 'nominal_receipt' ? 'Nominal Receipt'
                                        : currentTxnType === 'bank_transfer' ? 'Bank Transfer'
                                        : currentTxnType}
                                    </span>
                                  ) : (
                                  <select
                                    value={currentTxnType}
                                    onChange={(e) => {
                                      const newType = e.target.value as TransactionType;
                                      if (newType === 'ignore') {
                                        openIgnoreConfirm(txn);
                                        return;
                                      }
                                      // Reverting to original type - clear all overrides
                                      if (newType === defaultTxnType) {
                                        setTransactionTypeOverrides(prev => { const u = new Map(prev); u.delete(txn.row); return u; });
                                        setEditedTransactions(prev => { const u = new Map(prev); u.delete(txn.row); return u; });
                                        return;
                                      }
                                      const updated = new Map(transactionTypeOverrides);
                                      updated.set(txn.row, newType);
                                      setTransactionTypeOverrides(updated);
                                      // Clear previous account edit for all type changes
                                      const edits = new Map(editedTransactions);
                                      edits.delete(txn.row);
                                      setEditedTransactions(edits);
                                      if (newType === 'nominal_receipt' || newType === 'nominal_payment') {
                                        openNominalDetailModal(txn, newType, 'receipts');
                                      } else if (newType === 'bank_transfer') {
                                        openBankTransferModal(txn, 'receipts');
                                      } else {
                                        suggestAccountForTransaction(txn, newType);
                                      }
                                    }}
                                    className={`text-xs px-2 py-1 border rounded bg-white w-full ${
                                      isTypeOverridden ? 'border-yellow-400 bg-yellow-50' : 'border-gray-300'
                                    }`}
                                  >
                                    {isPositive ? (
                                      <>
                                        <option value="sales_receipt">Sales Receipt</option>
                                        <option value="purchase_refund">Purchase Refund</option>
                                        <option value="nominal_receipt">Nominal Receipt</option>
                                      </>
                                    ) : (
                                      <>
                                        <option value="purchase_payment">Purchase Payment</option>
                                        <option value="sales_refund">Sales Refund</option>
                                        <option value="nominal_payment">Nominal Payment</option>
                                      </>
                                    )}
                                    <option value="bank_transfer">Bank Transfer</option>
                                    <option value="ignore">Ignore (in Opera)</option>
                                  </select>
                                  )}
                                </td>
                                <td className="p-2">
                                  {rowImported ? (
                                    <span className="text-xs text-gray-500">{currentCbtype || '—'}</span>
                                  ) : filteredCbtypes.length > 0 ? (
                                    <select
                                      value={currentCbtype}
                                      onChange={(e) => {
                                        const updated = new Map(cbtypeOverrides);
                                        updated.set(txn.row, e.target.value);
                                        setCbtypeOverrides(updated);
                                      }}
                                      className={`text-xs px-1 py-1 border rounded w-full ${
                                        cbtypeOverrides.has(txn.row) ? 'border-yellow-400 bg-yellow-50' : 'border-gray-300'
                                      }`}
                                    >
                                      {filteredCbtypes.map(t => (
                                        <option key={t.code} value={t.code}>{t.code} - {t.description}</option>
                                      ))}
                                    </select>
                                  ) : (
                                    <span className="text-xs text-gray-400">Loading...</span>
                                  )}
                                </td>
                                <td className="p-2">
                                  {rowImported ? (
                                    <span className="text-xs text-gray-700">
                                      {isNominal && nominalPostingDetails.has(txn.row)
                                        ? `${nominalPostingDetails.get(txn.row)?.nominalCode} - ${(() => { const nd = nominalPostingDetails.get(txn.row); const na = nominalAccounts.find(n => n.code === nd?.nominalCode); return na?.description || ''; })()}`
                                        : isBankTransfer && bankTransferDetails.has(txn.row)
                                          ? `Transfer → ${bankTransferDetails.get(txn.row)?.destBankCode}`
                                          : displayAccount
                                            ? `${displayAccount} - ${displayAccountName}`
                                            : '—'}
                                    </span>
                                  ) : (
                                  <>
                                  {isNominal ? (
                                    <div>
                                      <button
                                        onClick={() => openNominalDetailModal(txn, currentTxnType, 'receipts')}
                                        className={`w-full text-sm px-2 py-1 border rounded flex items-center justify-between ${
                                          nominalPostingDetails.has(txn.row)
                                            ? 'border-green-400 bg-green-50 text-green-700'
                                            : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
                                        }`}
                                      >
                                        {nominalPostingDetails.has(txn.row) ? (
                                          <>
                                            <span className="truncate">
                                              {nominalPostingDetails.get(txn.row)?.nominalCode} - £{nominalPostingDetails.get(txn.row)?.netAmount.toFixed(2)}
                                            </span>
                                            <Edit3 className="h-3 w-3 flex-shrink-0" />
                                          </>
                                        ) : (
                                          <>
                                            <span>Enter Details...</span>
                                            <Edit3 className="h-3 w-3" />
                                          </>
                                        )}
                                      </button>
                                      {nominalPostingDetails.has(txn.row) && (() => {
                                        const nominalDetail = nominalPostingDetails.get(txn.row);
                                        const nominalAcc = nominalAccounts.find(n => n.code === nominalDetail?.nominalCode);
                                        const hasVat = nominalDetail?.vatCode && nominalDetail.vatCode !== 'N/A' && nominalDetail.vatAmount > 0;
                                        return (
                                          <div className="text-xs text-gray-500 mt-1 flex items-center gap-2">
                                            <span className="truncate" title={nominalAcc?.description}>{nominalAcc?.description || 'Unknown'}</span>
                                            {hasVat && <span className="flex-shrink-0 text-green-600">+VAT</span>}
                                          </div>
                                        );
                                      })()}
                                    </div>
                                  ) : isBankTransfer ? (
                                    <button
                                      onClick={() => openBankTransferModal(txn, 'receipts')}
                                      className={`w-full text-sm px-2 py-1 border rounded flex items-center justify-between ${
                                        bankTransferDetails.has(txn.row)
                                          ? 'border-green-400 bg-green-50 text-green-700'
                                          : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
                                      }`}
                                    >
                                      {bankTransferDetails.has(txn.row) ? (
                                        <>
                                          <span className="truncate">
                                            {txn.amount < 0 ? 'To: ' : 'From: '}{bankTransferDetails.get(txn.row)?.destBankCode}
                                          </span>
                                          <Edit3 className="h-3 w-3 flex-shrink-0" />
                                        </>
                                      ) : (
                                        <>
                                          <span>Select Bank...</span>
                                          <Landmark className="h-3 w-3" />
                                        </>
                                      )}
                                    </button>
                                  ) : (() => {
                                    const filteredAccounts = (showCustomers ? customers : suppliers)
                                      .filter(acc => {
                                        if (!inlineAccountSearchText) return true;
                                        const search = inlineAccountSearchText.toLowerCase();
                                        return acc.code.toLowerCase().includes(search) ||
                                               acc.name.toLowerCase().includes(search);
                                      })
                                      .slice(0, 50);
                                    return (
                                    <div className="relative">
                                      <input
                                        type="text"
                                        value={inlineAccountSearch?.row === txn.row && inlineAccountSearch?.section === 'receipts'
                                          ? inlineAccountSearchText
                                          : (displayAccount
                                            ? `${displayAccount} - ${displayAccountName}`
                                            : '')}
                                        onChange={(e) => {
                                          setInlineAccountSearchText(e.target.value);
                                          setInlineAccountHighlightIndex(0);
                                          if (!inlineAccountSearch || inlineAccountSearch.row !== txn.row) {
                                            setInlineAccountSearch({ row: txn.row, section: 'receipts' });
                                          }
                                        }}
                                        onFocus={() => {
                                          setInlineAccountSearch({ row: txn.row, section: 'receipts' });
                                          setInlineAccountSearchText('');
                                          setInlineAccountHighlightIndex(0);
                                        }}
                                        onKeyDown={(e) => {
                                          if (e.key === 'ArrowDown') {
                                            e.preventDefault();
                                            if (!inlineAccountSearch || inlineAccountSearch.row !== txn.row) {
                                              setInlineAccountSearch({ row: txn.row, section: 'receipts' });
                                            }
                                            if (filteredAccounts.length === 1) {
                                              handleAccountChange(txn, filteredAccounts[0].code, showCustomers ? 'C' : 'S');
                                              setInlineAccountSearch(null);
                                              setInlineAccountSearchText('');
                                            } else if (filteredAccounts.length > 1) {
                                              setInlineAccountHighlightIndex(prev => prev < filteredAccounts.length - 1 ? prev + 1 : prev);
                                            }
                                          } else if (e.key === 'ArrowUp') {
                                            e.preventDefault();
                                            setInlineAccountHighlightIndex(prev => prev > 0 ? prev - 1 : 0);
                                          } else if (e.key === 'Enter') {
                                            e.preventDefault();
                                            if (inlineAccountSearchText.length > 0 && filteredAccounts.length > 0) {
                                              const selIdx = Math.min(inlineAccountHighlightIndex, filteredAccounts.length - 1);
                                              handleAccountChange(txn, filteredAccounts[selIdx].code, showCustomers ? 'C' : 'S');
                                            }
                                            setInlineAccountSearch(null);
                                            setInlineAccountSearchText('');
                                          } else if (e.key === 'Escape') {
                                            setInlineAccountSearch(null);
                                            setInlineAccountSearchText('');
                                            (e.target as HTMLInputElement).blur();
                                          } else if (e.key === 'Tab') {
                                            if (inlineAccountSearchText.length > 0 && filteredAccounts.length > 0) {
                                              const selIdx = Math.min(inlineAccountHighlightIndex, filteredAccounts.length - 1);
                                              handleAccountChange(txn, filteredAccounts[selIdx].code, showCustomers ? 'C' : 'S');
                                            }
                                            setInlineAccountSearch(null);
                                            setInlineAccountSearchText('');
                                          }
                                        }}
                                        placeholder={`Search ${showCustomers ? 'customer' : 'supplier'}...`}
                                        data-account-input={`receipts-${txn.row}`}
                                        className={`w-full text-sm px-2 py-1 border-2 rounded focus:ring-2 focus:ring-blue-500 focus:border-blue-500 focus:outline-none ${
                                          editedTxn?.isEdited ? 'border-green-400 bg-green-50' : displayAccount ? 'border-gray-300' : 'border-gray-300'
                                        } ${editedTxn?.manual_account ? 'pr-7' : ''}`}
                                      />
                                      {editedTxn?.manual_account && !(inlineAccountSearch?.row === txn.row && inlineAccountSearch?.section === 'receipts') && (
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setEditedTransactions(prev => { const u = new Map(prev); u.delete(txn.row); return u; });
                                            setSelectedForImport(prev => { const u = new Set(prev); u.delete(txn.row); return u; });
                                          }}
                                          className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-gray-400 hover:text-red-500 rounded-full hover:bg-red-50"
                                          title="Clear account assignment"
                                        >
                                          <X className="h-3.5 w-3.5" />
                                        </button>
                                      )}
                                      {inlineAccountSearch?.row === txn.row && inlineAccountSearch?.section === 'receipts' && (
                                        <>
                                          <div
                                            className="fixed inset-0 z-40"
                                            onClick={() => {
                                              setInlineAccountSearch(null);
                                              setInlineAccountSearchText('');
                                            }}
                                          />
                                          <div className="absolute z-50 w-64 mt-1 bg-white border border-gray-300 rounded-md shadow-lg max-h-48 overflow-y-auto">
                                            {filteredAccounts.map((acc, accIdx) => (
                                              <button
                                                key={acc.code}
                                                type="button"
                                                ref={accIdx === inlineAccountHighlightIndex ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                                                onClick={() => {
                                                  handleAccountChange(txn, acc.code, showCustomers ? 'C' : 'S');
                                                  setInlineAccountSearch(null);
                                                  setInlineAccountSearchText('');
                                                }}
                                                className={`w-full text-left px-2 py-1.5 text-sm ${
                                                  accIdx === inlineAccountHighlightIndex ? 'bg-blue-100' : 'hover:bg-blue-50'
                                                }`}
                                              >
                                                <span className="font-medium">{acc.code}</span>
                                                <span className="text-gray-600"> - {acc.name}</span>
                                              </button>
                                            ))}
                                            {filteredAccounts.length === 0 && (
                                              <div className="px-2 py-1.5 text-sm text-gray-500">No matches found</div>
                                            )}
                                          </div>
                                        </>
                                      )}
                                    </div>
                                    );
                                  })()}
                                  </>
                                  )}
                                </td>
                                <td className="p-2 text-center">
                                  {rowImported ? (
                                    <span className="text-gray-400 text-xs">—</span>
                                  ) : (() => {
                                    const canAutoAllocate = currentTxnType === 'sales_receipt' || currentTxnType === 'purchase_payment' ||
                                                           currentTxnType === 'sales_refund' || currentTxnType === 'purchase_refund';
                                    if (!canAutoAllocate) return <span className="text-gray-400 text-xs">N/A</span>;
                                    if (!hasAccount) return <span className="text-gray-400 text-xs">-</span>;
                                    return (
                                      <input
                                        type="checkbox"
                                        checked={!autoAllocateDisabled.has(txn.row)}
                                        onChange={(e) => {
                                          const updated = new Set(autoAllocateDisabled);
                                          if (e.target.checked) updated.delete(txn.row);
                                          else updated.add(txn.row);
                                          setAutoAllocateDisabled(updated);
                                        }}
                                        className="rounded border-green-400 text-green-600 focus:ring-green-500"
                                        title={!autoAllocateDisabled.has(txn.row) ? 'Auto-allocate to invoices' : 'Post on account (no allocation)'}
                                      />
                                    );
                                  })()}
                                </td>
                                <td className="p-2">
                                  {editedTxn?.isEdited || nominalPostingDetails.has(txn.row) || bankTransferDetails.has(txn.row) ? (
                                    <span className="inline-flex items-center gap-1 text-blue-600 text-xs">
                                      <Edit3 className="h-3 w-3" /> Modified
                                    </span>
                                  ) : txn.match_score ? (
                                    <span className={`inline-flex items-center gap-1 text-xs ${
                                      txn.match_score >= 80 ? 'text-green-600' :
                                      txn.match_score >= 60 ? 'text-amber-600' :
                                      'text-red-600'
                                    }`}>
                                      {txn.match_score >= 80 ? <CheckCircle className="h-3 w-3" /> :
                                       txn.match_score >= 60 ? <AlertCircle className="h-3 w-3" /> :
                                       <XCircle className="h-3 w-3" />}
                                      {txn.match_score >= 80 ? 'Confident' : txn.match_score >= 60 ? 'Review' : 'Low'}
                                    </span>
                                  ) : (
                                    <span className="text-green-600 text-xs">Matched</span>
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
                })()}
                {activePreviewTab === 'receipts' && (bankPreview.matched_receipts?.filter((t: any) => !t.is_duplicate)?.length || 0) === 0 && (
                  <div className="text-center py-8 text-gray-500">No matched receipts found</div>
                )}

                {/* ===== PAYMENTS TAB ===== */}
                {activePreviewTab === 'payments' && (bankPreview.matched_payments?.filter((t: any) => !t.is_duplicate)?.length || 0) > 0 && (() => {
                  const allPayments = (bankPreview.matched_payments || []).filter((t: any) => !t.is_duplicate);
                  const filtered = allPayments.filter(txn =>
                    !tabSearchFilter || txn.name.toLowerCase().includes(tabSearchFilter.toLowerCase()) ||
                    (txn.reference || '').toLowerCase().includes(tabSearchFilter.toLowerCase())
                  );
                  const selectedCount = filtered.filter(t => selectedForImport.has(t.row)).length;
                  const isImported = bankImportResult?.success;
                  const importedRows = new Set((bankImportResult?.imported_transactions || []).map((t: any) => t.row));
                  return (
                    <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                      <div className="flex justify-between items-center mb-2">
                        <h4 className="font-medium text-red-800">
                          {isImported
                            ? `Payments — ${importedRows.size > 0 ? filtered.filter(t => importedRows.has(t.row)).length : 0} posted to Opera`
                            : `Payments (${filtered.length} records / ${selectedCount} to import)`
                          }
                        </h4>
                      </div>
                      <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 bg-red-100 z-10">
                            <tr>
                              <th className="p-1.5 w-12 text-center">
                                <div className="flex flex-col items-center gap-1">
                                  <span className="text-xs">Incl</span>
                                  {!isImported && (
                                    <input
                                      type="checkbox"
                                      checked={filtered.filter(t => !t.is_duplicate).length > 0 && filtered.filter(t => !t.is_duplicate).every(t => selectedForImport.has(t.row))}
                                      onChange={(e) => {
                                        const updated = new Set(selectedForImport);
                                        if (e.target.checked) {
                                          filtered.filter(t => !t.is_duplicate).forEach(t => updated.add(t.row));
                                        } else {
                                          filtered.forEach(t => updated.delete(t.row));
                                        }
                                        setSelectedForImport(updated);
                                      }}
                                      className="rounded border-red-400 text-red-600 focus:ring-red-500"
                                      title="Select/deselect all"
                                    />
                                  )}
                                </div>
                              </th>
                              <th className="text-left p-1.5 w-24">Date</th>
                              <th className="text-left p-1.5">Name</th>
                              <th className="text-right p-1.5 w-24">Amount</th>
                              <th className="text-left p-1.5 w-32">Type</th>
                              <th className="text-left p-1.5 w-28">CB Type</th>
                              <th className="text-left p-1.5 min-w-[150px]">Assign Account</th>
                              <th className="text-center p-1.5 w-16" title="Auto-allocate to invoices after import">
                                <div className="flex flex-col items-center gap-1">
                                  <span className="text-xs">Alloc</span>
                                  {!isImported && (
                                    <input
                                      type="checkbox"
                                      checked={filtered.length > 0 && filtered.every(t => !autoAllocateDisabled.has(t.row))}
                                      onChange={(e) => {
                                        const updated = new Set(autoAllocateDisabled);
                                        if (e.target.checked) {
                                          filtered.forEach(t => updated.delete(t.row));
                                        } else {
                                          filtered.forEach(t => updated.add(t.row));
                                        }
                                        setAutoAllocateDisabled(updated);
                                      }}
                                      className="rounded border-red-400 text-red-600 focus:ring-red-500"
                                      title="Enable/disable allocation for all"
                                    />
                                  )}
                                </div>
                              </th>
                              <th className="text-left p-1.5 w-20">Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filtered.map((txn, idx) => {
                              const rowImported = (isImported && importedRows.has(txn.row)) || alreadyPostedRows.has(txn.row);
                              const editedTxn = editedTransactions.get(txn.row);
                              const isPositive = txn.amount > 0;
                              const defaultTxnType = (txn.action || 'purchase_payment') as TransactionType;
                              const currentTxnType = transactionTypeOverrides.get(txn.row) || defaultTxnType;
                              const showCustomers = currentTxnType === 'sales_receipt' || currentTxnType === 'sales_refund';
                              const isNominal = currentTxnType === 'nominal_receipt' || currentTxnType === 'nominal_payment';
                              const isBankTransfer = currentTxnType === 'bank_transfer';
                              const isNlOrTransfer = isNominal || isBankTransfer;
                              const isTypeOverridden = transactionTypeOverrides.has(txn.row);
                              const displayAccount = editedTxn?.manual_account || (!isTypeOverridden ? txn.account : '');
                              const displayAccountName = editedTxn?.account_name || (!isTypeOverridden ? (txn.account_name || '') : '');
                              const hasAccount = isNlOrTransfer || !!displayAccount;
                              const isIncluded = selectedForImport.has(txn.row);
                              const filteredCbtypes = filterCbtypesForAction(isPositive ? receiptTypes : paymentTypes, currentTxnType);
                              const defaultCbtype = getBestCbtype(currentTxnType, filteredCbtypes, txn.name || txn.memo);
                              const currentCbtype = cbtypeOverrides.get(txn.row) || defaultCbtype;
                              return (
                              <tr key={idx} className={`border-t border-red-200 ${rowImported ? 'bg-green-50' : txn.is_duplicate ? 'bg-amber-50' : isIncluded ? (editedTxn?.isEdited ? 'bg-green-50' : '') : 'opacity-50'}`}>
                                <td className="p-2 text-center">
                                  {rowImported ? (
                                    <span className="inline-flex items-center gap-1 text-green-700 text-xs font-medium">
                                      <CheckCircle className="h-3.5 w-3.5" /> Posted
                                    </span>
                                  ) : txn.is_duplicate ? (
                                    <span className="inline-flex items-center gap-1 text-amber-600 text-xs font-medium" title="This transaction is already in Opera">
                                      <AlertCircle className="h-3.5 w-3.5" /> Already in Opera
                                    </span>
                                  ) : (
                                  <input
                                    type="checkbox"
                                    checked={isIncluded}
                                    disabled={!hasAccount}
                                    onChange={(e) => {
                                      const updated = new Set(selectedForImport);
                                      if (e.target.checked) updated.add(txn.row);
                                      else updated.delete(txn.row);
                                      setSelectedForImport(updated);
                                    }}
                                    className="rounded border-red-400"
                                    title={!hasAccount ? 'Assign an account first to include in import' : ''}
                                  />
                                  )}
                                </td>
                                <td className="p-2">
                                  {txn.period_valid === false && !isImported ? (
                                    <div className="flex items-center gap-1">
                                      <input
                                        type="date"
                                        value={dateOverrides.get(txn.row) || txn.date}
                                        onChange={(e) => {
                                          const newDate = e.target.value;
                                          setDateOverrides(prev => {
                                            const updated = new Map(prev);
                                            if (newDate && newDate !== txn.date) {
                                              updated.set(txn.row, newDate);
                                            } else {
                                              updated.delete(txn.row);
                                            }
                                            return updated;
                                          });
                                        }}
                                        className={`w-32 text-xs border rounded px-1 py-0.5 ${
                                          dateOverrides.has(txn.row) ? 'border-green-400 bg-green-50' : 'border-orange-400 bg-orange-50'
                                        }`}
                                        title={txn.period_error || 'Date outside allowed posting period'}
                                      />
                                      <button
                                        onClick={() => {
                                          const today = new Date().toISOString().split('T')[0];
                                          setDateOverrides(prev => {
                                            const updated = new Map(prev);
                                            updated.set(txn.row, today);
                                            return updated;
                                          });
                                        }}
                                        className="text-xs px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
                                        title="Set to today's date"
                                      >
                                        Today
                                      </button>
                                      {!dateOverrides.has(txn.row) && (
                                        <span title={txn.period_error || 'Date outside allowed posting period'}><AlertCircle className="h-4 w-4 text-orange-500" /></span>
                                      )}
                                      {dateOverrides.has(txn.row) && (
                                        <span title="Date corrected"><CheckCircle className="h-4 w-4 text-green-500" /></span>
                                      )}
                                    </div>
                                  ) : (
                                    txn.date
                                  )}
                                </td>
                                <td className="p-2">
                                  <div className="max-w-xs truncate" title={txn.name}>{txn.name}</div>
                                  {txn.reference && (
                                    <div className="text-xs text-gray-500 truncate" title={txn.reference}>Ref: {txn.reference}</div>
                                  )}
                                </td>
                                <td className={`p-2 text-right font-medium whitespace-nowrap ${isPositive ? 'text-green-700' : 'text-red-700'}`}>
                                  {isPositive ? '+' : '-'}£{Math.abs(txn.amount).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </td>
                                <td className="p-2">
                                  {rowImported ? (
                                    <span className="text-xs text-gray-700">
                                      {currentTxnType === 'purchase_payment' ? 'Purchase Payment'
                                        : currentTxnType === 'sales_refund' ? 'Sales Refund'
                                        : currentTxnType === 'nominal_payment' ? 'Nominal Payment'
                                        : currentTxnType === 'bank_transfer' ? 'Bank Transfer'
                                        : currentTxnType}
                                    </span>
                                  ) : (
                                  <select
                                    value={currentTxnType}
                                    onChange={(e) => {
                                      const newType = e.target.value as TransactionType;
                                      if (newType === 'ignore') {
                                        openIgnoreConfirm(txn);
                                        return;
                                      }
                                      // Reverting to original type - clear all overrides
                                      if (newType === defaultTxnType) {
                                        setTransactionTypeOverrides(prev => { const u = new Map(prev); u.delete(txn.row); return u; });
                                        setEditedTransactions(prev => { const u = new Map(prev); u.delete(txn.row); return u; });
                                        return;
                                      }
                                      const updated = new Map(transactionTypeOverrides);
                                      updated.set(txn.row, newType);
                                      setTransactionTypeOverrides(updated);
                                      // Clear previous account edit for all type changes
                                      const edits = new Map(editedTransactions);
                                      edits.delete(txn.row);
                                      setEditedTransactions(edits);
                                      if (newType === 'nominal_receipt' || newType === 'nominal_payment') {
                                        openNominalDetailModal(txn, newType, 'payments');
                                      } else if (newType === 'bank_transfer') {
                                        openBankTransferModal(txn, 'payments');
                                      } else {
                                        suggestAccountForTransaction(txn, newType);
                                      }
                                    }}
                                    className={`text-xs px-2 py-1 border rounded bg-white w-full ${
                                      isTypeOverridden ? 'border-yellow-400 bg-yellow-50' : 'border-gray-300'
                                    }`}
                                  >
                                    {isPositive ? (
                                      <>
                                        <option value="sales_receipt">Sales Receipt</option>
                                        <option value="purchase_refund">Purchase Refund</option>
                                        <option value="nominal_receipt">Nominal Receipt</option>
                                      </>
                                    ) : (
                                      <>
                                        <option value="purchase_payment">Purchase Payment</option>
                                        <option value="sales_refund">Sales Refund</option>
                                        <option value="nominal_payment">Nominal Payment</option>
                                      </>
                                    )}
                                    <option value="bank_transfer">Bank Transfer</option>
                                    <option value="ignore">Ignore (in Opera)</option>
                                  </select>
                                  )}
                                </td>
                                <td className="p-2">
                                  {rowImported ? (
                                    <span className="text-xs text-gray-500">{currentCbtype || '—'}</span>
                                  ) : filteredCbtypes.length > 0 ? (
                                    <select
                                      value={currentCbtype}
                                      onChange={(e) => {
                                        const updated = new Map(cbtypeOverrides);
                                        updated.set(txn.row, e.target.value);
                                        setCbtypeOverrides(updated);
                                      }}
                                      className={`text-xs px-1 py-1 border rounded w-full ${
                                        cbtypeOverrides.has(txn.row) ? 'border-yellow-400 bg-yellow-50' : 'border-gray-300'
                                      }`}
                                    >
                                      {filteredCbtypes.map(t => (
                                        <option key={t.code} value={t.code}>{t.code} - {t.description}</option>
                                      ))}
                                    </select>
                                  ) : (
                                    <span className="text-xs text-gray-400">Loading...</span>
                                  )}
                                </td>
                                <td className="p-2">
                                  {rowImported ? (
                                    <span className="text-xs text-gray-700">
                                      {isNominal && nominalPostingDetails.has(txn.row)
                                        ? `${nominalPostingDetails.get(txn.row)?.nominalCode} - ${(() => { const nd = nominalPostingDetails.get(txn.row); const na = nominalAccounts.find(n => n.code === nd?.nominalCode); return na?.description || ''; })()}`
                                        : isBankTransfer && bankTransferDetails.has(txn.row)
                                          ? `Transfer → ${bankTransferDetails.get(txn.row)?.destBankCode}`
                                          : displayAccount
                                            ? `${displayAccount} - ${displayAccountName}`
                                            : '—'}
                                    </span>
                                  ) : (
                                  <>
                                  {isNominal ? (
                                    <div>
                                      <button
                                        onClick={() => openNominalDetailModal(txn, currentTxnType, 'payments')}
                                        className={`w-full text-sm px-2 py-1 border rounded flex items-center justify-between ${
                                          nominalPostingDetails.has(txn.row)
                                            ? 'border-green-400 bg-green-50 text-green-700'
                                            : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
                                        }`}
                                      >
                                        {nominalPostingDetails.has(txn.row) ? (
                                          <>
                                            <span className="truncate">
                                              {nominalPostingDetails.get(txn.row)?.nominalCode} - £{nominalPostingDetails.get(txn.row)?.netAmount.toFixed(2)}
                                            </span>
                                            <Edit3 className="h-3 w-3 flex-shrink-0" />
                                          </>
                                        ) : (
                                          <>
                                            <span>Enter Details...</span>
                                            <Edit3 className="h-3 w-3" />
                                          </>
                                        )}
                                      </button>
                                      {nominalPostingDetails.has(txn.row) && (() => {
                                        const nominalDetail = nominalPostingDetails.get(txn.row);
                                        const nominalAcc = nominalAccounts.find(n => n.code === nominalDetail?.nominalCode);
                                        const hasVat = nominalDetail?.vatCode && nominalDetail.vatCode !== 'N/A' && nominalDetail.vatAmount > 0;
                                        return (
                                          <div className="text-xs text-gray-500 mt-1 flex items-center gap-2">
                                            <span className="truncate" title={nominalAcc?.description}>{nominalAcc?.description || 'Unknown'}</span>
                                            {hasVat && <span className="flex-shrink-0 text-green-600">+VAT</span>}
                                          </div>
                                        );
                                      })()}
                                    </div>
                                  ) : isBankTransfer ? (
                                    <button
                                      onClick={() => openBankTransferModal(txn, 'payments')}
                                      className={`w-full text-sm px-2 py-1 border rounded flex items-center justify-between ${
                                        bankTransferDetails.has(txn.row)
                                          ? 'border-green-400 bg-green-50 text-green-700'
                                          : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
                                      }`}
                                    >
                                      {bankTransferDetails.has(txn.row) ? (
                                        <>
                                          <span className="truncate">
                                            {txn.amount < 0 ? 'To: ' : 'From: '}{bankTransferDetails.get(txn.row)?.destBankCode}
                                          </span>
                                          <Edit3 className="h-3 w-3 flex-shrink-0" />
                                        </>
                                      ) : (
                                        <>
                                          <span>Select Bank...</span>
                                          <Landmark className="h-3 w-3" />
                                        </>
                                      )}
                                    </button>
                                  ) : (() => {
                                    const filteredAccounts = (showCustomers ? customers : suppliers)
                                      .filter(acc => {
                                        if (!inlineAccountSearchText) return true;
                                        const search = inlineAccountSearchText.toLowerCase();
                                        return acc.code.toLowerCase().includes(search) ||
                                               acc.name.toLowerCase().includes(search);
                                      })
                                      .slice(0, 50);
                                    return (
                                    <div className="relative">
                                      <input
                                        type="text"
                                        value={inlineAccountSearch?.row === txn.row && inlineAccountSearch?.section === 'payments'
                                          ? inlineAccountSearchText
                                          : (displayAccount
                                            ? `${displayAccount} - ${displayAccountName}`
                                            : '')}
                                        onChange={(e) => {
                                          setInlineAccountSearchText(e.target.value);
                                          setInlineAccountHighlightIndex(0);
                                          if (!inlineAccountSearch || inlineAccountSearch.row !== txn.row) {
                                            setInlineAccountSearch({ row: txn.row, section: 'payments' });
                                          }
                                        }}
                                        onFocus={() => {
                                          setInlineAccountSearch({ row: txn.row, section: 'payments' });
                                          setInlineAccountSearchText('');
                                          setInlineAccountHighlightIndex(0);
                                        }}
                                        onKeyDown={(e) => {
                                          if (e.key === 'ArrowDown') {
                                            e.preventDefault();
                                            if (!inlineAccountSearch || inlineAccountSearch.row !== txn.row) {
                                              setInlineAccountSearch({ row: txn.row, section: 'payments' });
                                            }
                                            if (filteredAccounts.length === 1) {
                                              handleAccountChange(txn, filteredAccounts[0].code, showCustomers ? 'C' : 'S');
                                              setInlineAccountSearch(null);
                                              setInlineAccountSearchText('');
                                            } else if (filteredAccounts.length > 1) {
                                              setInlineAccountHighlightIndex(prev => prev < filteredAccounts.length - 1 ? prev + 1 : prev);
                                            }
                                          } else if (e.key === 'ArrowUp') {
                                            e.preventDefault();
                                            setInlineAccountHighlightIndex(prev => prev > 0 ? prev - 1 : 0);
                                          } else if (e.key === 'Enter') {
                                            e.preventDefault();
                                            if (inlineAccountSearchText.length > 0 && filteredAccounts.length > 0) {
                                              const selIdx = Math.min(inlineAccountHighlightIndex, filteredAccounts.length - 1);
                                              handleAccountChange(txn, filteredAccounts[selIdx].code, showCustomers ? 'C' : 'S');
                                            }
                                            setInlineAccountSearch(null);
                                            setInlineAccountSearchText('');
                                          } else if (e.key === 'Escape') {
                                            setInlineAccountSearch(null);
                                            setInlineAccountSearchText('');
                                            (e.target as HTMLInputElement).blur();
                                          } else if (e.key === 'Tab') {
                                            if (inlineAccountSearchText.length > 0 && filteredAccounts.length > 0) {
                                              const selIdx = Math.min(inlineAccountHighlightIndex, filteredAccounts.length - 1);
                                              handleAccountChange(txn, filteredAccounts[selIdx].code, showCustomers ? 'C' : 'S');
                                            }
                                            setInlineAccountSearch(null);
                                            setInlineAccountSearchText('');
                                          }
                                        }}
                                        placeholder={`Search ${showCustomers ? 'customer' : 'supplier'}...`}
                                        data-account-input={`payments-${txn.row}`}
                                        className={`w-full text-sm px-2 py-1 border-2 rounded focus:ring-2 focus:ring-blue-500 focus:border-blue-500 focus:outline-none ${
                                          editedTxn?.isEdited ? 'border-green-400 bg-green-50' : displayAccount ? 'border-gray-300' : 'border-gray-300'
                                        } ${editedTxn?.manual_account ? 'pr-7' : ''}`}
                                      />
                                      {editedTxn?.manual_account && !(inlineAccountSearch?.row === txn.row && inlineAccountSearch?.section === 'payments') && (
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setEditedTransactions(prev => { const u = new Map(prev); u.delete(txn.row); return u; });
                                            setSelectedForImport(prev => { const u = new Set(prev); u.delete(txn.row); return u; });
                                          }}
                                          className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-gray-400 hover:text-red-500 rounded-full hover:bg-red-50"
                                          title="Clear account assignment"
                                        >
                                          <X className="h-3.5 w-3.5" />
                                        </button>
                                      )}
                                      {inlineAccountSearch?.row === txn.row && inlineAccountSearch?.section === 'payments' && (
                                        <>
                                          <div
                                            className="fixed inset-0 z-40"
                                            onClick={() => {
                                              setInlineAccountSearch(null);
                                              setInlineAccountSearchText('');
                                            }}
                                          />
                                          <div className="absolute z-50 w-64 mt-1 bg-white border border-gray-300 rounded-md shadow-lg max-h-48 overflow-y-auto">
                                            {filteredAccounts.map((acc, accIdx) => (
                                              <button
                                                key={acc.code}
                                                type="button"
                                                ref={accIdx === inlineAccountHighlightIndex ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                                                onClick={() => {
                                                  handleAccountChange(txn, acc.code, showCustomers ? 'C' : 'S');
                                                  setInlineAccountSearch(null);
                                                  setInlineAccountSearchText('');
                                                }}
                                                className={`w-full text-left px-2 py-1.5 text-sm ${
                                                  accIdx === inlineAccountHighlightIndex ? 'bg-blue-100' : 'hover:bg-blue-50'
                                                }`}
                                              >
                                                <span className="font-medium">{acc.code}</span>
                                                <span className="text-gray-600"> - {acc.name}</span>
                                              </button>
                                            ))}
                                            {filteredAccounts.length === 0 && (
                                              <div className="px-2 py-1.5 text-sm text-gray-500">No matches found</div>
                                            )}
                                          </div>
                                        </>
                                      )}
                                    </div>
                                    );
                                  })()}
                                  </>
                                  )}
                                </td>
                                <td className="p-2 text-center">
                                  {rowImported ? (
                                    <span className="text-gray-400 text-xs">—</span>
                                  ) : (() => {
                                    const canAutoAllocate = currentTxnType === 'sales_receipt' || currentTxnType === 'purchase_payment' ||
                                                           currentTxnType === 'sales_refund' || currentTxnType === 'purchase_refund';
                                    if (!canAutoAllocate) return <span className="text-gray-400 text-xs">N/A</span>;
                                    if (!hasAccount) return <span className="text-gray-400 text-xs">-</span>;
                                    return (
                                      <input
                                        type="checkbox"
                                        checked={!autoAllocateDisabled.has(txn.row)}
                                        onChange={(e) => {
                                          const updated = new Set(autoAllocateDisabled);
                                          if (e.target.checked) updated.delete(txn.row);
                                          else updated.add(txn.row);
                                          setAutoAllocateDisabled(updated);
                                        }}
                                        className="rounded border-red-400 text-red-600 focus:ring-red-500"
                                        title={!autoAllocateDisabled.has(txn.row) ? 'Auto-allocate to invoices' : 'Post on account (no allocation)'}
                                      />
                                    );
                                  })()}
                                </td>
                                <td className="p-2">
                                  {editedTxn?.isEdited || nominalPostingDetails.has(txn.row) || bankTransferDetails.has(txn.row) ? (
                                    <span className="inline-flex items-center gap-1 text-blue-600 text-xs">
                                      <Edit3 className="h-3 w-3" /> Modified
                                    </span>
                                  ) : txn.match_score ? (
                                    <span className={`inline-flex items-center gap-1 text-xs ${
                                      txn.match_score >= 80 ? 'text-green-600' :
                                      txn.match_score >= 60 ? 'text-amber-600' :
                                      'text-red-600'
                                    }`}>
                                      {txn.match_score >= 80 ? <CheckCircle className="h-3 w-3" /> :
                                       txn.match_score >= 60 ? <AlertCircle className="h-3 w-3" /> :
                                       <XCircle className="h-3 w-3" />}
                                      {txn.match_score >= 80 ? 'Confident' : txn.match_score >= 60 ? 'Review' : 'Low'}
                                    </span>
                                  ) : (
                                    <span className="text-green-600 text-xs">Matched</span>
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
                })()}
                {activePreviewTab === 'payments' && (bankPreview.matched_payments?.filter((t: any) => !t.is_duplicate)?.length || 0) === 0 && (
                  <div className="text-center py-8 text-gray-500">No matched payments found</div>
                )}

                {/* ===== REFUNDS TAB ===== */}
                {activePreviewTab === 'refunds' && (() => {
                  const refunds = (bankPreview.matched_refunds || []).filter((t: any) => !t.is_duplicate);
                  const activeRefunds = refunds.filter(txn => !refundOverrides.get(txn.row)?.rejected);
                  const rejectedCount = refunds.filter(txn => refundOverrides.get(txn.row)?.rejected).length;
                  const filtered = activeRefunds.filter(txn =>
                    !tabSearchFilter || txn.name.toLowerCase().includes(tabSearchFilter.toLowerCase()) ||
                    (txn.reference || '').toLowerCase().includes(tabSearchFilter.toLowerCase())
                  );
                  const selectedCount = filtered.filter(t => selectedForImport.has(t.row)).length;
                  const isImported = bankImportResult?.success;
                  const importedRows = new Set((bankImportResult?.imported_transactions || []).map((t: any) => t.row));
                  if (refunds.length === 0) return <div className="text-center py-8 text-gray-500">No refunds detected</div>;
                  return (
                    <div className="bg-orange-50 border border-orange-200 rounded-lg p-4">
                      <div className="flex justify-between items-center mb-3">
                        <h4 className="font-medium text-orange-800">
                          {isImported
                            ? `Refunds — ${importedRows.size > 0 ? filtered.filter(t => importedRows.has(t.row)).length : 0} posted to Opera`
                            : <>Refunds ({filtered.length} records / {selectedCount} to import)
                                {rejectedCount > 0 && (
                                  <span className="text-sm font-normal ml-2 text-red-600">
                                    ({rejectedCount} rejected)
                                  </span>
                                )}
                              </>
                          }
                        </h4>
                        <div className="flex gap-2">
                          <button
                            onClick={() => {
                              const updated = new Set(selectedForImport);
                              filtered.filter(t => !t.is_duplicate).forEach(t => updated.add(t.row));
                              setSelectedForImport(updated);
                            }}
                            className="text-xs px-2 py-1 bg-orange-200 text-orange-800 rounded hover:bg-orange-300"
                          >
                            Select All
                          </button>
                          <button
                            onClick={() => {
                              const updated = new Set(selectedForImport);
                              filtered.forEach(t => updated.delete(t.row));
                              setSelectedForImport(updated);
                            }}
                            className="text-xs px-2 py-1 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
                          >
                            Deselect All
                          </button>
                          {refundOverrides.size > 0 && (
                            <button
                              onClick={() => setRefundOverrides(new Map())}
                              className="text-xs px-2 py-1 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 flex items-center gap-1"
                            >
                              <RotateCcw className="h-3 w-3" /> Reset Changes
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="text-xs text-orange-700 mb-3 bg-orange-100 p-2 rounded">
                        Review auto-detected refunds. Change type or account if needed. Uncheck to exclude from import.
                      </div>
                      <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 bg-orange-100 z-10">
                            <tr>
                              <th className="p-2 w-16 text-left">Include</th>
                              <th className="text-left p-2">Date</th>
                              <th className="text-left p-2">Name</th>
                              <th className="text-right p-2 min-w-[110px]">Amount</th>
                              <th className="text-left p-2 min-w-[140px]">Type</th>
                              <th className="text-left p-2 min-w-[180px]">Account</th>
                              <th className="text-left p-2">Credit Note</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filtered.map((txn) => {
                              const override = refundOverrides.get(txn.row);
                              const currentType = override?.transaction_type || txn.action as TransactionType;
                              const showCustomers = currentType === 'sales_receipt' || currentType === 'sales_refund';
                              const isNominalRef = currentType === 'nominal_receipt' || currentType === 'nominal_payment';
                              const isBankTransferRef = currentType === 'bank_transfer';
                              const currentAccount = override?.account || txn.account;
                              const isModified = override && (override.transaction_type || override.account);
                              const isSelected = selectedForImport.has(txn.row);
                              const isPositiveRef = txn.amount > 0;
                              const rowImported = (isImported && importedRows.has(txn.row)) || alreadyPostedRows.has(txn.row);
                              return (
                                <tr key={txn.row} className={`border-t border-orange-200 ${rowImported ? 'bg-green-50' : txn.is_duplicate ? 'bg-amber-50' : isModified ? 'bg-yellow-50' : ''} ${!rowImported && !txn.is_duplicate && !isSelected ? 'opacity-50' : ''}`}>
                                  <td className="p-2">
                                    {rowImported ? (
                                      <span className="inline-flex items-center gap-1 text-green-700 text-xs font-medium">
                                        <CheckCircle className="h-3.5 w-3.5" /> Posted
                                      </span>
                                    ) : txn.is_duplicate ? (
                                      <span className="inline-flex items-center gap-1 text-amber-600 text-xs font-medium" title="This transaction is already in Opera">
                                        <AlertCircle className="h-3.5 w-3.5" /> Already in Opera
                                      </span>
                                    ) : (
                                    <input
                                      type="checkbox"
                                      checked={isSelected}
                                      onChange={(e) => {
                                        const updated = new Set(selectedForImport);
                                        if (e.target.checked) updated.add(txn.row);
                                        else updated.delete(txn.row);
                                        setSelectedForImport(updated);
                                      }}
                                      className="rounded border-orange-400"
                                    />
                                    )}
                                  </td>
                                  <td className="p-2">
                                    {txn.period_valid === false ? (
                                      <div className="flex items-center gap-1">
                                        <input
                                          type="date"
                                          value={dateOverrides.get(txn.row) || txn.date}
                                          onChange={(e) => {
                                            const newDate = e.target.value;
                                            setDateOverrides(prev => {
                                              const updated = new Map(prev);
                                              if (newDate && newDate !== txn.date) {
                                                updated.set(txn.row, newDate);
                                              } else {
                                                updated.delete(txn.row);
                                              }
                                              return updated;
                                            });
                                          }}
                                          className={`w-32 text-xs border rounded px-1 py-0.5 ${
                                            dateOverrides.has(txn.row) ? 'border-green-400 bg-green-50' : 'border-orange-400 bg-orange-50'
                                          }`}
                                          title={txn.period_error || 'Date outside allowed posting period'}
                                        />
                                        <button
                                          onClick={() => {
                                            const today = new Date().toISOString().split('T')[0];
                                            setDateOverrides(prev => {
                                              const updated = new Map(prev);
                                              updated.set(txn.row, today);
                                              return updated;
                                            });
                                          }}
                                          className="text-xs px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
                                          title="Set to today's date"
                                        >
                                          Today
                                        </button>
                                        {!dateOverrides.has(txn.row) && (
                                          <span title={txn.period_error || 'Date outside allowed posting period'}><AlertCircle className="h-4 w-4 text-orange-500" /></span>
                                        )}
                                        {dateOverrides.has(txn.row) && (
                                          <span title="Date corrected"><CheckCircle className="h-4 w-4 text-green-500" /></span>
                                        )}
                                      </div>
                                    ) : (
                                      txn.date
                                    )}
                                  </td>
                                  <td className="p-2">
                                    <div className="max-w-xs truncate" title={txn.name}>{txn.name}</div>
                                  </td>
                                  <td className={`p-2 text-right font-medium whitespace-nowrap ${txn.amount > 0 ? 'text-green-700' : 'text-red-700'}`}>
                                    {txn.amount > 0 ? '+' : '-'}£{Math.abs(txn.amount).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                  </td>
                                  <td className="p-2">
                                    <select
                                      value={currentType}
                                      onChange={(e) => {
                                        const newType = e.target.value as TransactionType;
                                        if (newType === 'ignore') {
                                          openIgnoreConfirm(txn);
                                          return;
                                        }
                                        const updated = new Map(refundOverrides);
                                        const current = updated.get(txn.row) || {};
                                        const nowCustomer = newType === 'sales_receipt' || newType === 'sales_refund';
                                        const wasCustomer = currentType === 'sales_receipt' || currentType === 'sales_refund';
                                        updated.set(txn.row, {
                                          ...current,
                                          transaction_type: newType,
                                          ledger_type: nowCustomer ? 'C' : 'S',
                                          // Reset account if ledger type changed
                                          account: nowCustomer !== wasCustomer ? undefined : current.account
                                        });
                                        setRefundOverrides(updated);
                                        // Open appropriate modal for special types
                                        if (newType === 'nominal_receipt' || newType === 'nominal_payment') {
                                          openNominalDetailModal(txn, newType, 'refund');
                                        } else if (newType === 'bank_transfer') {
                                          openBankTransferModal(txn, 'refund');
                                        }
                                      }}
                                      className={`text-xs px-2 py-1 border rounded bg-white w-full ${
                                        override?.transaction_type ? 'border-yellow-400 bg-yellow-50' : 'border-gray-300'
                                      }`}
                                    >
                                      {/* Restrict based on credit/debit. Refunds are typically opposite sign */}
                                      {isPositiveRef ? (
                                        <>
                                          <option value="sales_receipt">Sales Receipt</option>
                                          <option value="purchase_refund">Purchase Refund</option>
                                          <option value="nominal_receipt">Nominal Receipt</option>
                                        </>
                                      ) : (
                                        <>
                                          <option value="purchase_payment">Purchase Payment</option>
                                          <option value="sales_refund">Sales Refund</option>
                                          <option value="nominal_payment">Nominal Payment</option>
                                        </>
                                      )}
                                      <option value="bank_transfer">Bank Transfer</option>
                                      <option value="ignore">Ignore (in Opera)</option>
                                    </select>
                                  </td>
                                  <td className="p-2">
                                    {isNominalRef ? (
                                      <div>
                                        <button
                                          onClick={() => openNominalDetailModal(txn, currentType, 'refund')}
                                          className={`w-full text-xs px-2 py-1 border rounded flex items-center justify-between ${
                                            nominalPostingDetails.has(txn.row)
                                              ? 'border-green-400 bg-green-50 text-green-700'
                                              : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
                                          }`}
                                        >
                                          {nominalPostingDetails.has(txn.row) ? (
                                            <>
                                              <span className="truncate">
                                                {nominalPostingDetails.get(txn.row)?.nominalCode} - £{nominalPostingDetails.get(txn.row)?.netAmount.toFixed(2)}
                                              </span>
                                              <Edit3 className="h-3 w-3 flex-shrink-0" />
                                            </>
                                          ) : (
                                            <>
                                              <span>Enter Details...</span>
                                              <Edit3 className="h-3 w-3" />
                                            </>
                                          )}
                                        </button>
                                        {nominalPostingDetails.has(txn.row) && (() => {
                                          const nominalDetail = nominalPostingDetails.get(txn.row);
                                          const nominalAcc = nominalAccounts.find(n => n.code === nominalDetail?.nominalCode);
                                          const hasVat = nominalDetail?.vatCode && nominalDetail.vatCode !== 'N/A' && nominalDetail.vatAmount > 0;
                                          return (
                                            <div className="text-xs text-gray-500 mt-1 flex items-center gap-2">
                                              <span className="truncate" title={nominalAcc?.description}>{nominalAcc?.description || 'Unknown'}</span>
                                              {hasVat && <span className="flex-shrink-0 text-green-600">+VAT</span>}
                                            </div>
                                          );
                                        })()}
                                      </div>
                                    ) : isBankTransferRef ? (
                                      <button
                                        onClick={() => openBankTransferModal(txn, 'refund')}
                                        className={`w-full text-xs px-2 py-1 border rounded flex items-center justify-between ${
                                          bankTransferDetails.has(txn.row)
                                            ? 'border-green-400 bg-green-50 text-green-700'
                                            : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
                                        }`}
                                      >
                                        {bankTransferDetails.has(txn.row) ? (
                                          <>
                                            <span className="truncate">
                                              {txn.amount < 0 ? 'To: ' : 'From: '}{bankTransferDetails.get(txn.row)?.destBankCode}
                                            </span>
                                            <Edit3 className="h-3 w-3 flex-shrink-0" />
                                          </>
                                        ) : (
                                          <>
                                            <span>Select Bank...</span>
                                            <Landmark className="h-3 w-3" />
                                          </>
                                        )}
                                      </button>
                                    ) : (() => {
                                      const filteredAccounts = (showCustomers ? customers : suppliers)
                                        .filter(acc => {
                                          if (!inlineAccountSearchText) return true;
                                          const search = inlineAccountSearchText.toLowerCase();
                                          return acc.code.toLowerCase().includes(search) ||
                                                 acc.name.toLowerCase().includes(search);
                                        })
                                        .slice(0, 50);
                                      return (
                                      <div className="relative">
                                        <input
                                          type="text"
                                          value={inlineAccountSearch?.row === txn.row && inlineAccountSearch?.section === 'refund'
                                            ? inlineAccountSearchText
                                            : (override?.account
                                              ? `${override.account} - ${(showCustomers ? customers : suppliers).find(a => a.code === override.account)?.name || ''}`
                                              : `${currentAccount} - ${txn.account_name || '(matched)'}`)}
                                          onChange={(e) => {
                                            setInlineAccountSearchText(e.target.value);
                                            setInlineAccountHighlightIndex(0);
                                            if (!inlineAccountSearch || inlineAccountSearch.row !== txn.row) {
                                              setInlineAccountSearch({ row: txn.row, section: 'refund' });
                                            }
                                          }}
                                          onFocus={() => {
                                            setInlineAccountSearch({ row: txn.row, section: 'refund' });
                                            setInlineAccountSearchText('');
                                            setInlineAccountHighlightIndex(0);
                                          }}
                                          onKeyDown={(e) => {
                                            // Check if this field was already filled (editing vs new)
                                            const wasAlreadyFilled = override?.account || txn.account;

                                            // Helper to move to next row's account input (only for new entries)
                                            const moveToNextRow = () => {
                                              if (wasAlreadyFilled) return; // Don't auto-advance when editing
                                              const currentIdx = filtered.findIndex(t => t.row === txn.row);
                                              if (currentIdx >= 0 && currentIdx < filtered.length - 1) {
                                                const nextRow = filtered[currentIdx + 1];
                                                setTimeout(() => {
                                                  const nextInput = document.querySelector(`[data-account-input="refund-${nextRow.row}"]`) as HTMLInputElement;
                                                  if (nextInput) nextInput.focus();
                                                }, 10);
                                              }
                                            };

                                            if (e.key === 'ArrowDown') {
                                              e.preventDefault();
                                              // Ensure dropdown is open
                                              if (!inlineAccountSearch || inlineAccountSearch.row !== txn.row) {
                                                setInlineAccountSearch({ row: txn.row, section: 'refund' });
                                              }
                                              // If only one result, select it and move to next row
                                              if (filteredAccounts.length === 1) {
                                                const selectedAcc = filteredAccounts[0];
                                                const updated = new Map(refundOverrides);
                                                const current = updated.get(txn.row) || {};
                                                updated.set(txn.row, {
                                                  ...current,
                                                  account: selectedAcc.code,
                                                  ledger_type: showCustomers ? 'C' : 'S'
                                                });
                                                setRefundOverrides(updated);
                                                setInlineAccountSearch(null);
                                                setInlineAccountSearchText('');
                                                moveToNextRow();
                                              } else if (filteredAccounts.length > 1) {
                                                setInlineAccountHighlightIndex(prev =>
                                                  prev < filteredAccounts.length - 1 ? prev + 1 : prev
                                                );
                                              }
                                            } else if (e.key === 'ArrowUp') {
                                              e.preventDefault();
                                              if (filteredAccounts.length > 0) {
                                                setInlineAccountHighlightIndex(prev => prev > 0 ? prev - 1 : 0);
                                              }
                                            } else if (e.key === 'Enter') {
                                              e.preventDefault();
                                              // If user hasn't typed any search text, close dropdown (don't auto-advance when editing)
                                              const userIsSearching = inlineAccountSearchText.length > 0;

                                              if (!userIsSearching) {
                                                // No search text - close dropdown, only advance if new entry
                                                setInlineAccountSearch(null);
                                                setInlineAccountSearchText('');
                                                if (!wasAlreadyFilled) moveToNextRow();
                                              } else if (filteredAccounts.length > 0) {
                                                // User typed search and there are results - select highlighted item
                                                const idx = Math.min(inlineAccountHighlightIndex, filteredAccounts.length - 1);
                                                const selectedAcc = filteredAccounts[idx];
                                                if (selectedAcc) {
                                                  const updated = new Map(refundOverrides);
                                                  const current = updated.get(txn.row) || {};
                                                  updated.set(txn.row, {
                                                    ...current,
                                                    account: selectedAcc.code,
                                                    ledger_type: showCustomers ? 'C' : 'S'
                                                  });
                                                  setRefundOverrides(updated);
                                                  setInlineAccountSearch(null);
                                                  setInlineAccountSearchText('');
                                                  moveToNextRow();
                                                }
                                              } else {
                                                // User typed search but no results - close dropdown
                                                setInlineAccountSearch(null);
                                                setInlineAccountSearchText('');
                                              }
                                            } else if (e.key === 'Escape') {
                                              setInlineAccountSearch(null);
                                              setInlineAccountSearchText('');
                                              (e.target as HTMLInputElement).blur();
                                            } else if (e.key === 'Tab') {
                                              // Select highlighted item on Tab if user was searching, then let Tab move focus
                                              if (inlineAccountSearchText.length > 0 && filteredAccounts.length > 0) {
                                                const idx = Math.min(inlineAccountHighlightIndex, filteredAccounts.length - 1);
                                                const selectedAcc = filteredAccounts[idx];
                                                if (selectedAcc) {
                                                  const updated = new Map(refundOverrides);
                                                  const current = updated.get(txn.row) || {};
                                                  updated.set(txn.row, {
                                                    ...current,
                                                    account: selectedAcc.code,
                                                    ledger_type: showCustomers ? 'C' : 'S'
                                                  });
                                                  setRefundOverrides(updated);
                                                }
                                              }
                                              setInlineAccountSearch(null);
                                              setInlineAccountSearchText('');
                                            }
                                          }}
                                          placeholder={`Search ${showCustomers ? 'customer' : 'supplier'}...`}
                                          data-account-input={`refund-${txn.row}`}
                                          className={`w-full text-xs px-2 py-1 border-2 rounded focus:ring-2 focus:ring-blue-500 focus:border-blue-500 focus:outline-none ${
                                            override?.account ? 'border-yellow-400 bg-yellow-50' : 'border-gray-300'
                                          } ${override?.account ? 'pr-7' : ''}`}
                                        />
                                        {override?.account && !(inlineAccountSearch?.row === txn.row && inlineAccountSearch?.section === 'refund') && (
                                          <button
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setRefundOverrides(prev => { const u = new Map(prev); u.delete(txn.row); return u; });
                                              setSelectedForImport(prev => { const u = new Set(prev); u.delete(txn.row); return u; });
                                            }}
                                            className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-gray-400 hover:text-red-500 rounded-full hover:bg-red-50"
                                            title="Clear account assignment"
                                          >
                                            <X className="h-3.5 w-3.5" />
                                          </button>
                                        )}
                                        {inlineAccountSearch?.row === txn.row && inlineAccountSearch?.section === 'refund' && (
                                          <>
                                            {/* Click-outside overlay - rendered first so dropdown is on top */}
                                            <div
                                              className="fixed inset-0 z-40"
                                              onClick={() => {
                                                setInlineAccountSearch(null);
                                                setInlineAccountSearchText('');
                                              }}
                                            />
                                            <div className="absolute z-50 w-64 mt-1 bg-white border border-gray-300 rounded-md shadow-lg max-h-48 overflow-y-auto">
                                              {filteredAccounts.map((acc, idx) => (
                                                  <button
                                                    key={acc.code}
                                                    type="button"
                                                    ref={idx === inlineAccountHighlightIndex ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                                                    onClick={() => {
                                                      // Check if this was already filled (editing) vs new entry
                                                      const wasAlreadyFilled = override?.account || txn.account;
                                                      const updated = new Map(refundOverrides);
                                                      const current = updated.get(txn.row) || {};
                                                      updated.set(txn.row, {
                                                        ...current,
                                                        account: acc.code,
                                                        ledger_type: showCustomers ? 'C' : 'S'
                                                      });
                                                      setRefundOverrides(updated);
                                                      setInlineAccountSearch(null);
                                                      setInlineAccountSearchText('');
                                                      // Only move to next row if this was a new entry, not an edit
                                                      if (!wasAlreadyFilled) {
                                                        const currentIdx = filtered.findIndex(t => t.row === txn.row);
                                                        if (currentIdx >= 0 && currentIdx < filtered.length - 1) {
                                                          const nextRow = filtered[currentIdx + 1];
                                                          setTimeout(() => {
                                                            const nextInput = document.querySelector(`[data-account-input="refund-${nextRow.row}"]`) as HTMLInputElement;
                                                            if (nextInput) nextInput.focus();
                                                          }, 10);
                                                        }
                                                      }
                                                    }}
                                                    className={`w-full text-left px-2 py-1.5 text-sm ${
                                                      idx === inlineAccountHighlightIndex ? 'bg-blue-100' : 'hover:bg-blue-50'
                                                    }`}
                                                  >
                                                    <span className="font-medium">{acc.code}</span>
                                                    <span className="text-gray-600"> - {acc.name}</span>
                                                  </button>
                                                ))}
                                              {filteredAccounts.length === 0 && (
                                                <div className="px-2 py-1.5 text-sm text-gray-500">No matches found</div>
                                              )}
                                            </div>
                                          </>
                                        )}
                                      </div>
                                      );
                                    })()}
                                  </td>
                                  <td className="p-2">
                                    {txn.refund_credit_note && (
                                      <div>
                                        <span className="font-mono text-xs">{txn.refund_credit_note}</span>
                                        {txn.refund_credit_amount != null && (
                                          <span className="text-xs text-gray-500 ml-1">
                                            (£{txn.refund_credit_amount.toFixed(2)})
                                          </span>
                                        )}
                                      </div>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      {refundOverrides.size > 0 && (
                        <div className="mt-3 p-3 bg-yellow-50 border border-yellow-200 rounded flex items-center gap-2 text-yellow-800">
                          <Edit3 className="h-4 w-4" />
                          <span className="text-sm">
                            {Array.from(refundOverrides.values()).filter(v => v.transaction_type || v.account).length} refund(s) modified
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* ===== REPEAT ENTRIES TAB ===== */}
                {activePreviewTab === 'repeat' && (() => {
                  const repeatEntries = bankPreview.repeat_entries || [];
                  const filtered = repeatEntries.filter(txn =>
                    !tabSearchFilter || txn.name.toLowerCase().includes(tabSearchFilter.toLowerCase()) ||
                    (txn.reference || '').toLowerCase().includes(tabSearchFilter.toLowerCase()) ||
                    (txn.repeat_entry_desc || '').toLowerCase().includes(tabSearchFilter.toLowerCase())
                  );
                  if (repeatEntries.length === 0) return <div className="text-center py-8 text-gray-500">No repeat entries detected</div>;
                  const handleUpdateRepeatEntryDate = async (entryRef: string, bankCode: string, newDate: string, statementName?: string, learnAlias: boolean = true) => {
                    setUpdatingRepeatEntry(entryRef);
                    try {
                      let url = `${API_BASE}/bank-import/update-repeat-entry-date?entry_ref=${encodeURIComponent(entryRef)}&bank_code=${encodeURIComponent(bankCode)}&new_date=${encodeURIComponent(newDate)}`;
                      // Include statement name for learning if user opted in
                      if (learnAlias && statementName) {
                        url += `&statement_name=${encodeURIComponent(statementName)}`;
                      }
                      const res = await authFetch(url, { method: 'POST' });
                      const data = await res.json();
                      if (data.success) {
                        setUpdatedRepeatEntries(prev => new Set(prev).add(entryRef));
                        if (data.alias_saved) {
                          console.log(`Saved alias for future matching: ${statementName} -> ${entryRef}`);
                        }
                      } else {
                        alert(`Failed to update: ${data.error}`);
                      }
                    } catch (err) {
                      alert(`Error: ${err}`);
                    } finally {
                      setUpdatingRepeatEntry(null);
                    }
                  };

                  const allUpdated = filtered.every(t => updatedRepeatEntries.has(t.repeat_entry_ref || ''));
                  const someUpdated = filtered.some(t => updatedRepeatEntries.has(t.repeat_entry_ref || ''));

                  return (
                    <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
                      <div className="flex justify-between items-center mb-3">
                        <h4 className="font-medium text-purple-800">
                          Repeat Entries ({filtered.length})
                          {someUpdated && !allUpdated && (
                            <span className="ml-2 text-sm font-normal text-purple-600">
                              ({updatedRepeatEntries.size} updated)
                            </span>
                          )}
                        </h4>
                        {allUpdated && filtered.length > 0 && !repeatEntriesProcessed && (
                          <button
                            onClick={() => setRepeatEntriesProcessed(true)}
                            className="text-xs bg-green-600 hover:bg-green-700 text-white px-3 py-1.5 rounded flex items-center gap-1 transition-colors"
                          >
                            <CheckCircle className="h-3 w-3" /> Recurring entries posted in Opera - continue import
                          </button>
                        )}
                        {repeatEntriesProcessed && (
                          <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded flex items-center gap-1">
                            <CheckCircle className="h-3 w-3" /> Processed - ready to import
                          </span>
                        )}
                      </div>

                      {/* Period blocked warning */}
                      {filtered.some(txn => (txn.outstanding_blocked ?? 0) > 0) && (
                        <div className="text-xs mb-3 p-3 rounded bg-red-50 text-red-800 border border-red-200">
                          <strong>Period blocked:</strong> Some recurring entries have outstanding postings in closed or blocked periods on the Nominal Ledger calendar.
                          These entries will not be posted until the period is opened in Opera.
                        </div>
                      )}

                      {/* Workflow Instructions */}
                      <div className={`text-xs mb-3 p-3 rounded ${allUpdated ? 'bg-green-100 text-green-800' : 'bg-purple-100 text-purple-800'}`}>
                        <strong>Workflow to avoid duplicates:</strong>
                        <ol className="list-decimal ml-4 mt-1 space-y-1">
                          <li className={updatedRepeatEntries.size === filtered.length ? 'line-through opacity-60' : ''}>
                            Update the Next Post Date for each entry below to match the bank statement date
                          </li>
                          <li>In Opera, go to <strong>Cashbook → Repeat Entries → Post</strong> to process these entries</li>
                          <li>Return here and click <strong>Analyse Transactions</strong> again - these will now show as "Already Posted"</li>
                          <li>Import the remaining transactions</li>
                        </ol>
                      </div>

                      <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 bg-purple-100 z-10">
                            <tr>
                              <th className="text-left p-2">Status</th>
                              <th className="text-left p-2">Statement Date</th>
                              <th className="text-left p-2">Name</th>
                              <th className="text-right p-2 min-w-[110px]">Amount</th>
                              <th className="text-left p-2">Entry Ref</th>
                              <th className="text-left p-2">Description</th>
                              <th className="text-left p-2">Current Next Post</th>
                              <th className="text-left p-2">Outstanding</th>
                              <th className="text-left p-2">Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filtered.map((txn) => {
                              const isUpdated = updatedRepeatEntries.has(txn.repeat_entry_ref || '');
                              const isUpdating = updatingRepeatEntry === txn.repeat_entry_ref;
                              const needsUpdate = txn.date !== txn.repeat_entry_next_date;
                              return (
                                <tr key={txn.row} className={`border-t border-purple-200 ${(txn.outstanding_blocked ?? 0) > 0 && txn.outstanding_open === 0 ? 'bg-red-50' : (txn.outstanding_blocked ?? 0) > 0 ? 'bg-orange-50' : isUpdated ? 'bg-green-50' : txn.is_duplicate ? 'bg-amber-50' : 'hover:bg-purple-100/50'}`}>
                                  <td className="p-2">
                                    {(txn.outstanding_blocked ?? 0) > 0 && txn.outstanding_open === 0 ? (
                                      <span className="text-red-600 flex items-center gap-1" title={txn.outstanding_postings?.[0]?.period_error || 'Period is blocked'}>
                                        <XCircle className="h-4 w-4" />
                                        <span className="text-xs">Period Blocked</span>
                                      </span>
                                    ) : (txn.outstanding_blocked ?? 0) > 0 ? (
                                      <span className="text-orange-600 flex items-center gap-1" title={`${txn.outstanding_blocked} of ${txn.outstanding_count} entries in blocked periods`}>
                                        <AlertCircle className="h-4 w-4" />
                                        <span className="text-xs">Partial Block</span>
                                      </span>
                                    ) : isUpdated ? (
                                      <span className="text-green-600 flex items-center gap-1">
                                        <CheckCircle className="h-4 w-4" />
                                        <span className="text-xs">Updated</span>
                                      </span>
                                    ) : txn.is_duplicate ? (
                                      <span className="text-amber-600 flex items-center gap-1" title={txn.reason || 'Already posted'}>
                                        <AlertCircle className="h-4 w-4" />
                                        <span className="text-xs">Posted</span>
                                      </span>
                                    ) : (
                                      <span className="text-purple-600 flex items-center gap-1">
                                        <RefreshCw className="h-4 w-4" />
                                        <span className="text-xs">Pending</span>
                                      </span>
                                    )}
                                  </td>
                                  <td className="p-2 font-medium">{txn.date}</td>
                                  <td className="p-2">
                                    <div className="max-w-[150px] truncate" title={txn.name}>{txn.name}</div>
                                  </td>
                                  <td className={`p-2 text-right font-medium whitespace-nowrap ${txn.amount >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                    {txn.amount >= 0 ? '+' : ''}£{Math.abs(txn.amount).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                  </td>
                                  <td className="p-2">
                                    <span className="bg-purple-200 text-purple-800 px-2 py-0.5 rounded text-xs font-mono">
                                      {txn.repeat_entry_ref || '-'}
                                    </span>
                                  </td>
                                  <td className="p-2 text-purple-700 text-xs">{txn.repeat_entry_desc || '-'}</td>
                                  <td className="p-2">
                                    <span className={needsUpdate && !isUpdated ? 'text-orange-600' : 'text-purple-600'}>
                                      {txn.repeat_entry_next_date || '-'}
                                    </span>
                                    {needsUpdate && !isUpdated && (
                                      <span className="text-xs text-orange-500 ml-1">(differs)</span>
                                    )}
                                  </td>
                                  <td className="p-2">
                                    {txn.outstanding_postings && txn.outstanding_postings.length > 0 ? (
                                      <div className="text-xs space-y-1">
                                        <span className="font-medium text-purple-700">{txn.outstanding_count} to post</span>
                                        {txn.outstanding_postings.map((p, i) => (
                                          <div key={i} className="flex items-center gap-1.5">
                                            <input
                                              type="checkbox"
                                              checked={p.period_valid}
                                              disabled
                                              className="h-3.5 w-3.5 rounded border-gray-300"
                                              title={p.period_valid ? 'Will be posted' : (p.period_error || 'Period is blocked')}
                                            />
                                            <span className={p.period_valid ? 'text-green-700' : 'text-red-600'}>
                                              {p.date} <span className="text-gray-500">(P{p.period}/{p.year})</span>
                                            </span>
                                            {!p.period_valid && (
                                              <span className="text-red-500 text-[10px]">blocked</span>
                                            )}
                                          </div>
                                        ))}
                                      </div>
                                    ) : (
                                      <span className="text-xs text-gray-400">-</span>
                                    )}
                                  </td>
                                  <td className="p-2">
                                    {(() => {
                                      // All outstanding postings blocked
                                      const allBlocked = (txn.outstanding_blocked ?? 0) > 0 && txn.outstanding_open === 0;
                                      if (allBlocked) {
                                        return (
                                          <span className="text-xs text-red-600">
                                            Open period in Opera to post
                                          </span>
                                        );
                                      }

                                      // Check if entry is exhausted (posted == total && total > 0)
                                      const isExhausted = txn.repeat_entry_total && txn.repeat_entry_total > 0 &&
                                                          txn.repeat_entry_posted === txn.repeat_entry_total;
                                      // Check if date update is needed (next_post_date > statement_date)
                                      const needsDateUpdate = txn.repeat_entry_next_date && txn.date &&
                                                              txn.repeat_entry_next_date > txn.date;

                                      if (isUpdated) {
                                        return <span className="text-xs text-green-600">Done - run Opera Routine</span>;
                                      }

                                      if (isExhausted) {
                                        return (
                                          <span className="text-xs text-red-600" title={`Posted ${txn.repeat_entry_posted}/${txn.repeat_entry_total}`}>
                                            Exhausted - increase posts in Opera
                                          </span>
                                        );
                                      }

                                      if (!needsDateUpdate) {
                                        // No date update needed - next_post_date is before or equal to statement date
                                        return (
                                          <span className="text-xs text-blue-600">
                                            Run Opera Routine
                                          </span>
                                        );
                                      }

                                      // Date update needed
                                      return (
                                        <button
                                          onClick={() => {
                                            const learnAlias = window.confirm(
                                              `Update date to ${txn.date}?\n\n` +
                                              `Also remember "${txn.name}" for automatic matching in future imports?\n\n` +
                                              `(Click OK to update and remember, Cancel to update only)`
                                            );
                                            handleUpdateRepeatEntryDate(
                                              txn.repeat_entry_ref!,
                                              selectedBankCode,
                                              txn.date,
                                              txn.name,
                                              learnAlias
                                            );
                                          }}
                                          disabled={isUpdating}
                                          className="text-xs px-2 py-1 bg-purple-600 text-white rounded hover:bg-purple-700 disabled:bg-gray-400 flex items-center gap-1"
                                        >
                                          {isUpdating ? (
                                            <><Loader2 className="h-3 w-3 animate-spin" /> Updating...</>
                                          ) : (
                                            <>Update to {txn.date}</>
                                          )}
                                        </button>
                                      );
                                    })()}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })()}

                {/* ===== UNMATCHED TAB ===== */}
                {activePreviewTab === 'unmatched' && (() => {
                  const allUnmatched = bankPreview.unmatched || [];
                  const filtered = allUnmatched.filter(txn =>
                    !tabSearchFilter || txn.name.toLowerCase().includes(tabSearchFilter.toLowerCase()) ||
                    (txn.reference || '').toLowerCase().includes(tabSearchFilter.toLowerCase())
                  );
                  if (allUnmatched.length === 0) return <div className="text-center py-8 text-gray-500">No unmatched transactions</div>;
                  const isImported = bankImportResult?.success;
                  const importedRows = new Set((bankImportResult?.imported_transactions || []).map((t: any) => t.row));
                  return (
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                      {(() => {
                        const selectedCount = filtered.filter(t => selectedForImport.has(t.row)).length;
                        return (
                          <div className="flex justify-between items-center mb-3">
                            <h4 className="font-medium text-amber-800">
                              {isImported
                                ? `Unmatched Transactions — ${importedRows.size > 0 ? filtered.filter(t => importedRows.has(t.row)).length : 0} posted to Opera`
                                : <>Unmatched Transactions ({filtered.length} records / {selectedCount} to import)
                                    <span className="text-sm font-normal ml-2 text-amber-600">
                                      - Assign account to enable Include checkbox
                                    </span>
                                  </>
                              }
                            </h4>
                            <div className="flex items-center gap-2">
                              {!isImported && filtered.some(t => editedTransactions.has(t.row) || transactionTypeOverrides.has(t.row) || nominalPostingDetails.has(t.row) || bankTransferDetails.has(t.row)) && (
                                <button
                                  onClick={() => {
                                    const rows = filtered.map(t => t.row);
                                    setEditedTransactions(prev => { const u = new Map(prev); rows.forEach(r => u.delete(r)); return u; });
                                    setTransactionTypeOverrides(prev => { const u = new Map(prev); rows.forEach(r => u.delete(r)); return u; });
                                    setNominalPostingDetails(prev => { const u = new Map(prev); rows.forEach(r => u.delete(r)); return u; });
                                    setBankTransferDetails(prev => { const u = new Map(prev); rows.forEach(r => u.delete(r)); return u; });
                                    setCbtypeOverrides(prev => { const u = new Map(prev); rows.forEach(r => u.delete(r)); return u; });
                                    setSelectedForImport(prev => { const u = new Set(prev); rows.forEach(r => u.delete(r)); return u; });
                                  }}
                                  className="text-xs px-2.5 py-1 border border-amber-400 text-amber-700 rounded hover:bg-amber-100 flex items-center gap-1"
                                  title="Clear all account assignments and type overrides for unmatched items"
                                >
                                  <RotateCcw className="h-3 w-3" />
                                  Reset All
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })()}
                      {/* Apply to all similar banner */}
                      {applyAllSimilar?.show && (
                        <div className="mb-3 p-3 bg-blue-50 border border-blue-200 rounded-lg flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="text-blue-600 text-lg">&#10697;</span>
                            <p className="text-sm text-blue-800">
                              <strong>{applyAllSimilar.count}</strong> similar transaction{applyAllSimilar.count !== 1 ? 's' : ''} found
                              {applyAllSimilar.similarityKey ? ` matching "${applyAllSimilar.similarityKey}"` : ''}.
                              Apply <strong>{applyAllSimilar.accountName}</strong> to all?
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={handleApplyToAllSimilar}
                              className="btn btn-primary text-xs px-3 py-1.5"
                            >
                              Apply to {applyAllSimilar.count}
                            </button>
                            <button
                              onClick={() => setApplyAllSimilar(null)}
                              className="text-blue-400 hover:text-blue-600 text-lg leading-none"
                            >
                              &times;
                            </button>
                          </div>
                        </div>
                      )}
                      <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 bg-amber-100 z-10">
                            <tr>
                              <th className="p-1.5 w-12 text-center">
                                <div className="flex flex-col items-center gap-1">
                                  <span className="text-xs">Incl</span>
                                  {!isImported && (
                                    <input
                                      type="checkbox"
                                      checked={filtered.filter(t => !ignoredTransactions.has(t.row) && !deferredRows.has(t.row)).length > 0 && filtered.filter(t => !ignoredTransactions.has(t.row) && !deferredRows.has(t.row)).every(t => selectedForImport.has(t.row))}
                                      onChange={(e) => {
                                        const updated = new Set(selectedForImport);
                                        if (e.target.checked) {
                                          filtered.filter(t => !ignoredTransactions.has(t.row) && !deferredRows.has(t.row)).forEach(t => updated.add(t.row));
                                        } else {
                                          filtered.forEach(t => updated.delete(t.row));
                                        }
                                        setSelectedForImport(updated);
                                      }}
                                      className="rounded border-amber-400 text-amber-600 focus:ring-amber-500"
                                      title="Select/deselect all"
                                    />
                                  )}
                                </div>
                              </th>
                              <th className="text-left p-1.5 w-24">Date</th>
                              <th className="text-left p-1.5">Name</th>
                              <th className="text-right p-1.5 w-24">Amount</th>
                              <th className="text-left p-1.5 w-32">Type</th>
                              <th className="text-left p-1.5 w-28">CB Type</th>
                              <th className="text-left p-1.5 min-w-[150px]">Assign Account</th>
                              <th className="text-center p-1.5 w-16" title="Auto-allocate to invoices after import">
                                Alloc
                              </th>
                              <th className="text-left p-1.5 w-20">Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filtered.map((txn) => {
                              const isIgnored = ignoredTransactions.has(txn.row);
                              const isDeferred = deferredRows.has(txn.row);
                              const editedTxn = editedTransactions.get(txn.row);
                              const isPositive = txn.amount > 0;
                              const currentTxnType = transactionTypeOverrides.get(txn.row) || getSmartDefaultTransactionType(txn);
                              const showCustomers = currentTxnType === 'sales_receipt' || currentTxnType === 'sales_refund';
                              const isNominal = currentTxnType === 'nominal_receipt' || currentTxnType === 'nominal_payment';
                              const isBankTransfer = currentTxnType === 'bank_transfer';
                              const isNlOrTransfer = isNominal || isBankTransfer;
                              const isIncluded = selectedForImport.has(txn.row);
                              // For Nominal/Bank Transfer, account is handled elsewhere
                              const hasAccount = isNlOrTransfer || editedTxn?.manual_account;

                              // If ignored, show simplified row
                              if (isIgnored) {
                                return (
                                  <tr
                                    key={txn.row}
                                    className="border-t border-gray-200 bg-gray-100 opacity-60"
                                  >
                                    <td className="p-2 text-center">
                                      <span className="text-gray-400">-</span>
                                    </td>
                                    <td className="p-2 text-gray-500 line-through">{txn.date}</td>
                                    <td className="p-2 text-gray-500 line-through">{txn.name}</td>
                                    <td className="p-2 text-right text-gray-500 line-through whitespace-nowrap">
                                      £{Math.abs(txn.amount).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                    </td>
                                    <td colSpan={5} className="p-2 text-center">
                                      <span className="inline-flex items-center gap-1 px-2 py-1 bg-gray-200 text-gray-600 rounded text-xs">
                                        <CheckCircle className="h-3 w-3" />
                                        Ignored
                                      </span>
                                      <button
                                        className="ml-2 text-xs text-blue-600 hover:text-blue-800 underline"
                                        onClick={() => {
                                          setIgnoredTransactions(prev => {
                                            const s = new Set(prev);
                                            s.delete(txn.row);
                                            return s;
                                          });
                                          const dateOnly = txn.date.includes('T') ? txn.date.split('T')[0] : txn.date;
                                          authFetch(`${API_BASE}/reconcile/bank/${encodeURIComponent(selectedBankCode)}/unignore-transaction?transaction_date=${encodeURIComponent(dateOnly)}&amount=${txn.amount}`, { method: 'DELETE' }).catch(() => {});
                                        }}
                                      >
                                        Undo
                                      </button>
                                    </td>
                                  </tr>
                                );
                              }

                              // If deferred, show amber-tinted simplified row
                              if (isDeferred) {
                                return (
                                  <tr
                                    key={txn.row}
                                    className="border-t border-amber-200 bg-amber-50/50 opacity-75"
                                  >
                                    <td className="p-2 text-center">
                                      <input type="checkbox" disabled checked={false} className="rounded border-amber-400" />
                                    </td>
                                    <td className="p-2 text-amber-700">{txn.date}</td>
                                    <td className="p-2 text-amber-700">{txn.name}</td>
                                    <td className={`p-2 text-right font-medium whitespace-nowrap ${isPositive ? 'text-green-700' : 'text-red-700'}`}>
                                      {isPositive ? '+' : '-'}£{Math.abs(txn.amount).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                    </td>
                                    <td colSpan={5} className="p-2">
                                      <span className="inline-flex items-center gap-1 text-xs px-2 py-1 bg-amber-100 text-amber-800 rounded">
                                        <Clock className="h-3 w-3" />
                                        Awaiting manual entry
                                      </span>
                                      <button
                                        className="ml-2 text-xs text-blue-600 hover:text-blue-800 underline"
                                        onClick={() => {
                                          setDeferredRows(prev => {
                                            const s = new Set(prev);
                                            s.delete(txn.row);
                                            // Persist updated set (may be empty) so backend stays in sync
                                            persistDeferDecisions(s);
                                            return s;
                                          });
                                        }}
                                      >
                                        Undo
                                      </button>
                                    </td>
                                  </tr>
                                );
                              }

                              const rowImported = (isImported && importedRows.has(txn.row)) || alreadyPostedRows.has(txn.row);

                              return (
                                <tr
                                  key={txn.row}
                                  className={`border-t border-amber-200 ${rowImported ? 'bg-green-50' : isIncluded ? 'bg-amber-100' : ''} ${!rowImported && editedTxn?.isEdited ? 'bg-green-50' : ''}`}
                                >
                                  <td className="p-2 text-center">
                                    {rowImported ? (
                                      <span className="inline-flex items-center gap-1 text-green-700 text-xs font-medium">
                                        <CheckCircle className="h-3.5 w-3.5" /> Posted
                                      </span>
                                    ) : (
                                    <input
                                      type="checkbox"
                                      checked={isIncluded}
                                      disabled={!hasAccount}
                                      onChange={(e) => {
                                        const updated = new Set(selectedForImport);
                                        if (e.target.checked) {
                                          updated.add(txn.row);
                                          // Remove from ignored (DB + state) so it survives re-preview
                                          if (ignoredTransactions.has(txn.row)) {
                                            setIgnoredTransactions(prev => {
                                              const s = new Set(prev);
                                              s.delete(txn.row);
                                              return s;
                                            });
                                            // Unignore in DB - fire and forget
                                            const dateOnly = txn.date.includes('T') ? txn.date.split('T')[0] : txn.date;
                                            authFetch(`${API_BASE}/reconcile/bank/${encodeURIComponent(selectedBankCode)}/unignore-transaction?transaction_date=${encodeURIComponent(dateOnly)}&amount=${txn.amount}`, { method: 'DELETE' }).catch(() => {});
                                          }
                                        } else {
                                          updated.delete(txn.row);
                                          // Persist as ignored (DB + state) so it survives re-preview
                                          setIgnoredTransactions(prev => new Set([...prev, txn.row]));
                                          const dateOnly = txn.date.includes('T') ? txn.date.split('T')[0] : txn.date;
                                          const cleanDesc = (txn.name || txn.reference || '').replace(/[\n\r]/g, ' ').trim();
                                          const params = new URLSearchParams({
                                            transaction_date: dateOnly,
                                            amount: txn.amount.toString(),
                                            description: cleanDesc,
                                            reason: 'Excluded from import'
                                          });
                                          authFetch(`${API_BASE}/reconcile/bank/${encodeURIComponent(selectedBankCode)}/ignore-transaction?${params}`, { method: 'POST' }).catch(() => {});
                                        }
                                        setSelectedForImport(updated);
                                      }}
                                      className="rounded border-amber-400"
                                      title={!hasAccount ? 'Assign an account first to include in import' : ''}
                                    />
                                    )}
                                  </td>
                                  <td className="p-2">
                                    {txn.period_valid === false ? (
                                      <div className="flex items-center gap-1">
                                        <input
                                          type="date"
                                          value={dateOverrides.get(txn.row) || txn.date}
                                          onChange={(e) => {
                                            const newDate = e.target.value;
                                            setDateOverrides(prev => {
                                              const updated = new Map(prev);
                                              if (newDate && newDate !== txn.date) {
                                                updated.set(txn.row, newDate);
                                              } else {
                                                updated.delete(txn.row);
                                              }
                                              return updated;
                                            });
                                          }}
                                          className={`w-32 text-xs border rounded px-1 py-0.5 ${
                                            dateOverrides.has(txn.row) ? 'border-green-400 bg-green-50' : 'border-orange-400 bg-orange-50'
                                          }`}
                                          title={txn.period_error || 'Date outside allowed posting period'}
                                        />
                                        <button
                                          onClick={() => {
                                            const today = new Date().toISOString().split('T')[0];
                                            setDateOverrides(prev => {
                                              const updated = new Map(prev);
                                              updated.set(txn.row, today);
                                              return updated;
                                            });
                                          }}
                                          className="text-xs px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
                                          title="Set to today's date"
                                        >
                                          Today
                                        </button>
                                        {!dateOverrides.has(txn.row) && (
                                          <span title={txn.period_error || 'Date outside allowed posting period'}><AlertCircle className="h-4 w-4 text-orange-500" /></span>
                                        )}
                                        {dateOverrides.has(txn.row) && (
                                          <span title="Date corrected"><CheckCircle className="h-4 w-4 text-green-500" /></span>
                                        )}
                                      </div>
                                    ) : (
                                      txn.date
                                    )}
                                  </td>
                                  <td className="p-2">
                                    <div className="flex items-center gap-1.5">
                                      <div className="max-w-xs truncate" title={txn.name}>{txn.name}</div>
                                      {(txn.similar_count || 0) > 1 && !editedTransactions.has(txn.row) && (
                                        <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded-full" title={`${txn.similar_count} similar transactions (${txn.similarity_key})`}>
                                          {txn.similar_count} similar
                                        </span>
                                      )}
                                    </div>
                                    {txn.reference && (
                                      <div className="text-xs text-gray-500 truncate" title={txn.reference}>Ref: {txn.reference}</div>
                                    )}
                                  </td>
                                  <td className={`p-2 text-right font-medium whitespace-nowrap ${isPositive ? 'text-green-700' : 'text-red-700'}`}>
                                    {isPositive ? '+' : '-'}£{Math.abs(txn.amount).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                  </td>
                                  <td className="p-2">
                                    {rowImported ? (
                                      <span className="text-xs text-gray-700">
                                        {currentTxnType === 'sales_receipt' ? 'Sales Receipt'
                                          : currentTxnType === 'purchase_payment' ? 'Purchase Payment'
                                          : currentTxnType === 'sales_refund' ? 'Sales Refund'
                                          : currentTxnType === 'purchase_refund' ? 'Purchase Refund'
                                          : currentTxnType === 'nominal_receipt' ? 'Nominal Receipt'
                                          : currentTxnType === 'nominal_payment' ? 'Nominal Payment'
                                          : currentTxnType === 'bank_transfer' ? 'Bank Transfer'
                                          : currentTxnType}
                                      </span>
                                    ) : (
                                    <select
                                      value={currentTxnType}
                                      onChange={(e) => {
                                        const newType = e.target.value as TransactionType;
                                        if (newType === 'ignore') {
                                          openIgnoreConfirm(txn);
                                          return;
                                        }
                                        const updated = new Map(transactionTypeOverrides);
                                        updated.set(txn.row, newType);
                                        setTransactionTypeOverrides(updated);
                                        // Clear account selection if ledger type changed
                                        const wasCustomer = currentTxnType === 'sales_receipt' || currentTxnType === 'sales_refund';
                                        const nowCustomer = newType === 'sales_receipt' || newType === 'sales_refund';
                                        if (wasCustomer !== nowCustomer && editedTxn?.isEdited) {
                                          const edits = new Map(editedTransactions);
                                          edits.delete(txn.row);
                                          setEditedTransactions(edits);
                                        }
                                        // Open appropriate modal or auto-suggest
                                        if (newType === 'nominal_receipt' || newType === 'nominal_payment') {
                                          openNominalDetailModal(txn, newType, 'unmatched');
                                        } else if (newType === 'bank_transfer') {
                                          openBankTransferModal(txn, 'unmatched');
                                        } else {
                                          // Auto-suggest account for customer/supplier types
                                          suggestAccountForTransaction(txn, newType);
                                        }
                                      }}
                                      className="text-xs px-2 py-1 border border-gray-300 rounded bg-white w-full"
                                    >
                                      {/* Credit (positive): Sales Receipt, Purchase Refund, Nominal Receipt */}
                                      {/* Debit (negative): Purchase Payment, Sales Refund, Nominal Payment */}
                                      {isPositive ? (
                                        <>
                                          <option value="sales_receipt">Sales Receipt</option>
                                          <option value="purchase_refund">Purchase Refund</option>
                                          <option value="nominal_receipt">Nominal Receipt</option>
                                        </>
                                      ) : (
                                        <>
                                          <option value="purchase_payment">Purchase Payment</option>
                                          <option value="sales_refund">Sales Refund</option>
                                          <option value="nominal_payment">Nominal Payment</option>
                                        </>
                                      )}
                                      <option value="bank_transfer">Bank Transfer</option>
                                      <option value="ignore">Ignore (in Opera)</option>
                                    </select>
                                    )}
                                  </td>
                                  <td className="p-2">
                                    {rowImported ? (
                                      <span className="text-xs text-gray-500">{cbtypeOverrides.get(txn.row) || '—'}</span>
                                    ) : (() => {
                                      const types = filterCbtypesForAction(
                                        isPositive ? receiptTypes : paymentTypes,
                                        currentTxnType
                                      );
                                      const defaultCb = getBestCbtype(currentTxnType, types, txn.name || txn.memo);
                                      const currentCb = cbtypeOverrides.get(txn.row) || defaultCb;
                                      return types.length > 0 ? (
                                        <select
                                          value={currentCb}
                                          onChange={(e) => {
                                            const updated = new Map(cbtypeOverrides);
                                            updated.set(txn.row, e.target.value);
                                            setCbtypeOverrides(updated);
                                          }}
                                          className={`text-xs px-1 py-1 border rounded w-full ${
                                            cbtypeOverrides.has(txn.row) ? 'border-yellow-400 bg-yellow-50' : 'border-gray-300'
                                          }`}
                                        >
                                          {types.map(t => (
                                            <option key={t.code} value={t.code}>{t.code} - {t.description}</option>
                                          ))}
                                        </select>
                                      ) : (
                                        <span className="text-xs text-gray-400">Loading...</span>
                                      );
                                    })()}
                                  </td>
                                  <td className="p-2">
                                    {rowImported ? (
                                      <span className="text-xs text-gray-700">
                                        {isNominal && nominalPostingDetails.has(txn.row)
                                          ? `${nominalPostingDetails.get(txn.row)?.nominalCode} - ${(() => { const nd = nominalPostingDetails.get(txn.row); const na = nominalAccounts.find(n => n.code === nd?.nominalCode); return na?.description || ''; })()}`
                                          : isBankTransfer && bankTransferDetails.has(txn.row)
                                            ? `Transfer → ${bankTransferDetails.get(txn.row)?.destBankCode}`
                                            : editedTxn?.manual_account
                                              ? `${editedTxn.manual_account} - ${editedTxn.account_name || ''}`
                                              : '—'}
                                      </span>
                                    ) : (
                                    <>
                                    {/* Show edit button for nominal types, dropdown for others */}
                                    {isNominal ? (
                                      <div>
                                        <button
                                          onClick={() => openNominalDetailModal(txn, currentTxnType, 'unmatched')}
                                          className={`w-full text-sm px-2 py-1 border rounded flex items-center justify-between ${
                                            nominalPostingDetails.has(txn.row)
                                              ? 'border-green-400 bg-green-50 text-green-700'
                                              : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
                                          }`}
                                        >
                                          {nominalPostingDetails.has(txn.row) ? (
                                            <>
                                              <span className="truncate">
                                                {nominalPostingDetails.get(txn.row)?.nominalCode} - £{nominalPostingDetails.get(txn.row)?.netAmount.toFixed(2)}
                                              </span>
                                              <Edit3 className="h-3 w-3 flex-shrink-0" />
                                            </>
                                          ) : (
                                            <>
                                              <span>Enter Details...</span>
                                              <Edit3 className="h-3 w-3" />
                                            </>
                                          )}
                                        </button>
                                        {nominalPostingDetails.has(txn.row) && (() => {
                                          const nominalDetail = nominalPostingDetails.get(txn.row);
                                          const nominalAcc = nominalAccounts.find(n => n.code === nominalDetail?.nominalCode);
                                          const hasVat = nominalDetail?.vatCode && nominalDetail.vatCode !== 'N/A' && nominalDetail.vatAmount > 0;
                                          return (
                                            <div className="text-xs text-gray-500 mt-1 flex items-center gap-2">
                                              <span className="truncate" title={nominalAcc?.description}>{nominalAcc?.description || 'Unknown'}</span>
                                              {hasVat && <span className="flex-shrink-0 text-green-600">+VAT</span>}
                                            </div>
                                          );
                                        })()}
                                      </div>
                                    ) : isBankTransfer ? (
                                      <button
                                        onClick={() => openBankTransferModal(txn, 'unmatched')}
                                        className={`w-full text-sm px-2 py-1 border rounded flex items-center justify-between ${
                                          bankTransferDetails.has(txn.row)
                                            ? 'border-green-400 bg-green-50 text-green-700'
                                            : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
                                        }`}
                                      >
                                        {bankTransferDetails.has(txn.row) ? (
                                          <>
                                            <span className="truncate">
                                              {txn.amount < 0 ? 'To: ' : 'From: '}{bankTransferDetails.get(txn.row)?.destBankCode}
                                            </span>
                                            <Edit3 className="h-3 w-3 flex-shrink-0" />
                                          </>
                                        ) : (
                                          <>
                                            <span>Select Bank...</span>
                                            <Landmark className="h-3 w-3" />
                                          </>
                                        )}
                                      </button>
                                    ) : (() => {
                                      const filteredAccounts = (showCustomers ? customers : suppliers)
                                        .filter(acc => {
                                          if (!inlineAccountSearchText) return true;
                                          const search = inlineAccountSearchText.toLowerCase();
                                          return acc.code.toLowerCase().includes(search) ||
                                                 acc.name.toLowerCase().includes(search);
                                        })
                                        .slice(0, 50);
                                      return (
                                      <div className="relative">
                                        <input
                                          type="text"
                                          value={inlineAccountSearch?.row === txn.row && inlineAccountSearch?.section === 'unmatched'
                                            ? inlineAccountSearchText
                                            : (editedTxn?.manual_account
                                              ? `${editedTxn.manual_account} - ${editedTxn.account_name || ''}`
                                              : '')}
                                          onChange={(e) => {
                                            setInlineAccountSearchText(e.target.value);
                                            setInlineAccountHighlightIndex(0);
                                            if (!inlineAccountSearch || inlineAccountSearch.row !== txn.row) {
                                              setInlineAccountSearch({ row: txn.row, section: 'unmatched' });
                                            }
                                          }}
                                          onFocus={() => {
                                            setInlineAccountSearch({ row: txn.row, section: 'unmatched' });
                                            setInlineAccountSearchText('');
                                            setInlineAccountHighlightIndex(0);
                                          }}
                                          onKeyDown={(e) => {
                                            // Check if this field was already filled (editing vs new)
                                            const wasAlreadyFilled = editedTxn?.manual_account;

                                            // Helper to move to next row's account input (only for new entries)
                                            const moveToNextRow = () => {
                                              if (wasAlreadyFilled) return; // Don't auto-advance when editing
                                              const currentIdx = filtered.findIndex(t => t.row === txn.row);
                                              if (currentIdx >= 0 && currentIdx < filtered.length - 1) {
                                                const nextRow = filtered[currentIdx + 1];
                                                setTimeout(() => {
                                                  const nextInput = document.querySelector(`[data-account-input="unmatched-${nextRow.row}"]`) as HTMLInputElement;
                                                  if (nextInput) nextInput.focus();
                                                }, 10);
                                              }
                                            };

                                            if (e.key === 'ArrowDown') {
                                              e.preventDefault();
                                              // Ensure dropdown is open
                                              if (!inlineAccountSearch || inlineAccountSearch.row !== txn.row) {
                                                setInlineAccountSearch({ row: txn.row, section: 'unmatched' });
                                              }
                                              // If only one result, select it and move to next row
                                              if (filteredAccounts.length === 1) {
                                                const selectedAcc = filteredAccounts[0];
                                                handleAccountChange(txn, selectedAcc.code, showCustomers ? 'C' : 'S');
                                                setInlineAccountSearch(null);
                                                setInlineAccountSearchText('');
                                                moveToNextRow();
                                              } else if (filteredAccounts.length > 1) {
                                                setInlineAccountHighlightIndex(prev =>
                                                  prev < filteredAccounts.length - 1 ? prev + 1 : prev
                                                );
                                              }
                                            } else if (e.key === 'ArrowUp') {
                                              e.preventDefault();
                                              if (filteredAccounts.length > 0) {
                                                setInlineAccountHighlightIndex(prev => prev > 0 ? prev - 1 : 0);
                                              }
                                            } else if (e.key === 'Enter') {
                                              e.preventDefault();
                                              // If user hasn't typed any search text, just close dropdown (don't auto-advance when editing)
                                              const userIsSearching = inlineAccountSearchText.length > 0;

                                              if (!userIsSearching) {
                                                // No search text - close dropdown, only advance if new entry
                                                setInlineAccountSearch(null);
                                                setInlineAccountSearchText('');
                                                if (!wasAlreadyFilled) moveToNextRow();
                                              } else if (filteredAccounts.length > 0) {
                                                // User typed search and there are results - select highlighted item
                                                const idx = Math.min(inlineAccountHighlightIndex, filteredAccounts.length - 1);
                                                const selectedAcc = filteredAccounts[idx];
                                                if (selectedAcc) {
                                                  handleAccountChange(txn, selectedAcc.code, showCustomers ? 'C' : 'S');
                                                  setInlineAccountSearch(null);
                                                  setInlineAccountSearchText('');
                                                  moveToNextRow();
                                                }
                                              } else {
                                                // User typed search but no results - close dropdown
                                                setInlineAccountSearch(null);
                                                setInlineAccountSearchText('');
                                              }
                                            } else if (e.key === 'Escape') {
                                              setInlineAccountSearch(null);
                                              setInlineAccountSearchText('');
                                              (e.target as HTMLInputElement).blur();
                                            } else if (e.key === 'Tab') {
                                              // Select highlighted item on Tab if user was searching, then let Tab move focus
                                              if (inlineAccountSearchText.length > 0 && filteredAccounts.length > 0) {
                                                const idx = Math.min(inlineAccountHighlightIndex, filteredAccounts.length - 1);
                                                const selectedAcc = filteredAccounts[idx];
                                                if (selectedAcc) {
                                                  handleAccountChange(txn, selectedAcc.code, showCustomers ? 'C' : 'S');
                                                }
                                              }
                                              setInlineAccountSearch(null);
                                              setInlineAccountSearchText('');
                                            }
                                          }}
                                          placeholder={`Search ${showCustomers ? 'customer' : 'supplier'}...`}
                                          data-account-input={`unmatched-${txn.row}`}
                                          className={`w-full text-sm px-2 py-1 border-2 rounded focus:ring-2 focus:ring-blue-500 focus:border-blue-500 focus:outline-none ${
                                            editedTxn?.isEdited ? 'border-green-400 bg-green-50' : 'border-gray-300'
                                          } ${editedTxn?.manual_account ? 'pr-7' : ''}`}
                                        />
                                        {editedTxn?.manual_account && !(inlineAccountSearch?.row === txn.row && inlineAccountSearch?.section === 'unmatched') && (
                                          <button
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setEditedTransactions(prev => { const u = new Map(prev); u.delete(txn.row); return u; });
                                              setSelectedForImport(prev => { const u = new Set(prev); u.delete(txn.row); return u; });
                                            }}
                                            className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-gray-400 hover:text-red-500 rounded-full hover:bg-red-50"
                                            title="Clear account assignment"
                                          >
                                            <X className="h-3.5 w-3.5" />
                                          </button>
                                        )}
                                        {inlineAccountSearch?.row === txn.row && inlineAccountSearch?.section === 'unmatched' && (
                                          <>
                                            {/* Click-outside overlay - rendered first so dropdown is on top */}
                                            <div
                                              className="fixed inset-0 z-40"
                                              onClick={() => {
                                                setInlineAccountSearch(null);
                                                setInlineAccountSearchText('');
                                              }}
                                            />
                                            <div className="absolute z-50 w-64 mt-1 bg-white border border-gray-300 rounded-md shadow-lg max-h-48 overflow-y-auto">
                                              {filteredAccounts.map((acc, idx) => (
                                                  <button
                                                    key={acc.code}
                                                    type="button"
                                                    ref={idx === inlineAccountHighlightIndex ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                                                    onClick={() => {
                                                      // Check if this was already filled (editing) vs new entry
                                                      const wasAlreadyFilled = editedTxn?.manual_account;
                                                      handleAccountChange(txn, acc.code, showCustomers ? 'C' : 'S');
                                                      setInlineAccountSearch(null);
                                                      setInlineAccountSearchText('');
                                                      // Only move to next row if this was a new entry, not an edit
                                                      if (!wasAlreadyFilled) {
                                                        const currentIdx = filtered.findIndex(t => t.row === txn.row);
                                                        if (currentIdx >= 0 && currentIdx < filtered.length - 1) {
                                                          const nextRow = filtered[currentIdx + 1];
                                                          setTimeout(() => {
                                                            const nextInput = document.querySelector(`[data-account-input="unmatched-${nextRow.row}"]`) as HTMLInputElement;
                                                            if (nextInput) nextInput.focus();
                                                          }, 10);
                                                        }
                                                      }
                                                    }}
                                                    className={`w-full text-left px-2 py-1.5 text-sm ${
                                                      idx === inlineAccountHighlightIndex ? 'bg-blue-100' : 'hover:bg-blue-50'
                                                    }`}
                                                  >
                                                    <span className="font-medium">{acc.code}</span>
                                                    <span className="text-gray-600"> - {acc.name}</span>
                                                  </button>
                                                ))}
                                              {filteredAccounts.length === 0 && (
                                                <div className="px-2 py-1.5 text-sm text-gray-500">No matches found</div>
                                              )}
                                            </div>
                                          </>
                                        )}
                                      </div>
                                      );
                                    })()}
                                    </>
                                    )}
                                  </td>
                                  {/* Auto-Allocate checkbox - defaults checked unless explicitly disabled */}
                                  <td className="p-2 text-center">
                                    {rowImported ? (
                                      <span className="text-gray-400 text-xs">—</span>
                                    ) : (
                                    (() => {
                                      // Only show for customer/supplier transaction types (not nominal or bank transfer)
                                      const canAutoAllocate = currentTxnType === 'sales_receipt' || currentTxnType === 'purchase_payment' ||
                                                             currentTxnType === 'sales_refund' || currentTxnType === 'purchase_refund';
                                      const rowAutoAllocEnabled = !autoAllocateDisabled.has(txn.row);

                                      if (!canAutoAllocate) {
                                        return <span className="text-gray-400 text-xs">N/A</span>;
                                      }

                                      if (!hasAccount) {
                                        return <span className="text-gray-400 text-xs">-</span>;
                                      }

                                      return (
                                        <input
                                          type="checkbox"
                                          checked={rowAutoAllocEnabled}
                                          onChange={(e) => {
                                            const updated = new Set(autoAllocateDisabled);
                                            if (e.target.checked) {
                                              // Enable auto-allocate (remove from disabled set)
                                              updated.delete(txn.row);
                                            } else {
                                              // Disable auto-allocate for this row
                                              updated.add(txn.row);
                                            }
                                            setAutoAllocateDisabled(updated);
                                          }}
                                          className="rounded border-green-400 text-green-600 focus:ring-green-500"
                                          title={rowAutoAllocEnabled ? 'Auto-allocate to invoices' : 'Skip auto-allocation (post on account)'}
                                        />
                                      );
                                    })()
                                    )}
                                  </td>
                                  <td className="p-2">
                                    {(editedTxn?.isEdited || nominalPostingDetails.has(txn.row) || bankTransferDetails.has(txn.row)) ? (
                                      <span className="inline-flex items-center gap-1 text-green-600 text-xs">
                                        <CheckCircle className="h-3 w-3" />
                                        {(txn as any).suggested_account ? 'Auto-filled' : 'Ready'}
                                      </span>
                                    ) : txn.is_duplicate ? (
                                      <span className="inline-flex items-center gap-1 text-amber-600 text-xs font-medium" title="This transaction is already in Opera">
                                        <AlertCircle className="h-3 w-3" /> Already in Opera
                                      </span>
                                    ) : (
                                      <div className="flex items-center gap-1">
                                        <span className="text-gray-400 text-xs">Unassigned</span>
                                        {!rowImported && (
                                          <button
                                            className="text-xs px-2 py-1 text-amber-600 hover:text-amber-800 hover:bg-amber-50 rounded"
                                            title="Defer: skip this import, reappears on next scan"
                                            onClick={() => {
                                              setDeferredRows(prev => {
                                                const next = new Set([...prev, txn.row]);
                                                // Persist immediately — no Import-button click needed
                                                persistDeferDecisions(next);
                                                return next;
                                              });
                                              // Remove from selectedForImport if it was somehow selected
                                              setSelectedForImport(prev => {
                                                const s = new Set(prev);
                                                s.delete(txn.row);
                                                return s;
                                              });
                                            }}
                                          >
                                            Defer
                                          </button>
                                        )}
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
                })()}

                {/* ===== SKIPPED TAB ===== */}
                {activePreviewTab === 'skipped' && (() => {
                  // Include duplicates from matched tabs alongside explicit already_posted/skipped
                  const duplicatesFromMatched = [
                    ...(bankPreview.matched_receipts || []).filter((t: any) => t.is_duplicate),
                    ...(bankPreview.matched_payments || []).filter((t: any) => t.is_duplicate),
                    ...(bankPreview.matched_refunds || []).filter((t: any) => t.is_duplicate),
                  ];
                  const allSkipped = [...(bankPreview.already_posted || []), ...(bankPreview.skipped || []), ...duplicatesFromMatched];
                  const filtered = allSkipped.filter(txn =>
                    !tabSearchFilter || txn.name.toLowerCase().includes(tabSearchFilter.toLowerCase()) ||
                    (txn.reference || '').toLowerCase().includes(tabSearchFilter.toLowerCase())
                  );
                  if (allSkipped.length === 0) return <div className="text-center py-8 text-gray-500">No transactions already in Opera</div>;
                  return (
                    <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                      <div className="flex justify-between items-center mb-3">
                        <h4 className="font-medium text-gray-800">
                          Already in Opera ({filtered.length})
                          <span className="text-sm font-normal ml-2 text-gray-500">
                            — these transactions are already posted, no import needed
                          </span>
                        </h4>
                        {includedSkipped.size > 0 && (
                          <button
                            onClick={() => setIncludedSkipped(new Map())}
                            className="text-sm text-gray-600 hover:text-gray-800 flex items-center gap-1"
                          >
                            <RotateCcw className="h-3 w-3" /> Clear Inclusions
                          </button>
                        )}
                      </div>
                      <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 bg-gray-100 z-10">
                            <tr>
                              <th className="p-2 text-left w-8">Include</th>
                              <th className="text-left p-2">Date</th>
                              <th className="text-left p-2">Name</th>
                              <th className="text-right p-2 min-w-[110px]">Amount</th>
                              <th className="text-left p-2">Reason</th>
                              <th className="text-left p-2">Transaction Type</th>
                              <th className="text-left p-2 min-w-[180px]">Assign Account</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filtered.map((txn, idx) => {
                              const isIncluded = includedSkipped.has(txn.row);
                              const inclusion = includedSkipped.get(txn.row);
                              const isAlreadyPosted = txn.is_duplicate || (txn.reason && txn.reason.includes('Already'));
                              const isGcFx = txn.action === 'gc_fx_ignore';
                              const isPositive = txn.amount > 0;
                              const skippedTxnType = inclusion?.transaction_type || getSmartDefaultTransactionType(txn);
                              const showCust = skippedTxnType === 'sales_receipt' || skippedTxnType === 'sales_refund';
                              const isNominalSkip = skippedTxnType === 'nominal_receipt' || skippedTxnType === 'nominal_payment';
                              const isBankTransferSkip = skippedTxnType === 'bank_transfer';
                              return (
                                <tr key={idx} className={`border-t border-gray-200 ${isIncluded ? 'bg-green-50' : isAlreadyPosted ? 'bg-amber-50' : isGcFx ? 'bg-purple-50' : ''}`}>
                                  <td className="p-2">
                                    {isAlreadyPosted ? (
                                      <span className="inline-flex items-center gap-1 text-amber-600 text-xs font-medium" title={txn.reason || 'Already posted to Opera'}>
                                        <CheckCircle className="h-3.5 w-3.5" /> In Opera
                                      </span>
                                    ) : !isGcFx ? (
                                      <input
                                        type="checkbox"
                                        checked={isIncluded}
                                        onChange={(e) => {
                                          const updated = new Map(includedSkipped);
                                          if (e.target.checked) {
                                            const smartType = getSmartDefaultTransactionType(txn);
                                            const isCustomerType = smartType === 'sales_receipt' || smartType === 'sales_refund';
                                            updated.set(txn.row, {
                                              account: '',
                                              ledger_type: isCustomerType ? 'C' : 'S',
                                              transaction_type: smartType
                                            });
                                          } else {
                                            updated.delete(txn.row);
                                          }
                                          setIncludedSkipped(updated);
                                        }}
                                        className="rounded border-gray-400"
                                      />
                                    ) : null}
                                  </td>
                                  <td className="p-2">
                                    {txn.period_valid === false && isIncluded ? (
                                      <div className="flex items-center gap-1">
                                        <input
                                          type="date"
                                          value={dateOverrides.get(txn.row) || txn.date}
                                          onChange={(e) => {
                                            const newDate = e.target.value;
                                            setDateOverrides(prev => {
                                              const updated = new Map(prev);
                                              if (newDate && newDate !== txn.date) {
                                                updated.set(txn.row, newDate);
                                              } else {
                                                updated.delete(txn.row);
                                              }
                                              return updated;
                                            });
                                          }}
                                          className={`w-32 text-xs border rounded px-1 py-0.5 ${
                                            dateOverrides.has(txn.row) ? 'border-green-400 bg-green-50' : 'border-orange-400 bg-orange-50'
                                          }`}
                                          title={txn.period_error || 'Date outside allowed posting period'}
                                        />
                                        <button
                                          onClick={() => {
                                            const today = new Date().toISOString().split('T')[0];
                                            setDateOverrides(prev => {
                                              const updated = new Map(prev);
                                              updated.set(txn.row, today);
                                              return updated;
                                            });
                                          }}
                                          className="text-xs px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
                                          title="Set to today's date"
                                        >
                                          Today
                                        </button>
                                        {!dateOverrides.has(txn.row) && (
                                          <span title={txn.period_error || 'Date outside allowed posting period'}><AlertCircle className="h-4 w-4 text-orange-500" /></span>
                                        )}
                                        {dateOverrides.has(txn.row) && (
                                          <span title="Date corrected"><CheckCircle className="h-4 w-4 text-green-500" /></span>
                                        )}
                                      </div>
                                    ) : (
                                      <span className={txn.period_valid === false ? 'text-orange-600' : ''}>
                                        {txn.date}
                                        {txn.period_valid === false && !isIncluded && (
                                          <span title={txn.period_error || 'Date outside allowed posting period'}><AlertCircle className="inline h-3 w-3 ml-1 text-orange-500" /></span>
                                        )}
                                      </span>
                                    )}
                                  </td>
                                  <td className="p-2">
                                    <div className="max-w-xs truncate" title={txn.name}>{txn.name}</div>
                                  </td>
                                  <td className={`p-2 text-right font-medium whitespace-nowrap ${isPositive ? 'text-green-700' : 'text-red-700'}`}>
                                    {isPositive ? '+' : '-'}£{Math.abs(txn.amount).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                  </td>
                                  <td className="p-2 text-xs max-w-xs">
                                    {isGcFx ? (
                                      <div className="flex flex-col gap-0.5">
                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-purple-100 text-purple-800 rounded-full text-xs font-medium w-fit">
                                          GoCardless FX
                                        </span>
                                        {txn.gc_fx_currency && (
                                          <span className="text-purple-600 text-xs">
                                            {txn.gc_fx_currency} {txn.gc_fx_original_amount != null ? `${txn.gc_fx_currency === 'EUR' ? '\u20AC' : txn.gc_fx_currency}${txn.gc_fx_original_amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}` : ''}
                                            {txn.gc_fx_gbp_amount != null ? ` \u2192 \u00A3${txn.gc_fx_gbp_amount.toLocaleString(undefined, { minimumFractionDigits: 2 })} GBP` : ''}
                                          </span>
                                        )}
                                      </div>
                                    ) : (
                                      <span className="text-gray-600 truncate" title={txn.reason || 'Already posted'}>
                                        {txn.reason || 'Already posted'}
                                      </span>
                                    )}
                                  </td>
                                  <td className="p-2">
                                    {isIncluded && (
                                      <select
                                        value={skippedTxnType}
                                        onChange={(e) => {
                                          const newType = e.target.value as TransactionType;
                                          if (newType === 'ignore') {
                                            openIgnoreConfirm(txn);
                                            return;
                                          }
                                          const updated = new Map(includedSkipped);
                                          const current = updated.get(txn.row)!;
                                          const nowCustomer = newType === 'sales_receipt' || newType === 'sales_refund';
                                          updated.set(txn.row, {
                                            ...current,
                                            transaction_type: newType,
                                            ledger_type: nowCustomer ? 'C' : 'S',
                                            account: '' // Reset account on type change
                                          });
                                          setIncludedSkipped(updated);
                                          // Open appropriate modal for special types
                                          if (newType === 'nominal_receipt' || newType === 'nominal_payment') {
                                            openNominalDetailModal(txn, newType, 'skipped');
                                          } else if (newType === 'bank_transfer') {
                                            openBankTransferModal(txn, 'skipped');
                                          }
                                        }}
                                        className="text-xs px-2 py-1 border border-gray-300 rounded bg-white w-full"
                                      >
                                        {/* Restrict based on credit/debit */}
                                        {isPositive ? (
                                          <>
                                            <option value="sales_receipt">Sales Receipt</option>
                                            <option value="purchase_refund">Purchase Refund</option>
                                            <option value="nominal_receipt">Nominal Receipt</option>
                                          </>
                                        ) : (
                                          <>
                                            <option value="purchase_payment">Purchase Payment</option>
                                            <option value="sales_refund">Sales Refund</option>
                                            <option value="nominal_payment">Nominal Payment</option>
                                          </>
                                        )}
                                        <option value="bank_transfer">Bank Transfer</option>
                                        <option value="ignore">Ignore (in Opera)</option>
                                      </select>
                                    )}
                                  </td>
                                  <td className="p-2">
                                    {isIncluded ? (
                                      isNominalSkip ? (
                                        <div>
                                          <button
                                            onClick={() => openNominalDetailModal(txn, skippedTxnType, 'skipped')}
                                            className={`w-full text-sm px-2 py-1 border rounded flex items-center justify-between ${
                                              nominalPostingDetails.has(txn.row)
                                                ? 'border-green-400 bg-green-50 text-green-700'
                                                : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
                                            }`}
                                          >
                                            {nominalPostingDetails.has(txn.row) ? (
                                              <>
                                                <span className="truncate">
                                                  {nominalPostingDetails.get(txn.row)?.nominalCode} - £{nominalPostingDetails.get(txn.row)?.netAmount.toFixed(2)}
                                                </span>
                                                <Edit3 className="h-3 w-3 flex-shrink-0" />
                                              </>
                                            ) : (
                                              <>
                                                <span>Enter Details...</span>
                                                <Edit3 className="h-3 w-3" />
                                              </>
                                            )}
                                          </button>
                                          {nominalPostingDetails.has(txn.row) && (() => {
                                            const nominalDetail = nominalPostingDetails.get(txn.row);
                                            const nominalAcc = nominalAccounts.find(n => n.code === nominalDetail?.nominalCode);
                                            const hasVat = nominalDetail?.vatCode && nominalDetail.vatCode !== 'N/A' && nominalDetail.vatAmount > 0;
                                            return (
                                              <div className="text-xs text-gray-500 mt-1 flex items-center gap-2">
                                                <span className="truncate" title={nominalAcc?.description}>{nominalAcc?.description || 'Unknown'}</span>
                                                {hasVat && <span className="flex-shrink-0 text-green-600">+VAT</span>}
                                              </div>
                                            );
                                          })()}
                                        </div>
                                      ) : isBankTransferSkip ? (
                                        <button
                                          onClick={() => openBankTransferModal(txn, 'skipped')}
                                          className={`w-full text-sm px-2 py-1 border rounded flex items-center justify-between ${
                                            bankTransferDetails.has(txn.row)
                                              ? 'border-green-400 bg-green-50 text-green-700'
                                              : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
                                          }`}
                                        >
                                          {bankTransferDetails.has(txn.row) ? (
                                            <>
                                              <span className="truncate">
                                                {txn.amount < 0 ? 'To: ' : 'From: '}{bankTransferDetails.get(txn.row)?.destBankCode}
                                              </span>
                                              <Edit3 className="h-3 w-3 flex-shrink-0" />
                                            </>
                                          ) : (
                                            <>
                                              <span>Select Bank...</span>
                                              <Landmark className="h-3 w-3" />
                                            </>
                                          )}
                                        </button>
                                      ) : (() => {
                                        const filteredSkippedAccounts = (showCust ? customers : suppliers)
                                          .filter(acc => {
                                            if (!inlineAccountSearchText) return true;
                                            const search = inlineAccountSearchText.toLowerCase();
                                            return acc.code.toLowerCase().includes(search) ||
                                                   acc.name.toLowerCase().includes(search);
                                          })
                                          .slice(0, 50);
                                        return (
                                        <div className="relative">
                                          <input
                                            type="text"
                                            value={inlineAccountSearch?.row === txn.row && inlineAccountSearch?.section === 'skipped'
                                              ? inlineAccountSearchText
                                              : (inclusion?.account
                                                ? `${inclusion.account} - ${(showCust ? customers : suppliers).find(a => a.code === inclusion.account)?.name || ''}`
                                                : '')}
                                            onChange={(e) => {
                                              setInlineAccountSearchText(e.target.value);
                                              setInlineAccountHighlightIndex(0);
                                              if (!inlineAccountSearch || inlineAccountSearch.row !== txn.row) {
                                                setInlineAccountSearch({ row: txn.row, section: 'skipped' });
                                              }
                                            }}
                                            onFocus={() => {
                                              setInlineAccountSearch({ row: txn.row, section: 'skipped' });
                                              setInlineAccountSearchText('');
                                              setInlineAccountHighlightIndex(0);
                                            }}
                                            onKeyDown={(e) => {
                                              // Check if this field was already filled (editing vs new)
                                              const wasAlreadyFilled = inclusion?.account;

                                              // Helper to move to next row's account input (only for new entries)
                                              const moveToNextRow = () => {
                                                if (wasAlreadyFilled) return; // Don't auto-advance when editing
                                                const currentIdx = filtered.findIndex(t => t.row === txn.row);
                                                if (currentIdx >= 0 && currentIdx < filtered.length - 1) {
                                                  const nextRow = filtered[currentIdx + 1];
                                                  setTimeout(() => {
                                                    const nextInput = document.querySelector(`[data-account-input="skipped-${nextRow.row}"]`) as HTMLInputElement;
                                                    if (nextInput) nextInput.focus();
                                                  }, 10);
                                                }
                                              };

                                              if (e.key === 'ArrowDown') {
                                                e.preventDefault();
                                                // Ensure dropdown is open
                                                if (!inlineAccountSearch || inlineAccountSearch.row !== txn.row) {
                                                  setInlineAccountSearch({ row: txn.row, section: 'skipped' });
                                                }
                                                // If only one result, select it and move to next row
                                                if (filteredSkippedAccounts.length === 1) {
                                                  const selectedAcc = filteredSkippedAccounts[0];
                                                  const updated = new Map(includedSkipped);
                                                  const current = updated.get(txn.row)!;
                                                  updated.set(txn.row, { ...current, account: selectedAcc.code, ledger_type: showCust ? 'C' : 'S' });
                                                  setIncludedSkipped(updated);
                                                  setInlineAccountSearch(null);
                                                  setInlineAccountSearchText('');
                                                  moveToNextRow();
                                                } else if (filteredSkippedAccounts.length > 1) {
                                                  setInlineAccountHighlightIndex(prev =>
                                                    prev < filteredSkippedAccounts.length - 1 ? prev + 1 : prev
                                                  );
                                                }
                                              } else if (e.key === 'ArrowUp') {
                                                e.preventDefault();
                                                if (filteredSkippedAccounts.length > 0) {
                                                  setInlineAccountHighlightIndex(prev => prev > 0 ? prev - 1 : 0);
                                                }
                                              } else if (e.key === 'Enter') {
                                                e.preventDefault();
                                                // If user hasn't typed any search text, close dropdown (don't auto-advance when editing)
                                                const userIsSearching = inlineAccountSearchText.length > 0;

                                                if (!userIsSearching) {
                                                  // No search text - close dropdown, only advance if new entry
                                                  setInlineAccountSearch(null);
                                                  setInlineAccountSearchText('');
                                                  if (!wasAlreadyFilled) moveToNextRow();
                                                } else if (filteredSkippedAccounts.length > 0) {
                                                  // User typed search and there are results - select highlighted item
                                                  const idx = Math.min(inlineAccountHighlightIndex, filteredSkippedAccounts.length - 1);
                                                  const selectedAcc = filteredSkippedAccounts[idx];
                                                  if (selectedAcc) {
                                                    const updated = new Map(includedSkipped);
                                                    const current = updated.get(txn.row)!;
                                                    updated.set(txn.row, { ...current, account: selectedAcc.code, ledger_type: showCust ? 'C' : 'S' });
                                                    setIncludedSkipped(updated);
                                                    setInlineAccountSearch(null);
                                                    setInlineAccountSearchText('');
                                                    moveToNextRow();
                                                  }
                                                } else {
                                                  // User typed search but no results - close dropdown
                                                  setInlineAccountSearch(null);
                                                  setInlineAccountSearchText('');
                                                }
                                              } else if (e.key === 'Escape') {
                                                setInlineAccountSearch(null);
                                                setInlineAccountSearchText('');
                                                (e.target as HTMLInputElement).blur();
                                              } else if (e.key === 'Tab') {
                                                // Select highlighted item on Tab if user was searching, then let Tab move focus
                                                if (inlineAccountSearchText.length > 0 && filteredSkippedAccounts.length > 0) {
                                                  const idx = Math.min(inlineAccountHighlightIndex, filteredSkippedAccounts.length - 1);
                                                  const selectedAcc = filteredSkippedAccounts[idx];
                                                  if (selectedAcc) {
                                                    const updated = new Map(includedSkipped);
                                                    const current = updated.get(txn.row)!;
                                                    updated.set(txn.row, { ...current, account: selectedAcc.code, ledger_type: showCust ? 'C' : 'S' });
                                                    setIncludedSkipped(updated);
                                                  }
                                                }
                                                setInlineAccountSearch(null);
                                                setInlineAccountSearchText('');
                                              }
                                            }}
                                            placeholder={`Search ${showCust ? 'customer' : 'supplier'}...`}
                                            data-account-input={`skipped-${txn.row}`}
                                            className={`w-full text-sm px-2 py-1 border-2 rounded focus:ring-2 focus:ring-blue-500 focus:border-blue-500 focus:outline-none ${
                                              inclusion?.account ? 'border-green-400 bg-green-50' : 'border-gray-300'
                                            } ${inclusion?.account ? 'pr-7' : ''}`}
                                          />
                                          {inclusion?.account && !(inlineAccountSearch?.row === txn.row && inlineAccountSearch?.section === 'skipped') && (
                                            <button
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                setIncludedSkipped(prev => { const u = new Map(prev); u.delete(txn.row); return u; });
                                                setSelectedForImport(prev => { const u = new Set(prev); u.delete(txn.row); return u; });
                                              }}
                                              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-gray-400 hover:text-red-500 rounded-full hover:bg-red-50"
                                              title="Clear account assignment"
                                            >
                                              <X className="h-3.5 w-3.5" />
                                            </button>
                                          )}
                                          {inlineAccountSearch?.row === txn.row && inlineAccountSearch?.section === 'skipped' && (
                                            <>
                                              {/* Click-outside overlay - rendered first so dropdown is on top */}
                                              <div
                                                className="fixed inset-0 z-40"
                                                onClick={() => {
                                                  setInlineAccountSearch(null);
                                                  setInlineAccountSearchText('');
                                                }}
                                              />
                                              <div className="absolute z-50 w-64 mt-1 bg-white border border-gray-300 rounded-md shadow-lg max-h-48 overflow-y-auto">
                                                {filteredSkippedAccounts.map((acc, idx) => (
                                                    <button
                                                      key={acc.code}
                                                      type="button"
                                                      ref={idx === inlineAccountHighlightIndex ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                                                      onClick={() => {
                                                        // Check if this was already filled (editing) vs new entry
                                                        const wasAlreadyFilled = inclusion?.account;
                                                        const updated = new Map(includedSkipped);
                                                        const current = updated.get(txn.row)!;
                                                        updated.set(txn.row, { ...current, account: acc.code, ledger_type: showCust ? 'C' : 'S' });
                                                        setIncludedSkipped(updated);
                                                        setInlineAccountSearch(null);
                                                        setInlineAccountSearchText('');
                                                        // Only move to next row if this was a new entry, not an edit
                                                        if (!wasAlreadyFilled) {
                                                          const currentIdx = filtered.findIndex(t => t.row === txn.row);
                                                          if (currentIdx >= 0 && currentIdx < filtered.length - 1) {
                                                            const nextRow = filtered[currentIdx + 1];
                                                            setTimeout(() => {
                                                              const nextInput = document.querySelector(`[data-account-input="skipped-${nextRow.row}"]`) as HTMLInputElement;
                                                              if (nextInput) nextInput.focus();
                                                            }, 10);
                                                          }
                                                        }
                                                      }}
                                                      className={`w-full text-left px-2 py-1.5 text-sm ${
                                                        idx === inlineAccountHighlightIndex ? 'bg-blue-100' : 'hover:bg-blue-50'
                                                      }`}
                                                    >
                                                      <span className="font-medium">{acc.code}</span>
                                                      <span className="text-gray-600"> - {acc.name}</span>
                                                    </button>
                                                  ))}
                                                {filteredSkippedAccounts.length === 0 && (
                                                  <div className="px-2 py-1.5 text-sm text-gray-500">No matches found</div>
                                                )}
                                              </div>
                                            </>
                                          )}
                                        </div>
                                        );
                                      })()
                                    ) : null}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      {includedSkipped.size > 0 && (
                        <div className="mt-3 p-3 bg-green-50 border border-green-200 rounded flex items-center gap-2 text-green-700">
                          <Edit3 className="h-4 w-4" />
                          <span className="text-sm font-medium">
                            {includedSkipped.size} skipped item(s) included for import
                            {Array.from(includedSkipped.values()).filter(v => !v.account).length > 0 && (
                              <span className="text-amber-600 ml-2">
                                ({Array.from(includedSkipped.values()).filter(v => !v.account).length} still need account assignment)
                              </span>
                            )}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* ===== STAGE 4: IMPORT TO OPERA ===== */}
                <div className="mt-4 p-4 bg-indigo-50 border-2 border-indigo-300 rounded-lg">
                  <h3 className="text-lg font-semibold text-indigo-800 mb-4 flex items-center gap-2">
                    <div className={`w-8 h-8 rounded-full ${allTransactionsImported ? 'bg-green-500' : 'bg-indigo-600'} text-white flex items-center justify-center text-sm font-bold`}>
                      {allTransactionsImported ? '✓' : '4'}
                    </div>
                    Import to Opera
                    <span className="font-normal text-sm text-indigo-600 ml-2">— Post transactions to cashbook</span>
                  </h3>

                  {/* Import Readiness Summary */}
                  <div className={`p-3 rounded-lg border mb-4 ${
                    allTransactionsImported || allAlreadyInOpera
                      ? 'bg-green-50 border-green-200'
                      : bankImportResult?.success
                        ? 'bg-blue-50 border-blue-200'
                        : importReadiness?.canImport
                          ? 'bg-green-50 border-green-200'
                          : 'bg-amber-50 border-amber-200'
                  }`}>
                    <div className="flex items-start gap-3">
                      {allTransactionsImported || allAlreadyInOpera ? (
                        <CheckCircle className="h-5 w-5 text-green-600 mt-0.5 flex-shrink-0" />
                      ) : bankImportResult?.success ? (
                        <AlertCircle className="h-5 w-5 text-blue-600 mt-0.5 flex-shrink-0" />
                      ) : importReadiness?.canImport ? (
                        <CheckCircle className="h-5 w-5 text-green-600 mt-0.5 flex-shrink-0" />
                      ) : (
                        <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-4 flex-wrap text-sm">
                          <span className={allTransactionsImported || allAlreadyInOpera ? 'text-green-800 font-medium' : bankImportResult?.success ? 'text-blue-800 font-medium' : importReadiness?.canImport ? 'text-green-800 font-medium' : 'text-amber-800 font-medium'}>
                            {allTransactionsImported
                              ? `Import complete for "${selectedPdfFile?.filename || selectedEmailStatement?.filename || 'statement'}" — please reconcile`
                              : allAlreadyInOpera
                                ? 'All non-deferred transactions are now in Opera — nothing further to import, proceed to reconcile'
                              : bankImportResult?.success
                                ? (bankImportResult.imported_count || 0) === 0 && (bankImportResult.skipped_count || 0) > 0
                                  ? `Nothing to import — all ${bankImportResult.skipped_count} attempted transaction${bankImportResult.skipped_count === 1 ? '' : 's'} already in Opera.`
                                  : `${bankImportResult.imported_count || 0} imported — select remaining transactions to continue`
                                : importReadiness?.canImport
                                  ? `Ready to import ${importReadiness.totalReady} transaction${importReadiness.totalReady !== 1 ? 's' : ''}${duplicateTransactionCount > 0 ? ` (${duplicateTransactionCount} already in Opera)` : ''}`
                                  : duplicateTransactionCount > 0
                                    ? `${duplicateTransactionCount} transaction${duplicateTransactionCount !== 1 ? 's' : ''} already in Opera — no new transactions to import`
                                    : 'No transactions selected to import'}
                          </span>
                          {/* Show breakdown */}
                          {importReadiness && (
                            <span className="text-gray-600 text-xs">
                              {importReadiness.receiptsReady > 0 && <span className="mr-2">✓ {importReadiness.receiptsReady} receipts</span>}
                              {importReadiness.paymentsReady > 0 && <span className="mr-2">✓ {importReadiness.paymentsReady} payments</span>}
                              {importReadiness.refundsReady > 0 && <span className="mr-2">✓ {importReadiness.refundsReady} refunds</span>}
                              {importReadiness.unmatchedReady > 0 && <span className="mr-2">✓ {importReadiness.unmatchedReady} unmatched</span>}
                              {importReadiness.skippedReady > 0 && <span className="mr-2">✓ {importReadiness.skippedReady} included</span>}
                            </span>
                          )}
                        </div>
                        {/* Show issues if any (hidden only when ALL transactions imported) */}
                        {importReadiness && !importReadiness.canImport && !allTransactionsImported && (
                          <div className="mt-2 text-sm text-amber-700 space-y-2">
                            {importReadiness.totalIncomplete > 0 && (
                              <div className="p-3 bg-amber-100 rounded">
                                <div className="flex items-center gap-1 font-medium">
                                  <XCircle className="h-3.5 w-3.5" />
                                  <span>{importReadiness.totalIncomplete} transaction{importReadiness.totalIncomplete !== 1 ? 's' : ''} missing account assignment</span>
                                </div>
                                <div className="mt-2 ml-4 text-xs text-amber-700 space-y-1">
                                  <p><strong>Option 1:</strong> Assign an account in the Unmatched tab above (e.g., select Customer/Supplier)</p>
                                  <p><strong>Option 2:</strong> Exclude from import and enter manually in Opera:</p>
                                  <ul className="list-disc list-inside ml-4 text-amber-600">
                                    <li>Uncheck the transaction above to exclude it</li>
                                    <li>Enter the receipt/payment directly in Opera Cashbook</li>
                                    <li>Note: Excluded items won't appear in auto-reconcile - you'll mark them off manually</li>
                                  </ul>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => {
                                    // Find and deselect all unmatched transactions without accounts
                                    const unmatched = bankPreview?.unmatched || [];
                                    const newSelected = new Set(selectedForImport);
                                    unmatched.forEach(txn => {
                                      const edited = editedTransactions.get(txn.row);
                                      if (!edited?.manual_account && selectedForImport.has(txn.row)) {
                                        newSelected.delete(txn.row);
                                      }
                                    });
                                    // Also check skipped included items
                                    includedSkipped.forEach((data, row) => {
                                      if (!data.account) {
                                        setIncludedSkipped(prev => {
                                          const updated = new Map(prev);
                                          updated.delete(row);
                                          return updated;
                                        });
                                      }
                                    });
                                    setSelectedForImport(newSelected);
                                  }}
                                  className="mt-3 ml-4 px-3 py-1.5 text-xs bg-amber-200 hover:bg-amber-300 text-amber-800 rounded transition-colors font-medium"
                                >
                                  Exclude all unassigned (enter in Opera manually)
                                </button>
                              </div>
                            )}
                            {importReadiness.hasPeriodViolations && (
                              <div className="flex items-center gap-1">
                                <XCircle className="h-3.5 w-3.5" />
                                <span>{importReadiness.periodViolationsCount} transaction{importReadiness.periodViolationsCount !== 1 ? 's have' : ' has'} dates outside allowed posting period</span>
                              </div>
                            )}
                            {importReadiness.hasUnhandledRepeatEntries && (
                              <div className="flex items-center gap-1">
                                <XCircle className="h-3.5 w-3.5" />
                                <span>{importReadiness.unhandledRepeatEntries} repeat entr{importReadiness.unhandledRepeatEntries !== 1 ? 'ies need' : 'y needs'} processing in Opera first</span>
                              </div>
                            )}
                            {importReadiness.totalReady === 0 && importReadiness.totalIncomplete === 0 && !allAlreadyInOpera && (
                              <div className="flex items-center gap-1">
                                <XCircle className="h-3.5 w-3.5" />
                                <span>{(alreadyInOperaCount + deferredRows.size) > 0
                                  ? 'All non-deferred transactions are now in Opera — nothing further to import, proceed to reconcile'
                                  : 'No transactions selected for import - check the boxes to include items'}</span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Import Controls */}
                  <div className="flex items-center gap-4 flex-wrap">
                    {/* Import Button */}
                    <button
                      onClick={(allAlreadyInOpera || allItemsHandled) ? async () => {
                        // If there are deferred rows, the import endpoint must be
                        // called first so they're audited to deferred_transactions.db
                        // and the bank_statement_imports record is created. Without
                        // this, Sequential Statement Gating can't derive 'imported'
                        // state and the next statement stays gated.
                        if (deferredRows.size > 0) {
                          try {
                            if (isEmailSource) {
                              await handleEmailImport();
                            } else if (selectedPdfFile) {
                              await handlePdfImport();
                            } else {
                              await handleBankImport();
                            }
                          } catch (e) {
                            console.warn('Defer-only import call failed; proceeding to reconcile anyway', e);
                          }
                        }
                        const reconcileData = {
                          bank_code: selectedBankCode,
                          statement_transactions: bankPreview?.statement_transactions || [],
                          statement_info: bankPreview?.statement_info || bankPreview?.statement_bank_info || null,
                          source: (selectedPdfFile ? 'pdf' : 'email') as string,
                          imported_at: new Date().toISOString(),
                          import_id: undefined as number | undefined,
                          filename: selectedPdfFile?.filename || selectedEmailStatement?.filename || undefined,
                          email_id: selectedEmailStatement?.emailId || undefined,
                          full_path: selectedPdfFile?.fullPath || undefined,
                        };
                        if (onImportComplete) {
                          onImportComplete(reconcileData);
                        } else {
                          sessionStorage.setItem(currentCompanyId ? `reconcile_statement_data_${currentCompanyId}` : 'reconcile_statement_data', JSON.stringify(reconcileData));
                          window.location.href = `/cashbook/statement-reconcile?bank=${encodeURIComponent(selectedBankCode)}`;
                        }
                      } : (isEmailSource ? handleEmailImport : selectedPdfFile ? handlePdfImport : handleBankImport)}
                      disabled={importDisabled || isImporting || (allTransactionsImported && !allAlreadyInOpera && !allItemsHandled)}
                      className={`px-6 py-3 rounded-lg flex items-center gap-2 font-medium text-lg ${
                        (allAlreadyInOpera || allItemsHandled || allTransactionsImported)
                          ? 'bg-green-600 text-white hover:bg-green-700 shadow-md hover:shadow-lg transition-all'
                          : importDisabled || isImporting
                            ? 'bg-gray-400 text-white cursor-not-allowed'
                            : 'bg-green-600 text-white hover:bg-green-700 shadow-md hover:shadow-lg transition-all'
                      }`}
                      title={allAlreadyInOpera
                        ? 'All transactions are already in Opera — click to reconcile'
                        : allTransactionsImported
                          ? 'All transactions imported — click to reconcile'
                          : importTitle || 'Import transactions to Opera'}
                    >
                      {isImporting ? <Loader2 className="h-5 w-5 animate-spin" /> : (allAlreadyInOpera || allItemsHandled) ? <ArrowRight className="h-5 w-5" /> : <CheckCircle className="h-5 w-5" />}
                      {allAlreadyInOpera || allItemsHandled ? 'Proceed to Reconcile' : allTransactionsImported ? 'All Imported' : 'Import to Opera'}
                      {!allTransactionsImported && !allAlreadyInOpera && importReadiness && importReadiness.totalReady > 0 && (
                        <span className="bg-green-500 text-white text-sm px-2 py-0.5 rounded-full ml-1">
                          {importReadiness.totalReady}
                        </span>
                      )}
                    </button>
                    {/* Standalone reconcile buttons removed — main button handles reconcile flow */}
                  </div>

                  {dataSource === 'opera3' && (
                    <p className="mt-3 text-sm text-amber-600 flex items-center gap-1">
                      <AlertCircle className="h-4 w-4" />
                      Import not available for Opera 3 (read-only data source)
                    </p>
                  )}

                  {/* Reconcile prompt removed — main button handles reconcile flow */}
                </div>

                {/* Errors */}
                {bankPreview.errors && bankPreview.errors.length > 0 && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                    <h4 className="font-medium text-red-800 mb-2">Errors</h4>
                    <ul className="list-disc list-inside text-sm text-red-600">
                      {bankPreview.errors.map((err, idx) => (
                        <li key={idx}>{err}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {/* Import Results */}
            {bankImportResult && (
              <div ref={importResultRef} className={`p-4 rounded-lg ${bankImportResult.success ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
                <div className="flex items-center gap-2 mb-2">
                  {bankImportResult.success ? (
                    <CheckCircle className="h-5 w-5 text-green-600" />
                  ) : (
                    <XCircle className="h-5 w-5 text-red-600" />
                  )}
                  <h3 className={`font-semibold ${bankImportResult.success ? 'text-green-800' : 'text-red-800'}`}>
                    {bankImportResult.success
                      ? (bankImportResult.imported_count || 0) === 0 && (bankImportResult.skipped_count || 0) > 0
                        ? 'Nothing to Import'
                        : 'Import Completed'
                      : 'Import Failed'}
                  </h3>
                </div>
                {bankImportResult.imported_transactions_count !== undefined && (
                  <div className="text-sm text-gray-700">
                    <p className="font-medium">
                      Imported {bankImportResult.imported_transactions_count} transactions
                      {bankImportResult.total_amount && ` totaling £${bankImportResult.total_amount.toFixed(2)}`}
                    </p>
                    {(bankImportResult.receipts_imported > 0 || bankImportResult.payments_imported > 0 || bankImportResult.refunds_imported > 0) && (
                      <div className="mt-1 text-xs space-x-3">
                        {bankImportResult.receipts_imported > 0 && (
                          <span className="text-green-600">{bankImportResult.receipts_imported} receipts</span>
                        )}
                        {bankImportResult.payments_imported > 0 && (
                          <span className="text-red-600">{bankImportResult.payments_imported} payments</span>
                        )}
                        {bankImportResult.refunds_imported > 0 && (
                          <span className="text-orange-600">{bankImportResult.refunds_imported} refunds</span>
                        )}
                        {bankImportResult.skipped_rejected > 0 && (
                          <span className="text-gray-500">{bankImportResult.skipped_rejected} rejected</span>
                        )}
                      </div>
                    )}
                    {/* Show allocation results if auto-allocate was enabled */}
                    {bankImportResult.auto_allocate_enabled && bankImportResult.allocations_attempted > 0 && (
                      <div className="mt-2 p-2 bg-purple-50 border border-purple-200 rounded text-xs">
                        <span className="font-medium text-purple-800">Invoice allocation: </span>
                        <span className="text-purple-700">
                          {bankImportResult.allocations_successful} of {bankImportResult.allocations_attempted} transactions matched to invoices
                        </span>
                      </div>
                    )}
                    {/* Show auto-reconcile results */}
                    {bankImportResult.reconciliation_result && (
                      <div className={`mt-2 p-2 rounded text-xs ${
                        bankImportResult.reconciliation_result.success
                          ? 'bg-green-50 border border-green-200'
                          : 'bg-amber-50 border border-amber-200'
                      }`}>
                        <span className={`font-medium ${
                          bankImportResult.reconciliation_result.success ? 'text-green-800' : 'text-amber-800'
                        }`}>
                          {bankImportResult.reconciliation_result.success ? '✓ Statement reconciled: ' : 'Reconciliation: '}
                        </span>
                        <span className={bankImportResult.reconciliation_result.success ? 'text-green-700' : 'text-amber-700'}>
                          {bankImportResult.reconciliation_result.success
                            ? `${bankImportResult.reconciliation_result.entries_reconciled} entries with line numbers assigned`
                            : bankImportResult.reconciliation_result.messages?.join(', ') || 'Not completed'
                          }
                        </span>
                      </div>
                    )}
                  </div>
                )}
                {bankImportResult.error && (
                  <div className="mt-2">
                    <p className="text-sm font-medium text-red-700">{bankImportResult.error}</p>
                    {bankImportResult.message && (
                      <p className="text-sm text-red-600 mt-2 p-2 bg-red-100 rounded">{bankImportResult.message}</p>
                    )}
                    {bankImportResult.overlap_warning && bankImportResult.overlap_details && (
                      <div className="mt-2 p-3 bg-amber-50 border border-amber-200 rounded">
                        <p className="text-sm text-amber-800">
                          A previous import record exists for <strong>{bankImportResult.overlap_details.existing_filename}</strong> ({bankImportResult.overlap_details.existing_period}), imported on {bankImportResult.overlap_details.existing_import_date?.split('T')[0] || bankImportResult.overlap_details.existing_import_date}.
                        </p>
                        <p className="text-xs text-amber-600 mt-1">
                          If you have restored the Opera database, the previous import tracking record is stale and can be safely cleared.
                        </p>
                        <button
                          className="mt-2 px-3 py-1.5 text-sm font-medium bg-amber-600 text-white rounded hover:bg-amber-700"
                          onClick={async () => {
                            const importId = bankImportResult.overlap_details.existing_import_id;
                            try {
                              setBankImportResult(null);
                              setIsImporting(true);
                              // Delete the stale import record
                              await authFetch(`${API_BASE}/bank-import/import-history/${importId}`, { method: 'DELETE' });
                              // Re-run the import. Match the main button's
                              // dispatch order: email source first (most
                              // common when statementSource='email'), then
                              // PDF, then CSV fallback. The previous order
                              // preferred selectedPdfFile, which routed
                              // email-source imports through /import-from-pdf
                              // with an empty file_path when a stale
                              // selectedPdfFile lingered from session restore.
                              if (isEmailSource && selectedEmailStatement) {
                                await handleEmailImport();
                              } else if (selectedPdfFile?.fullPath) {
                                await handlePdfImport();
                              } else if (selectedEmailStatement) {
                                await handleEmailImport();
                              } else {
                                await handleBankImport();
                              }
                            } catch (err) {
                              setBankImportResult({
                                success: false,
                                error: `Failed to clear old record: ${err instanceof Error ? err.message : 'Unknown error'}`
                              });
                              setIsImporting(false);
                            }
                          }}
                        >
                          Clear Old Record & Retry Import
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {/* Show blocking repeat entries */}
                {bankImportResult.repeat_entries && bankImportResult.repeat_entries.length > 0 && (
                  <div className="mt-3 p-3 bg-orange-50 border border-orange-200 rounded">
                    <h4 className="font-medium text-orange-800 mb-2">Repeat Entries Requiring Action:</h4>
                    <ul className="text-sm text-orange-700 space-y-1">
                      {bankImportResult.repeat_entries.map((entry: any, idx: number) => (
                        <li key={idx} className="flex justify-between">
                          <span>{entry.entry_desc || entry.name}</span>
                          <span className="font-mono">{entry.amount < 0 ? '-' : ''}£{Math.abs(entry.amount).toFixed(2)}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="text-xs text-orange-600 mt-2">
                      Go to Opera → Cashbook → Repeat Entries → Post routine, then re-preview this statement.
                    </p>
                  </div>
                )}
                {/* Show period violations */}
                {bankImportResult.period_violations && bankImportResult.period_violations.length > 0 && (
                  <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded">
                    <h4 className="font-medium text-amber-800 mb-2">Period Violations - Cannot Import:</h4>
                    {bankImportResult.period_info && (
                      <p className="text-sm text-amber-600 mb-2">
                        Current period is {bankImportResult.period_info.current_period}/{bankImportResult.period_info.current_year}
                      </p>
                    )}
                    <ul className="text-sm text-amber-700 space-y-1">
                      {bankImportResult.period_violations.map((v: any, idx: number) => (
                        <li key={idx}>
                          <strong>{v.name || `Row ${v.row}`}</strong> ({v.date}) -
                          {v.ledger_name && <span className="text-amber-600"> {v.ledger_name}</span>}: {v.error}
                        </li>
                      ))}
                    </ul>
                    <p className="text-sm text-amber-600 mt-2">
                      Please adjust the dates or open the periods in Opera before importing.
                    </p>
                  </div>
                )}
                {bankImportResult.errors && bankImportResult.errors.length > 0 && (
                  <ul className="mt-2 list-disc list-inside text-sm text-red-600">
                    {bankImportResult.errors.map((err: any, idx: number) => (
                      <li key={idx}>Row {err.row}: {err.error}</li>
                    ))}
                  </ul>
                )}

              </div>
            )}

            {/* ===== STAGE 5: RECONCILE ===== */}
            {((bankImportResult?.success && showReconcilePrompt) || allAlreadyInOpera || allItemsHandled) && bankPreview && (
              <div className="mt-4 p-4 bg-green-50 border-2 border-green-300 rounded-lg">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-green-600 text-white flex items-center justify-center text-sm font-bold flex-shrink-0">5</div>
                    <h4 className="font-semibold text-green-800">
                      {bankImportResult?.reconciliation_result?.success
                        ? 'Statement Reconciled'
                        : 'Reconcile Statement'}
                      <span className="font-normal text-sm text-green-600 ml-2">— Verify imported entries against statement</span>
                    </h4>
                    {bankImportResult?.reconciliation_result?.success && (
                      <span className="text-xs bg-green-200 text-green-800 px-2 py-1 rounded">
                        Line numbers assigned automatically
                      </span>
                    )}
                  </div>
                </div>

                {/* Summary stats */}
                <div className="mb-4 p-3 bg-white rounded border border-green-200 grid grid-cols-3 gap-4 text-sm">
                  <div>
                    <div className="text-gray-500">Statement Lines</div>
                    <div className="font-semibold text-lg">{bankPreview?.total_transactions || '-'}</div>
                  </div>
                  <div>
                    <div className="text-gray-500">In Opera</div>
                    <div className="font-semibold text-lg text-green-600">{(bankPreview?.already_posted?.length || 0) + ([...(bankPreview?.matched_receipts || []), ...(bankPreview?.matched_payments || []), ...(bankPreview?.matched_refunds || [])].filter(t => t.is_duplicate).length)}</div>
                  </div>
                  <div>
                    <div className="text-gray-500">Ignored</div>
                    <div className="font-semibold text-lg text-gray-500">{ignoredTransactions.size}</div>
                  </div>
                </div>

                {/* Statement transactions table - ALL transactions in PDF order with line numbers */}
                {(() => {
                  // Get ALL statement transactions from bankPreview, sorted by row (PDF order)
                  // Build entry number lookup from already_posted (these have duplicate_candidates)
                  const alreadyPostedByRow = new Map<number, any>();
                  (bankPreview.already_posted || []).forEach((t: any) => {
                    if (t.row) {
                      const entryNum = t.duplicate_candidates?.[0]?.record_id || t.entry_number || t.matched_entry || null;
                      alreadyPostedByRow.set(t.row, { ...t, entry_number: entryNum });
                    }
                  });

                  // Build all statement transactions — prefer already_posted version (has entry_number)
                  const seenRows = new Set<number>();
                  const allStatementTxns = [
                    ...(bankPreview.matched_receipts || []),
                    ...(bankPreview.matched_payments || []),
                    ...(bankPreview.matched_refunds || []),
                    ...(bankPreview.repeat_entries || []),
                    ...(bankPreview.unmatched || []),
                    ...(bankPreview.already_posted || []),
                    ...(bankPreview.skipped || [])
                  ].map(t => {
                    // If this row has an already_posted version with entry_number, use it
                    if (t.row && alreadyPostedByRow.has(t.row)) {
                      return alreadyPostedByRow.get(t.row);
                    }
                    return t;
                  }).filter(t => {
                    // Deduplicate by row
                    if (!t.row) return true;
                    if (seenRows.has(t.row)) return false;
                    seenRows.add(t.row);
                    return true;
                  }).sort((a, b) => (a.row || 0) - (b.row || 0));

                  // Build a map of row -> imported transaction (to get entry_number)
                  const importedByRow = new Map<number, any>();
                  (bankImportResult?.imported_transactions || []).forEach((t: any) => {
                    if (t.row) importedByRow.set(t.row, t);
                  });
                  // Mark already_posted items as "in Opera"
                  (bankPreview.already_posted || []).forEach((t: any) => {
                    if (t.row && !importedByRow.has(t.row)) {
                      const entryNum = t.duplicate_candidates?.[0]?.record_id || t.entry_number || t.matched_entry || null;
                      importedByRow.set(t.row, { ...t, already_in_opera: true, entry_number: entryNum });
                    }
                  });
                  // Also check ALL categories — enriched transactions have duplicate data
                  [...(bankPreview.matched_receipts || []),
                   ...(bankPreview.matched_payments || []),
                   ...(bankPreview.matched_refunds || []),
                   ...(bankPreview.repeat_entries || []),
                   ...(bankPreview.skipped || [])].forEach((t: any) => {
                    if (t.row && (t.is_duplicate || t.action === 'skip') && !importedByRow.has(t.row)) {
                      const entryNum = t.duplicate_candidates?.[0]?.record_id || t.entry_number || t.matched_entry || null;
                      if (entryNum) {
                        importedByRow.set(t.row, { ...t, already_in_opera: true, entry_number: entryNum });
                      }
                    }
                  });

                  if (allStatementTxns.length === 0) {
                    return (
                      <div className="p-4 bg-amber-50 border border-amber-200 rounded text-amber-800">
                        No statement transactions found.
                      </div>
                    );
                  }

                  // Count how many are in Opera
                  const importedCount = allStatementTxns.filter(t => importedByRow.has(t.row)).length;

                  return (
                    <>
                      <div className="bg-white rounded border border-green-200 overflow-hidden">
                        <div className="px-3 py-2 bg-green-100 border-b border-green-200">
                          <span className="text-sm font-medium text-green-800">
                            Statement Transactions ({allStatementTxns.length} lines)
                          </span>
                        </div>
                        <div className="max-h-80 overflow-auto">
                          <table className="w-full text-sm">
                            <thead className="bg-green-50 sticky top-0">
                              <tr>
                                <th className="px-2 py-2 text-center text-green-800 font-bold w-16">Line #</th>
                                <th className="px-2 py-2 text-left text-green-800">Date</th>
                                <th className="px-2 py-2 text-right text-green-800">Amount</th>
                                <th className="px-2 py-2 text-left text-green-800">Description</th>
                                <th className="px-2 py-2 text-left text-green-800">Opera Entry</th>
                              </tr>
                            </thead>
                            <tbody>
                              {allStatementTxns.map((txn: any, idx: number) => {
                                const imported = importedByRow.get(txn.row);
                                const lineNumber = txn.row ? txn.row * 10 : (idx + 1) * 10;

                                return (
                                  <tr key={txn.row || idx} className={`border-t border-green-100 ${imported ? 'bg-white' : 'bg-gray-50 text-gray-400'}`}>
                                    <td className="px-2 py-2 text-center font-bold text-green-700 bg-green-50">
                                      {lineNumber}
                                    </td>
                                    <td className="px-2 py-2 whitespace-nowrap">
                                      {typeof txn.date === 'string' ? txn.date.split('T')[0] : txn.date || '-'}
                                    </td>
                                    <td className={`px-2 py-2 text-right font-mono ${(txn.amount || 0) < 0 ? 'text-red-600' : 'text-green-600'}`}>
                                      £{Math.abs(txn.amount || 0).toFixed(2)}
                                    </td>
                                    <td className="px-2 py-2 truncate max-w-[300px]" title={txn.name || txn.memo || txn.description || ''}>
                                      {txn.name || txn.memo || txn.description || '-'}
                                    </td>
                                    <td className="px-2 py-2 font-mono text-xs text-blue-600">
                                      {imported?.entry_number || txn.entry_number || txn.matched_entry || txn.duplicate_candidates?.[0]?.record_id || <span className="text-gray-400">-</span>}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>

                      {/* Summary and action buttons */}
                      <div className="mt-4 flex items-center justify-between">
                        <div className="text-sm text-green-700">
                          <strong>{allStatementTxns.length}</strong> statement lines
                          <span className="ml-2 text-green-600">
                            • {importedCount} in Opera
                          </span>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => {
                              // Store statement data in sessionStorage for reconcile screen
                              const reconcileData = {
                                bank_code: selectedBankCode,
                                statement_transactions: bankPreview?.statement_transactions || [],
                                statement_info: bankPreview?.statement_info || bankPreview?.statement_bank_info || null,
                                source: (selectedPdfFile ? 'pdf' : 'email'),
                                imported_at: new Date().toISOString(),
                                import_id: bankImportResult?.import_id || null,
                                filename: selectedPdfFile?.filename || selectedEmailStatement?.filename || undefined,
                                email_id: selectedEmailStatement?.emailId || undefined,
                                full_path: selectedPdfFile?.fullPath || undefined,
                              };
                              if (onImportComplete) {
                                onImportComplete(reconcileData);
                              } else {
                                sessionStorage.setItem(currentCompanyId ? `reconcile_statement_data_${currentCompanyId}` : 'reconcile_statement_data', JSON.stringify(reconcileData));
                                window.location.href = `/cashbook/statement-reconcile?bank=${encodeURIComponent(selectedBankCode)}`;
                              }
                            }}
                            className="px-6 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 font-medium flex items-center gap-2 shadow-md hover:shadow-lg transition-all"
                          >
                            Reconcile Statement
                            <ArrowRight className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    </>
                  );
                })()}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Help - Bank Statement */}
      {activeType === 'bank-statement' && (
        <div className="mt-6 bg-blue-50 rounded-lg p-4 border border-blue-200">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-blue-600 flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="font-semibold text-blue-800">Bank Statement Import</h3>
              <div className="text-sm text-blue-700 mt-1 space-y-2">
                <p>Import transactions from bank statement files (CSV, OFX, QIF, MT940).</p>
                <p>The system will automatically match transactions to customers/suppliers using fuzzy name matching.</p>
                <div className="bg-white/50 rounded p-2 mt-2">
                  <p className="font-medium text-blue-800 mb-1">Workflow:</p>
                  <ol className="list-decimal list-inside space-y-1 text-blue-700">
                    <li>Click "Analyse Transactions" to analyze the bank statement</li>
                    <li>Review matched receipts (green) and payments (red)</li>
                    <li>For unmatched transactions (amber), select an account from the dropdown</li>
                    <li>Use checkboxes to bulk-assign multiple transactions at once</li>
                    <li>Click "Import Transactions" when ready</li>
                  </ol>
                </div>
                {dataSource === 'opera-sql' ? (
                  <p className="font-medium mt-2">Opera SQL SE: Full import functionality available.</p>
                ) : (
                  <p className="font-medium text-amber-700 mt-2">Opera 3: Preview only (read-only data source).</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Form (for other import types) */}
      {activeType !== 'bank-statement' && (
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          {importTypes.find(t => t.id === activeType)?.label}
        </h2>

        <div className="space-y-6">
          {/* Common Fields Row */}
          <div className="grid grid-cols-4 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Post Date</label>
              <input
                type="date"
                value={postDate}
                onChange={e => setPostDate(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            {(activeType === 'sales-receipt' || activeType === 'purchase-payment') && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Bank Account</label>
                <input
                  type="text"
                  value={bankAccount}
                  onChange={e => setBankAccount(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                  placeholder="e.g. BB005"
                />
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Reference</label>
              <input
                type="text"
                value={reference}
                onChange={e => setReference(e.target.value)}
                maxLength={20}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                placeholder="e.g., INV12345"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Input By</label>
              <input
                type="text"
                value={inputBy}
                onChange={e => setInputBy(e.target.value)}
                maxLength={8}
                className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
          </div>

          {/* Sales Receipt Fields */}
          {activeType === 'sales-receipt' && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Customer Account *</label>
                <input
                  type="text"
                  value={customerAccount}
                  onChange={e => setCustomerAccount(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                  placeholder="e.g., A046"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Amount (GBP) *</label>
                <input
                  type="number"
                  value={receiptAmount}
                  onChange={e => setReceiptAmount(e.target.value)}
                  step="0.01"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                  placeholder="100.00"
                />
              </div>
            </div>
          )}

          {/* Purchase Payment Fields */}
          {activeType === 'purchase-payment' && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Supplier Account *</label>
                <input
                  type="text"
                  value={supplierAccount}
                  onChange={e => setSupplierAccount(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                  placeholder="e.g., P001"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Amount (GBP) *</label>
                <input
                  type="number"
                  value={paymentAmount}
                  onChange={e => setPaymentAmount(e.target.value)}
                  step="0.01"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                  placeholder="500.00"
                />
              </div>
            </div>
          )}

          {/* Sales Invoice Fields */}
          {activeType === 'sales-invoice' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Customer Account *</label>
                  <input
                    type="text"
                    value={customerAccount}
                    onChange={e => setCustomerAccount(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                    placeholder="e.g., A046"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Invoice Number *</label>
                  <input
                    type="text"
                    value={invoiceNumber}
                    onChange={e => setInvoiceNumber(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                    placeholder="e.g., INV001"
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Net Amount (GBP) *</label>
                  <input
                    type="number"
                    value={netAmount}
                    onChange={e => setNetAmount(e.target.value)}
                    step="0.01"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                    placeholder="1000.00"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">VAT Amount (GBP)</label>
                  <input
                    type="number"
                    value={vatAmount}
                    onChange={e => setVatAmount(e.target.value)}
                    step="0.01"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                    placeholder="200.00"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Sales Nominal</label>
                  <input
                    type="text"
                    value={nominalAccount}
                    onChange={e => setNominalAccount(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                    placeholder="GA010"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <input
                  type="text"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                  placeholder="Invoice description"
                />
              </div>
            </div>
          )}

          {/* Purchase Invoice Fields */}
          {activeType === 'purchase-invoice' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Supplier Account *</label>
                  <input
                    type="text"
                    value={supplierAccount}
                    onChange={e => setSupplierAccount(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                    placeholder="e.g., P001"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Invoice Number *</label>
                  <input
                    type="text"
                    value={invoiceNumber}
                    onChange={e => setInvoiceNumber(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                    placeholder="e.g., PINV001"
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Net Amount (GBP) *</label>
                  <input
                    type="number"
                    value={netAmount}
                    onChange={e => setNetAmount(e.target.value)}
                    step="0.01"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                    placeholder="500.00"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">VAT Amount (GBP)</label>
                  <input
                    type="number"
                    value={vatAmount}
                    onChange={e => setVatAmount(e.target.value)}
                    step="0.01"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                    placeholder="100.00"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Expense Nominal</label>
                  <input
                    type="text"
                    value={nominalAccount}
                    onChange={e => setNominalAccount(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                    placeholder="HA010"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <input
                  type="text"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                  placeholder="Invoice description"
                />
              </div>
            </div>
          )}

          {/* Nominal Journal Fields */}
          {activeType === 'nominal-journal' && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <input
                  type="text"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                  placeholder="Journal description"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Journal Lines</label>
                <div className="space-y-2">
                  {journalLines.map((line, idx) => (
                    <div key={idx} className="flex gap-2 items-center">
                      <input
                        type="text"
                        value={line.account}
                        onChange={e => updateJournalLine(idx, 'account', e.target.value)}
                        className="w-32 px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                        placeholder="Account"
                      />
                      <input
                        type="number"
                        value={line.amount}
                        onChange={e => updateJournalLine(idx, 'amount', e.target.value)}
                        step="0.01"
                        className="w-32 px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                        placeholder="Amount"
                      />
                      <input
                        type="text"
                        value={line.description}
                        onChange={e => updateJournalLine(idx, 'description', e.target.value)}
                        className="flex-1 px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                        placeholder="Description"
                      />
                      {journalLines.length > 2 && (
                        <button
                          onClick={() => removeJournalLine(idx)}
                          className="text-red-500 hover:text-red-700"
                        >
                          &times;
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <div className="flex justify-between items-center mt-2">
                  <button
                    onClick={addJournalLine}
                    className="text-blue-600 hover:text-blue-800 text-sm font-medium"
                  >
                    + Add Line
                  </button>
                  <div className={`text-sm font-medium ${Math.abs(journalTotal) < 0.01 ? 'text-green-600' : 'text-red-600'}`}>
                    Total: {journalTotal >= 0 ? '' : '-'}£{Math.abs(journalTotal).toFixed(2)}
                    {Math.abs(journalTotal) < 0.01 ? ' (Balanced)' : ' (Must be £0.00)'}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Validate Only Checkbox and Submit */}
          <div className="flex items-center justify-between pt-4 border-t">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={validateOnly}
                onChange={e => setValidateOnly(e.target.checked)}
                className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
              />
              <span className="text-sm text-gray-700">Validate only (don't import)</span>
            </label>

            <button
              onClick={handleImport}
              disabled={loading || !bankPreview}
              className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed flex items-center gap-2"
              title={!bankPreview ? 'Run Analyse Transactions first' : ''}
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Processing...
                </>
              ) : validateOnly ? (
                'Validate'
              ) : (
                'Import'
              )}
            </button>
          </div>
        </div>
      </div>
      )}

      {/* Results (for non-bank-statement imports) */}
      {activeType !== 'bank-statement' && result && (
        <div className={`rounded-lg shadow p-6 ${
          result.success ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'
        }`}>
          <div className="flex items-start gap-3">
            {result.success ? (
              <CheckCircle className="h-6 w-6 text-green-600 flex-shrink-0" />
            ) : (
              <XCircle className="h-6 w-6 text-red-600 flex-shrink-0" />
            )}
            <div className="flex-1">
              <h3 className={`font-semibold ${result.success ? 'text-green-800' : 'text-red-800'}`}>
                {result.success
                  ? (result.validate_only ? 'Validation Successful' : 'Import Successful')
                  : 'Import Failed'
                }
              </h3>

              {result.details && result.details.length > 0 && (
                <div className="mt-2">
                  <ul className="list-disc list-inside text-sm text-gray-600 space-y-1">
                    {result.details.map((detail, i) => (
                      <li key={i}>{detail}</li>
                    ))}
                  </ul>
                </div>
              )}

              {result.errors && result.errors.length > 0 && (
                <div className="mt-2">
                  <ul className="list-disc list-inside text-sm text-red-600 space-y-1">
                    {result.errors.map((error, i) => (
                      <li key={i}>{error}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Help Section (for non-bank-statement imports) */}
      {activeType !== 'bank-statement' && (
      <div className="bg-blue-50 rounded-lg p-6 border border-blue-200">
        <div className="flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-blue-600 flex-shrink-0 mt-0.5" />
          <div>
            <h3 className="font-semibold text-blue-800">
              {activeType === 'sales-receipt' && 'Sales Receipt Help'}
              {activeType === 'purchase-payment' && 'Purchase Payment Help'}
              {activeType === 'sales-invoice' && 'Sales Invoice Help'}
              {activeType === 'purchase-invoice' && 'Purchase Invoice Help'}
              {activeType === 'nominal-journal' && 'Nominal Journal Help'}
            </h3>
            <div className="text-sm text-blue-700 mt-1 space-y-1">
              {activeType === 'sales-receipt' && (
                <>
                  <p>Records a payment received from a customer.</p>
                  <p>Creates: aentry, atran, and ntran (Debit Bank, Credit SL Control)</p>
                </>
              )}
              {activeType === 'purchase-payment' && (
                <>
                  <p>Records a payment made to a supplier.</p>
                  <p>Creates: aentry, atran, and ntran (Credit Bank, Debit PL Control)</p>
                </>
              )}
              {activeType === 'sales-invoice' && (
                <>
                  <p>Posts a sales invoice to the nominal ledger.</p>
                  <p>Creates: ntran (Debit SL Control, Credit Sales, Credit VAT)</p>
                </>
              )}
              {activeType === 'purchase-invoice' && (
                <>
                  <p>Posts a purchase invoice to the nominal ledger.</p>
                  <p>Creates: ntran (Credit PL Control, Debit Expense, Debit VAT)</p>
                </>
              )}
              {activeType === 'nominal-journal' && (
                <>
                  <p>Posts a manual journal entry. Journal must balance (total = £0.00).</p>
                  <p>Positive amounts = Debit, Negative amounts = Credit</p>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      )}

      {/* Import History Modal */}
      {showImportHistory && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm-xl w-full max-w-4xl max-h-[85vh] overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <History className="h-5 w-5 text-blue-600" />
                Bank Statement Import History
              </h2>
              <button onClick={() => setShowImportHistory(false)} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Filters */}
            <div className="p-4 border-b bg-gray-50 flex flex-wrap items-end gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">From Date</label>
                <input
                  type="date"
                  value={historyFromDate}
                  onChange={(e) => setHistoryFromDate(e.target.value)}
                  className="text-sm border border-gray-300 rounded px-2 py-1"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">To Date</label>
                <input
                  type="date"
                  value={historyToDate}
                  onChange={(e) => setHistoryToDate(e.target.value)}
                  className="text-sm border border-gray-300 rounded px-2 py-1"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Show</label>
                <select
                  value={historyLimit}
                  onChange={(e) => setHistoryLimit(Number(e.target.value))}
                  className="text-sm border border-gray-300 rounded px-2 py-1"
                >
                  <option value={10}>Last 10</option>
                  <option value={25}>Last 25</option>
                  <option value={50}>Last 50</option>
                  <option value={100}>Last 100</option>
                </select>
              </div>
              <button
                onClick={() => fetchImportHistory(historyLimit, historyFromDate, historyToDate)}
                className="px-3 py-1 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
              >
                Filter
              </button>
              <button
                onClick={() => { setHistoryFromDate(''); setHistoryToDate(''); fetchImportHistory(historyLimit); }}
                className="px-3 py-1 bg-gray-200 text-gray-700 text-sm rounded hover:bg-gray-300"
              >
                Reset
              </button>
              <div className="flex-1" />
              <button
                onClick={() => setShowClearConfirm(true)}
                disabled={isClearing}
                className="px-3 py-1 bg-red-600 text-white text-sm rounded hover:bg-red-700 disabled:bg-gray-400"
              >
                {isClearing ? 'Clearing...' : 'Clear History'}
              </button>
            </div>

            <div className="overflow-y-auto max-h-[55vh] p-4">
              {importHistoryLoading ? (
                <div className="text-center py-8 text-gray-500">Loading...</div>
              ) : importHistoryData.length === 0 ? (
                <div className="text-center py-8 text-gray-500">No import history found</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="w-8 p-2"></th>
                      <th className="text-left p-2 font-medium text-gray-600">Date</th>
                      <th className="text-left p-2 font-medium text-gray-600">Filename</th>
                      <th className="text-center p-2 font-medium text-gray-600">Source</th>
                      <th className="text-center p-2 font-medium text-gray-600">Bank</th>
                      <th className="text-right p-2 font-medium text-gray-600">Receipts</th>
                      <th className="text-right p-2 font-medium text-gray-600">Payments</th>
                      <th className="text-center p-2 font-medium text-gray-600">Txns</th>
                      <th className="text-center p-2 font-medium text-gray-600">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {importHistoryData.map((h) => (
                      <React.Fragment key={h.id}>
                        <tr className={`hover:bg-gray-50 cursor-pointer ${expandedHistoryId === h.id ? 'bg-blue-50' : ''}`}>
                          <td className="p-2 text-center">
                            <button
                              onClick={() => toggleHistoryRow(h.id)}
                              className="p-1 hover:bg-gray-200 rounded"
                            >
                              {expandedHistoryId === h.id ? (
                                <ChevronDown className="h-4 w-4 text-gray-500" />
                              ) : (
                                <ChevronRight className="h-4 w-4 text-gray-500" />
                              )}
                            </button>
                          </td>
                          <td className="p-2 text-gray-900" onClick={() => toggleHistoryRow(h.id)}>
                            {new Date(h.import_date).toLocaleDateString()}
                          </td>
                          <td className="p-2 text-gray-600 text-xs" onClick={() => toggleHistoryRow(h.id)}>
                            <span className="font-mono">{h.filename || '-'}</span>
                          </td>
                          <td className="p-2 text-center" onClick={() => toggleHistoryRow(h.id)}>
                            <span className={`px-2 py-0.5 rounded text-xs ${h.source === 'file' ? 'bg-green-100 text-green-700' : 'bg-purple-100 text-purple-700'}`}>
                              {h.source === 'file' ? 'File' : 'Email'}
                            </span>
                          </td>
                          <td className="p-2 text-center text-gray-600 font-mono text-xs" onClick={() => toggleHistoryRow(h.id)}>
                            {h.bank_code || '-'}
                          </td>
                          <td className="p-2 text-right text-green-600" onClick={() => toggleHistoryRow(h.id)}>
                            £{(h.total_receipts || 0).toFixed(2)}
                          </td>
                          <td className="p-2 text-right text-red-600" onClick={() => toggleHistoryRow(h.id)}>
                            £{(h.total_payments || 0).toFixed(2)}
                          </td>
                          <td className="p-2 text-center text-gray-600" onClick={() => toggleHistoryRow(h.id)}>
                            {h.transactions_imported || 0}
                          </td>
                          <td className="p-2 text-center">
                            <button
                              onClick={() => setReImportRecord({ id: h.id, filename: h.filename || 'Unknown', amount: (h.total_receipts || 0) + (h.total_payments || 0) })}
                              className="px-2 py-1 text-xs bg-amber-100 text-amber-700 rounded hover:bg-amber-200"
                              title="Remove from history to allow re-importing"
                            >
                              Re-import
                            </button>
                          </td>
                        </tr>
                        {/* Expanded Detail Row */}
                        {expandedHistoryId === h.id && (
                          <tr key={`${h.id}-detail`} className="bg-gray-50">
                            <td colSpan={9} className="p-4">
                              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                                <div>
                                  <div className="text-gray-500 text-xs uppercase tracking-wide mb-1">Import Date & Time</div>
                                  <div className="font-medium">
                                    {new Date(h.import_date).toLocaleDateString()} at {new Date(h.import_date).toLocaleTimeString()}
                                  </div>
                                </div>
                                <div>
                                  <div className="text-gray-500 text-xs uppercase tracking-wide mb-1">Target System</div>
                                  <div className="font-medium">
                                    <span className={`px-2 py-0.5 rounded text-xs ${h.target_system === 'opera3' ? 'bg-orange-100 text-orange-700' : 'bg-blue-100 text-blue-700'}`}>
                                      {h.target_system === 'opera3' ? 'Opera 3' : 'Opera SQL SE'}
                                    </span>
                                  </div>
                                </div>
                                <div>
                                  <div className="text-gray-500 text-xs uppercase tracking-wide mb-1">Imported By</div>
                                  <div className="font-medium font-mono text-xs">{h.imported_by || '-'}</div>
                                </div>
                                <div>
                                  <div className="text-gray-500 text-xs uppercase tracking-wide mb-1">Record ID</div>
                                  <div className="font-medium font-mono text-xs">#{h.id}</div>
                                </div>

                                {/* Email Details (if from email) */}
                                {h.source === 'email' && (
                                  <>
                                    <div className="col-span-2">
                                      <div className="text-gray-500 text-xs uppercase tracking-wide mb-1">Email Subject</div>
                                      <div className="font-medium text-xs">{h.email_subject || '-'}</div>
                                    </div>
                                    <div className="col-span-2">
                                      <div className="text-gray-500 text-xs uppercase tracking-wide mb-1">From</div>
                                      <div className="font-medium text-xs">{h.email_from || '-'}</div>
                                    </div>
                                  </>
                                )}

                                {/* Summary */}
                                <div className="col-span-2 md:col-span-4 mt-2 pt-3 border-t border-gray-200">
                                  <div className="flex items-center gap-6">
                                    <div className="flex items-center gap-2">
                                      <span className="text-gray-500 text-xs">Receipts:</span>
                                      <span className="font-semibold text-green-600">£{(h.total_receipts || 0).toFixed(2)}</span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <span className="text-gray-500 text-xs">Payments:</span>
                                      <span className="font-semibold text-red-600">£{(h.total_payments || 0).toFixed(2)}</span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <span className="text-gray-500 text-xs">Net:</span>
                                      <span className={`font-semibold ${((h.total_receipts || 0) - (h.total_payments || 0)) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                        £{((h.total_receipts || 0) - (h.total_payments || 0)).toFixed(2)}
                                      </span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <span className="text-gray-500 text-xs">Transactions:</span>
                                      <span className="font-semibold">{h.transactions_imported || 0}</span>
                                    </div>
                                  </div>
                                </div>

                                {/* Statement Review */}
                                <div className="col-span-2 md:col-span-4 mt-3 pt-3 border-t border-gray-200">
                                  {!statementReview && !statementReviewLoading && !statementReviewError && (
                                    <button
                                      onClick={() => fetchStatementReview(h.id)}
                                      className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
                                    >
                                      Review Statement
                                    </button>
                                  )}
                                  {statementReviewLoading && (
                                    <div className="text-sm text-gray-500 py-2">Loading statement transactions...</div>
                                  )}
                                  {statementReviewError && (
                                    <div className="p-2 bg-red-50 border border-red-200 rounded text-sm text-red-700 flex items-center gap-2">
                                      <span>Failed to load: {statementReviewError}</span>
                                      <button onClick={() => { setStatementReviewError(null); }} className="text-red-400 hover:text-red-600 ml-auto">x</button>
                                    </div>
                                  )}
                                  {statementReview && statementReview.import_id === h.id && (
                                    <div>
                                      {/* Review summary bar */}
                                      <div className="flex items-center justify-between mb-2">
                                        <div className="flex items-center gap-4 text-xs">
                                          <span className="font-medium text-gray-700">
                                            {statementReview.summary.reconciled} of {statementReview.summary.total} reconciled
                                          </span>
                                          {statementReview.summary.unreconciled > 0 && (
                                            <span className="text-amber-600 font-medium">
                                              {statementReview.summary.unreconciled} unreconciled
                                            </span>
                                          )}
                                          {statementReview.summary.not_imported > 0 && (
                                            <span className="text-gray-500">
                                              {statementReview.summary.not_imported} not imported
                                            </span>
                                          )}
                                        </div>
                                        <div className="flex items-center gap-2">
                                          {statementReview.summary.unreconciled > 0 && (
                                            <label className="flex items-center gap-1 text-xs text-gray-600 cursor-pointer">
                                              <input
                                                type="checkbox"
                                                checked={showUnreconciledOnly}
                                                onChange={(e) => setShowUnreconciledOnly(e.target.checked)}
                                                className="rounded border-gray-300 text-blue-600"
                                              />
                                              Unreconciled only
                                            </label>
                                          )}
                                          <button
                                            onClick={() => fetchStatementReview(h.id)}
                                            className="px-2 py-0.5 text-xs text-gray-500 hover:text-gray-700 border border-gray-300 rounded hover:bg-gray-100"
                                            title="Refresh reconciliation status"
                                          >
                                            Refresh
                                          </button>
                                        </div>
                                      </div>

                                      {/* Transactions table */}
                                      <div className="overflow-x-auto max-h-[40vh] overflow-y-auto border border-gray-200 rounded">
                                        <table className="w-full text-xs">
                                          <thead className="bg-gray-100 sticky top-0">
                                            <tr>
                                              <th className="text-left p-1.5 font-medium text-gray-600 w-12">#</th>
                                              <th className="text-left p-1.5 font-medium text-gray-600 w-20">Date</th>
                                              <th className="text-left p-1.5 font-medium text-gray-600">Description</th>
                                              <th className="text-right p-1.5 font-medium text-gray-600 w-24">Receipts</th>
                                              <th className="text-right p-1.5 font-medium text-gray-600 w-24">Payments</th>
                                              <th className="text-right p-1.5 font-medium text-gray-600 w-24">Balance</th>
                                              <th className="text-left p-1.5 font-medium text-gray-600 w-28">Opera Entry</th>
                                              <th className="text-center p-1.5 font-medium text-gray-600 w-16">Status</th>
                                            </tr>
                                          </thead>
                                          <tbody className="divide-y divide-gray-100">
                                            {statementReview.transactions
                                              .filter(t => !showUnreconciledOnly || t.is_reconciled === false)
                                              .map((t, idx) => (
                                              <tr
                                                key={idx}
                                                className={
                                                  t.is_reconciled === false
                                                    ? 'bg-amber-50'
                                                    : t.is_reconciled === null
                                                    ? 'bg-gray-50'
                                                    : ''
                                                }
                                              >
                                                <td className="p-1.5 text-gray-400 font-mono">{t.line_number}</td>
                                                <td className="p-1.5 text-gray-700 font-mono">{t.date}</td>
                                                <td className="p-1.5 text-gray-900 truncate max-w-[300px]" title={t.description}>{t.description}</td>
                                                <td className="p-1.5 text-right text-green-600 font-mono">
                                                  {t.amount > 0 ? `£${t.amount.toFixed(2)}` : ''}
                                                </td>
                                                <td className="p-1.5 text-right text-red-600 font-mono">
                                                  {t.amount < 0 ? `£${Math.abs(t.amount).toFixed(2)}` : ''}
                                                </td>
                                                <td className="p-1.5 text-right text-gray-700 font-mono">
                                                  {t.balance != null ? `£${t.balance.toFixed(2)}` : '-'}
                                                </td>
                                                <td className="p-1.5 text-gray-600 font-mono text-xs">
                                                  {t.posted_entry_number || <span className="text-gray-400 italic">-</span>}
                                                </td>
                                                <td className="p-1.5 text-center">
                                                  {t.is_reconciled === true && (
                                                    <span className="text-green-600" title="Reconciled">&#10003;</span>
                                                  )}
                                                  {t.is_reconciled === false && (
                                                    <span className="text-amber-600 font-bold" title="Unreconciled">&#10007;</span>
                                                  )}
                                                  {t.is_reconciled === null && (
                                                    <span className="text-gray-400" title="Not imported">-</span>
                                                  )}
                                                </td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Clear History Confirmation */}
      {showClearConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm-xl p-6 max-w-md">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Clear Import History?</h3>
            <p className="text-gray-600 mb-4">
              This will permanently delete import history records
              {historyFromDate || historyToDate ? ' within the selected date range' : ''}.
              This action cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowClearConfirm(false)}
                className="px-4 py-2 text-gray-700 border border-gray-300 rounded hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={clearImportHistory}
                className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
              >
                Clear History
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clear Statement Confirmation */}
      {showClearStatementConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm-xl p-6 max-w-md">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Clear Statement?</h3>
            <p className="text-gray-600 mb-2">
              Are you sure you want to clear the current statement?
            </p>
            <div className="bg-amber-50 border border-amber-200 rounded p-3 mb-4 text-sm text-amber-800">
              <strong>Warning:</strong> The following will be lost:
              <ul className="list-disc list-inside mt-1 text-amber-700">
                <li>All account assignments you've made</li>
                <li>Transaction type selections</li>
                <li>Date overrides</li>
                <li>Selected/deselected items</li>
              </ul>
              <p className="mt-2 text-xs">
                Tip: Any transactions you excluded can still be entered manually in Opera.
              </p>
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowClearStatementConfirm(false)}
                className="px-4 py-2 text-gray-700 border border-gray-300 rounded hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setBankPreview(null);
                  setBankImportResult(null);
                  setEditedTransactions(new Map());
                  setIncludedSkipped(new Map());
                  setTransactionTypeOverrides(new Map());
                  setRefundOverrides(new Map());
                  setSelectedForImport(new Set());
                  setDateOverrides(new Map());
                  setAutoAllocateDisabled(new Set());
                  setNominalPostingDetails(new Map());
                  setBankTransferDetails(new Map());
                  setCbtypeOverrides(new Map());
                  setIgnoredTransactions(new Set());
                  setAlreadyPostedRows(new Map());
                  setShowReconcilePrompt(false);
                  setSequenceError(null);
                  setTabSearchFilter('');
                  // Reset recurring entries check so it re-fires for the next statement
                  setRecurringCheckBank('');
                  setRecurringCheckDone(false);
                  setShowRecurringWarning(false);
                  setRecurringEntries([]);
                  setRepeatEntriesProcessed(false);
                  setUpdatedRepeatEntries(new Set());
                  clearPersistedState();
                  deleteDraftForCurrentStatement();
                  setShowClearStatementConfirm(false);
                }}
                className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
              >
                Clear Statement
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Ignore Transaction Confirmation */}
      {ignoreConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm-xl p-6 max-w-md">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Ignore Transaction?</h3>
            <p className="text-gray-600 mb-2">
              Are you sure you want to ignore this transaction? It won't appear in future reconciliations.
            </p>
            <div className="bg-gray-50 p-3 rounded mb-4">
              <div className="text-sm text-gray-500">Date: {ignoreConfirm.date}</div>
              <div className="font-mono text-sm">{ignoreConfirm.description}</div>
              <div className={`text-sm font-medium ${ignoreConfirm.amount >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                £{Math.abs(ignoreConfirm.amount).toFixed(2)} {ignoreConfirm.amount >= 0 ? '(Receipt)' : '(Payment)'}
              </div>
            </div>
            <p className="text-amber-600 text-sm mb-4">
              <strong>Note:</strong> Use this for transactions already entered manually in Opera.
              You can view/manage ignored transactions in Bank Reconciliation.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setIgnoreConfirm(null)}
                className="px-4 py-2 text-gray-700 border border-gray-300 rounded hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleIgnoreTransaction}
                disabled={isIgnoring}
                className="px-4 py-2 bg-amber-600 text-white rounded hover:bg-amber-700 disabled:bg-gray-400"
              >
                {isIgnoring ? 'Ignoring...' : 'Yes, Ignore'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Re-import Confirmation */}
      {reImportRecord && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm-xl p-6 max-w-md">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Allow Re-import?</h3>
            <p className="text-gray-600 mb-2">
              This will remove the import record for:
            </p>
            <div className="bg-gray-50 p-3 rounded mb-4">
              <div className="font-mono text-sm">{reImportRecord.filename}</div>
              <div className="text-sm text-gray-500">Total: £{reImportRecord.amount.toFixed(2)}</div>
            </div>
            <p className="text-amber-600 text-sm mb-4">
              <strong>Note:</strong> This does NOT remove transactions from Opera.
              Only use this if you have restored Opera data and need to re-import.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setReImportRecord(null)}
                className="px-4 py-2 text-gray-700 border border-gray-300 rounded hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={deleteHistoryRecord}
                disabled={isDeleting}
                className="px-4 py-2 bg-amber-600 text-white rounded hover:bg-amber-700 disabled:bg-gray-400"
              >
                {isDeleting ? 'Removing...' : 'Remove from History'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Recurring Entries Modal */}
      {showRecurringModal && recurringEntries.length > 0 && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm-xl max-w-3xl w-full mx-4 max-h-[80vh] flex flex-col">
            <div className="px-6 py-4 border-b border-purple-200 bg-purple-50 rounded-t-lg flex items-center justify-between">
              <div className="flex items-center gap-2">
                <RotateCcw className="h-5 w-5 text-purple-600" />
                <h3 className="text-lg font-semibold text-purple-900">Recurring Entries Due</h3>
              </div>
              <button onClick={handleSkipRecurringEntries} className="text-purple-400 hover:text-purple-600 text-xl">&times;</button>
            </div>

            <div className="px-6 py-3 text-sm text-purple-800 bg-purple-50/50 border-b border-purple-100">
              {recurringEntries.length} recurring {recurringEntries.length === 1 ? 'entry is' : 'entries are'} due for bank <strong>{selectedBankCode}</strong>.
              {recurringEntries.some(e => !e.can_post) && (
                <span className="text-red-600 ml-1">
                  ({recurringEntries.filter(e => !e.can_post).length} period-blocked)
                </span>
              )}
              {' '}Select entries to post, or skip to continue.
            </div>

            <div className="flex-1 overflow-auto px-6 py-3">
              {/* Post results */}
              {recurringPostResults.length > 0 && (
                <div className="mb-3 space-y-1">
                  {recurringPostResults.map((r, i) => (
                    <div key={i} className={`text-sm px-3 py-1.5 rounded ${r.success ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
                      {r.entry_ref ? `${r.entry_ref}: ` : ''}{r.success ? r.message || 'Posted' : r.error || 'Failed'}
                    </div>
                  ))}
                </div>
              )}

              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-purple-200 text-left">
                    <th className="py-2 px-1 w-8">
                      <input
                        type="checkbox"
                        checked={recurringEntries.filter(e => e.can_post).length > 0 && recurringEntries.filter(e => e.can_post).every(e => recurringSelected.has(e.entry_ref))}
                        disabled={recurringEntries.filter(e => e.can_post).length === 0}
                        onChange={(ev) => {
                          if (ev.target.checked) {
                            setRecurringSelected(new Set(recurringEntries.filter(e => e.can_post).map(e => e.entry_ref)));
                          } else {
                            setRecurringSelected(new Set());
                          }
                        }}
                        className="accent-purple-600"
                      />
                    </th>
                    <th className="py-2 px-2 text-purple-700">Entry</th>
                    <th className="py-2 px-2 text-purple-700">Description</th>
                    <th className="py-2 px-2 text-purple-700">Type</th>
                    <th className="py-2 px-2 text-purple-700 text-right">Amount</th>
                    <th className="py-2 px-2 text-purple-700">Post Date</th>
                    <th className="py-2 px-2 text-purple-700">Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {recurringEntries.map(entry => {
                    const isBlocked = !entry.can_post;
                    const isSelected = recurringSelected.has(entry.entry_ref);
                    return (
                      <tr key={entry.entry_ref} className={`border-b border-gray-100 ${isBlocked ? 'opacity-60' : ''}`}>
                        <td className="py-2 px-1">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            disabled={isBlocked || postingRecurring}
                            onChange={() => {
                              const next = new Set(recurringSelected);
                              if (isSelected) next.delete(entry.entry_ref);
                              else next.add(entry.entry_ref);
                              setRecurringSelected(next);
                            }}
                            className="accent-purple-600"
                          />
                        </td>
                        <td className="py-2 px-2 font-mono text-xs">{entry.base_entry_ref || entry.entry_ref.split(':')[0]}</td>
                        <td className="py-2 px-2">
                          <div className="font-medium text-gray-900">{entry.description}</div>
                          <div className="text-xs text-gray-500">{entry.account} {entry.account_desc ? `- ${entry.account_desc}` : ''}</div>
                          {isBlocked && <div className="text-xs text-red-600 mt-0.5">{entry.blocked_reason}</div>}
                        </td>
                        <td className="py-2 px-2 text-xs text-gray-600">{entry.type_desc}</td>
                        <td className="py-2 px-2 text-right font-medium">
                          <span className={entry.amount_pence < 0 ? 'text-red-600' : 'text-green-600'}>
                            {entry.amount_pence < 0 ? '-' : ''}£{entry.amount_pounds.toFixed(2)}
                          </span>
                        </td>
                        <td className="py-2 px-2">
                          {isBlocked ? (
                            <span className="text-xs text-red-500">{entry.next_post_date}</span>
                          ) : (
                            <input
                              type="date"
                              value={recurringOverrideDates[entry.entry_ref] || entry.next_post_date}
                              onChange={(ev) => setRecurringOverrideDates(prev => ({ ...prev, [entry.entry_ref]: ev.target.value }))}
                              disabled={postingRecurring}
                              className="text-xs border border-gray-300 rounded px-1.5 py-1 w-32"
                            />
                          )}
                        </td>
                        <td className="py-2 px-2 text-xs text-gray-500">
                          {entry.total_posts > 0 ? `${entry.posted_count}/${entry.total_posts}` : `${entry.posted_count}`}
                          <span className="text-gray-400 ml-1">{entry.frequency}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="px-6 py-4 border-t border-gray-200 flex items-center justify-between bg-gray-50 rounded-b-lg">
              <div className="text-sm text-gray-500">
                {recurringSelected.size} of {recurringEntries.filter(e => e.can_post).length} selected
              </div>
              <div className="flex gap-3">
                <button
                  onClick={handleSkipRecurringEntries}
                  disabled={postingRecurring}
                  className="px-4 py-2 text-gray-700 border border-gray-300 rounded-md hover:bg-gray-100"
                >
                  Skip
                </button>
                <button
                  onClick={handlePostRecurringEntries}
                  disabled={postingRecurring || recurringSelected.size === 0}
                  className="px-4 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 disabled:bg-gray-400 flex items-center gap-2"
                >
                  {postingRecurring ? (
                    <><Loader2 className="h-4 w-4 animate-spin" /> Posting...</>
                  ) : (
                    <>Post Selected ({recurringSelected.size})</>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

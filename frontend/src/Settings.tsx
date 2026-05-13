/**
 * Bank-reconcile Settings page.
 *
 * Surfaces the per-company configuration the plugin reads at runtime:
 *   - Folder paths       (settings.folder_settings)
 *   - Recurring entries  (settings.recurring_entries_mode)
 *   - Opera mapping      (`/auth/system-info` host endpoint)
 *   - Email account      (`/auth/email-config` host endpoint)
 *   - Match config       (settings.match_config — min match score, etc.)
 *
 * The first two + match_config are plugin endpoints (work in SAM-plugged
 * mode too). Opera mapping and email config are standalone-host-only —
 * SAM provides its own equivalents through ctx, so we hide those panels
 * when the host endpoints aren't available (HTTP 404).
 */
import { useEffect, useState, useCallback } from 'react';
import { Settings as SettingsIcon, Save, AlertCircle, CheckCircle, Database, Mail, FolderOpen, RotateCcw, Sliders } from 'lucide-react';
import apiClient from './api-shim';
import { PageHeader } from './PageHeader';

interface FolderSettings {
  base_folder: string;
  archive_folder: string;
}

interface MatchConfig {
  min_match_score?: number;
  learn_threshold?: number;
  use_phonetic?: boolean;
  use_levenshtein?: boolean;
  use_ngram?: boolean;
}

interface SystemInfo {
  active_company?: {
    code?: string | null;
    opera_database?: string | null;
    opera_version?: string | null;
  };
  adapter?: string;
  opera_sql?: {
    host?: string;
    port?: number;
    username?: string;
    password_configured?: boolean;
    encrypt?: boolean;
    trust_server_certificate?: boolean;
  } | null;
}

interface EmailConfig {
  configured: boolean;
  email_provider?: {
    name?: string;
    provider_type?: string;
    server?: string;
    port?: number;
    username?: string;
    use_ssl?: boolean;
    from_email?: string;
    allow_invalid_cert?: boolean;
    password_configured?: boolean;
  } | null;
}

// Helper for host-level fetches that bypass the plugin's apiClient
// (which prefixes /api/apps/bank-reconcile). The host endpoints
// (`/auth/*`) sit at the standalone server root.
async function hostFetch<T = unknown>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(path, init);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function Settings() {
  // -------- Folder settings --------
  const [folderBase, setFolderBase] = useState('');
  const [folderArchive, setFolderArchive] = useState('');
  const [folderStatus, setFolderStatus] = useState<'idle' | 'saving' | 'ok' | 'err'>('idle');
  const [folderError, setFolderError] = useState<string | null>(null);

  // -------- Recurring entries --------
  const [recurringMode, setRecurringMode] = useState<'process' | 'warn'>('process');
  const [recurringStatus, setRecurringStatus] = useState<'idle' | 'saving' | 'ok' | 'err'>('idle');

  // -------- Match config --------
  const [matchConfig, setMatchConfig] = useState<MatchConfig>({});
  const [matchStatus, setMatchStatus] = useState<'idle' | 'saving' | 'ok' | 'err'>('idle');

  // -------- Opera mapping (standalone-only) --------
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [operaDb, setOperaDb] = useState('');
  const [operaVer, setOperaVer] = useState<'SE' | '3'>('SE');
  const [operaStatus, setOperaStatus] = useState<'idle' | 'saving' | 'ok' | 'err'>('idle');
  const [operaError, setOperaError] = useState<string | null>(null);

  // -------- Email config (standalone-only) --------
  const [emailConfig, setEmailConfig] = useState<EmailConfig | null>(null);
  const [emailType, setEmailType] = useState<'imap' | 'microsoft' | 'gmail'>('imap');
  const [emailName, setEmailName] = useState('');
  const [emailServer, setEmailServer] = useState('');
  const [emailPort, setEmailPort] = useState<number | ''>('');
  const [emailUser, setEmailUser] = useState('');
  const [emailPass, setEmailPass] = useState('');
  const [emailFrom, setEmailFrom] = useState('');
  const [emailSsl, setEmailSsl] = useState(true);
  const [emailInsecure, setEmailInsecure] = useState(true);
  const [emailStatus, setEmailStatus] = useState<'idle' | 'saving' | 'ok' | 'err'>('idle');
  const [emailError, setEmailError] = useState<string | null>(null);

  // -------- Load initial state --------
  const load = useCallback(async () => {
    try {
      const folderRes = await apiClient.get<{ base_folder?: string; archive_folder?: string }>(
        '/api/bank-import/folder-settings',
      );
      setFolderBase(folderRes.data?.base_folder ?? '');
      setFolderArchive(folderRes.data?.archive_folder ?? '');
    } catch {
      // endpoint may not yet be ported — show empty form
    }
    try {
      const recRes = await apiClient.get<{ mode?: string }>('/api/recurring-entries/config');
      if (recRes.data?.mode === 'process' || recRes.data?.mode === 'warn') {
        setRecurringMode(recRes.data.mode);
      }
    } catch {
      /* tolerated */
    }
    try {
      const matchRes = await apiClient.get<MatchConfig>('/api/bank-import/config');
      if (matchRes.data) setMatchConfig(matchRes.data);
    } catch {
      /* tolerated */
    }
    const sys = await hostFetch<SystemInfo>('/auth/system-info');
    if (sys) {
      setSystemInfo(sys);
      setOperaDb(sys.active_company?.opera_database ?? '');
      const v = sys.active_company?.opera_version;
      if (v === '3') setOperaVer('3');
      else setOperaVer('SE');
    }
    const em = await hostFetch<EmailConfig>('/auth/email-config');
    if (em) {
      setEmailConfig(em);
      const p = em.email_provider ?? {};
      if (p.provider_type === 'imap' || p.provider_type === 'microsoft' || p.provider_type === 'gmail') {
        setEmailType(p.provider_type);
      }
      setEmailName(p.name ?? '');
      setEmailServer(p.server ?? '');
      setEmailPort(typeof p.port === 'number' ? p.port : '');
      setEmailUser(p.username ?? '');
      setEmailFrom(p.from_email ?? '');
      setEmailSsl(p.use_ssl !== false);
      setEmailInsecure(p.allow_invalid_cert !== false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // -------- Save handlers --------
  const saveFolders = async () => {
    setFolderStatus('saving');
    setFolderError(null);
    try {
      await apiClient.put('/api/bank-import/folder-settings', {
        base_folder: folderBase.trim(),
        archive_folder: folderArchive.trim(),
      });
      setFolderStatus('ok');
    } catch (err) {
      setFolderError((err as Error).message);
      setFolderStatus('err');
    }
  };

  const saveRecurring = async () => {
    setRecurringStatus('saving');
    try {
      await apiClient.put(`/api/recurring-entries/config?mode=${recurringMode}`);
      setRecurringStatus('ok');
    } catch {
      setRecurringStatus('err');
    }
  };

  const saveMatchConfig = async () => {
    setMatchStatus('saving');
    try {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(matchConfig)) {
        if (v !== undefined && v !== null) params.append(k, String(v));
      }
      await apiClient.put(`/api/bank-import/config?${params.toString()}`);
      setMatchStatus('ok');
    } catch {
      setMatchStatus('err');
    }
  };

  const saveOperaMapping = async () => {
    setOperaStatus('saving');
    setOperaError(null);
    try {
      const res = await fetch('/auth/system-info', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opera_database: operaDb.trim(), opera_version: operaVer }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setOperaStatus('ok');
      void load();
    } catch (err) {
      setOperaError((err as Error).message);
      setOperaStatus('err');
    }
  };

  const saveEmail = async () => {
    setEmailStatus('saving');
    setEmailError(null);
    try {
      const payload: Record<string, unknown> = {
        provider_type: emailType,
        name: emailName.trim(),
        server: emailServer.trim(),
        port: emailPort === '' ? undefined : Number(emailPort),
        username: emailUser.trim(),
        password: emailPass, // blank = keep existing
        from_email: emailFrom.trim(),
        use_ssl: emailSsl,
        allow_invalid_cert: emailInsecure,
      };
      const res = await fetch('/auth/email-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setEmailPass('');
      setEmailStatus('ok');
      void load();
    } catch (err) {
      setEmailError((err as Error).message);
      setEmailStatus('err');
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader icon={SettingsIcon} title="Settings" subtitle="Per-company bank reconciliation configuration" />

      {/* Folder settings */}
      <section className="bg-white border border-gray-200 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-1">
          <FolderOpen className="w-4 h-4 text-blue-600" />
          <h2 className="text-base font-semibold">Statement folders</h2>
        </div>
        <p className="text-xs text-gray-500 mb-4">
          Where bank statement PDFs are scanned from and archived after processing.
        </p>
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Base folder</label>
            <input
              type="text"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              placeholder="/srv/bank-statements"
              value={folderBase}
              onChange={(e) => setFolderBase(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Archive folder</label>
            <input
              type="text"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              placeholder="/srv/bank-statements/archive"
              value={folderArchive}
              onChange={(e) => setFolderArchive(e.target.value)}
            />
          </div>
          <SaveRow status={folderStatus} error={folderError} onSave={saveFolders} />
        </div>
      </section>

      {/* Recurring entries */}
      <section className="bg-white border border-gray-200 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-1">
          <RotateCcw className="w-4 h-4 text-blue-600" />
          <h2 className="text-base font-semibold">Recurring entries</h2>
        </div>
        <p className="text-xs text-gray-500 mb-4">
          How the plugin treats recurring transaction patterns when posting to Opera.
        </p>
        <div className="space-y-3">
          <select
            className="px-3 py-2 border border-gray-300 rounded-md text-sm"
            value={recurringMode}
            onChange={(e) => setRecurringMode(e.target.value as 'process' | 'warn')}
          >
            <option value="process">Process — post recurring entries automatically</option>
            <option value="warn">Warn — flag recurring entries for manual review</option>
          </select>
          <SaveRow status={recurringStatus} onSave={saveRecurring} />
        </div>
      </section>

      {/* Match config */}
      <section className="bg-white border border-gray-200 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-1">
          <Sliders className="w-4 h-4 text-blue-600" />
          <h2 className="text-base font-semibold">Match algorithm</h2>
        </div>
        <p className="text-xs text-gray-500 mb-4">
          Tune the fuzzy-match thresholds used by the alias auto-matcher.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Min match score</label>
            <input
              type="number"
              min={0}
              max={100}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              value={matchConfig.min_match_score ?? ''}
              onChange={(e) =>
                setMatchConfig({ ...matchConfig, min_match_score: Number(e.target.value) })
              }
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Learn threshold</label>
            <input
              type="number"
              min={0}
              max={100}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              value={matchConfig.learn_threshold ?? ''}
              onChange={(e) =>
                setMatchConfig({ ...matchConfig, learn_threshold: Number(e.target.value) })
              }
            />
          </div>
        </div>
        <div className="flex gap-4 mt-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={matchConfig.use_phonetic ?? false}
              onChange={(e) => setMatchConfig({ ...matchConfig, use_phonetic: e.target.checked })}
            />
            Phonetic
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={matchConfig.use_levenshtein ?? false}
              onChange={(e) => setMatchConfig({ ...matchConfig, use_levenshtein: e.target.checked })}
            />
            Levenshtein
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={matchConfig.use_ngram ?? false}
              onChange={(e) => setMatchConfig({ ...matchConfig, use_ngram: e.target.checked })}
            />
            N-gram
          </label>
        </div>
        <div className="mt-3">
          <SaveRow status={matchStatus} onSave={saveMatchConfig} />
        </div>
      </section>

      {/* Opera mapping (standalone-only) */}
      {systemInfo && (
        <section className="bg-white border border-gray-200 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-1">
            <Database className="w-4 h-4 text-blue-600" />
            <h2 className="text-base font-semibold">Opera connection</h2>
          </div>
          <p className="text-xs text-gray-500 mb-4">
            Per-company Opera database. The adapter rebuilds its pool on save — no restart needed.
            Connection params (host/user/password) are bootstrap env vars and not editable here.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Opera database</label>
              <input
                type="text"
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                placeholder="Opera3SECompany00I"
                value={operaDb}
                onChange={(e) => setOperaDb(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Opera version</label>
              <select
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                value={operaVer}
                onChange={(e) => setOperaVer(e.target.value as 'SE' | '3')}
              >
                <option value="SE">SE</option>
                <option value="3">3</option>
              </select>
            </div>
          </div>
          <div className="mt-3 text-xs text-gray-500">
            Adapter: <code className="bg-gray-100 px-1 rounded">{systemInfo.adapter}</code>
            {systemInfo.opera_sql && (
              <>
                {' · '}Host: <code className="bg-gray-100 px-1 rounded">{systemInfo.opera_sql.host}:{systemInfo.opera_sql.port}</code>
                {' · '}User: <code className="bg-gray-100 px-1 rounded">{systemInfo.opera_sql.username}</code>
                {' · '}Password: {systemInfo.opera_sql.password_configured ? 'configured' : 'not set'}
              </>
            )}
          </div>
          <div className="mt-3">
            <SaveRow status={operaStatus} error={operaError} onSave={saveOperaMapping} />
          </div>
        </section>
      )}

      {/* Email account (standalone-only) */}
      {emailConfig && (
        <section className="bg-white border border-gray-200 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-1">
            <Mail className="w-4 h-4 text-blue-600" />
            <h2 className="text-base font-semibold">Email account</h2>
          </div>
          <p className="text-xs text-gray-500 mb-4">
            Where the plugin reads bank statements from. IMAP is wired today.
          </p>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Provider</label>
                <select
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                  value={emailType}
                  onChange={(e) =>
                    setEmailType(e.target.value as 'imap' | 'microsoft' | 'gmail')
                  }
                >
                  <option value="imap">IMAP</option>
                  <option value="microsoft">Microsoft Graph (reserved)</option>
                  <option value="gmail">Gmail (reserved)</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Display name</label>
                <input
                  type="text"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                  value={emailName}
                  onChange={(e) => setEmailName(e.target.value)}
                />
              </div>
            </div>
            {emailType === 'imap' && (
              <>
                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">IMAP server</label>
                    <input
                      type="text"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                      placeholder="imap.example.com"
                      value={emailServer}
                      onChange={(e) => setEmailServer(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Port</label>
                    <input
                      type="number"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                      placeholder="993"
                      value={emailPort}
                      onChange={(e) => setEmailPort(e.target.value === '' ? '' : Number(e.target.value))}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Username</label>
                    <input
                      type="text"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                      value={emailUser}
                      onChange={(e) => setEmailUser(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Password <span className="text-gray-400 font-normal">(blank = keep existing)</span>
                    </label>
                    <input
                      type="password"
                      autoComplete="new-password"
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                      value={emailPass}
                      onChange={(e) => setEmailPass(e.target.value)}
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">From-email</label>
                  <input
                    type="text"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                    placeholder="reply-to@example.com"
                    value={emailFrom}
                    onChange={(e) => setEmailFrom(e.target.value)}
                  />
                </div>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={emailSsl}
                      onChange={(e) => setEmailSsl(e.target.checked)}
                    />
                    Use SSL/TLS
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={emailInsecure}
                      onChange={(e) => setEmailInsecure(e.target.checked)}
                    />
                    Trust invalid certificate (LAN servers)
                  </label>
                </div>
                {emailConfig.email_provider?.password_configured && (
                  <p className="text-xs text-gray-500">Password configured. Leave blank to keep it.</p>
                )}
              </>
            )}
            <SaveRow status={emailStatus} error={emailError} onSave={saveEmail} />
          </div>
        </section>
      )}
    </div>
  );
}

function SaveRow({
  status,
  error,
  onSave,
}: {
  status: 'idle' | 'saving' | 'ok' | 'err';
  error?: string | null;
  onSave: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={onSave}
        disabled={status === 'saving'}
        className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 disabled:opacity-50"
      >
        <Save className="w-4 h-4" />
        {status === 'saving' ? 'Saving…' : 'Save'}
      </button>
      {status === 'ok' && (
        <span className="flex items-center gap-1 text-xs text-green-700">
          <CheckCircle className="w-3 h-3" /> Saved
        </span>
      )}
      {status === 'err' && (
        <span className="flex items-center gap-1 text-xs text-red-700">
          <AlertCircle className="w-3 h-3" /> {error ?? 'Save failed'}
        </span>
      )}
    </div>
  );
}

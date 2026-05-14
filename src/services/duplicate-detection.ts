/**
 * Bank-import duplicate detection.
 *
 * Faithful port of `EnhancedDuplicateDetector` in
 * `sql_rag/bank_duplicates.py`. The Python implementation runs six
 * strategies in priority order — all ported here.
 *
 * Strategies (priority order, fingerprint short-circuits the rest):
 *   0. fingerprint  — BKIMP:HASH:DATE in at_refer/st_trref/pt_trref
 *                     (confidence 1.0, definitive)
 *   1. fit_id       — OFX bank-issued unique transaction id in at_refer
 *                     (confidence 0.95)
 *   2. exact        — date + amount + account (confidence 0.90)
 *   3. fuzzy_amount — date + ±5% amount + account
 *                     (confidence 0.5–0.7 by diff %)
 *   4. reference    — partial reference + account
 *                     (confidence 0.6, top-5 by date)
 *   5. cross_period — ±7 days + amount + account
 *                     (confidence 0.5–0.75 by date diff)
 *   6. bank_amount  — ±14 days + signed amount on aentry header,
 *                     no account required (catches direct Opera entries
 *                     like HMRC). Only runs if no account-level match.
 *                     (confidence 0.5–0.95 by date diff)
 *
 * Sign-aware throughout: a +£X receipt and a -£X payment are NOT
 * duplicates. Receipt amounts route to stran (st_trtype='R'),
 * payment amounts route to ptran (pt_trtype='P').
 *
 * Determinism: fingerprint uses a stable MD5 of name|amount|date.
 * Test depth proves it stable across calls and resilient against
 * dataframe-shaped DB responses.
 */
import type { Knex } from 'knex';
import { createHash } from 'crypto';

export interface DuplicateCandidate {
  table: 'atran' | 'stran' | 'ptran' | 'aentry';
  record_id: string;
  match_type:
    | 'fingerprint'
    | 'exact'
    | 'fit_id'
    | 'fuzzy_amount'
    | 'reference'
    | 'cross_period'
    | 'bank_amount';
  confidence: number;
  details: Record<string, unknown>;
}

export interface CheckTransactionInput {
  name: string;
  amount: number;
  date: Date | string;
  /** Optional matched Opera account code (customer or supplier). */
  account?: string | null;
  /** Optional bank account code. */
  bank_code?: string | null;
  /** Optional FIT ID (OFX bank-issued unique transaction id). */
  fit_id?: string | null;
  /** Optional transaction reference. */
  reference?: string | null;
  /** Optional matcher-derived action — when supplied, the stran/ptran
   *  probes use the correct trtype filter (R/P for normal,
   *  F for refunds). Without it, we fall back to a sign-derived
   *  default that matches receipts/payments but NOT refunds — same
   *  behaviour SAM has shipped, kept for backward-compat with callers
   *  that don't classify rows. Faithful port of
   *  duplicate_check.py:ACTION_TYPE_MAP. */
  action?: string | null;
}

/**
 * stran trtype expected for a given matcher action.
 *   sales_receipt → 'R'   (receipt against the customer)
 *   sales_refund  → 'F'   (refund credit-note)
 *   purchase_refund treated symmetrically against ptran below.
 * Falls back to null when action is unknown — caller then uses the
 * sign-derived default.
 */
const STRAN_TRTYPE_FOR_ACTION: Record<string, string> = {
  sales_receipt: 'R',
  sales_refund: 'F',
};
const PTRAN_TRTYPE_FOR_ACTION: Record<string, string> = {
  purchase_payment: 'P',
  purchase_refund: 'F',
};

function stranTrtype(action: string | null | undefined, amount: number): string {
  if (action && STRAN_TRTYPE_FOR_ACTION[action]) {
    return STRAN_TRTYPE_FOR_ACTION[action]!;
  }
  // Sign-derived default (legacy SAM behaviour). Refunds aren't
  // catchable without an explicit action; caller should pass it.
  return amount >= 0 ? 'R' : 'F';
}

function ptranTrtype(action: string | null | undefined, amount: number): string {
  if (action && PTRAN_TRTYPE_FOR_ACTION[action]) {
    return PTRAN_TRTYPE_FOR_ACTION[action]!;
  }
  return amount <= 0 ? 'P' : 'F';
}

function parseDate(input: Date | string): Date {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) throw new Error('Invalid date');
    return input;
  }
  const trimmed = input.trim();
  // Accept YYYY-MM-DD or DD/MM/YYYY
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) {
    return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  }
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed);
  if (dmy) {
    return new Date(Date.UTC(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1])));
  }
  throw new Error(`Unsupported date format: ${input}`);
}

function dateIsoYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------
// Fingerprint helpers
// ---------------------------------------------------------------------

export function generateImportFingerprint(
  name: string,
  amount: number,
  txnDate: Date | string,
): string {
  const d = parseDate(txnDate);
  const data = `${name}|${amount}|${dateIsoYmd(d)}`;
  const hash = createHash('md5').update(data).digest('hex').slice(0, 8).toUpperCase();
  const importDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `BKIMP:${hash}:${importDate}`;
}

export function extractHashFromFingerprint(fingerprint: string): string | null {
  if (!fingerprint || !fingerprint.startsWith('BKIMP:')) return null;
  const parts = fingerprint.split(':');
  return parts.length >= 2 ? (parts[1] ?? null) : null;
}

// ---------------------------------------------------------------------
// Strategy 0: fingerprint match
// ---------------------------------------------------------------------

interface AtranRow {
  at_unique?: string | null;
  at_pstdate?: string | Date | null;
  at_value?: number | string | null;
  at_refer?: string | null;
  at_acnt?: string | null;
}

interface StranRow {
  st_unique?: string | null;
  st_trdate?: string | Date | null;
  st_trvalue?: number | string | null;
  st_trref?: string | null;
  st_account?: string | null;
  st_trtype?: string | null;
}

interface PtranRow {
  pt_unique?: string | null;
  pt_trdate?: string | Date | null;
  pt_trvalue?: number | string | null;
  pt_trref?: string | null;
  pt_account?: string | null;
  pt_trtype?: string | null;
}

async function fingerprintMatch(
  operaDb: Knex,
  name: string,
  amount: number,
  txnDate: Date,
  bankCode: string | null,
): Promise<DuplicateCandidate[]> {
  const fingerprint = generateImportFingerprint(name, amount, txnDate);
  const hash = extractHashFromFingerprint(fingerprint);
  if (!hash) return [];
  const candidates: DuplicateCandidate[] = [];

  const pattern = `BKIMP:${hash}%`;

  try {
    const atRows = (await operaDb('atran')
      .where('at_refer', 'like', pattern)
      .select(
        'at_unique',
        'at_pstdate',
        'at_value',
        'at_refer',
        'at_acnt',
      )) as unknown as AtranRow[];
    for (const row of atRows) {
      const entryBank = (row.at_acnt ?? '').toString().trim();
      if (bankCode && entryBank && entryBank !== bankCode) continue;
      const refParts = (row.at_refer ?? '').toString().split(':');
      const importDate = refParts.length >= 3 ? refParts[2] ?? '' : '';
      candidates.push({
        table: 'atran',
        record_id: (row.at_unique ?? '').toString().trim(),
        match_type: 'fingerprint',
        confidence: 1,
        details: {
          fingerprint,
          imported_on: importDate,
          at_date: row.at_pstdate ? String(row.at_pstdate) : '',
          at_value: Number(row.at_value ?? 0),
          at_acnt: entryBank,
        },
      });
    }
  } catch {
    // advisory
  }

  try {
    const stRows = (await operaDb('stran')
      .where('st_trref', 'like', pattern)
      .select(
        'st_unique',
        'st_trdate',
        'st_trvalue',
        'st_trref',
        'st_account',
      )) as unknown as StranRow[];
    for (const row of stRows) {
      candidates.push({
        table: 'stran',
        record_id: (row.st_unique ?? '').toString().trim(),
        match_type: 'fingerprint',
        confidence: 1,
        details: {
          fingerprint,
          st_trdate: row.st_trdate ? String(row.st_trdate) : '',
          st_trvalue: Number(row.st_trvalue ?? 0),
          st_account: (row.st_account ?? '').toString().trim(),
        },
      });
    }
  } catch {
    // advisory
  }

  try {
    const ptRows = (await operaDb('ptran')
      .where('pt_trref', 'like', pattern)
      .select(
        'pt_unique',
        'pt_trdate',
        'pt_trvalue',
        'pt_trref',
        'pt_account',
      )) as unknown as PtranRow[];
    for (const row of ptRows) {
      candidates.push({
        table: 'ptran',
        record_id: (row.pt_unique ?? '').toString().trim(),
        match_type: 'fingerprint',
        confidence: 1,
        details: {
          fingerprint,
          pt_trdate: row.pt_trdate ? String(row.pt_trdate) : '',
          pt_trvalue: Number(row.pt_trvalue ?? 0),
          pt_account: (row.pt_account ?? '').toString().trim(),
        },
      });
    }
  } catch {
    // advisory
  }

  return candidates;
}

// ---------------------------------------------------------------------
// Strategy 2: exact match (date + amount + account)
// ---------------------------------------------------------------------

async function exactMatch(
  operaDb: Knex,
  amount: number,
  txnDate: Date,
  account: string,
  bankCode: string | null,
  action: string | null,
): Promise<DuplicateCandidate[]> {
  const candidates: DuplicateCandidate[] = [];
  const dateStr = dateIsoYmd(txnDate);

  if (bankCode) {
    try {
      const signedPence = Math.round(amount * 100);
      const rows = (await operaDb('atran')
        .where('at_acnt', bankCode)
        .andWhere('at_pstdate', dateStr)
        .andWhereRaw('ABS(at_value - ?) < 1', [signedPence])
        .select(
          'at_unique',
          'at_pstdate',
          'at_value',
          'at_refer',
          'at_acnt',
        )) as unknown as AtranRow[];
      for (const row of rows) {
        candidates.push({
          table: 'atran',
          record_id: (row.at_unique ?? '').toString().trim(),
          match_type: 'exact',
          confidence: 0.9,
          details: {
            matched_on: 'date+amount+bank',
            at_date: row.at_pstdate ? String(row.at_pstdate) : '',
            at_value_pence: Number(row.at_value ?? 0),
          },
        });
      }
    } catch {
      // advisory
    }
  }

  // Ledger probe routing:
  //   When action is 'sales_*' / 'purchase_*', use the action-specific
  //   trtype (R / F for stran, P / F for ptran). When action is
  //   missing, fall back to a sign-derived default (legacy SAM
  //   behaviour) — refunds won't be detected without an explicit
  //   action, which is the legacy contract (duplicate_check.py only
  //   probes ledger tables when action is a refund).
  const isStranAction =
    action === 'sales_receipt' ||
    action === 'sales_refund' ||
    (!action && amount > 0);
  const isPtranAction =
    action === 'purchase_payment' ||
    action === 'purchase_refund' ||
    (!action && amount < 0);

  if (isStranAction) {
    try {
      const trtype = stranTrtype(action, amount);
      // Refunds (trtype='F') store st_trvalue as POSITIVE; receipts
      // ('R') store it as NEGATIVE. Sign-aware comparison handles
      // both: receipt amount > 0 should match negative st_trvalue;
      // refund amount < 0 should match positive st_trvalue.
      const target = trtype === 'F' ? Math.abs(amount) : -amount;
      const rows = (await operaDb('stran')
        .whereRaw('RTRIM(st_account) = ?', [account])
        .andWhere('st_trdate', dateStr)
        .andWhereRaw('ABS(st_trvalue - ?) < 0.01', [target])
        .andWhere('st_trtype', trtype)
        .select(
          'st_unique',
          'st_trdate',
          'st_trvalue',
          'st_trref',
          'st_account',
        )) as unknown as StranRow[];
      for (const row of rows) {
        candidates.push({
          table: 'stran',
          record_id: (row.st_unique ?? '').toString().trim(),
          match_type: 'exact',
          confidence: 0.9,
          details: {
            matched_on: `date+amount+customer+st_trtype=${trtype}`,
            st_trdate: row.st_trdate ? String(row.st_trdate) : '',
            st_trvalue: Number(row.st_trvalue ?? 0),
          },
        });
      }
    } catch {
      // advisory
    }
  }
  if (isPtranAction) {
    try {
      const trtype = ptranTrtype(action, amount);
      // Refunds (trtype='F') store pt_trvalue as POSITIVE; payments
      // ('P') store it as NEGATIVE. Sign-aware.
      const target = trtype === 'F' ? Math.abs(amount) : amount;
      const rows = (await operaDb('ptran')
        .whereRaw('RTRIM(pt_account) = ?', [account])
        .andWhere('pt_trdate', dateStr)
        .andWhereRaw('ABS(pt_trvalue - ?) < 0.01', [target])
        .andWhere('pt_trtype', trtype)
        .select(
          'pt_unique',
          'pt_trdate',
          'pt_trvalue',
          'pt_trref',
          'pt_account',
        )) as unknown as PtranRow[];
      for (const row of rows) {
        candidates.push({
          table: 'ptran',
          record_id: (row.pt_unique ?? '').toString().trim(),
          match_type: 'exact',
          confidence: 0.9,
          details: {
            matched_on: `date+amount+supplier+pt_trtype=${trtype}`,
            pt_trdate: row.pt_trdate ? String(row.pt_trdate) : '',
            pt_trvalue: Number(row.pt_trvalue ?? 0),
          },
        });
      }
    } catch {
      // advisory
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------
// Strategy 1: FIT ID match (OFX bank-issued unique transaction id)
// ---------------------------------------------------------------------

async function fitIdMatch(
  operaDb: Knex,
  fitId: string,
): Promise<DuplicateCandidate[]> {
  const candidates: DuplicateCandidate[] = [];
  if (!fitId) return candidates;
  try {
    const rows = (await operaDb('atran')
      .where(function fitIdFilter(this: Knex.QueryBuilder) {
        this.where('at_refer', fitId).orWhere('at_refer', 'like', `%${fitId}%`);
      })
      .select('at_unique', 'at_pstdate', 'at_value', 'at_refer', 'at_acnt')) as unknown as AtranRow[];
    for (const row of rows) {
      candidates.push({
        table: 'atran',
        record_id: (row.at_unique ?? '').toString().trim(),
        match_type: 'fit_id',
        confidence: 0.95,
        details: {
          fit_id: fitId,
          at_refer: row.at_refer ?? '',
          at_date: row.at_pstdate ? String(row.at_pstdate) : '',
          at_value: Number(row.at_value ?? 0),
        },
      });
    }
  } catch {
    // advisory
  }
  return candidates;
}

// ---------------------------------------------------------------------
// Strategy 3: fuzzy amount match (within tolerance, e.g. fees added)
// ---------------------------------------------------------------------

async function fuzzyAmountMatch(
  operaDb: Knex,
  amount: number,
  txnDate: Date,
  account: string,
  tolerance: number,
  action: string | null,
): Promise<DuplicateCandidate[]> {
  const candidates: DuplicateCandidate[] = [];
  const dateStr = dateIsoYmd(txnDate);
  const absAmount = Math.abs(amount);
  if (absAmount <= 0) return candidates;
  const toleranceAmount = absAmount * tolerance;

  const isStranAction =
    action === 'sales_receipt' ||
    action === 'sales_refund' ||
    (!action && amount > 0);
  const isPtranAction =
    action === 'purchase_payment' ||
    action === 'purchase_refund' ||
    (!action && amount < 0);

  if (isStranAction) {
    try {
      const trtype = stranTrtype(action, amount);
      const target = trtype === 'F' ? Math.abs(amount) : -amount;
      const rows = (await operaDb('stran')
        .whereRaw('RTRIM(st_account) = ?', [account])
        .andWhere('st_trdate', dateStr)
        .andWhereRaw('ABS(st_trvalue - ?) <= ?', [target, toleranceAmount])
        .andWhereRaw('ABS(st_trvalue - ?) > 0.01', [target])
        .andWhere('st_trtype', trtype)
        .select('st_unique', 'st_trdate', 'st_trvalue', 'st_account')) as unknown as StranRow[];
      for (const row of rows) {
        const stValue = Math.abs(Number(row.st_trvalue ?? 0));
        const diff = Math.abs(stValue - absAmount);
        const diffPct = absAmount > 0 ? diff / absAmount : 0;
        const confidence = Math.max(0.5, 0.7 - diffPct * 2);
        candidates.push({
          table: 'stran',
          record_id: (row.st_unique ?? '').toString().trim(),
          match_type: 'fuzzy_amount',
          confidence,
          details: {
            matched_on: 'date+fuzzy_amount+customer',
            amount_diff: Math.round(diff * 100) / 100,
            diff_pct: Math.round(diffPct * 1000) / 10,
            st_trvalue: Number(row.st_trvalue ?? 0),
          },
        });
      }
    } catch {
      // advisory
    }
  }
  if (isPtranAction) {
    try {
      const trtype = ptranTrtype(action, amount);
      const target = trtype === 'F' ? Math.abs(amount) : amount;
      const rows = (await operaDb('ptran')
        .whereRaw('RTRIM(pt_account) = ?', [account])
        .andWhere('pt_trdate', dateStr)
        .andWhereRaw('ABS(pt_trvalue - ?) <= ?', [target, toleranceAmount])
        .andWhereRaw('ABS(pt_trvalue - ?) > 0.01', [target])
        .andWhere('pt_trtype', trtype)
        .select('pt_unique', 'pt_trdate', 'pt_trvalue', 'pt_account')) as unknown as PtranRow[];
      for (const row of rows) {
        const ptValue = Math.abs(Number(row.pt_trvalue ?? 0));
        const diff = Math.abs(ptValue - absAmount);
        const diffPct = absAmount > 0 ? diff / absAmount : 0;
        const confidence = Math.max(0.5, 0.7 - diffPct * 2);
        candidates.push({
          table: 'ptran',
          record_id: (row.pt_unique ?? '').toString().trim(),
          match_type: 'fuzzy_amount',
          confidence,
          details: {
            matched_on: 'date+fuzzy_amount+supplier',
            amount_diff: Math.round(diff * 100) / 100,
            diff_pct: Math.round(diffPct * 1000) / 10,
            pt_trvalue: Number(row.pt_trvalue ?? 0),
          },
        });
      }
    } catch {
      // advisory
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------
// Strategy 4: reference match (top-5 by date, account-scoped)
// ---------------------------------------------------------------------

async function referenceMatch(
  operaDb: Knex,
  reference: string,
  account: string,
): Promise<DuplicateCandidate[]> {
  const candidates: DuplicateCandidate[] = [];
  const ref = (reference ?? '').trim();
  if (!ref || ref.length < 3) return candidates;
  const pattern = `%${ref}%`;

  try {
    const rows = (await operaDb('stran')
      .whereRaw('RTRIM(st_account) = ?', [account])
      .andWhere('st_trref', 'like', pattern)
      .orderBy('st_trdate', 'desc')
      .limit(5)
      .select('st_unique', 'st_trdate', 'st_trvalue', 'st_trref', 'st_account')) as unknown as StranRow[];
    for (const row of rows) {
      candidates.push({
        table: 'stran',
        record_id: (row.st_unique ?? '').toString().trim(),
        match_type: 'reference',
        confidence: 0.6,
        details: {
          matched_on: 'reference',
          reference: ref,
          st_trref: row.st_trref ?? '',
          st_trdate: row.st_trdate ? String(row.st_trdate) : '',
          st_trvalue: Number(row.st_trvalue ?? 0),
        },
      });
    }
  } catch {
    // advisory
  }

  try {
    const rows = (await operaDb('ptran')
      .whereRaw('RTRIM(pt_account) = ?', [account])
      .andWhere('pt_trref', 'like', pattern)
      .orderBy('pt_trdate', 'desc')
      .limit(5)
      .select('pt_unique', 'pt_trdate', 'pt_trvalue', 'pt_trref', 'pt_account')) as unknown as PtranRow[];
    for (const row of rows) {
      candidates.push({
        table: 'ptran',
        record_id: (row.pt_unique ?? '').toString().trim(),
        match_type: 'reference',
        confidence: 0.6,
        details: {
          matched_on: 'reference',
          reference: ref,
          pt_trref: row.pt_trref ?? '',
          pt_trdate: row.pt_trdate ? String(row.pt_trdate) : '',
          pt_trvalue: Number(row.pt_trvalue ?? 0),
        },
      });
    }
  } catch {
    // advisory
  }

  return candidates;
}

// ---------------------------------------------------------------------
// Strategy 5: cross-period match (same amount, different posting date)
// ---------------------------------------------------------------------

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 24 * 60 * 60 * 1000);
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs(Math.round((a.getTime() - b.getTime()) / (24 * 60 * 60 * 1000)));
}

async function crossPeriodMatch(
  operaDb: Knex,
  amount: number,
  txnDate: Date,
  account: string,
  days: number,
  action: string | null,
): Promise<DuplicateCandidate[]> {
  const candidates: DuplicateCandidate[] = [];
  const absAmount = Math.abs(amount);
  if (absAmount <= 0) return candidates;
  const startDate = dateIsoYmd(addDays(txnDate, -days));
  const endDate = dateIsoYmd(addDays(txnDate, days));
  const txnDateStr = dateIsoYmd(txnDate);

  const isStranAction =
    action === 'sales_receipt' ||
    action === 'sales_refund' ||
    (!action && amount > 0);
  const isPtranAction =
    action === 'purchase_payment' ||
    action === 'purchase_refund' ||
    (!action && amount < 0);

  if (isStranAction) {
    try {
      const trtype = stranTrtype(action, amount);
      const target = trtype === 'F' ? Math.abs(amount) : -amount;
      const rows = (await operaDb('stran')
        .whereRaw('RTRIM(st_account) = ?', [account])
        .andWhereBetween('st_trdate', [startDate, endDate])
        .andWhere('st_trdate', '!=', txnDateStr)
        .andWhereRaw('ABS(st_trvalue - ?) < 0.01', [target])
        .andWhere('st_trtype', trtype)
        .select('st_unique', 'st_trdate', 'st_trvalue', 'st_account')) as unknown as StranRow[];
      for (const row of rows) {
        const postedDate = row.st_trdate ? new Date(row.st_trdate) : null;
        const diffDays = postedDate ? daysBetween(postedDate, txnDate) : days;
        const confidence = Math.max(0.5, 0.75 - diffDays * 0.05);
        candidates.push({
          table: 'stran',
          record_id: (row.st_unique ?? '').toString().trim(),
          match_type: 'cross_period',
          confidence,
          details: {
            matched_on: 'amount+customer+nearby_date',
            days_diff: diffDays,
            st_trdate: postedDate ? dateIsoYmd(postedDate) : '',
            txn_date: txnDateStr,
            st_trvalue: Number(row.st_trvalue ?? 0),
          },
        });
      }
    } catch {
      // advisory
    }
  }
  if (isPtranAction) {
    try {
      const trtype = ptranTrtype(action, amount);
      const target = trtype === 'F' ? Math.abs(amount) : amount;
      const rows = (await operaDb('ptran')
        .whereRaw('RTRIM(pt_account) = ?', [account])
        .andWhereBetween('pt_trdate', [startDate, endDate])
        .andWhere('pt_trdate', '!=', txnDateStr)
        .andWhereRaw('ABS(pt_trvalue - ?) < 0.01', [target])
        .andWhere('pt_trtype', trtype)
        .select('pt_unique', 'pt_trdate', 'pt_trvalue', 'pt_account')) as unknown as PtranRow[];
      for (const row of rows) {
        const postedDate = row.pt_trdate ? new Date(row.pt_trdate) : null;
        const diffDays = postedDate ? daysBetween(postedDate, txnDate) : days;
        const confidence = Math.max(0.5, 0.75 - diffDays * 0.05);
        candidates.push({
          table: 'ptran',
          record_id: (row.pt_unique ?? '').toString().trim(),
          match_type: 'cross_period',
          confidence,
          details: {
            matched_on: 'amount+supplier+nearby_date',
            days_diff: diffDays,
            pt_trdate: postedDate ? dateIsoYmd(postedDate) : '',
            txn_date: txnDateStr,
            pt_trvalue: Number(row.pt_trvalue ?? 0),
          },
        });
      }
    } catch {
      // advisory
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------
// Strategy 6: bank-level signed-amount match against aentry
// ---------------------------------------------------------------------

interface AentryRow {
  ae_entry?: string | null;
  ae_value?: number | string | null;
  ae_lstdate?: string | Date | null;
  ae_entref?: string | null;
  ae_comment?: string | null;
}

async function bankAmountMatch(
  operaDb: Knex,
  amount: number,
  txnDate: Date,
  bankCode: string,
  days: number,
): Promise<DuplicateCandidate[]> {
  const candidates: DuplicateCandidate[] = [];
  const signedPence = Math.round(amount * 100);
  const startDate = dateIsoYmd(addDays(txnDate, -days));
  const endDate = dateIsoYmd(addDays(txnDate, days));
  try {
    const rows = (await operaDb('aentry')
      .where('ae_acnt', bankCode)
      .andWhereBetween('ae_lstdate', [startDate, endDate])
      .andWhereRaw('ABS(ae_value - ?) < 1', [signedPence])
      .select('ae_entry', 'ae_value', 'ae_lstdate', 'ae_entref', 'ae_comment')) as unknown as AentryRow[];
    for (const row of rows) {
      const postedDate = row.ae_lstdate ? new Date(row.ae_lstdate) : null;
      const diffDays = postedDate ? daysBetween(postedDate, txnDate) : days;
      const confidence = Math.max(0.5, 0.95 - diffDays * 0.05);
      candidates.push({
        table: 'aentry',
        record_id: (row.ae_entry ?? '').toString().trim(),
        match_type: 'bank_amount',
        confidence,
        details: {
          ae_entry: (row.ae_entry ?? '').toString().trim(),
          ae_value: Number(row.ae_value ?? 0),
          ae_lstdate: postedDate ? dateIsoYmd(postedDate) : '',
          ae_entref: (row.ae_entref ?? '').toString().trim(),
          ae_comment: (row.ae_comment ?? '').toString().trim(),
          days_diff: diffDays,
        },
      });
    }
  } catch {
    // advisory
  }
  return candidates;
}

// ---------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------

export async function findDuplicates(
  operaDb: Knex,
  input: CheckTransactionInput,
): Promise<DuplicateCandidate[]> {
  let txnDate: Date;
  try {
    txnDate = parseDate(input.date);
  } catch {
    return [];
  }
  const candidates: DuplicateCandidate[] = [];

  // Strategy 0: fingerprint
  candidates.push(
    ...(await fingerprintMatch(
      operaDb,
      input.name ?? '',
      input.amount ?? 0,
      txnDate,
      input.bank_code ?? null,
    )),
  );

  // Only run the other strategies if no fingerprint match
  const hasFingerprint = candidates.some((c) => c.match_type === 'fingerprint');
  if (!hasFingerprint) {
    // Strategy 1: FIT ID
    if (input.fit_id) {
      candidates.push(...(await fitIdMatch(operaDb, input.fit_id)));
    }

    if (input.account) {
      const action = input.action ?? null;
      // Strategy 2: exact (date+amount+account)
      candidates.push(
        ...(await exactMatch(
          operaDb,
          input.amount,
          txnDate,
          input.account,
          input.bank_code ?? null,
          action,
        )),
      );
      // Strategy 3: fuzzy amount (within 5%)
      candidates.push(
        ...(await fuzzyAmountMatch(
          operaDb,
          input.amount,
          txnDate,
          input.account,
          0.05,
          action,
        )),
      );
      // Strategy 4: reference-based
      if (input.reference) {
        candidates.push(
          ...(await referenceMatch(operaDb, input.reference, input.account)),
        );
      }
      // Strategy 5: cross-period (±7 days)
      candidates.push(
        ...(await crossPeriodMatch(
          operaDb,
          input.amount,
          txnDate,
          input.account,
          7,
          action,
        )),
      );
    }

    // Strategy 6: bank-level signed-amount (no account required)
    // Only runs when account-level strategies found nothing — catches
    // transactions entered directly in Opera (e.g. HMRC) where no
    // account match was made. Uses 14-day window because Opera
    // posting date can drift from bank statement date.
    if (input.bank_code && candidates.length === 0) {
      candidates.push(
        ...(await bankAmountMatch(
          operaDb,
          input.amount,
          txnDate,
          input.bank_code,
          14,
        )),
      );
    }
  }

  // De-dupe by (table, record_id), keep highest confidence first.
  const seen = new Set<string>();
  const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence);
  const out: DuplicateCandidate[] = [];
  for (const c of sorted) {
    const key = `${c.table}:${c.record_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

export interface CheckBatchResult {
  index: number;
  candidates: DuplicateCandidate[];
}

export interface CheckBatchResponse {
  success: boolean;
  duplicates_found: number;
  results: Record<string, Array<{
    table: string;
    record_id: string;
    match_type: string;
    confidence: number;
    details: Record<string, unknown>;
  }>>;
  error?: string;
}

export async function checkBatch(
  operaDb: Knex,
  transactions: CheckTransactionInput[],
  bankCode?: string | null,
): Promise<CheckBatchResponse> {
  try {
    const results: CheckBatchResponse['results'] = {};
    let duplicatesFound = 0;
    for (let i = 0; i < transactions.length; i++) {
      const txn = transactions[i]!;
      const candidates = await findDuplicates(operaDb, {
        ...txn,
        bank_code: txn.bank_code ?? bankCode ?? null,
      });
      if (candidates.length > 0) {
        results[i.toString()] = candidates.map((c) => ({
          table: c.table,
          record_id: c.record_id,
          match_type: c.match_type,
          confidence: Math.round(c.confidence * 100),
          details: c.details,
        }));
        duplicatesFound += 1;
      }
    }
    return { success: true, duplicates_found: duplicatesFound, results };
  } catch (err: any) {
    return {
      success: false,
      duplicates_found: 0,
      results: {},
      error: err?.message ?? String(err),
    };
  }
}

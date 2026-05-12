/**
 * Reconcile a bank account across cashbook (atran), bank master
 * (nbank.nk_curbal), and nominal ledger (ntran).
 *
 * Faithful port of `reconcile_bank` (apps/bank_reconcile/api/
 * routes.py:320-704).
 *
 * Reads:
 *   - nbank for account info + current balance (in pence)
 *   - atran for cashbook movements (current year + all time, in pence)
 *   - nacnt for prior-year B/F + description
 *   - ntran for current-year debits / credits / net (in pounds)
 *   - anoml for transfer-file posted vs pending state
 *
 * All three balances should match when fully reconciled:
 *   1. atran current-year movements + B/F  →  cashbook expected closing
 *   2. nbank.nk_curbal                    →  bank master balance
 *   3. ntran current-year net             →  nominal ledger balance
 *
 * Tolerance for "reconciled" is < £0.005.
 */
import type { Knex } from 'knex';

export interface BankAccountInfo {
  code: string;
  description: string;
  sort_code: string;
  account_number: string;
}

export interface PendingTransfer {
  nominal_account: string;
  source: string;
  source_desc: string;
  date: string;
  value: number;
  reference: string;
  comment: string;
}

export interface CashbookSection {
  source: string;
  current_year: number;
  current_year_entries: number;
  current_year_transactions: number;
  current_year_receipts: number;
  current_year_payments: number;
  current_year_movements: number;
  prior_year_bf: number;
  expected_closing: number;
  all_time_entries: number;
  all_time_net: number;
  transfer_file: {
    source: string;
    posted_to_nl: { count: number; total: number };
    pending_transfer: {
      count: number;
      total: number;
      transactions: PendingTransfer[];
    };
  };
}

export interface BankMasterSection {
  source: string;
  balance_pence: number;
  balance_pounds: number;
}

export interface NominalLedgerSection {
  source: string;
  account: string;
  description: string;
  current_year?: number;
  brought_forward?: number;
  current_year_debits?: number;
  current_year_credits?: number;
  current_year_net?: number;
  closing_balance?: number;
  total_balance: number;
}

export interface VarianceComparison {
  description: string;
  cashbook_expected?: number;
  bank_master?: number;
  nominal_ledger?: number;
  amount: number;
  absolute: number;
  reconciled: boolean;
}

export interface ReconcileBankResponse {
  success: boolean;
  reconciliation_date?: string;
  bank_code?: string;
  bank_account?: BankAccountInfo;
  cashbook?: CashbookSection;
  bank_master?: BankMasterSection;
  nominal_ledger?: NominalLedgerSection;
  variance?: {
    cashbook_vs_bank_master: VarianceComparison;
    bank_master_vs_nominal: VarianceComparison;
    cashbook_vs_nominal: VarianceComparison;
    summary: {
      current_year: number;
      cashbook_movements: number;
      prior_year_bf: number;
      cashbook_expected_closing: number;
      bank_master_balance: number;
      nominal_ledger_balance: number;
      transfer_file_pending: number;
      all_reconciled: boolean;
      has_pending_transfers: boolean;
    };
  };
  status?: 'RECONCILED' | 'UNRECONCILED';
  message?: string;
  details?: unknown[];
  error?: string;
}

const SOURCE_DESC_MAP: Record<string, string> = {
  P: 'Purchase',
  S: 'Sales',
  A: 'Cashbook',
  J: 'Journal',
};

function trim(s: string | null | undefined): string {
  return (s ?? '').trim();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatPounds(n: number): string {
  return n.toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export async function reconcileBank(
  operaDb: Knex,
  bankCode: string,
  now: Date = new Date(),
): Promise<ReconcileBankResponse> {
  const code = (bankCode ?? '').trim();
  if (!code) {
    return { success: false, error: 'bank_code is required' };
  }
  try {
    // 1. Bank account info
    const bankInfo = (await operaDb('nbank')
      .whereRaw('RTRIM(nk_acnt) = ?', [code])
      .select(
        'nk_acnt',
        operaDb.raw('RTRIM(nk_desc) AS description'),
        'nk_sort',
        'nk_number',
      )
      .first()) as unknown as
      | {
          nk_acnt: string | null;
          description: string | null;
          nk_sort: string | null;
          nk_number: string | null;
        }
      | undefined;
    if (!bankInfo) {
      return { success: false, error: `Bank account ${code} not found` };
    }

    // 2. Current year (max nt_year)
    const cyRow = (await operaDb('ntran')
      .max({ current_year: 'nt_year' })
      .first()) as unknown as { current_year: number | string | null } | undefined;
    const currentYear =
      cyRow?.current_year !== null && cyRow?.current_year !== undefined
        ? Number(cyRow.current_year)
        : now.getUTCFullYear();

    // 3. Cashbook current year (atran)
    const cbCyRow = (await operaDb('atran')
      .where({ at_acnt: code })
      .andWhereRaw('YEAR(at_pstdate) = ?', [currentYear])
      .select(
        operaDb.raw('COUNT(DISTINCT at_entry) AS entry_count'),
        operaDb.raw('COUNT(*) AS transaction_count'),
        operaDb.raw(
          'SUM(CASE WHEN at_value > 0 THEN at_value ELSE 0 END) AS receipts_pence',
        ),
        operaDb.raw(
          'SUM(CASE WHEN at_value < 0 THEN ABS(at_value) ELSE 0 END) AS payments_pence',
        ),
        operaDb.raw('SUM(at_value) AS net_pence'),
      )
      .first()) as unknown as
      | {
          entry_count: number | string | null;
          transaction_count: number | string | null;
          receipts_pence: number | string | null;
          payments_pence: number | string | null;
          net_pence: number | string | null;
        }
      | undefined;
    const cbCyEntryCount = Number(cbCyRow?.entry_count ?? 0);
    const cbCyTxnCount = Number(cbCyRow?.transaction_count ?? 0);
    const cbCyReceiptsPence = Number(cbCyRow?.receipts_pence ?? 0);
    const cbCyPaymentsPence = Number(cbCyRow?.payments_pence ?? 0);
    const cbCyNetPence = Number(cbCyRow?.net_pence ?? 0);
    const cbCyReceipts = cbCyReceiptsPence / 100;
    const cbCyPayments = cbCyPaymentsPence / 100;
    const cbCyMovements = cbCyNetPence / 100;

    // 4. Cashbook all-time
    const cbAllRow = (await operaDb('atran')
      .where({ at_acnt: code })
      .select(
        operaDb.raw('COUNT(DISTINCT at_entry) AS entry_count'),
        operaDb.raw('COUNT(*) AS transaction_count'),
        operaDb.raw('SUM(at_value) AS net_pence'),
      )
      .first()) as unknown as
      | {
          entry_count: number | string | null;
          transaction_count: number | string | null;
          net_pence: number | string | null;
        }
      | undefined;
    const cbAllCount = Number(cbAllRow?.entry_count ?? 0);
    const cbAllNetPence = Number(cbAllRow?.net_pence ?? 0);
    const cbAllTotal = cbAllNetPence / 100;

    // 5. nbank.nk_curbal
    const nbankBalRow = (await operaDb('nbank')
      .whereRaw('RTRIM(nk_acnt) = ?', [code])
      .select('nk_curbal')
      .first()) as unknown as { nk_curbal: number | string | null } | undefined;
    const nbankCurbalPence = Number(nbankBalRow?.nk_curbal ?? 0);
    const nbankCurbalPounds = nbankCurbalPence / 100;

    // 6. nacnt
    const nacntRow = (await operaDb('nacnt')
      .where({ na_acnt: code })
      .select(
        'na_acnt',
        operaDb.raw('RTRIM(na_desc) AS description'),
        'na_ytddr',
        'na_ytdcr',
        'na_prydr',
        'na_prycr',
      )
      .first()) as unknown as
      | {
          na_acnt: string | null;
          description: string | null;
          na_ytddr: number | string | null;
          na_ytdcr: number | string | null;
          na_prydr: number | string | null;
          na_prycr: number | string | null;
        }
      | undefined;

    let bfBalance = 0;
    let nlTotal = 0;
    let nlDetails: NominalLedgerSection;
    if (nacntRow) {
      const pryDr = Number(nacntRow.na_prydr ?? 0);
      const pryCr = Number(nacntRow.na_prycr ?? 0);
      bfBalance = pryDr - pryCr;

      const ntranRow = (await operaDb('ntran')
        .where({ nt_acnt: code, nt_year: currentYear })
        .select(
          operaDb.raw(
            'SUM(CASE WHEN nt_value > 0 THEN nt_value ELSE 0 END) AS debits',
          ),
          operaDb.raw(
            'SUM(CASE WHEN nt_value < 0 THEN ABS(nt_value) ELSE 0 END) AS credits',
          ),
          operaDb.raw('SUM(nt_value) AS net'),
        )
        .first()) as unknown as
        | {
            debits: number | string | null;
            credits: number | string | null;
            net: number | string | null;
          }
        | undefined;
      const cyDr = Number(ntranRow?.debits ?? 0);
      const cyCr = Number(ntranRow?.credits ?? 0);
      const cyNet = Number(ntranRow?.net ?? 0);
      const closingBalance = cyNet;
      nlTotal = closingBalance;
      nlDetails = {
        source: 'ntran (Nominal Ledger)',
        account: code,
        description: trim(nacntRow.description),
        current_year: currentYear,
        brought_forward: round2(bfBalance),
        current_year_debits: round2(cyDr),
        current_year_credits: round2(cyCr),
        current_year_net: round2(cyNet),
        closing_balance: round2(closingBalance),
        total_balance: round2(nlTotal),
      };
    } else {
      nlDetails = {
        source: 'ntran (Nominal Ledger)',
        account: code,
        description: 'Account not found in nacnt',
        total_balance: 0,
      };
    }

    const cbExpectedClosing = nacntRow
      ? cbCyMovements + bfBalance
      : cbCyMovements;

    // 7. anoml — pending transfers
    let anomlPending: any[] = [];
    try {
      anomlPending = (await operaDb('anoml')
        .where({ ax_nacnt: code })
        .andWhere((qb) => {
          qb.where('ax_done', '<>', 'Y').orWhereNull('ax_done');
        })
        .orderBy('ax_date', 'desc')
        .select(
          'ax_nacnt',
          'ax_source',
          'ax_date',
          'ax_value',
          'ax_tref',
          'ax_comment',
          'ax_done',
        )) as unknown as any[];
    } catch {
      anomlPending = [];
    }

    let anomlSummary: any[] = [];
    try {
      anomlSummary = (await operaDb('anoml')
        .where({ ax_nacnt: code })
        .groupByRaw("CASE WHEN ax_done = 'Y' THEN 'Posted' ELSE 'Pending' END")
        .select(
          operaDb.raw(
            "CASE WHEN ax_done = 'Y' THEN 'Posted' ELSE 'Pending' END AS status",
          ),
          operaDb.raw('COUNT(*) AS count'),
          operaDb.raw('SUM(ax_value) AS total'),
        )) as unknown as any[];
    } catch {
      anomlSummary = [];
    }

    let postedCount = 0;
    let postedTotal = 0;
    let pendingCount = 0;
    let pendingTotal = 0;
    for (const row of anomlSummary ?? []) {
      const status = trim(row.status);
      if (status === 'Posted') {
        postedCount = Number(row.count ?? 0);
        postedTotal = Number(row.total ?? 0);
      } else {
        pendingCount = Number(row.count ?? 0);
        pendingTotal = Number(row.total ?? 0);
      }
    }

    const pendingTransactions: PendingTransfer[] = [];
    for (const row of anomlPending ?? []) {
      const tr = row.ax_date;
      const dateStr =
        tr instanceof Date && !Number.isNaN(tr.getTime())
          ? tr.toISOString().slice(0, 10)
          : tr
            ? String(tr).slice(0, 10)
            : '';
      const value = Number(row.ax_value ?? 0);
      const sourceCode = trim(row.ax_source);
      pendingTransactions.push({
        nominal_account: trim(row.ax_nacnt),
        source: sourceCode,
        source_desc: SOURCE_DESC_MAP[sourceCode] ?? sourceCode,
        date: dateStr,
        value: round2(value),
        reference: trim(row.ax_tref),
        comment: trim(row.ax_comment),
      });
    }

    // 8. Variance computation
    const variance_cb_nbank = cbExpectedClosing - nbankCurbalPounds;
    const variance_cb_nbank_abs = Math.abs(variance_cb_nbank);
    const variance_nbank_nl = nbankCurbalPounds - nlTotal;
    const variance_nbank_nl_abs = Math.abs(variance_nbank_nl);
    const variance_cb_nl = cbExpectedClosing - nlTotal;
    const variance_cb_nl_abs = Math.abs(variance_cb_nl);
    const allReconciled =
      variance_cb_nbank_abs < 0.005 && variance_nbank_nl_abs < 0.005;

    let message: string;
    if (allReconciled) {
      if (pendingCount > 0) {
        message = `Bank ${code} reconciles across all sources. ${pendingCount} entries (£${formatPounds(Math.abs(pendingTotal))}) in transfer file pending.`;
      } else {
        message = `Bank ${code} fully reconciles: Cashbook = Bank Master = Nominal Ledger`;
      }
    } else {
      const issues: string[] = [];
      if (variance_cb_nl_abs >= 0.005) {
        issues.push(
          variance_cb_nl > 0
            ? `Cashbook £${formatPounds(variance_cb_nl_abs)} MORE than NL`
            : `Cashbook £${formatPounds(variance_cb_nl_abs)} LESS than NL`,
        );
      }
      if (variance_cb_nbank_abs >= 0.005) {
        issues.push(
          variance_cb_nbank > 0
            ? `Cashbook £${formatPounds(variance_cb_nbank_abs)} MORE than Bank Master`
            : `Cashbook £${formatPounds(variance_cb_nbank_abs)} LESS than Bank Master`,
        );
      }
      if (variance_nbank_nl_abs >= 0.005) {
        issues.push(
          variance_nbank_nl > 0
            ? `Bank Master £${formatPounds(variance_nbank_nl_abs)} MORE than NL`
            : `Bank Master £${formatPounds(variance_nbank_nl_abs)} LESS than NL`,
        );
      }
      message = issues.length > 0 ? issues.join('; ') : 'Variance detected';
    }

    return {
      success: true,
      reconciliation_date: now.toISOString().slice(0, 19).replace('T', ' '),
      bank_code: code,
      bank_account: {
        code: trim(bankInfo.nk_acnt),
        description: trim(bankInfo.description),
        sort_code: trim(bankInfo.nk_sort),
        account_number: trim(bankInfo.nk_number),
      },
      cashbook: {
        source: 'atran (Cashbook Transactions)',
        current_year: currentYear,
        current_year_entries: cbCyEntryCount,
        current_year_transactions: cbCyTxnCount,
        current_year_receipts: round2(cbCyReceipts),
        current_year_payments: round2(cbCyPayments),
        current_year_movements: round2(cbCyMovements),
        prior_year_bf: nacntRow ? round2(bfBalance) : 0,
        expected_closing: round2(cbExpectedClosing),
        all_time_entries: cbAllCount,
        all_time_net: round2(cbAllTotal),
        transfer_file: {
          source: 'anoml (Cashbook to Nominal Transfer File)',
          posted_to_nl: {
            count: postedCount,
            total: round2(postedTotal),
          },
          pending_transfer: {
            count: pendingCount,
            total: round2(pendingTotal),
            transactions: pendingTransactions,
          },
        },
      },
      bank_master: {
        source: 'nbank.nk_curbal (Bank Master Balance)',
        balance_pence: Math.round(nbankCurbalPence),
        balance_pounds: round2(nbankCurbalPounds),
      },
      nominal_ledger: nlDetails,
      variance: {
        cashbook_vs_bank_master: {
          description: 'atran movements + B/F vs nbank.nk_curbal',
          cashbook_expected: round2(cbExpectedClosing),
          bank_master: round2(nbankCurbalPounds),
          amount: round2(variance_cb_nbank),
          absolute: round2(variance_cb_nbank_abs),
          reconciled: variance_cb_nbank_abs < 0.005,
        },
        bank_master_vs_nominal: {
          description: 'nbank.nk_curbal vs ntran current year',
          bank_master: round2(nbankCurbalPounds),
          nominal_ledger: round2(nlTotal),
          amount: round2(variance_nbank_nl),
          absolute: round2(variance_nbank_nl_abs),
          reconciled: variance_nbank_nl_abs < 0.005,
        },
        cashbook_vs_nominal: {
          description: 'atran expected vs ntran',
          cashbook_expected: round2(cbExpectedClosing),
          nominal_ledger: round2(nlTotal),
          amount: round2(variance_cb_nl),
          absolute: round2(variance_cb_nl_abs),
          reconciled: variance_cb_nl_abs < 0.005,
        },
        summary: {
          current_year: currentYear,
          cashbook_movements: round2(cbCyMovements),
          prior_year_bf: nacntRow ? round2(bfBalance) : 0,
          cashbook_expected_closing: round2(cbExpectedClosing),
          bank_master_balance: round2(nbankCurbalPounds),
          nominal_ledger_balance: round2(nlTotal),
          transfer_file_pending: round2(pendingTotal),
          all_reconciled: allReconciled,
          has_pending_transfers: pendingCount > 0,
        },
      },
      status: allReconciled ? 'RECONCILED' : 'UNRECONCILED',
      message,
      details: [],
    };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

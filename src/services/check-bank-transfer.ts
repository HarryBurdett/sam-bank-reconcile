/**
 * Bank-transfer detection — flag transactions that move money between
 * two Opera bank accounts (rather than to/from a customer or supplier).
 *
 * Faithful port of `_check_bank_transfer`
 * (sql_rag/bank_import.py:1229-1295) plus its helper
 * `_load_other_bank_accounts` (1198-1228).
 *
 * Match strategy (per legacy audit 2026-05-05 stages-1-2 F7):
 *   1. Account-number match (≥6 digits): highly specific — accept on
 *      its own with confidence 1.0.
 *   2. Sort-code-only match (6 digits) is risky because invoice numbers
 *      and customer references can coincidentally embed a 6-digit
 *      subsequence. Only accept a sort-code match when:
 *        (a) the unnormalised text contains the literal dashed/spaced
 *            form (e.g. "20-96-89" or "20 96 89") — banks universally
 *            print sort codes that way, so a dashed match is much more
 *            reliable than a digit-substring match against random
 *            references.
 *
 * Works on Opera SE and Opera 3 — uses Knex builder, parameter binding
 * only, no MSSQL-specific syntax.
 */
import type { Knex } from 'knex';

export interface OtherBank {
  code: string;
  description: string;
  sort_code: string;
  account_number: string;
}

export interface BankTransferResult {
  is_transfer: boolean;
  dest_bank_code: string;
  dest_bank_description: string;
  match_score: number;
  match_source:
    | 'bank_account_number'
    | 'bank_sort_code_formatted'
    | 'none';
}

const NOT_TRANSFER: BankTransferResult = {
  is_transfer: false,
  dest_bank_code: '',
  dest_bank_description: '',
  match_score: 0,
  match_source: 'none',
};

/**
 * Load every other (non-this) Opera bank account that has either a
 * sort code or an account number — those are the only banks we can
 * meaningfully match against. Petty-cash and foreign-currency banks
 * are excluded (legacy filter).
 */
export async function loadOtherBankAccounts(
  operaDb: Knex,
  thisBankCode: string,
): Promise<OtherBank[]> {
  try {
    const rows = (await operaDb('nbank')
      .select(
        operaDb.raw('RTRIM(nk_acnt) as code'),
        operaDb.raw('RTRIM(nk_desc) as description'),
        operaDb.raw("RTRIM(ISNULL(nk_sort, '')) as sort_code"),
        operaDb.raw("RTRIM(ISNULL(nk_number, '')) as account_number"),
      )
      .whereRaw('RTRIM(nk_acnt) <> ?', [thisBankCode])
      .andWhere('nk_petty', 0)
      .andWhere(function noForeignCurrency(this: Knex.QueryBuilder) {
        this.whereNull('nk_fcurr').orWhereRaw("RTRIM(nk_fcurr) = ''");
      })) as unknown as Array<{
      code: string;
      description: string;
      sort_code: string;
      account_number: string;
    }>;
    return (rows ?? [])
      .map((r) => {
        const sortNorm = (r.sort_code ?? '').replace(/[\s-]/g, '');
        const acctNorm = (r.account_number ?? '').replace(/\s/g, '');
        return {
          code: (r.code ?? '').trim(),
          description: (r.description ?? '').trim(),
          sort_code: sortNorm,
          account_number: acctNorm,
        };
      })
      .filter((b) => b.sort_code || b.account_number);
  } catch {
    return [];
  }
}

/**
 * Detect whether `(memo + name + reference)` describes a transfer to
 * another Opera bank account.
 */
export function checkBankTransfer(
  otherBanks: OtherBank[],
  memo: string,
  name: string,
  reference: string,
): BankTransferResult {
  if (!otherBanks.length) return NOT_TRANSFER;

  const raw = `${memo ?? ''} ${name ?? ''} ${reference ?? ''}`;
  // Normalised (digits-only) text — used for account-number checks
  // and the digit-substring half of the sort-code check.
  const search = raw.replace(/[\s-]/g, '');

  for (const bank of otherBanks) {
    // 1. Account-number match — most specific.
    if (bank.account_number && bank.account_number.length >= 6) {
      if (search.includes(bank.account_number)) {
        return {
          is_transfer: true,
          dest_bank_code: bank.code,
          dest_bank_description: bank.description,
          match_score: 1.0,
          match_source: 'bank_account_number',
        };
      }
    }

    // 2. Sort-code match — only with extra evidence (literal dashed
    // or spaced form in the raw text).
    if (bank.sort_code && bank.sort_code.length >= 6) {
      const sort = bank.sort_code;
      const dashed = `${sort.slice(0, 2)}-${sort.slice(2, 4)}-${sort.slice(4, 6)}`;
      const spaced = `${sort.slice(0, 2)} ${sort.slice(2, 4)} ${sort.slice(4, 6)}`;
      if (
        search.includes(sort) &&
        (raw.includes(dashed) || raw.includes(spaced))
      ) {
        return {
          is_transfer: true,
          dest_bank_code: bank.code,
          dest_bank_description: bank.description,
          match_score: 0.9,
          match_source: 'bank_sort_code_formatted',
        };
      }
    }
  }

  return NOT_TRANSFER;
}

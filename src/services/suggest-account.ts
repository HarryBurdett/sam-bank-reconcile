/**
 * Suggest a customer or supplier account for a bank-statement line.
 *
 * Faithful port of `suggest_account_for_transaction`
 * (apps/bank_reconcile/api/routes.py:11225-11334).
 *
 * Three-tier matcher:
 *   1. Substring         (confidence 95)  — direct contains in either direction
 *   2. Word match        (confidence ≥ 70) — significant words intersection
 *   3. Fuzzy             (confidence ≥ 60) — Ratcliff/Obershelp ratio
 *
 * Sales transactions search sname (customers); purchase transactions
 * search pname (suppliers). Dormant accounts are excluded.
 */
import type { Knex } from 'knex';
import { sequenceMatcherRatio } from '../_shared/index.js';

export type TransactionType =
  | 'sales_receipt'
  | 'sales_refund'
  | 'purchase_payment'
  | 'purchase_refund';

export type MatchStrategy = 'substring' | 'word_match' | 'fuzzy';

export interface AccountSuggestion {
  code: string;
  name: string;
  score: number;
  match_type: MatchStrategy;
}

export interface SuggestAccountResponse {
  success: boolean;
  suggestions: AccountSuggestion[];
  ledger_type?: 'C' | 'S';
  searched_count?: number;
  search_term?: string;
  error?: string;
}

interface CustomerRow {
  code: string;
  name: string;
}

const SALES_TYPES = new Set<TransactionType>(['sales_receipt', 'sales_refund']);

async function loadCustomers(operaDb: Knex): Promise<CustomerRow[]> {
  try {
    return (await operaDb('sname')
      .select(
        'sn_account as code',
        operaDb.raw('RTRIM(sn_name) as name'),
      )
      .where(function notStopped(this: Knex.QueryBuilder) {
        this.where('sn_stop', 0).orWhereNull('sn_stop');
      })
      .andWhere(function notDormant(this: Knex.QueryBuilder) {
        this.where('sn_dormant', 0).orWhereNull('sn_dormant');
      })
      .orderBy('sn_name')) as unknown as CustomerRow[];
  } catch {
    return [];
  }
}

async function loadSuppliers(operaDb: Knex): Promise<CustomerRow[]> {
  try {
    return (await operaDb('pname')
      .select(
        'pn_account as code',
        operaDb.raw('RTRIM(pn_name) as name'),
      )
      .where(function notStopped(this: Knex.QueryBuilder) {
        this.where('pn_stop', 0).orWhereNull('pn_stop');
      })
      .andWhere(function notDormant(this: Knex.QueryBuilder) {
        this.where('pn_dormant', 0).orWhereNull('pn_dormant');
      })
      .orderBy('pn_name')) as unknown as CustomerRow[];
  } catch {
    return [];
  }
}

function significantWords(s: string): Set<string> {
  return new Set(s.split(/\s+/).filter((w) => w.length > 2));
}

export async function suggestAccountForTransaction(
  operaDb: Knex,
  name: string,
  transactionType: TransactionType,
  limit = 5,
): Promise<SuggestAccountResponse> {
  try {
    const isCustomer = SALES_TYPES.has(transactionType);
    const accounts = isCustomer
      ? await loadCustomers(operaDb)
      : await loadSuppliers(operaDb);
    if (accounts.length === 0) {
      return {
        success: true,
        suggestions: [],
        ledger_type: isCustomer ? 'C' : 'S',
        searched_count: 0,
        search_term: name,
      };
    }

    const nameUpper = (name ?? '').toUpperCase().trim();
    const nameWords = significantWords(nameUpper);
    const matches: AccountSuggestion[] = [];

    for (const a of accounts) {
      const code = (a.code ?? '').toString().trim();
      const accName = (a.name ?? '').toString().trim();
      if (!accName) continue;
      const accUpper = accName.toUpperCase();

      // Strategy 1: substring
      if (accUpper.includes(nameUpper) || nameUpper.includes(accUpper)) {
        matches.push({
          code,
          name: accName,
          score: 95,
          match_type: 'substring',
        });
        continue;
      }

      // Strategy 2: significant-word intersection
      const accWords = significantWords(accUpper);
      const common = new Set<string>();
      for (const w of nameWords) if (accWords.has(w)) common.add(w);
      if (common.size > 0 && common.size >= Math.min(2, accWords.size)) {
        const rawScore =
          (common.size / Math.max(nameWords.size, accWords.size)) * 100;
        if (rawScore >= 40) {
          matches.push({
            code,
            name: accName,
            score: Math.floor(Math.min(90, rawScore + 30)),
            match_type: 'word_match',
          });
          continue;
        }
      }

      // Strategy 3: Ratcliff/Obershelp ratio
      const ratio = sequenceMatcherRatio(nameUpper, accUpper) * 100;
      if (ratio >= 60) {
        matches.push({
          code,
          name: accName,
          score: Math.floor(ratio),
          match_type: 'fuzzy',
        });
      }
    }

    matches.sort((a, b) => b.score - a.score);
    return {
      success: true,
      suggestions: matches.slice(0, limit),
      ledger_type: isCustomer ? 'C' : 'S',
      searched_count: accounts.length,
      search_term: name,
    };
  } catch (err: any) {
    return {
      success: false,
      suggestions: [],
      error: err?.message ?? String(err),
    };
  }
}

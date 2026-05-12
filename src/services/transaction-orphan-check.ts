/**
 * Per-line bank-statement orphan detection + recovery.
 *
 * Companion to `reconciliation-status.ts` which handles statement-
 * level divergence. This module handles the finer-grained case: an
 * individual statement line was posted to Opera (we wrote its
 * `posted_entry_number` into `bank_statement_transactions`) but the
 * Opera entry no longer exists — i.e. Opera was restored to a
 * backup, or the cashbook entry was deleted directly in Opera.
 *
 * Without this detection a statement could show as "10/21 posted" in
 * the UI while Opera actually has zero of those 10 entries. The user
 * can't tell from the SAM UI alone that re-posting is needed.
 *
 * Wired into:
 *   - GET /api/reconcile/bank/:bank_code/status — surfaced as an
 *     orphan-line count in the response
 *   - GET /api/bank-import/scan-all-banks — when SAM's scan-all-banks
 *     is fully ported, it'll call this per-bank to flag affected
 *     statements
 *   - POST /api/bank-import/recover-orphan-transactions —
 *     explicit-confirmation recovery (clears posted_entry_number on
 *     orphan lines so they can be re-posted via normal import flow)
 *
 * Validation: for each `bank_statement_transactions` row with a
 * non-empty `posted_entry_number`, query Opera atran/aentry to
 * confirm the entry exists. Cost-conscious: batch the lookups, run
 * one Opera query per bank rather than one per line.
 *
 * Driver-agnostic: Knex builder + parameter binding throughout —
 * works on Opera SE (MSSQL) and Opera 3 (FoxPro via SAM's Write
 * Agent) without dialect-specific functions.
 */
import type { Knex } from 'knex';

export interface OrphanedStatementLine {
  import_id: number;
  transaction_id: number;
  line_number: number;
  post_date: string | null;
  amount: number;
  posted_entry_number: string;
  description: string;
}

export interface OrphanedStatement {
  import_id: number;
  filename: string | null;
  statement_date: string | null;
  opening_balance: number | null;
  closing_balance: number | null;
  orphan_lines: OrphanedStatementLine[];
  /** Total amount of orphaned lines (sum of `amount`). */
  orphan_total: number;
}

export interface TransactionOrphanCheckResult {
  success: boolean;
  bank_code: string;
  statement_count: number;
  orphan_line_count: number;
  orphan_statements: OrphanedStatement[];
  error?: string;
}

export interface TransactionOrphanRecoveryResult {
  success: boolean;
  bank_code: string;
  cleared_lines: number;
  cleared_statements: OrphanedStatement[];
  error?: string;
}

interface TxRow {
  id: number;
  import_id: number;
  line_number: number;
  post_date: Date | string | null;
  description: string | null;
  amount: number | string;
  posted_entry_number: string | null;
}

interface ImportRow {
  id: number;
  filename: string | null;
  statement_date: Date | string | null;
  opening_balance: number | string | null;
  closing_balance: number | string | null;
}

function dateToYmd(d: unknown): string | null {
  if (!d) return null;
  if (d instanceof Date) {
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
  return String(d).slice(0, 10);
}

/**
 * Look up which Opera `at_entry`/`ae_entry` values from the provided
 * list currently exist in `aentry` for the given bank. Returns the
 * set that ARE present — caller diffs against the requested list to
 * find orphans.
 *
 * Batched (200 entries per query) to stay below MSSQL's 2100-param
 * cap when a statement has lots of posted lines.
 */
async function entriesPresentInOpera(
  operaDb: Knex,
  bankCode: string,
  entryNumbers: string[],
): Promise<Set<string>> {
  const present = new Set<string>();
  const unique = Array.from(new Set(entryNumbers.map((e) => e.trim()).filter(Boolean)));
  if (unique.length === 0) return present;

  const batchSize = 200;
  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize);
    try {
      const placeholders = batch.map(() => '?').join(',');
      const rows = (await operaDb('aentry')
        .select(operaDb.raw('RTRIM(ae_entry) AS ae_entry'))
        .whereRaw('RTRIM(ae_acnt) = ?', [bankCode])
        .andWhereRaw(`RTRIM(ae_entry) IN (${placeholders})`, batch)) as unknown as Array<{
        ae_entry: string | null;
      }>;
      for (const r of rows ?? []) {
        const v = (r.ae_entry ?? '').trim();
        if (v) present.add(v);
      }
    } catch {
      // Best-effort — if Opera read fails, assume present rather
      // than over-report orphans (false positives mis-direct the
      // user to re-post things that are actually fine).
      for (const e of batch) present.add(e);
    }
  }
  return present;
}

async function fetchPostedLines(
  appDb: Knex,
  bankCode: string,
): Promise<{ imports: Map<number, ImportRow>; lines: TxRow[] }> {
  // Pull imports for this bank that have at least one posted line.
  // Join against the transactions table to avoid loading statements
  // with nothing posted.
  const imports = (await appDb('bank_statement_imports')
    .select(
      'id',
      'filename',
      'statement_date',
      'opening_balance',
      'closing_balance',
    )
    .where('bank_code', bankCode)) as unknown as ImportRow[];
  const importMap = new Map<number, ImportRow>();
  for (const r of imports) importMap.set(r.id, r);

  if (importMap.size === 0) return { imports: importMap, lines: [] };

  const lines = (await appDb('bank_statement_transactions')
    .select(
      'id',
      'import_id',
      'line_number',
      'post_date',
      'description',
      'amount',
      'posted_entry_number',
    )
    .whereIn('import_id', Array.from(importMap.keys()))
    .whereNotNull('posted_entry_number')
    .andWhereRaw("TRIM(posted_entry_number) <> ''")) as unknown as TxRow[];

  return { imports: importMap, lines };
}

function buildOrphanResult(
  importMap: Map<number, ImportRow>,
  lines: TxRow[],
  presentInOpera: Set<string>,
): { orphan_statements: OrphanedStatement[]; orphan_line_count: number } {
  const byImport = new Map<number, OrphanedStatementLine[]>();
  for (const line of lines) {
    const entry = (line.posted_entry_number ?? '').trim();
    if (!entry || presentInOpera.has(entry)) continue;
    const arr = byImport.get(line.import_id) ?? [];
    arr.push({
      import_id: line.import_id,
      transaction_id: line.id,
      line_number: line.line_number,
      post_date: dateToYmd(line.post_date),
      amount: Number(line.amount ?? 0),
      posted_entry_number: entry,
      description: (line.description ?? '').toString(),
    });
    byImport.set(line.import_id, arr);
  }

  const orphan_statements: OrphanedStatement[] = [];
  let orphan_line_count = 0;
  for (const [importId, orphanLines] of byImport) {
    const imp = importMap.get(importId);
    orphan_line_count += orphanLines.length;
    orphan_statements.push({
      import_id: importId,
      filename: imp?.filename ?? null,
      statement_date: dateToYmd(imp?.statement_date) || null,
      opening_balance: imp?.opening_balance !== undefined ? Number(imp.opening_balance) : null,
      closing_balance: imp?.closing_balance !== undefined ? Number(imp.closing_balance) : null,
      orphan_lines: orphanLines.sort((a, b) => a.line_number - b.line_number),
      orphan_total: Math.round(orphanLines.reduce((s, l) => s + l.amount, 0) * 100) / 100,
    });
  }
  orphan_statements.sort(
    (a, b) => (a.statement_date ?? '').localeCompare(b.statement_date ?? ''),
  );
  return { orphan_statements, orphan_line_count };
}

/**
 * Read-only orphan detection for a single bank. Walks every
 * statement on the bank, finds each `bank_statement_transactions`
 * row with a `posted_entry_number`, validates each against Opera
 * `aentry`, returns the statements with one or more orphaned lines.
 *
 * Suitable to wire into:
 *   - the bank's reconcile-status response
 *   - scan-all-banks per-bank enrichment
 *   - a dedicated read-only check endpoint
 */
export async function checkOrphanedTransactions(
  operaDb: Knex,
  appDb: Knex,
  bankCode: string,
): Promise<TransactionOrphanCheckResult> {
  const code = (bankCode ?? '').trim();
  if (!code) {
    return {
      success: false,
      bank_code: code,
      statement_count: 0,
      orphan_line_count: 0,
      orphan_statements: [],
      error: 'bank_code required',
    };
  }
  try {
    const { imports, lines } = await fetchPostedLines(appDb, code);
    if (lines.length === 0) {
      return {
        success: true,
        bank_code: code,
        statement_count: 0,
        orphan_line_count: 0,
        orphan_statements: [],
      };
    }
    const entryNumbers = lines
      .map((l) => (l.posted_entry_number ?? '').trim())
      .filter(Boolean);
    const presentInOpera = await entriesPresentInOpera(operaDb, code, entryNumbers);
    const { orphan_statements, orphan_line_count } = buildOrphanResult(
      imports,
      lines,
      presentInOpera,
    );
    return {
      success: true,
      bank_code: code,
      statement_count: orphan_statements.length,
      orphan_line_count,
      orphan_statements,
    };
  } catch (err: any) {
    return {
      success: false,
      bank_code: code,
      statement_count: 0,
      orphan_line_count: 0,
      orphan_statements: [],
      error: err?.message ?? String(err),
    };
  }
}

/**
 * Explicit-confirmation recovery. Re-runs the detection and clears
 * `posted_entry_number` + `posted_at` on every orphaned line so the
 * normal import-from-pdf flow can re-post them. Statement-level
 * `is_reconciled` is also cleared on any affected import (those
 * statements clearly aren't reconciled anymore since Opera lost the
 * entries).
 *
 * Never auto-runs — caller is an explicit POST endpoint after the
 * user has reviewed the detection result and confirmed an Opera
 * restore has happened.
 */
export async function recoverOrphanedTransactions(
  operaDb: Knex,
  appDb: Knex,
  bankCode: string,
): Promise<TransactionOrphanRecoveryResult> {
  const code = (bankCode ?? '').trim();
  if (!code) {
    return {
      success: false,
      bank_code: code,
      cleared_lines: 0,
      cleared_statements: [],
      error: 'bank_code required',
    };
  }
  try {
    const detection = await checkOrphanedTransactions(operaDb, appDb, code);
    if (!detection.success) {
      return {
        success: false,
        bank_code: code,
        cleared_lines: 0,
        cleared_statements: [],
        error: detection.error,
      };
    }
    if (detection.orphan_statements.length === 0) {
      return {
        success: true,
        bank_code: code,
        cleared_lines: 0,
        cleared_statements: [],
      };
    }

    const txIds: number[] = [];
    const importIds = new Set<number>();
    for (const stmt of detection.orphan_statements) {
      importIds.add(stmt.import_id);
      for (const line of stmt.orphan_lines) txIds.push(line.transaction_id);
    }

    // Clear the orphaned line tracking + the parent statement's
    // reconciliation flag in a single transaction to keep them
    // consistent. Also re-sync each affected statement's stored
    // `transactions_imported` count to the live count of lines that
    // still have a `posted_entry_number` — otherwise the Hub display
    // ("N/M posted") stays frozen at the pre-recovery count and the
    // statement looks like it's still partially posted to Opera.
    await appDb.transaction(async (trx) => {
      await trx('bank_statement_transactions')
        .whereIn('id', txIds)
        .update({
          posted_entry_number: null,
          posted_at: null,
          is_reconciled: 0,
        });
      for (const importId of importIds) {
        const row = await trx('bank_statement_transactions')
          .where({ import_id: importId })
          .whereNotNull('posted_entry_number')
          .andWhereRaw("TRIM(posted_entry_number) <> ''")
          .count<{ c: number | string }[]>({ c: '*' })
          .first();
        const remainingPosted = Number(row?.c ?? 0);
        await trx('bank_statement_imports').where({ id: importId }).update({
          is_reconciled: 0,
          reconciled_count: 0,
          reconciled_at: null,
          reconciled_by: null,
          transactions_imported: remainingPosted,
        });
      }
    });

    return {
      success: true,
      bank_code: code,
      cleared_lines: txIds.length,
      cleared_statements: detection.orphan_statements,
    };
  } catch (err: any) {
    return {
      success: false,
      bank_code: code,
      cleared_lines: 0,
      cleared_statements: [],
      error: err?.message ?? String(err),
    };
  }
}

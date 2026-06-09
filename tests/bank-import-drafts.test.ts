import { describe, it, expect } from 'vitest';
import {
  saveImportDraft,
  loadImportDraft,
  deleteImportDraft,
  getDraftStatementKeys,
} from '../src/services/bank-import-drafts.js';

const TEST_COMPANY = 'C';

interface Row {
  id: number;
  company_code: string;
  bank_code: string;
  source: string;
  email_id: string;
  attachment_id: string;
  pdf_hash: string;
  filename: string;
  preview_data: string;
  user_edits: string;
  target_system: string;
  updated_at: string;
}

interface MockState {
  rows: Row[];
  nextId: number;
}

function makeAppDb(state: MockState): any {
  const db: any = (table: string) => {
    if (table !== 'bank_import_drafts') {
      throw new Error(`Unexpected table: ${table}`);
    }
    let conds: Partial<Row> = {};
    let order: { col: keyof Row; dir: 'asc' | 'desc' } | null = null;
    let limitN = Infinity;
    const builder: any = {
      where: (cond: Partial<Row>) => {
        conds = { ...conds, ...cond };
        return builder;
      },
      andWhere: (col: keyof Row, val: Row[keyof Row]) => {
        (conds as any)[col] = val;
        return builder;
      },
      orderBy: (col: keyof Row, dir: 'asc' | 'desc') => {
        order = { col, dir };
        return builder;
      },
      limit: (n: number) => {
        limitN = n;
        return builder;
      },
      first: () => {
        const matches = state.rows.filter((r) =>
          Object.entries(conds).every(([k, v]) => (r as any)[k] === v),
        );
        return Promise.resolve(matches[0]);
      },
      select: (..._cols: unknown[]) => {
        let matches = state.rows.filter((r) =>
          Object.entries(conds).every(([k, v]) => (r as any)[k] === v),
        );
        if (order) {
          const { col, dir } = order;
          matches = [...matches].sort((a, b) => {
            const av = (a as any)[col];
            const bv = (b as any)[col];
            const cmp = String(av).localeCompare(String(bv));
            return dir === 'desc' ? -cmp : cmp;
          });
        }
        return Promise.resolve(matches.slice(0, limitN));
      },
      insert: (data: Partial<Row>) => ({
        returning: (_: string) => {
          const id = state.nextId++;
          state.rows.push({
            id,
            company_code: data.company_code ?? '',
            bank_code: data.bank_code ?? '',
            source: data.source ?? '',
            email_id: data.email_id ?? '',
            attachment_id: data.attachment_id ?? '',
            pdf_hash: data.pdf_hash ?? '',
            filename: data.filename ?? '',
            preview_data: data.preview_data ?? '{}',
            user_edits: data.user_edits ?? '{}',
            target_system: data.target_system ?? 'opera_se',
            updated_at: new Date().toISOString(),
          });
          return Promise.resolve([{ id }]);
        },
      }),
      update: (data: Partial<Row>) => {
        for (const r of state.rows) {
          const matches = Object.entries(conds).every(
            ([k, v]) => (r as any)[k] === v,
          );
          if (matches) {
            Object.assign(r, data);
            r.updated_at = new Date().toISOString();
          }
        }
        return Promise.resolve(1);
      },
      delete: () => {
        const before = state.rows.length;
        state.rows = state.rows.filter(
          (r) =>
            !Object.entries(conds).every(([k, v]) => (r as any)[k] === v),
        );
        return Promise.resolve(before - state.rows.length);
      },
    };
    return builder;
  };
  db.fn = { now: () => 'NOW()' };
  return db;
}

describe('saveImportDraft', () => {
  it('inserts a new draft when none exists', async () => {
    const state: MockState = { rows: [], nextId: 1 };
    const db = makeAppDb(state);
    const result = await saveImportDraft(db, TEST_COMPANY, {
      bankCode: 'BC010',
      source: 'email',
      filename: 'statement_april.pdf',
      previewData: { rows: 5 },
      userEdits: { 0: { override: 'manual' } },
      emailId: 1234,
      attachmentId: 'A1',
      pdfHash: 'abc123',
      targetSystem: 'opera_se',
    });

    expect(result.success).toBe(true);
    expect(result.draft_id).toBe(1);
    expect(state.rows).toHaveLength(1);
    expect(JSON.parse(state.rows[0]!.preview_data)).toEqual({ rows: 5 });
    expect(JSON.parse(state.rows[0]!.user_edits)).toEqual({
      0: { override: 'manual' },
    });
    expect(state.rows[0]!.email_id).toBe('1234');
  });

  it('updates existing draft for same key (upsert)', async () => {
    const state: MockState = { rows: [], nextId: 1 };
    const db = makeAppDb(state);
    await saveImportDraft(db, TEST_COMPANY, {
      bankCode: 'BC010',
      source: 'email',
      filename: 'a.pdf',
      previewData: { v: 1 },
      userEdits: {},
      emailId: 100,
      attachmentId: 'A1',
      pdfHash: 'h1',
    });
    await saveImportDraft(db, TEST_COMPANY, {
      bankCode: 'BC010',
      source: 'email',
      filename: 'a.pdf',
      previewData: { v: 2 },
      userEdits: { changed: true },
      emailId: 100,
      attachmentId: 'A1',
      pdfHash: 'h1',
    });
    expect(state.rows).toHaveLength(1);
    expect(JSON.parse(state.rows[0]!.preview_data)).toEqual({ v: 2 });
    expect(JSON.parse(state.rows[0]!.user_edits)).toEqual({ changed: true });
  });

  it('rejects missing bank_code/source/filename', async () => {
    const db = makeAppDb({ rows: [], nextId: 1 });
    const result = await saveImportDraft(db, TEST_COMPANY, {
      bankCode: '',
      source: 'email',
      filename: 'x',
      previewData: {},
      userEdits: {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/required/);
  });

  it('handles already-stringified preview_data', async () => {
    const state: MockState = { rows: [], nextId: 1 };
    const db = makeAppDb(state);
    await saveImportDraft(db, TEST_COMPANY, {
      bankCode: 'BC',
      source: 'file',
      filename: 'f.csv',
      previewData: '{"already":"stringified"}',
      userEdits: {},
    });
    expect(state.rows[0]!.preview_data).toBe('{"already":"stringified"}');
  });
});

describe('loadImportDraft', () => {
  it('returns has_draft=false when no row matches', async () => {
    const db = makeAppDb({ rows: [], nextId: 1 });
    const result = await loadImportDraft(db, TEST_COMPANY, {
      bankCode: 'BC010',
      source: 'email',
    });
    expect(result.success).toBe(true);
    expect(result.has_draft).toBe(false);
  });

  it('returns parsed preview_data + user_edits when found', async () => {
    const state: MockState = {
      rows: [
        {
          id: 7,
          company_code: TEST_COMPANY,
          bank_code: 'BC010',
          source: 'email',
          email_id: '99',
          attachment_id: '',
          pdf_hash: '',
          filename: 's.pdf',
          preview_data: '{"transactions":3}',
          user_edits: '{"0":{"x":1}}',
          target_system: 'opera_se',
          updated_at: '2026-04-15T10:00:00Z',
        },
      ],
      nextId: 8,
    };
    const db = makeAppDb(state);
    const result = await loadImportDraft(db, TEST_COMPANY, {
      bankCode: 'BC010',
      source: 'email',
      emailId: 99,
    });
    expect(result.has_draft).toBe(true);
    expect(result.draft?.id).toBe(7);
    expect(result.draft?.preview_data).toEqual({ transactions: 3 });
    expect(result.draft?.user_edits).toEqual({ '0': { x: 1 } });
  });

  it('rejects missing bank_code/source', async () => {
    const db = makeAppDb({ rows: [], nextId: 1 });
    const result = await loadImportDraft(db, TEST_COMPANY, {
      bankCode: '',
      source: 'email',
    });
    expect(result.success).toBe(false);
  });

  it('falls back to {} when preview_data is malformed JSON', async () => {
    const state: MockState = {
      rows: [
        {
          id: 1,
          company_code: TEST_COMPANY,
          bank_code: 'BC',
          source: 'file',
          email_id: '',
          attachment_id: '',
          pdf_hash: '',
          filename: 'f',
          preview_data: 'not-json',
          user_edits: '{}',
          target_system: 'opera_se',
          updated_at: '2026-04-15',
        },
      ],
      nextId: 2,
    };
    const db = makeAppDb(state);
    const result = await loadImportDraft(db, TEST_COMPANY, {
      bankCode: 'BC',
      source: 'file',
    });
    expect(result.draft?.preview_data).toEqual({});
  });
});

describe('deleteImportDraft', () => {
  it('removes a draft by full key', async () => {
    const state: MockState = {
      rows: [
        {
          id: 1,
          company_code: TEST_COMPANY,
          bank_code: 'BC',
          source: 'email',
          email_id: '5',
          attachment_id: 'A',
          pdf_hash: 'H',
          filename: 'f.pdf',
          preview_data: '{}',
          user_edits: '{}',
          target_system: 'opera_se',
          updated_at: '2026-04-15',
        },
      ],
      nextId: 2,
    };
    const db = makeAppDb(state);
    const result = await deleteImportDraft(db, TEST_COMPANY, {
      bankCode: 'BC',
      source: 'email',
      emailId: 5,
      attachmentId: 'A',
      pdfHash: 'H',
      filename: 'f.pdf',
    });
    expect(result.success).toBe(true);
    expect(result.deleted).toBe(true);
    expect(state.rows).toHaveLength(0);
  });

  it('returns deleted=false when no row matches', async () => {
    const db = makeAppDb({ rows: [], nextId: 1 });
    const result = await deleteImportDraft(db, TEST_COMPANY, {
      bankCode: 'BC',
      source: 'email',
    });
    expect(result.success).toBe(true);
    expect(result.deleted).toBe(false);
  });
});

describe('getDraftStatementKeys', () => {
  it('returns drafts for the given bank_code, sorted by updated_at desc', async () => {
    const state: MockState = {
      rows: [
        {
          id: 1,
          company_code: TEST_COMPANY,
          bank_code: 'BC',
          source: 'email',
          email_id: '1',
          attachment_id: 'A',
          pdf_hash: 'H1',
          filename: 'old.pdf',
          preview_data: '{}',
          user_edits: '{}',
          target_system: 'opera_se',
          updated_at: '2026-04-10',
        },
        {
          id: 2,
          company_code: TEST_COMPANY,
          bank_code: 'BC',
          source: 'file',
          email_id: '',
          attachment_id: '',
          pdf_hash: '',
          filename: 'new.csv',
          preview_data: '{}',
          user_edits: '{}',
          target_system: 'opera_se',
          updated_at: '2026-04-15',
        },
        {
          id: 3,
          company_code: TEST_COMPANY,
          bank_code: 'OTHER',
          source: 'email',
          email_id: '5',
          attachment_id: '',
          pdf_hash: '',
          filename: 'x.pdf',
          preview_data: '{}',
          user_edits: '{}',
          target_system: 'opera_se',
          updated_at: '2026-04-20',
        },
      ],
      nextId: 4,
    };
    const db = makeAppDb(state);
    const keys = await getDraftStatementKeys(db, TEST_COMPANY, 'BC');
    expect(keys).toHaveLength(2);
    expect(keys[0]?.filename).toBe('new.csv');
    expect(keys[1]?.filename).toBe('old.pdf');
  });

  it('returns empty array on empty bank code', async () => {
    const db = makeAppDb({ rows: [], nextId: 1 });
    const keys = await getDraftStatementKeys(db, TEST_COMPANY, '');
    expect(keys).toEqual([]);
  });
});

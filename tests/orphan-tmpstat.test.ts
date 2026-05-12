import { describe, it, expect } from 'vitest';
import { listOrphanTmpstat, clearOrphanTmpstat } from '../src/services/orphan-tmpstat.js';

function makeMockOpera(canned: {
  selectRows?: unknown[];
  updateAffected?: number;
  raw?: (sql: string, bindings: unknown[]) => Promise<unknown>;
}): any {
  const db: any = () => ({});
  db.raw =
    canned.raw ??
    (async (sql: string) => {
      // Distinguish SELECT vs UPDATE by SQL
      if (sql.trim().toUpperCase().startsWith('UPDATE')) {
        return { rowCount: canned.updateAffected ?? 0 };
      }
      return canned.selectRows ?? [];
    });
  return db;
}

describe('listOrphanTmpstat', () => {
  it('returns rows trimmed and typed', async () => {
    const db = makeMockOpera({
      selectRows: [
        {
          ae_entry: 'P10000123  ',
          ae_lstdate: '2026-04-15',
          value_pds: 1500.5,
          ae_entref: 'TEST REF ',
          ae_tmpstat: 1,
          ae_statln: 5,
        },
      ],
    });
    const result = await listOrphanTmpstat(db, 'BC010');
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
    expect(result.entries[0]?.entry).toBe('P10000123');
    expect(result.entries[0]?.value).toBe(1500.5);
    expect(result.entries[0]?.reference).toBe('TEST REF');
    expect(result.entries[0]?.tmpstat).toBe(1);
    expect(result.entries[0]?.statement_line).toBe(5);
  });

  it('returns empty list when no orphans', async () => {
    const db = makeMockOpera({ selectRows: [] });
    const result = await listOrphanTmpstat(db, 'BC010');
    expect(result.count).toBe(0);
    expect(result.entries).toEqual([]);
  });

  it('reports error gracefully', async () => {
    const db: any = {
      raw: async () => {
        throw new Error('connection lost');
      },
    };
    const result = await listOrphanTmpstat(db, 'BC010');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/connection lost/);
  });
});

describe('clearOrphanTmpstat', () => {
  it('returns cleared=0 when no orphans found', async () => {
    let updateCalled = false;
    const db: any = {
      raw: async (sql: string) => {
        if (sql.trim().toUpperCase().startsWith('UPDATE')) {
          updateCalled = true;
          return { rowCount: 0 };
        }
        return [];
      },
    };
    const result = await clearOrphanTmpstat(db, 'BC010');
    expect(result.success).toBe(true);
    expect(result.cleared).toBe(0);
    expect(result.entries).toEqual([]);
    // No UPDATE issued when there's nothing to clear
    expect(updateCalled).toBe(false);
  });

  it('previews + clears when orphans exist', async () => {
    const sequence: string[] = [];
    const db: any = {
      raw: async (sql: string) => {
        sequence.push(sql.trim().slice(0, 6).toUpperCase());
        if (sql.trim().toUpperCase().startsWith('UPDATE')) {
          return { rowCount: 1 };
        }
        return [
          {
            ae_entry: 'P10000123',
            ae_lstdate: '2026-04-15',
            value_pds: 1500,
            ae_tmpstat: 1,
          },
        ];
      },
    };
    const result = await clearOrphanTmpstat(db, 'BC010');
    expect(result.success).toBe(true);
    expect(result.cleared).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.previous_tmpstat).toBe(1);
    // SELECT preview ran first, then UPDATE
    expect(sequence).toEqual(['SELECT', 'UPDATE']);
  });

  it('rejects non-list entry_numbers', async () => {
    const db = makeMockOpera({});
    const result = await clearOrphanTmpstat(db, 'BC010', 'bad' as any);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/list of strings/);
  });

  it('rejects entry_numbers containing non-strings', async () => {
    const db = makeMockOpera({});
    const result = await clearOrphanTmpstat(db, 'BC010', ['ok', 123 as any]);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/list of strings/);
  });
});

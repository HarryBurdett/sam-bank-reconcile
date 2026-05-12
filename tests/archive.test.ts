import { describe, it, expect, vi } from 'vitest';
import {
  archiveFile,
  getArchiveHistory,
  restoreArchivedFile,
  getPendingFiles,
  type FileStorageAdapter,
} from '../src/services/archive.js';

interface LogRow {
  id: number;
  archived_at: string;
  original_path: string;
  archive_path: string;
  import_type: string;
  filename: string;
  metadata: string | null;
  restored_at: string | null;
  restored_to: string | null;
}

interface State {
  log: LogRow[];
  nextId: number;
}

function makeAppDb(state: State): any {
  function tableBuilder(table: string) {
    if (table !== 'file_archive_log') {
      throw new Error(`Unexpected table: ${table}`);
    }
    let typeFilter: string | null = null;
    let pathFilter: string | null = null;
    let idFilter: number | null = null;
    let limitN: number | null = null;
    const builder: any = {
      where: (cond: any) => {
        if (typeof cond === 'object') {
          if (cond.import_type) typeFilter = cond.import_type;
          if (cond.archive_path) pathFilter = cond.archive_path;
          if (cond.id) idFilter = cond.id;
        }
        return builder;
      },
      orderBy: () => builder,
      limit: (n: number) => {
        limitN = n;
        return builder;
      },
      first: async () => {
        if (pathFilter) {
          return state.log.find((r) => r.archive_path === pathFilter);
        }
        return undefined;
      },
      update: async (payload: any) => {
        if (idFilter !== null) {
          const idx = state.log.findIndex((r) => r.id === idFilter);
          if (idx >= 0) {
            state.log[idx] = { ...state.log[idx]!, ...payload };
            return 1;
          }
        }
        return 0;
      },
      insert: async (payload: any) => {
        const id = state.nextId++;
        state.log.push({
          id,
          archived_at: new Date().toISOString(),
          original_path: payload.original_path,
          archive_path: payload.archive_path,
          import_type: payload.import_type,
          filename: payload.filename,
          metadata: payload.metadata,
          restored_at: null,
          restored_to: null,
        });
        return [id];
      },
      then: async (resolve: any) => {
        let rows = state.log;
        if (typeFilter) rows = rows.filter((r) => r.import_type === typeFilter);
        rows = [...rows].sort((a, b) =>
          a.archived_at < b.archived_at ? 1 : -1,
        );
        if (limitN) rows = rows.slice(0, limitN);
        return resolve(rows);
      },
    };
    return builder;
  }
  const db: any = (table: string) => tableBuilder(table);
  db.fn = { now: () => '__NOW__' };
  return db;
}

function makeStorage(opts: {
  archiveResult?: { archivePath: string };
  restoreResult?: { restoredPath: string };
  pending?: Array<{
    path: string;
    filename: string;
    folder: string;
    size: number;
    modified: string;
  }>;
  failArchive?: boolean;
  failRestore?: boolean;
}): FileStorageAdapter {
  return {
    archive: vi.fn(async ({ sourcePath }) => {
      if (opts.failArchive) throw new Error('archive failed');
      return opts.archiveResult ?? { archivePath: `/archive/${sourcePath.split('/').pop()}` };
    }),
    restore: vi.fn(async ({ originalPath }) => {
      if (opts.failRestore) throw new Error('restore failed');
      return opts.restoreResult ?? { restoredPath: originalPath };
    }),
    listPending: vi.fn(async () => opts.pending ?? []),
  };
}

describe('archiveFile', () => {
  it('archives + writes log row', async () => {
    const state: State = { log: [], nextId: 1 };
    const storage = makeStorage({});
    const result = await archiveFile(makeAppDb(state), storage, {
      filePath: '/tmp/statement.pdf',
      importType: 'bank-statement',
      transactionsExtracted: 10,
    });
    expect(result.success).toBe(true);
    expect(result.archive_path).toBe('/archive/statement.pdf');
    expect(state.log.length).toBe(1);
    expect(state.log[0]?.filename).toBe('statement.pdf');
  });

  it('rejects unsupported import_type', async () => {
    const state: State = { log: [], nextId: 1 };
    const result = await archiveFile(
      makeAppDb(state),
      makeStorage({}),
      { filePath: '/tmp/x', importType: 'foo' as any },
    );
    expect(result.success).toBe(false);
  });

  it('returns error when storage throws', async () => {
    const state: State = { log: [], nextId: 1 };
    const result = await archiveFile(
      makeAppDb(state),
      makeStorage({ failArchive: true }),
      { filePath: '/tmp/x.pdf', importType: 'bank-statement' },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Archive failed/);
  });
});

describe('getArchiveHistory', () => {
  it('returns rows ordered desc and respects limit + filter', async () => {
    const state: State = {
      log: [
        {
          id: 1,
          archived_at: '2026-04-01T00:00:00Z',
          original_path: '/tmp/a.pdf',
          archive_path: '/archive/a.pdf',
          import_type: 'bank-statement',
          filename: 'a.pdf',
          metadata: null,
          restored_at: null,
          restored_to: null,
        },
        {
          id: 2,
          archived_at: '2026-04-15T00:00:00Z',
          original_path: '/tmp/b.csv',
          archive_path: '/archive/b.csv',
          import_type: 'gocardless',
          filename: 'b.csv',
          metadata: null,
          restored_at: null,
          restored_to: null,
        },
      ],
      nextId: 3,
    };
    const all = await getArchiveHistory(makeAppDb(state), null, 50);
    expect(all.count).toBe(2);
    expect(all.history?.[0]?.id).toBe(2);
    const onlyBank = await getArchiveHistory(
      makeAppDb(state),
      'bank-statement',
      50,
    );
    expect(onlyBank.count).toBe(1);
    expect(onlyBank.history?.[0]?.id).toBe(1);
  });
});

describe('restoreArchivedFile', () => {
  it('restores known archive path and stamps restored_at', async () => {
    const state: State = {
      log: [
        {
          id: 1,
          archived_at: '2026-04-01T00:00:00Z',
          original_path: '/tmp/a.pdf',
          archive_path: '/archive/a.pdf',
          import_type: 'bank-statement',
          filename: 'a.pdf',
          metadata: null,
          restored_at: null,
          restored_to: null,
        },
      ],
      nextId: 2,
    };
    const result = await restoreArchivedFile(
      makeAppDb(state),
      makeStorage({}),
      '/archive/a.pdf',
    );
    expect(result.success).toBe(true);
    expect(result.restored_path).toBe('/tmp/a.pdf');
    expect(state.log[0]?.restored_to).toBe('/tmp/a.pdf');
  });

  it('errors when archive_path missing from log', async () => {
    const state: State = { log: [], nextId: 1 };
    const result = await restoreArchivedFile(
      makeAppDb(state),
      makeStorage({}),
      '/archive/ghost.pdf',
    );
    expect(result.success).toBe(false);
  });
});

describe('getPendingFiles', () => {
  it('returns files for valid import_type', async () => {
    const result = await getPendingFiles(
      makeStorage({
        pending: [
          {
            path: '/tmp/x.pdf',
            filename: 'x.pdf',
            folder: 'bank-statements',
            size: 100,
            modified: '2026-04-15T10:00:00Z',
          },
        ],
      }),
      'bank-statement',
    );
    expect(result.success).toBe(true);
    expect(result.count).toBe(1);
  });

  it('rejects unknown import_type', async () => {
    const result = await getPendingFiles(makeStorage({}), 'foo' as any);
    expect(result.success).toBe(false);
  });
});

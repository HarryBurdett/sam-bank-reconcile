import { describe, it, expect } from 'vitest';
import {
  getFolderSettings,
  saveFolderSettings,
} from '../src/services/folder-settings.js';

const TEST_COMPANY = 'C';

interface SettingsRow {
  id: number;
  key: string;
  value: string;
  company_code: string;
}

interface MockState {
  rows: SettingsRow[];
}

function makeAppDb(state: MockState): any {
  const db: any = (table: string) => {
    if (table !== 'settings') throw new Error(`Unexpected table: ${table}`);
    let conds: Record<string, unknown> = {};
    const matches = () =>
      state.rows.filter((r) =>
        Object.entries(conds).every(([k, v]) => (r as any)[k] === v),
      );
    const builder: any = {
      where: (cond: Record<string, unknown>) => {
        Object.assign(conds, cond);
        return builder;
      },
      first: async () => matches()[0],
      update: async (data: Record<string, unknown>) => {
        let count = 0;
        for (const r of matches()) {
          Object.assign(r, data);
          count++;
        }
        return count;
      },
      insert: async (row: Record<string, unknown>) => {
        const id = (state.rows[state.rows.length - 1]?.id ?? 0) + 1;
        state.rows.push({
          id,
          key: String(row.key ?? ''),
          value: String(row.value ?? ''),
          company_code: String(row.company_code ?? ''),
        });
        return [id];
      },
    };
    return builder;
  };
  db.fn = { now: () => '__NOW__' };
  return db;
}

describe('getFolderSettings', () => {
  it('returns disabled defaults when no row exists', async () => {
    const state: MockState = { rows: [] };
    const result = await getFolderSettings(makeAppDb(state), TEST_COMPANY);
    expect(result.success).toBe(true);
    expect(result.base_folder).toBe('');
    expect(result.archive_folder).toBe('');
    expect(result.folder_enabled).toBe(false);
  });

  it('returns parsed settings + enabled=true when base_folder set', async () => {
    const state: MockState = {
      rows: [
        {
          id: 1,
          key: 'folder_settings',
          company_code: TEST_COMPANY,
          value: JSON.stringify({
            base_folder: '/srv/bank',
            archive_folder: '/srv/bank/archive',
          }),
        },
      ],
    };
    const result = await getFolderSettings(makeAppDb(state), TEST_COMPANY);
    expect(result.success).toBe(true);
    expect(result.base_folder).toBe('/srv/bank');
    expect(result.archive_folder).toBe('/srv/bank/archive');
    expect(result.folder_enabled).toBe(true);
  });

  it('falls back to defaults on malformed JSON', async () => {
    const state: MockState = {
      rows: [{ id: 1, key: 'folder_settings', company_code: TEST_COMPANY, value: 'not json' }],
    };
    const result = await getFolderSettings(makeAppDb(state), TEST_COMPANY);
    expect(result.success).toBe(true);
    expect(result.folder_enabled).toBe(false);
  });

  it('reports folder_enabled=false when base_folder is empty even if archive set', async () => {
    const state: MockState = {
      rows: [
        {
          id: 1,
          key: 'folder_settings',
          company_code: TEST_COMPANY,
          value: JSON.stringify({ base_folder: '', archive_folder: '/x' }),
        },
      ],
    };
    const result = await getFolderSettings(makeAppDb(state), TEST_COMPANY);
    expect(result.folder_enabled).toBe(false);
  });
});

describe('saveFolderSettings', () => {
  it('inserts a new row when none exists', async () => {
    const state: MockState = { rows: [] };
    const result = await saveFolderSettings(makeAppDb(state), TEST_COMPANY, {
      base_folder: '/srv/bank',
      archive_folder: '/srv/archive',
    });
    expect(result.success).toBe(true);
    expect(state.rows).toHaveLength(1);
    const stored = JSON.parse(state.rows[0]?.value ?? '{}');
    expect(stored.base_folder).toBe('/srv/bank');
    expect(stored.archive_folder).toBe('/srv/archive');
  });

  it('updates existing row instead of duplicating', async () => {
    const state: MockState = {
      rows: [
        {
          id: 1,
          key: 'folder_settings',
          company_code: TEST_COMPANY,
          value: JSON.stringify({ base_folder: '/old', archive_folder: '' }),
        },
      ],
    };
    const result = await saveFolderSettings(makeAppDb(state), TEST_COMPANY, {
      base_folder: '/new',
      archive_folder: '/new/arch',
    });
    expect(result.success).toBe(true);
    expect(state.rows).toHaveLength(1);
    const stored = JSON.parse(state.rows[0]?.value ?? '{}');
    expect(stored.base_folder).toBe('/new');
    expect(stored.archive_folder).toBe('/new/arch');
  });

  it('coerces missing fields to empty strings', async () => {
    const state: MockState = { rows: [] };
    const result = await saveFolderSettings(makeAppDb(state), TEST_COMPANY, {});
    expect(result.success).toBe(true);
    const stored = JSON.parse(state.rows[0]?.value ?? '{}');
    expect(stored.base_folder).toBe('');
    expect(stored.archive_folder).toBe('');
  });
});

import { describe, it, expect } from 'vitest';
import {
  getMatchConfig,
  updateMatchConfig,
} from '../src/services/match-config.js';

interface MockState {
  rows: Array<Record<string, unknown> & { id: number }>;
  nextId: number;
  raiseOnFirst?: boolean;
}

function makeAppDb(state: MockState): any {
  const db: any = (table: string) => {
    if (table !== 'match_config') {
      throw new Error(`Unexpected table: ${table}`);
    }
    if (state.raiseOnFirst) {
      // Force a thrown error in the first .first() call
      throw new Error('table missing');
    }
    const builder: any = {
      orderBy: () => builder,
      first: () => Promise.resolve(state.rows.slice(-1)[0]),
      insert: (row: Record<string, unknown>) => {
        const id = state.nextId++;
        state.rows.push({ id, ...row });
        return Promise.resolve([id]);
      },
    };
    return builder;
  };
  db.fn = { now: () => 'NOW()' };
  return db;
}

describe('getMatchConfig', () => {
  it('returns built-in defaults when no row exists', async () => {
    const db = makeAppDb({ rows: [], nextId: 1 });
    const result = await getMatchConfig(db);

    expect(result.success).toBe(true);
    expect(result.config.min_match_score).toBe(0.6);
    expect(result.config.learn_threshold).toBe(0.8);
    expect(result.config.ambiguity_threshold).toBe(0.15);
    expect(result.config.use_phonetic).toBe(true);
    expect(result.config.use_levenshtein).toBe(true);
    expect(result.config.use_ngram).toBe(true);
  });

  it('returns saved row preferring most recent (orderBy id desc)', async () => {
    const state: MockState = {
      rows: [
        {
          id: 1,
          min_match_score: 0.5,
          learn_threshold: 0.7,
          ambiguity_threshold: 0.1,
          use_phonetic: 0,
          use_levenshtein: 1,
          use_ngram: 0,
        },
        {
          id: 2,
          min_match_score: 0.75,
          learn_threshold: 0.85,
          ambiguity_threshold: 0.2,
          use_phonetic: true,
          use_levenshtein: false,
          use_ngram: true,
        },
      ],
      nextId: 3,
    };
    const db = makeAppDb(state);
    const result = await getMatchConfig(db);

    expect(result.success).toBe(true);
    expect(result.config.min_match_score).toBe(0.75);
    expect(result.config.learn_threshold).toBe(0.85);
    expect(result.config.ambiguity_threshold).toBe(0.2);
    expect(result.config.use_phonetic).toBe(true);
    expect(result.config.use_levenshtein).toBe(false);
    expect(result.config.use_ngram).toBe(true);
  });

  it('falls back to defaults on DB error (success still true)', async () => {
    const db = makeAppDb({ rows: [], nextId: 1, raiseOnFirst: true });
    const result = await getMatchConfig(db);

    // Python returns success=true even on error so the frontend has values
    expect(result.success).toBe(true);
    expect(result.config.min_match_score).toBe(0.6);
    expect(result.error).toMatch(/table missing/);
  });
});

describe('updateMatchConfig', () => {
  it('inserts a new row with the given thresholds', async () => {
    const state: MockState = { rows: [], nextId: 1 };
    const db = makeAppDb(state);
    const result = await updateMatchConfig(db, {
      min_match_score: 0.55,
      learn_threshold: 0.9,
      ambiguity_threshold: 0.05,
      use_phonetic: false,
      use_levenshtein: true,
      use_ngram: false,
    });

    expect(result.success).toBe(true);
    expect(result.message).toBe('Configuration updated');
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({
      min_match_score: 0.55,
      learn_threshold: 0.9,
      ambiguity_threshold: 0.05,
      use_phonetic: false,
      use_levenshtein: true,
      use_ngram: false,
    });
  });

  it('clamps thresholds to [0, 1]', async () => {
    const state: MockState = { rows: [], nextId: 1 };
    const db = makeAppDb(state);
    await updateMatchConfig(db, {
      min_match_score: 1.5,
      learn_threshold: -0.2,
      ambiguity_threshold: 999,
      use_phonetic: true,
      use_levenshtein: true,
      use_ngram: true,
    });

    expect(state.rows[0]?.min_match_score).toBe(1);
    expect(state.rows[0]?.learn_threshold).toBe(0);
    expect(state.rows[0]?.ambiguity_threshold).toBe(1);
  });

  it('returns success=false on DB error', async () => {
    const db: any = () => {
      throw new Error('insert failed');
    };
    db.fn = { now: () => 'NOW()' };
    const result = await updateMatchConfig(db, {
      min_match_score: 0.6,
      learn_threshold: 0.8,
      ambiguity_threshold: 0.15,
      use_phonetic: true,
      use_levenshtein: true,
      use_ngram: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/insert failed/);
  });
});

/**
 * Match-config GET/PUT for the bank-import matcher.
 *
 * Faithful port of `get_match_config` and `update_match_config` in
 * `apps/bank_reconcile/api/routes.py:3046-3134`. The Python version
 * stores config in the per-company SQLite `bank_aliases.db` —
 * the SAM port stores it in the per-app DB instead (table:
 * `match_config`).
 *
 * If no row exists, returns built-in defaults — same fallback as
 * Python.
 */
import type { Knex } from 'knex';

export interface MatchConfig {
  min_match_score: number;
  learn_threshold: number;
  ambiguity_threshold: number;
  use_phonetic: boolean;
  use_levenshtein: boolean;
  use_ngram: boolean;
}

const DEFAULTS: MatchConfig = {
  min_match_score: 0.6,
  learn_threshold: 0.8,
  ambiguity_threshold: 0.15,
  use_phonetic: true,
  use_levenshtein: true,
  use_ngram: true,
};

export interface GetMatchConfigResponse {
  success: boolean;
  config: MatchConfig & Partial<{ id: number; updated_at: string }>;
  error?: string;
}

export async function getMatchConfig(
  appDb: Knex,
): Promise<GetMatchConfigResponse> {
  try {
    const row = (await appDb('match_config')
      .orderBy('id', 'desc')
      .first()) as
      | (Record<string, unknown> & {
          id: number;
          min_match_score: number | string;
          learn_threshold: number | string;
          ambiguity_threshold: number | string;
          use_phonetic: number | boolean;
          use_levenshtein: number | boolean;
          use_ngram: number | boolean;
        })
      | undefined;

    if (!row) {
      return { success: true, config: { ...DEFAULTS } };
    }

    return {
      success: true,
      config: {
        min_match_score: Number(row.min_match_score ?? DEFAULTS.min_match_score),
        learn_threshold: Number(row.learn_threshold ?? DEFAULTS.learn_threshold),
        ambiguity_threshold: Number(
          row.ambiguity_threshold ?? DEFAULTS.ambiguity_threshold,
        ),
        use_phonetic: !!row.use_phonetic,
        use_levenshtein: !!row.use_levenshtein,
        use_ngram: !!row.use_ngram,
        id: row.id,
        updated_at: row.updated_at as string | undefined,
      } as MatchConfig & Partial<{ id: number; updated_at: string }>,
    };
  } catch (err: any) {
    // Python returns success=true with built-in defaults on error.
    // Mirror that behaviour so the frontend always has usable values.
    return {
      success: true,
      config: { ...DEFAULTS },
      error: err?.message ?? String(err),
    };
  }
}

export interface UpdateMatchConfigInput {
  min_match_score: number;
  learn_threshold: number;
  ambiguity_threshold: number;
  use_phonetic: boolean;
  use_levenshtein: boolean;
  use_ngram: boolean;
}

export interface UpdateMatchConfigResponse {
  success: boolean;
  message?: string;
  error?: string;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export async function updateMatchConfig(
  appDb: Knex,
  input: UpdateMatchConfigInput,
): Promise<UpdateMatchConfigResponse> {
  try {
    const min = clamp01(input.min_match_score);
    const learn = clamp01(input.learn_threshold);
    const amb = clamp01(input.ambiguity_threshold);

    await appDb('match_config').insert({
      min_match_score: min,
      learn_threshold: learn,
      ambiguity_threshold: amb,
      use_phonetic: !!input.use_phonetic,
      use_levenshtein: !!input.use_levenshtein,
      use_ngram: !!input.use_ngram,
      updated_at: appDb.fn.now(),
    });

    return { success: true, message: 'Configuration updated' };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

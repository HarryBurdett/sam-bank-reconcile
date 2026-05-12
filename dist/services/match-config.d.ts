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
export interface GetMatchConfigResponse {
    success: boolean;
    config: MatchConfig & Partial<{
        id: number;
        updated_at: string;
    }>;
    error?: string;
}
export declare function getMatchConfig(appDb: Knex): Promise<GetMatchConfigResponse>;
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
export declare function updateMatchConfig(appDb: Knex, input: UpdateMatchConfigInput): Promise<UpdateMatchConfigResponse>;
//# sourceMappingURL=match-config.d.ts.map
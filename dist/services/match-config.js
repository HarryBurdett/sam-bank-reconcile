const DEFAULTS = {
    min_match_score: 0.6,
    learn_threshold: 0.8,
    ambiguity_threshold: 0.15,
    use_phonetic: true,
    use_levenshtein: true,
    use_ngram: true,
};
export async function getMatchConfig(appDb) {
    try {
        const row = (await appDb('match_config')
            .orderBy('id', 'desc')
            .first());
        if (!row) {
            return { success: true, config: { ...DEFAULTS } };
        }
        return {
            success: true,
            config: {
                min_match_score: Number(row.min_match_score ?? DEFAULTS.min_match_score),
                learn_threshold: Number(row.learn_threshold ?? DEFAULTS.learn_threshold),
                ambiguity_threshold: Number(row.ambiguity_threshold ?? DEFAULTS.ambiguity_threshold),
                use_phonetic: !!row.use_phonetic,
                use_levenshtein: !!row.use_levenshtein,
                use_ngram: !!row.use_ngram,
                id: row.id,
                updated_at: row.updated_at,
            },
        };
    }
    catch (err) {
        // Python returns success=true with built-in defaults on error.
        // Mirror that behaviour so the frontend always has usable values.
        return {
            success: true,
            config: { ...DEFAULTS },
            error: err?.message ?? String(err),
        };
    }
}
function clamp01(n) {
    if (!Number.isFinite(n))
        return 0;
    if (n < 0)
        return 0;
    if (n > 1)
        return 1;
    return n;
}
export async function updateMatchConfig(appDb, input) {
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
    }
    catch (err) {
        return { success: false, error: err?.message ?? String(err) };
    }
}
//# sourceMappingURL=match-config.js.map
/**
 * Opera unique ID generator — replicates the format Opera uses for
 * internal record correlation (e.g. ax_unique on anoml, nt_pstid on
 * ntran).
 *
 * Faithful port of `OperaUniqueIdGenerator`
 * (sql_rag/opera_sql_import.py:36-99).
 *
 * Format: '_XXXXXXXXX' — underscore prefix + 9 base-36 characters
 * derived from a millisecond timestamp + 8-bit sequence counter.
 * Sequence overflow waits for the next millisecond tick to avoid
 * collisions.
 *
 * Concurrency: Node is single-threaded per event loop, so no lock
 * is needed (vs Python's threading.Lock). All state lives in module
 * closure.
 */
/**
 * Generate one Opera-format unique ID. Thread-safe within a single
 * Node process.
 */
export declare function generateOperaUniqueId(): string;
/**
 * Generate `count` Opera-format unique IDs in one call. Faster than
 * looping `generateOperaUniqueId()` because the sequence is advanced
 * by 1 after each generate to keep ids distinct within the same
 * millisecond.
 */
export declare function generateOperaUniqueIds(count: number): string[];
/** Reset internal counters — for tests only. */
export declare function _resetForTests(): void;
//# sourceMappingURL=unique-id.d.ts.map
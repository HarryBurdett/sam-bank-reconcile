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
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
let _lastTime = 0;
let _sequence = 0;
function _generateOne() {
    let current = Date.now();
    if (current === _lastTime) {
        _sequence++;
        if (_sequence > 255) {
            // Wait for the next millisecond tick.
            // Node 18+ is single-threaded — busy-wait loop is acceptable
            // here because it only runs on sequence-overflow (very rare).
            while (Date.now() === _lastTime) {
                // spin
            }
            current = Date.now();
            _sequence = 0;
            _lastTime = current;
        }
    }
    else {
        _sequence = 0;
        _lastTime = current;
    }
    // (timestamp_ms << 8) | sequence — uses BigInt for the shift to
    // avoid 32-bit truncation on Node.
    const combined = (BigInt(current) << 8n) + BigInt(_sequence);
    let n = combined;
    const out = [];
    while (n > 0n) {
        out.push(CHARS[Number(n % 36n)]);
        n /= 36n;
    }
    // Pad to 9 chars (zero-fill front), take last 9
    const idStr = out.reverse().join('').padStart(9, '0').slice(-9);
    return `_${idStr}`;
}
/**
 * Generate one Opera-format unique ID. Thread-safe within a single
 * Node process.
 */
export function generateOperaUniqueId() {
    return _generateOne();
}
/**
 * Generate `count` Opera-format unique IDs in one call. Faster than
 * looping `generateOperaUniqueId()` because the sequence is advanced
 * by 1 after each generate to keep ids distinct within the same
 * millisecond.
 */
export function generateOperaUniqueIds(count) {
    const out = [];
    for (let i = 0; i < count; i++) {
        out.push(_generateOne());
        _sequence++;
    }
    return out;
}
/** Reset internal counters — for tests only. */
export function _resetForTests() {
    _lastTime = 0;
    _sequence = 0;
}
//# sourceMappingURL=unique-id.js.map
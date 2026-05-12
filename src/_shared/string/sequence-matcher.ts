/**
 * Ratcliff/Obershelp similarity ratio — port of Python's
 * `difflib.SequenceMatcher.ratio()`.
 *
 * Faithful port of CPython's `Lib/difflib.py` `SequenceMatcher`:
 *   - find_longest_match  → findLongestMatch
 *   - get_matching_blocks → getMatchingBlocks (queue-based)
 *   - ratio()             → sequenceMatcherRatio
 *
 * The autojunk heuristic isn't implemented — short strings (company
 * names, transaction descriptions) don't trigger it in practice.
 *
 * Used by gocardless suggest-match (customer-mandate matching) and
 * bank-reconcile suggest-account (statement-line → customer/supplier
 * matching). Single source of truth so both plugins agree on what
 * "similarity" means.
 */

interface MatchBlock {
  a: number;
  b: number;
  size: number;
}

function findLongestMatch(
  a: string,
  b: string,
  alo: number,
  ahi: number,
  blo: number,
  bhi: number,
): MatchBlock {
  const b2j = new Map<string, number[]>();
  for (let i = blo; i < bhi; i++) {
    const ch = b[i]!;
    const arr = b2j.get(ch);
    if (arr) arr.push(i);
    else b2j.set(ch, [i]);
  }

  let besti = alo;
  let bestj = blo;
  let bestsize = 0;
  let j2len = new Map<number, number>();

  for (let i = alo; i < ahi; i++) {
    const newJ2len = new Map<number, number>();
    const positions = b2j.get(a[i]!);
    if (positions) {
      for (const j of positions) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newJ2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
    }
    j2len = newJ2len;
  }
  return { a: besti, b: bestj, size: bestsize };
}

function getMatchingBlocks(a: string, b: string): MatchBlock[] {
  const queue: Array<[number, number, number, number]> = [
    [0, a.length, 0, b.length],
  ];
  const matches: MatchBlock[] = [];
  while (queue.length > 0) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const m = findLongestMatch(a, b, alo, ahi, blo, bhi);
    if (m.size > 0) {
      matches.push(m);
      if (alo < m.a && blo < m.b) {
        queue.push([alo, m.a, blo, m.b]);
      }
      if (m.a + m.size < ahi && m.b + m.size < bhi) {
        queue.push([m.a + m.size, ahi, m.b + m.size, bhi]);
      }
    }
  }
  matches.sort((x, y) => x.a - y.a || x.b - y.b);
  return matches;
}

export function sequenceMatcherRatio(a: string, b: string): number {
  if (!a && !b) return 1.0;
  const total = a.length + b.length;
  if (total === 0) return 0;
  const matches = getMatchingBlocks(a, b);
  let matched = 0;
  for (const m of matches) matched += m.size;
  return (2 * matched) / total;
}

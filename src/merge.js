// merge.js — line-level 3-way merge (diff3), the engine behind git-style pulls.
//
// Inputs are the three versions of a file:
//   base     = the content at the last sync (.overleaf/base/<path>)
//   local    = your working copy        (ours)
//   incoming = Overleaf right now        (theirs)
//
// We auto-merge regions only one side changed, and emit git-style conflict
// markers for regions BOTH sides changed differently. PURE / stdlib-only so the
// whole thing is unit-tested without a browser.

export const MARK_START = "<<<<<<<";
export const MARK_MID = "=======";
export const MARK_END = ">>>>>>>";

const MAX_LINES = 6000; // beyond this the O(n*m) LCS table gets heavy -> whole-file conflict

function splitLines(s) {
  // strip a single trailing newline so a doc that only differs by it doesn't
  // look like a changed last line; re-joining never re-adds it.
  return String(s == null ? "" : s).replace(/\n$/, "").split("\n");
}

function eq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** LCS of two line arrays -> list of [i,j] matched index pairs (increasing in both). */
function lcsPairs(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i], next = dp[i + 1];
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1] + 1 : Math.max(next[j], row[j + 1]);
    }
  }
  const pairs = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/**
 * Diff base->side as change hunks that partition only the CHANGED base ranges:
 *   { baseLo, baseHi, repl: [lines] }  — base[baseLo..baseHi) becomes `repl`.
 * Matched (unchanged) lines are the gaps between hunks. A pure insertion is a
 * zero-width hunk (baseLo === baseHi).
 */
function diffHunks(base, side) {
  const pairs = lcsPairs(base, side);
  const hunks = [];
  let pb = 0, ps = 0;
  for (const [bi, si] of pairs) {
    if (bi > pb || si > ps) hunks.push({ baseLo: pb, baseHi: bi, repl: side.slice(ps, si) });
    pb = bi + 1; ps = si + 1;
  }
  if (pb < base.length || ps < side.length) hunks.push({ baseLo: pb, baseHi: base.length, repl: side.slice(ps) });
  return hunks;
}

/**
 * 3-way merge. Returns { clean, text, conflicts:[{local,incoming}] }.
 * Auto-merges regions only ONE side changed (even if the two sides' edits are on
 * different lines), and emits git-style markers only where the two sides changed
 * the SAME base region differently.
 */
export function merge3(baseText, localText, incomingText, opts = {}) {
  const localLabel = opts.localLabel || "LOCAL (yours)";
  const incomingLabel = opts.incomingLabel || "OVERLEAF (theirs)";
  const base = splitLines(baseText), local = splitLines(localText), incoming = splitLines(incomingText);

  if (eq(local, incoming)) return { clean: true, text: local.join("\n"), conflicts: [] };
  if (eq(base, local)) return { clean: true, text: incoming.join("\n"), conflicts: [] };
  if (eq(base, incoming)) return { clean: true, text: local.join("\n"), conflicts: [] };
  if (base.length + local.length > MAX_LINES * 2 || base.length + incoming.length > MAX_LINES * 2) {
    return {
      clean: false,
      text: [MARK_START + " " + localLabel, ...local, MARK_MID, ...incoming, MARK_END + " " + incomingLabel].join("\n"),
      conflicts: [{ local, incoming }],
    };
  }

  const h1 = diffHunks(base, local);
  const h2 = diffHunks(base, incoming);

  // Reconstruct a side's lines for base range [lo,hi) by replaying its hunks[from..to).
  const reconstruct = (hunks, from, to, lo, hi) => {
    const res = [];
    let bi = lo, k = from;
    while (bi < hi) {
      if (k < to && hunks[k].baseLo === bi) { res.push(...hunks[k].repl); bi = hunks[k].baseHi; k++; }
      else { res.push(base[bi]); bi++; }
    }
    while (k < to && hunks[k].baseLo === bi && hunks[k].baseLo === hunks[k].baseHi) { res.push(...hunks[k].repl); k++; }
    return res;
  };

  const out = [];
  const conflicts = [];
  let clean = true;
  let i = 0, p = 0, q = 0;

  while (i < base.length || p < h1.length || q < h2.length) {
    const aLo = p < h1.length ? h1[p].baseLo : Infinity;
    const bLo = q < h2.length ? h2[q].baseLo : Infinity;
    const nextChange = Math.min(aLo, bLo);
    if (i < nextChange) { out.push(...base.slice(i, Math.min(nextChange, base.length))); i = Math.min(nextChange, base.length); }
    if (nextChange === Infinity) break;

    // Window starts at i. Seed with hunks beginning exactly here, then expand to
    // cover any hunks from EITHER side that strictly overlap the window.
    let lo = i, hi = i, cp = p, cq = q;
    while (cp < h1.length && h1[cp].baseLo === lo) { hi = Math.max(hi, h1[cp].baseHi); cp++; }
    while (cq < h2.length && h2[cq].baseLo === lo) { hi = Math.max(hi, h2[cq].baseHi); cq++; }
    let grew = true;
    while (grew) {
      grew = false;
      while (cp < h1.length && h1[cp].baseLo < hi) { hi = Math.max(hi, h1[cp].baseHi); cp++; grew = true; }
      while (cq < h2.length && h2[cq].baseLo < hi) { hi = Math.max(hi, h2[cq].baseHi); cq++; grew = true; }
    }

    const localHas = cp > p, incomingHas = cq > q;
    const lSeg = reconstruct(h1, p, cp, lo, hi);
    const iSeg = reconstruct(h2, q, cq, lo, hi);
    if (localHas && !incomingHas) out.push(...lSeg);
    else if (!localHas && incomingHas) out.push(...iSeg);
    else if (eq(lSeg, iSeg)) out.push(...lSeg);
    else {
      clean = false;
      conflicts.push({ local: lSeg, incoming: iSeg });
      out.push(MARK_START + " " + localLabel, ...lSeg, MARK_MID, ...iSeg, MARK_END + " " + incomingLabel);
    }
    i = hi; p = cp; q = cq;
  }

  return { clean, text: out.join("\n"), conflicts };
}

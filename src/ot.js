// ot.js — pure helpers for OT char-offset math, line mapping, and applying ops.
//
// Overleaf docs are line arrays; comment/range anchors are CHARACTER offsets
// into the doc text (lines joined by "\n"). These helpers are stdlib-only and
// unit-tested (test/run.js).

/** Join Overleaf's line array into the full document text. */
export function docText(lines) {
  return Array.isArray(lines) ? lines.join("\n") : String(lines ?? "");
}

/**
 * Map a 0-based character offset to { line, col } (both 1-based) in `text`.
 * Offsets past the end clamp to the last position.
 */
export function offsetToLineCol(text, offset) {
  const n = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let last = 0; // index just after the previous newline
  for (let i = 0; i < n; i++) {
    if (text[i] === "\n") {
      line++;
      last = i + 1;
    }
  }
  return { line, col: n - last + 1 };
}

/** The text occupying [offset, offset+length) — what a comment is anchored to. */
export function sliceAt(text, offset, length) {
  const start = Math.max(0, Math.min(offset, text.length));
  return text.slice(start, start + Math.max(0, length || 0));
}

/**
 * Apply Overleaf OT ops to a string (used by the OL->local monitor).
 * Op shapes: insert { i:string, p:number }, delete { d:string, p:number }.
 * Applies in array order; positions are relative to the evolving string.
 */
export function applyOps(text, ops) {
  let out = text;
  for (const op of ops || []) {
    if (op == null) continue;
    const p = op.p | 0;
    if (typeof op.i === "string") {
      out = out.slice(0, p) + op.i + out.slice(p);
    } else if (typeof op.d === "string") {
      // Only delete if the doc actually has that text there; otherwise the
      // position drifted (wrong doc / stale base) and deleting would corrupt —
      // skip rather than mangle.
      if (out.slice(p, p + op.d.length) === op.d) {
        out = out.slice(0, p) + out.slice(p + op.d.length);
      }
    }
    // { p } with neither i nor d is a retain/cursor — ignore for content.
  }
  return out;
}

/**
 * Would `ops` apply CLEANLY to `text`? (Every insert position in range, every
 * delete matching the text it claims to remove.) Used to disambiguate which doc
 * a remote op belongs to when the broadcast carries no doc id — a clean apply is
 * strong evidence it's the right doc; otherwise we re-join to resync.
 */
export function opApplies(text, ops) {
  if (!Array.isArray(ops)) return false;
  let out = text;
  for (const op of ops) {
    if (op == null) continue;
    const p = op.p | 0;
    if (typeof op.i === "string") {
      if (p < 0 || p > out.length) return false;
      out = out.slice(0, p) + op.i + out.slice(p);
    } else if (typeof op.d === "string") {
      if (p < 0 || p + op.d.length > out.length || out.slice(p, p + op.d.length) !== op.d) return false;
      out = out.slice(0, p) + out.slice(p + op.d.length);
    }
    // comment {c,p,t} / retain {p}: no text constraint
  }
  return true;
}

/**
 * Does an OT op (insert/delete at position p) overlap a comment range
 * [start, start+len)? Used by write-back to detect comment-anchor risk.
 * - A delete that removes any character inside the range overlaps.
 * - An insert strictly inside the range is non-destructive (range grows) ->
 *   not flagged; an insert exactly at a boundary is safe too.
 */
export function opHitsRange(op, start, len) {
  const end = start + Math.max(0, len || 0);
  const p = op.p | 0;
  if (typeof op.d === "string") {
    const dEnd = p + op.d.length;
    return p < end && dEnd > start; // delete interval intersects the range
  }
  return false; // pure inserts don't collapse an anchor
}

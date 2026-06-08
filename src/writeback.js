// writeback.js — local -> Overleaf. The content path uses MINIMAL-DIFF OT ops
// (never a whole-document replace), which is what preserves comment anchors for
// edits outside commented spans. computeOps() and detectCommentConflicts() are
// PURE and unit-tested. submitOps() is the Phase-3 live step.

import { opHitsRange } from "./ot.js";
import { extractComments } from "./comments.js";

/**
 * Smallest-edit op set between two strings via common prefix/suffix trim.
 * Returns [] when equal, else a delete of the changed middle + an insert of the
 * new middle (positions are absolute char offsets in `oldText`). Keeping it to
 * the changed region means untouched (and commented) text is never re-sent.
 */
export function computeOps(oldText, newText) {
  if (oldText === newText) return [];
  const a = oldText;
  const b = newText;
  let s = 0;
  const min = Math.min(a.length, b.length);
  while (s < min && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  const ops = [];
  const deleted = a.slice(s, ea);
  const inserted = b.slice(s, eb);
  if (deleted) ops.push({ d: deleted, p: s });
  if (inserted) ops.push({ i: inserted, p: s });
  return ops;
}

/**
 * Find ops that would collapse a comment anchor (delete chars inside a comment
 * range). Returns [{ op, comment }] for surfacing to the user before applying.
 */
export function detectCommentConflicts(ops, ranges) {
  const comments = extractComments(ranges);
  const hits = [];
  for (const op of ops) {
    for (const c of comments) {
      if (opHitsRange(op, c.offset, c.length)) hits.push({ op, comment: c });
    }
  }
  return hits;
}

/**
 * Plan comment re-anchors for an edit that collapses comment anchors.
 *
 * When the content edit replaces [p, p+deleted) with `inserted`, the overlapping
 * comments detach server-side. We re-attach each affected thread (by reusing its
 * threadId) to the changed region of the NEW text, so the conversation isn't lost
 * — submitting `{c, p, t}` after the content op re-creates the comment range.
 *
 * @param ops        the content ops from computeOps ([{d,p}] and/or [{i,p}])
 * @param conflicts  detectCommentConflicts() output ([{op, comment}])
 * @param newText    the post-edit document text
 * @returns [{ t: threadId, c: anchorText, p: anchorPos }] (deduped by thread)
 */
export function planReanchors(ops, conflicts, newText) {
  if (!conflicts || !conflicts.length) return [];
  const ins = (ops || []).find((o) => typeof o.i === "string");
  const del = (ops || []).find((o) => typeof o.d === "string");
  const p = ((ins || del || {}).p | 0);
  const inserted = ins ? ins.i : "";

  let c, anchorP;
  if (inserted) {
    // anchor to the replacement text
    c = inserted;
    anchorP = p;
  } else if (p < newText.length) {
    // pure deletion: anchor to the single char now at the deletion point
    c = newText.slice(p, p + 1);
    anchorP = p;
  } else if (newText.length) {
    c = newText.slice(newText.length - 1);
    anchorP = newText.length - 1;
  } else {
    return []; // empty doc — nothing to anchor to
  }

  const seen = new Set();
  const out = [];
  for (const { comment } of conflicts) {
    const t = comment && comment.threadId;
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push({ t, c, p: anchorP });
  }
  return out;
}

/**
 * PHASE 3 (live): submit OT ops through the page's own authenticated socket via
 * the inject.js hook — `applyOtUpdate [docId, {op, v}]`, the same event Overleaf's
 * editor sends. Reusing the live socket inherits auth and the server-side OT/
 * ranges transform, so comment anchors are maintained server-side.
 *
 * Returns the ack body (or null for an empty op set). A version mismatch /
 * rejection surfaces as a thrown error or an error-shaped ack, so the caller can
 * re-sync rather than drift. `ops` is our [{d,p},{i,p}] shape (== sharejs text-ot).
 */
export async function submitOps(page, docId, ops, version) {
  if (!Array.isArray(ops) || ops.length === 0) return { ack: null, version: null };
  return page.evaluate(
    async ({ docId, payload }) => {
      if (!window.__olsyncRequest) throw new Error("socket hook not active");
      const ack = await window.__olsyncRequest("applyOtUpdate", [docId, payload]);
      // The server confirms OUR op with a sender-form `otUpdateApplied [{v}]` —
      // a single arg object with a numeric v and no op/doc. v is the version the
      // op was applied AT (the server TRANSFORMS a stale op and applies it at the
      // current version), so the next op goes at v+1. We read it back to keep the
      // version exact. Remote edits arrive as [docId,{op,v}] and are ignored here.
      await new Promise((r) => setTimeout(r, 700));
      let confirmed = null;
      for (const args of window.__olsyncDrainEdits ? window.__olsyncDrainEdits() : []) {
        if (
          Array.isArray(args) && args.length === 1 &&
          args[0] && typeof args[0] === "object" &&
          typeof args[0].v === "number" && args[0].op === undefined
        ) {
          confirmed = args[0].v; // most recent sender confirmation
        }
      }
      return { ack, version: confirmed };
    },
    { docId, payload: { op: ops, v: version } }
  );
}

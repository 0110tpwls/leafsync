// review.js — `leafsync review`: a git-diff-style preview of local vs Overleaf
// before you push. Classifies each file using the 3-way base and renders unified
// diffs grouped by direction. PURE (no fs/network) so it's unit-tested.

import { unifiedDiff } from "./merge.js";

/**
 * Classify one file from its three versions.
 *   insync   local === overleaf (nothing to do)
 *   outgoing only local changed   -> your edits would push to Overleaf
 *   incoming only Overleaf changed -> would arrive on next pull
 *   conflict both changed          -> needs a merge/resolve
 *   differs  no baseline yet (can't tell direction)
 */
export function reviewStatus(base, local, overleaf) {
  if (local === overleaf) return "insync";
  if (base == null) return "differs";
  const localChanged = local !== base;
  const overleafChanged = overleaf !== base;
  if (localChanged && !overleafChanged) return "outgoing";
  if (!localChanged && overleafChanged) return "incoming";
  return "conflict";
}

/**
 * Render a review report.
 * @param items [{ path, base|null, local, overleaf }]
 * @param opts  { stat: names-only }
 */
export function renderReview(items, { stat = false } = {}) {
  const groups = { outgoing: [], incoming: [], conflict: [], differs: [] };
  let insync = 0;
  for (const it of items) {
    const st = reviewStatus(it.base, it.local, it.overleaf);
    if (st === "insync") { insync++; continue; }
    groups[st].push(it);
  }

  const out = [];
  out.push(
    `review: ${groups.outgoing.length} outgoing, ${groups.incoming.length} incoming, ` +
      `${groups.conflict.length} conflict, ${insync} in sync` +
      (groups.differs.length ? `, ${groups.differs.length} unbaselined` : "")
  );

  const section = (title, key, aSel, bSel, aLabel, bLabel) => {
    const arr = groups[key];
    if (!arr.length) return;
    out.push("", `## ${title} (${arr.length})`);
    for (const it of arr) {
      if (stat) { out.push(`  ${it.path}`); continue; }
      out.push("", `### ${it.path}`);
      const d = unifiedDiff(aSel(it), bSel(it), { aLabel, bLabel });
      out.push(d || "  (differs only in trailing whitespace)");
    }
  };

  // outgoing: overleaf -> local, so '+' lines are what your push would add
  section("OUTGOING — would push to Overleaf", "outgoing", (it) => it.overleaf, (it) => it.local, "overleaf", "local");
  section("INCOMING — would arrive on next pull", "incoming", (it) => it.local, (it) => it.overleaf, "local", "overleaf");
  section("CONFLICT — changed on both sides", "conflict", (it) => it.local, (it) => it.overleaf, "local", "overleaf");
  section("DIFFERS — no baseline yet (run pull once)", "differs", (it) => it.overleaf, (it) => it.local, "overleaf", "local");

  if (out.length === 1) out.push("", "everything is in sync.");
  return out.join("\n") + "\n";
}

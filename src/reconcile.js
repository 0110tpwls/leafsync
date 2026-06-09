// reconcile.js — make `pull` safe and git-like: never silently overwrite local.
//
// Three inputs per file (git's merge inputs):
//   base     = .overleaf/base/<path>  (content at the last sync — the merge base)
//   local    = the file on disk        (ours)
//   incoming = the ZIP/joinDoc content (theirs = Overleaf now)
//
//   no local file                 -> write   (new)
//   local == incoming             -> nothing (in sync)
//   local == base                 -> write   (fast-forward; you didn't touch it)
//   incoming == base              -> KEEP local (your edit; remote unchanged)
//   all three differ (text)       -> 3-WAY MERGE: auto-merge if the changes don't
//                                    overlap; otherwise keep local live + record a
//                                    CONFLICT (git-style markers in .overleaf/).
//   all three differ (binary/no base) -> keep local, stash incoming sidecar
//
// `--force` restores clobber-everything. The base shadow (`.overleaf/base/`) is
// what lets us auto-merge and stash like git. Stdlib only.

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { merge3, MARK_START, MARK_MID, MARK_END } from "./merge.js";

export function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export async function readManifest(stateDir) {
  try {
    const j = JSON.parse(await readFile(path.join(stateDir, "manifest.json"), "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

export async function writeManifest(stateDir, manifest) {
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

// --- base shadow (merge base) + conflict artifacts ---
export function baseDir(stateDir) { return path.join(stateDir, "base"); }
export function conflictsDir(stateDir) { return path.join(stateDir, "conflicts"); }

export async function readBaseContent(stateDir, name) {
  try { return await readFile(path.join(baseDir(stateDir), name)); } catch { return null; }
}
export async function writeBaseContent(stateDir, name, buf) {
  const dest = path.join(baseDir(stateDir), name);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, buf);
}
function isBinaryBuf(buf) {
  return Buffer.isBuffer(buf) && buf.includes(0); // NUL byte -> treat as binary (don't merge)
}

/**
 * Reconcile incoming entries against local + the base shadow.
 * `dryRun` classifies every file (created/updated/merged/kept/conflict) WITHOUT
 * touching the disk — used by `pull --dry-run` to preview.
 */
export async function reconcile({ mirrorDir, entries, manifest, force = false, log = () => {}, stateDir = null, dryRun = false }) {
  const result = { created: [], updated: [], inSync: [], kept: [], merged: [], conflicts: [] };
  const next = { ...manifest };
  const conflictRecords = []; // { path } — full state lives in .overleaf/conflicts/
  const put = dryRun ? async () => {} : writeFile;
  const md = dryRun ? async () => {} : mkdir;

  for (const e of entries) {
    const dest = path.join(mirrorDir, e.name);
    const incoming = e.data;
    const incomingHash = sha256(incoming);
    const exists = existsSync(dest);
    const recordBase = async () => { if (stateDir && !dryRun) await writeBaseContent(stateDir, e.name, incoming); };

    if (!exists) {
      await md(path.dirname(dest), { recursive: true });
      await put(dest, incoming);
      next[e.name] = incomingHash; await recordBase();
      result.created.push(e.name);
      continue;
    }

    const localBuf = await readFile(dest);
    const localHash = sha256(localBuf);
    const baseHash = manifest[e.name];

    if (force) {
      await put(dest, incoming); next[e.name] = incomingHash; await recordBase();
      (localHash !== incomingHash ? result.updated : result.inSync).push(e.name);
      continue;
    }

    if (localHash === incomingHash) {
      next[e.name] = incomingHash; await recordBase(); result.inSync.push(e.name);
    } else if (localHash === baseHash) {
      await put(dest, incoming); next[e.name] = incomingHash; await recordBase(); result.updated.push(e.name);
    } else if (baseHash !== undefined && incomingHash === baseHash) {
      result.kept.push(e.name); // local edit, Overleaf unchanged -> keep local (pending push)
    } else {
      // changed on BOTH sides -> try a real 3-way merge.
      const baseContent = stateDir ? await readBaseContent(stateDir, e.name) : null;
      const mergeable = baseContent != null && !isBinaryBuf(incoming) && !isBinaryBuf(localBuf);
      if (mergeable) {
        const m = merge3(baseContent.toString("utf8"), localBuf.toString("utf8"), incoming.toString("utf8"));
        if (m.clean) {
          // auto-merged: local now carries both sides' changes -> base advances to
          // Overleaf's version, and the merged result is a pending push.
          await put(dest, m.text, "utf8");
          next[e.name] = sha256(Buffer.from(m.text, "utf8"));
          await recordBase();
          result.merged.push(e.name);
          continue;
        }
        // true conflict: keep LOCAL in the live file (so it still compiles and the
        // markers never get pushed); write the markered version + theirs to
        // .overleaf/conflicts/ for review/resolve. Baseline stays until resolved.
        if (!dryRun) await writeConflictFiles(stateDir, e.name, m.text, incoming);
        conflictRecords.push({ path: e.name });
        result.conflicts.push({ path: e.name, conflictFile: path.join(conflictsDir(stateDir), e.name) });
      } else {
        const side = dest + ".overleaf-incoming";
        await put(side, incoming);
        result.conflicts.push({ path: e.name, incoming: side });
      }
    }
  }

  if (stateDir && !dryRun) await writeConflictReport(stateDir, conflictRecords);
  return { result, manifest: next };
}

export async function writeConflictFiles(stateDir, name, markeredText, incomingBuf) {
  const markered = path.join(conflictsDir(stateDir), name);
  await mkdir(path.dirname(markered), { recursive: true });
  await writeFile(markered, markeredText, "utf8");
  await writeFile(markered + ".theirs", incomingBuf); // Overleaf's version, for `resolve --theirs`
}

/** Rewrite .overleaf/conflicts.json + CONFLICTS.md from the current conflict set. */
export async function writeConflictReport(stateDir, records) {
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "conflicts.json"), JSON.stringify(records, null, 2) + "\n");
  if (!records.length) {
    await rm(path.join(stateDir, "CONFLICTS.md"), { force: true });
    return;
  }
  const lines = [];
  lines.push("# Overleaf sync conflicts");
  lines.push("");
  lines.push(`${records.length} file(s) changed on BOTH your machine and Overleaf and could not auto-merge.`);
  lines.push("");
  lines.push("Resolve them with:");
  lines.push("```");
  lines.push("leafsync resolve            # interactive: ours / theirs / edit, per file");
  lines.push("```");
  lines.push("`ours` keeps your local version, `theirs` takes Overleaf's, `edit` opens the");
  lines.push("marked-up file below so you can hand-merge. Conflict regions are wrapped in");
  lines.push("`<<<<<<<` / `=======` / `>>>>>>>` markers (git style).");
  lines.push("");
  for (const r of records) {
    const markered = path.join(conflictsDir(stateDir), r.path);
    lines.push(`## ${r.path}`);
    lines.push("");
    lines.push("marked-up file: `" + path.relative(path.dirname(stateDir), markered) + "`");
    lines.push("");
    let preview = "";
    try { preview = await previewConflicts(markered); } catch { /* ignore */ }
    if (preview) { lines.push("```"); lines.push(preview); lines.push("```"); lines.push(""); }
  }
  await writeFile(path.join(stateDir, "CONFLICTS.md"), lines.join("\n") + "\n");
}

/** Extract just the conflict hunks (with markers + a little context) for the report. */
async function previewConflicts(markeredPath) {
  const text = await readFile(markeredPath, "utf8");
  const lines = text.split("\n");
  const out = [];
  let inHunk = false, shown = 0;
  for (let i = 0; i < lines.length && shown < 3; i++) {
    const l = lines[i];
    if (l.startsWith(MARK_START)) { inHunk = true; }
    if (inHunk) out.push(l);
    if (l.startsWith(MARK_END)) { inHunk = false; shown++; out.push("…"); }
  }
  return out.join("\n").trim();
}

/** One-line, user-facing summary of a reconcile result. */
export function summarize(result) {
  const n = (a) => a.length;
  return (
    `${n(result.created)} new, ${n(result.updated)} updated, ${n(result.inSync)} unchanged, ` +
    `${n(result.merged)} auto-merged, ${n(result.kept)} kept (local edits), ${n(result.conflicts)} conflict(s)`
  );
}

// resolve.js — git-style conflict resolution + stash for local<->Overleaf sync.
//
// Conflicts produced by reconcile() live under .overleaf/:
//   conflicts.json            [{ path }]            — the open conflict set
//   conflicts/<path>          file WITH <<<<<<< ======= >>>>>>> markers (edit this)
//   conflicts/<path>.theirs   Overleaf's version    (for `resolve --theirs`)
//   base/<path>               the merge base (last sync)
// The LIVE file always holds YOUR version while a conflict is open, so it still
// compiles and never pushes markers to Overleaf.

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import {
  baseDir, conflictsDir, sha256, writeBaseContent, writeConflictReport, writeConflictFiles,
} from "./reconcile.js";
import { merge3 } from "./merge.js";

export async function listConflicts(stateDir) {
  try {
    const j = JSON.parse(await readFile(path.join(stateDir, "conflicts.json"), "utf8"));
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

/**
 * Apply one resolution. choice ∈ 'ours' | 'theirs' | 'merged'.
 *   ours   -> keep the live (local) file; base advances to Overleaf's version, so
 *             your version becomes a pending push.
 *   theirs -> overwrite live with Overleaf's version; now in sync.
 *   merged -> take the hand-edited marked-up file (markers removed) as the result.
 * Returns { path, choice, baseHash } so the caller can update the manifest.
 */
export async function resolveConflict(stateDir, mirrorDir, p, choice) {
  const live = path.join(mirrorDir, p);
  const markered = path.join(conflictsDir(stateDir), p);
  const theirsPath = markered + ".theirs";
  const theirs = existsSync(theirsPath) ? await readFile(theirsPath) : null;
  if (theirs == null) throw new Error(`missing Overleaf copy for ${p} (re-run \`pull\`)`);

  if (choice === "theirs") {
    await mkdir(path.dirname(live), { recursive: true });
    await writeFile(live, theirs);
  } else if (choice === "merged") {
    const edited = await readFile(markered, "utf8");
    if (edited.includes("<<<<<<<") || edited.includes(">>>>>>>")) {
      throw new Error(`conflict markers still present — remove them in ${path.relative(path.dirname(stateDir), markered)} first`);
    }
    await writeFile(live, edited, "utf8");
  } // 'ours' -> leave the live file as-is

  await writeBaseContent(stateDir, p, theirs); // base := the Overleaf version we resolved against
  await rm(markered, { force: true });
  await rm(theirsPath, { force: true });
  return { path: p, choice, baseHash: sha256(theirs) };
}

/** Resolve every open conflict the same way (non-interactive). */
export async function resolveAll(stateDir, mirrorDir, choice) {
  const conflicts = await listConflicts(stateDir);
  const patch = {};
  const resolved = [];
  for (const c of conflicts) {
    const r = await resolveConflict(stateDir, mirrorDir, c.path, choice);
    patch[c.path] = r.baseHash;
    resolved.push(c.path);
  }
  await writeConflictReport(stateDir, []);
  return { resolved, patch };
}

/** Interactive per-file resolution (TTY only). */
export async function interactiveResolve(stateDir, mirrorDir, { editor } = {}) {
  const conflicts = await listConflicts(stateDir);
  if (!conflicts.length) return { resolved: [], patch: {}, skipped: [] };
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  const remaining = [];
  const resolved = [], patch = {};
  try {
    for (const c of conflicts) {
      const ans = (await ask(`\n${c.path}: keep (o)urs / take (t)heirs / (e)dit / (s)kip ? `)).trim().toLowerCase();
      const choose = async (ch) => { const r = await resolveConflict(stateDir, mirrorDir, c.path, ch); resolved.push(c.path); patch[c.path] = r.baseHash; };
      try {
        if (ans === "o" || ans === "ours") await choose("ours");
        else if (ans === "t" || ans === "theirs") await choose("theirs");
        else if (ans === "e" || ans === "edit") {
          const ed = editor || process.env.EDITOR || process.env.VISUAL || "vi";
          spawnSync(ed, [path.join(conflictsDir(stateDir), c.path)], { stdio: "inherit" });
          await choose("merged");
        } else { remaining.push(c); }
      } catch (err) { console.log(`  ${err.message} — left unresolved`); remaining.push(c); }
    }
  } finally { rl.close(); }
  await writeConflictReport(stateDir, remaining);
  return { resolved, patch, skipped: remaining.map((c) => c.path) };
}

// --- stash (git stash / stash pop) ---
function stashFile(stateDir) { return path.join(stateDir, "stash.json"); }
function stashDir(stateDir) { return path.join(stateDir, "stash"); }

export async function hasStash(stateDir) {
  try { const j = JSON.parse(await readFile(stashFile(stateDir), "utf8")); return Array.isArray(j) && j.length > 0; }
  catch { return false; }
}

/**
 * Save local modifications (files where live != base) and revert the live files
 * to base, so a subsequent `pull` fast-forwards cleanly. Mirrors `git stash`.
 */
export async function stashSave(stateDir, mirrorDir, manifest) {
  if (await hasStash(stateDir)) throw new Error("a stash already exists; `stash pop` it first");
  const entries = [];
  for (const name of Object.keys(manifest)) {
    const live = path.join(mirrorDir, name);
    if (!existsSync(live)) continue;
    const localBuf = await readFile(live);
    if (sha256(localBuf) === manifest[name]) continue; // unmodified vs base
    const basePath = path.join(baseDir(stateDir), name);
    if (!existsSync(basePath)) continue; // no base content to revert to
    const baseBuf = await readFile(basePath);
    const sPath = path.join(stashDir(stateDir), name);
    await mkdir(path.dirname(sPath), { recursive: true });
    await writeFile(sPath, localBuf);          // your saved work
    await writeFile(sPath + ".base", baseBuf); // base at stash time (merge base for pop)
    await writeFile(live, baseBuf);            // revert live to base
    entries.push({ path: name });
  }
  await mkdir(stateDir, { recursive: true });
  await writeFile(stashFile(stateDir), JSON.stringify(entries, null, 2) + "\n");
  return entries.map((e) => e.path);
}

/**
 * Re-apply stashed changes on top of the current (post-pull) state via 3-way
 * merge: base = base-at-stash, ours = stashed, theirs = current live. Clean merges
 * are written; overlaps become conflicts (resolve them like any other).
 */
export async function stashPop(stateDir, mirrorDir) {
  let entries = [];
  try { entries = JSON.parse(await readFile(stashFile(stateDir), "utf8")); } catch { /* none */ }
  if (!Array.isArray(entries) || !entries.length) throw new Error("no stash to pop");
  const popped = [], conflicts = [];
  const conflictRecords = await listConflicts(stateDir);
  for (const e of entries) {
    const sPath = path.join(stashDir(stateDir), e.path);
    if (!existsSync(sPath)) continue;
    const stashed = await readFile(sPath, "utf8");
    const stashBase = existsSync(sPath + ".base") ? await readFile(sPath + ".base", "utf8") : "";
    const live = path.join(mirrorDir, e.path);
    const current = existsSync(live) ? await readFile(live, "utf8") : "";
    const m = merge3(stashBase, stashed, current);
    if (m.clean) {
      await mkdir(path.dirname(live), { recursive: true });
      await writeFile(live, m.text, "utf8");
      popped.push(e.path);
    } else {
      await writeFile(live, stashed, "utf8"); // keep YOUR stashed work live
      await writeConflictFiles(stateDir, e.path, m.text, Buffer.from(current, "utf8"));
      conflictRecords.push({ path: e.path });
      conflicts.push(e.path);
    }
    await rm(sPath, { force: true });
    await rm(sPath + ".base", { force: true });
  }
  await writeFile(stashFile(stateDir), JSON.stringify([], null, 2) + "\n");
  if (conflicts.length) await writeConflictReport(stateDir, conflictRecords);
  return { popped, conflicts };
}

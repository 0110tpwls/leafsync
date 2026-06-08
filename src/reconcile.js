// reconcile.js — make `pull` safe: never silently overwrite local edits.
//
// A plain ZIP extract is `cp -f`: it clobbers any local change you hadn't
// pushed. Instead we keep a BASELINE manifest (sha256 per file, = the Overleaf
// content at the last pull) and do a 3-way reconcile per file, the way git does:
//
//   base = manifest[path]   (last-pulled Overleaf hash)
//   local = hash(file on disk)
//   incoming = hash(ZIP entry)
//
//   no local file              -> write   (new)
//   local == incoming          -> nothing (already in sync)
//   local == base              -> write   (fast-forward; you didn't touch it)
//   local != base, incoming==base -> KEEP local (your edit; remote unchanged)
//   local != base, incoming!=base -> CONFLICT: keep local, stash incoming as
//                                    <file>.overleaf-incoming, leave base
//
// `--force` restores the old clobber-everything behaviour. Stdlib only.

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

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

/**
 * Reconcile incoming ZIP entries against the local tree + baseline manifest.
 * @param entries [{ name, data:Buffer }] (files only, no dirs)
 * @returns { result, manifest } — result groups paths by outcome; manifest is
 *          the updated baseline to persist.
 */
export async function reconcile({ mirrorDir, entries, manifest, force = false, log = () => {} }) {
  const result = { created: [], updated: [], inSync: [], kept: [], conflicts: [] };
  const next = { ...manifest };

  for (const e of entries) {
    const dest = path.join(mirrorDir, e.name);
    const incoming = e.data;
    const incomingHash = sha256(incoming);
    const exists = existsSync(dest);

    if (!exists) {
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, incoming);
      next[e.name] = incomingHash;
      result.created.push(e.name);
      continue;
    }

    const localHash = sha256(await readFile(dest));
    const baseHash = manifest[e.name];

    if (force) {
      await writeFile(dest, incoming);
      next[e.name] = incomingHash;
      if (localHash !== incomingHash) result.updated.push(e.name);
      else result.inSync.push(e.name);
      continue;
    }

    if (localHash === incomingHash) {
      next[e.name] = incomingHash; // identical content; record baseline
      result.inSync.push(e.name);
    } else if (localHash === baseHash) {
      // Local untouched since last pull -> fast-forward to Overleaf.
      await writeFile(dest, incoming);
      next[e.name] = incomingHash;
      result.updated.push(e.name);
    } else if (baseHash !== undefined && incomingHash === baseHash) {
      // Local edited, Overleaf unchanged -> keep the local edit (pending push).
      result.kept.push(e.name);
      // baseline stays baseHash
    } else {
      // Changed on BOTH sides (or no baseline) -> conflict. Never destroy local.
      const side = dest + ".overleaf-incoming";
      await writeFile(side, incoming);
      result.conflicts.push({ path: e.name, incoming: side });
      // leave baseline as-is so the conflict keeps surfacing until resolved
    }
  }

  return { result, manifest: next };
}

/** One-line, user-facing summary of a reconcile result. */
export function summarize(result) {
  const n = (a) => a.length;
  return (
    `${n(result.created)} new, ${n(result.updated)} updated, ${n(result.inSync)} unchanged, ` +
    `${n(result.kept)} kept (local edits), ${n(result.conflicts)} conflict(s)`
  );
}

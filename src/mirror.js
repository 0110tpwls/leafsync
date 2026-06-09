// mirror.js — turn an Overleaf project tree into local files.
//
// processProjectStructure() is PURE (unit-tested). pullProject() drives the
// live page: it captures the project tree from the joinProjectResponse frame
// (via CDP) and downloads ALL content in one authenticated "Download as ZIP"
// request, then extracts it to the mirror dir. (The docstore REST route 404s on
// www.overleaf.com and per-doc socket joinDoc can't be sent from a passive CDP
// sniff, so the ZIP is the robust content path.) Comment RANGES are not in the
// ZIP and still need the socket joinDoc — tracked as a follow-up.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzip, stripCommonRoot } from "./unzip.js";
import { findRanges } from "./socketio.js";
import { reconcile, readManifest, writeManifest, summarize } from "./reconcile.js";
import { loadIgnore } from "./ignore.js";

/**
 * BFS Overleaf's project.rootFolder into flat lists.
 * Returns { folders:[path], docs:[{docId,path,name}], files:[{hash,path,name}] }.
 * The leading "rootFolder/" is not part of Overleaf paths; we build from names.
 */
export function processProjectStructure(project) {
  const folders = [];
  const docs = [];
  const files = [];
  const root = (project && project.rootFolder && project.rootFolder[0]) || project.rootFolder || {};
  const walk = (folder, prefix) => {
    for (const f of folder.folders || []) {
      const p = prefix ? `${prefix}/${f.name}` : f.name;
      folders.push(p);
      walk(f, p);
    }
    for (const d of folder.docs || []) {
      docs.push({ docId: d._id, name: d.name, path: prefix ? `${prefix}/${d.name}` : d.name });
    }
    for (const file of folder.fileRefs || folder.files || []) {
      files.push({
        id: file._id,
        hash: file.hash,
        name: file.name,
        path: prefix ? `${prefix}/${file.name}` : file.name,
      });
    }
  };
  walk(root, "");
  return { folders, docs, files };
}

/**
 * Pull the whole project to `mirrorDir`. Reconciles against a baseline manifest
 * (in `stateDir`) so local edits are never silently overwritten — see
 * reconcile.js. `force` restores clobber-everything behaviour.
 * @returns { docs:[{ docId, path, text, ranges }], sync } where sync is the
 *          reconcile result (created/updated/kept/conflicts).
 */
export async function pullProject({ page, cap, deployment, projectId, mirrorDir, stateDir = null, force = false, log = () => {}, dryRun = false }) {
  // The project tree arrives once on connect; wait for it (or use a cached one).
  log("waiting for project tree (joinProjectResponse)…");
  const project = await waitFor(cap, "project", 30000).catch(() => {
    throw new Error(
      "no joinProjectResponse captured in 30s. Likely the WS frames weren't " +
      "seen (attach-after-connect) or use an unrecognised Socket.IO format. " +
      "Re-run with --debug-frames to inspect the raw frames."
    );
  });
  const { folders, docs, files } = processProjectStructure(project);
  log(`project tree: ${docs.length} docs, ${files.length} binary files, ${folders.length} folders`);

  for (const dir of folders) {
    await mkdir(path.join(mirrorDir, dir), { recursive: true });
  }
  await mkdir(mirrorDir, { recursive: true });

  // Content via the authenticated "Download as ZIP" endpoint: one request for
  // the whole project. The docstore REST route 404s on www and per-doc socket
  // joinDoc can't be sent from a passive CDP sniff, so the ZIP is the robust
  // path for the mirror. (Comment RANGES still need joinDoc — see note below.)
  const t0 = Date.now();
  log("downloading project ZIP…");
  const zipUrl = `${deployment}/project/${projectId}/download/zip`;
  const fetchZip = () =>
    page.evaluate(async ({ url }) => {
      try {
        const r = await fetch(url, { credentials: "include" });
        if (!r.ok) return { ok: false, status: r.status };
        const ab = await r.arrayBuffer();
        // base64-encode in the page to ship binary back over CDP safely.
        let bin = "";
        const bytes = new Uint8Array(ab);
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return { ok: true, status: r.status, b64: btoa(bin), bytes: bytes.length };
      } catch (e) {
        return { ok: false, status: 0, error: String((e && e.message) || e) };
      }
    }, { url: zipUrl });

  // The download/zip endpoint is occasionally flaky (transient 500); retry.
  let zipB64 = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    zipB64 = await fetchZip();
    if (zipB64 && zipB64.ok) break;
    log(`ZIP download attempt ${attempt} failed (status ${zipB64 ? zipB64.status : "n/a"})${attempt < 3 ? " — retrying…" : ""}`);
    if (attempt < 3) await page.waitForTimeout(1500).catch(() => {});
  }
  if (!zipB64 || !zipB64.ok) {
    throw new Error(`ZIP download failed after 3 attempts (status ${zipB64 ? zipB64.status : "n/a"}) at ${zipUrl}`);
  }
  log(`ZIP ${(zipB64.bytes / 1024).toFixed(0)} KB downloaded (${Date.now() - t0}ms); extracting…`);

  let entries = unzip(Buffer.from(zipB64.b64, "base64"));
  entries = stripCommonRoot(entries);
  let fileEntries = entries.filter((e) => !e.dir);
  const byName = new Map(fileEntries.map((e) => [e.name, e.data]));

  // .overleafignore: drop ignored paths from the sync (both report + reconcile).
  const isIgnored = await loadIgnore(mirrorDir);
  const nIgnored = fileEntries.filter((e) => isIgnored(e.name)).length;
  if (nIgnored) log(`.overleafignore: skipping ${nIgnored} file(s)`);
  fileEntries = fileEntries.filter((e) => !isIgnored(e.name));

  // Reconcile against the baseline manifest instead of clobbering: local edits
  // are kept, true conflicts are stashed as <file>.overleaf-incoming. The state
  // dir defaults to mirrorDir/.overleaf when not given.
  const sd = stateDir || path.join(mirrorDir, ".overleaf");
  const manifest = await readManifest(sd);
  const { result: sync, manifest: nextManifest } = await reconcile({
    mirrorDir, entries: fileEntries, manifest, force, log, stateDir: sd, dryRun,
  });
  if (!dryRun) await writeManifest(sd, nextManifest);
  log(`${dryRun ? "would mirror" : "mirror"}: ${summarize(sync)}`);
  if (sync.merged.length) log(`  auto-merged ${sync.merged.length} file(s) (both sides changed, no overlap): ${sync.merged.slice(0, 5).join(", ")}`);
  for (const c of sync.conflicts) log(`  ⚠ conflict: ${c.path} (changed locally AND on Overleaf) → kept local; ${c.conflictFile ? "markers in .overleaf/conflicts/, run `leafsync resolve`" : "Overleaf version at " + path.basename(c.incoming)}`);
  if (sync.kept.length) log(`  kept ${sync.kept.length} local edit(s): ${sync.kept.slice(0, 5).join(", ")}${sync.kept.length > 5 ? "…" : ""}`);

  // Build text-doc results (feed the comment report). Match ZIP entries to the
  // project tree's docs by path; ranges are not in the ZIP (pending joinDoc).
  const docResults = [];
  for (const doc of docs) {
    if (isIgnored(doc.path)) continue;
    const data = byName.get(doc.path) || matchBySuffix(byName, doc.path);
    const text = data ? data.toString("utf8") : "";
    if (!data) log(`⚠ ${doc.path}: not found in ZIP (kept empty)`);
    docResults.push({ docId: doc.docId, path: doc.path, text, ranges: undefined });
  }
  const missingBinaries = files.filter((f) => !byName.has(f.path) && !matchBySuffix(byName, f.path));
  if (missingBinaries.length) log(`note: ${missingBinaries.length} binary file(s) from the tree weren't in the ZIP`);

  return { docs: docResults, sync };
}

/**
 * For each text doc, send joinDoc over the app's socket (via the injected hook)
 * to retrieve its lines + ranges (comments/tracked-changes). Returns a Map
 * docId -> { lines, version, ranges }. Requires inject.js to be installed.
 *
 * Bails early if the very first joinDoc fails (hook not active) so we don't wait
 * out one timeout per doc.
 */
export async function collectDocRanges(page, docs, { log = () => {}, timeout = 8000, skip = new Map(), historyOT = false, debug = null } = {}) {
  const ready = await page
    .evaluate(() => !!(window.__olsyncReady && window.__olsyncReady()))
    .catch(() => false);
  if (!ready) {
    log("comment sync: socket hook not active — skipping ranges (content mirror is unaffected)");
    return new Map();
  }

  const out = new Map();
  const dbg = []; // per-doc {path, resLen, ranges} for diagnosis
  let i = 0;
  let attempts = 0;
  let withComments = 0;
  for (const doc of docs) {
    i++;
    if (skip.has(doc.docId)) continue;
    attempts++;
    try {
      // Classic encodeRanges (no supportsHistoryOT) — the historyOT variant
      // appears to omit comment ranges from the joinDoc ack on www.
      const opts = historyOT ? { encodeRanges: true, supportsHistoryOT: true } : { encodeRanges: true };
      const res = await page.evaluate(
        async ({ docId, o, t }) =>
          Promise.race([
            window.__olsyncRequest("joinDoc", [docId, o]),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), t)),
          ]),
        { docId: doc.docId, o: opts, t: timeout }
      );
      // www ack shape: [null, lines, version, changes, ranges{comments}, otType];
      // ranges isn't at a fixed index, so scan for it.
      const lines = Array.isArray(res) ? res[1] : null;
      const version = Array.isArray(res) ? res[2] : null;
      const ranges = findRanges(res);
      out.set(doc.docId, { lines, version, ranges });
      if (debug) {
        // Dump the full ack with the (huge) lines array summarized, so the real
        // 6-element shape — and where comments live — is visible.
        const els = Array.isArray(res)
          ? res.map((e, idx) => (idx === 1 && Array.isArray(e) ? `<lines:${e.length}>` : e))
          : res;
        dbg.push({ path: doc.path, resLen: Array.isArray(res) ? res.length : -1, els });
      }
      const nc = ranges && Array.isArray(ranges.comments) ? ranges.comments.length : 0;
      if (nc) {
        withComments++;
        log(`[ranges ${i}/${docs.length}] ${doc.path}: ${nc} comment(s)`);
      }
    } catch (e) {
      const msg = (e && e.message) || String(e);
      log(`[ranges ${i}/${docs.length}] ${doc.path}: ${msg}`);
      if (attempts === 1) {
        log("first joinDoc failed — socket injection not working; aborting range collection");
        break;
      }
    }
  }
  log(`ranges: ${withComments} doc(s) with comments of ${docs.length}`);
  if (debug && dbg.length) {
    try {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(debug, JSON.stringify(dbg, null, 2));
      log(`wrote per-doc ranges debug (${dbg.length} docs) to ${debug}`);
    } catch (e) {
      /* ignore */
    }
  }
  return out;
}

/**
 * Re-join a single doc over the hooked socket to refresh its base text, version,
 * and ranges (used by watch to recover after a rejected push). Returns
 * { lines, version, ranges } or null.
 */
export async function joinOneDoc(page, docId, { timeout = 8000 } = {}) {
  try {
    const res = await page.evaluate(
      async ({ docId, t }) =>
        Promise.race([
          window.__olsyncRequest("joinDoc", [docId, { encodeRanges: true }]),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), t)),
        ]),
      { docId, t: timeout }
    );
    if (!Array.isArray(res)) return null;
    return { lines: res[1], version: res[2], ranges: findRanges(res) };
  } catch {
    return null;
  }
}

/** Fall back to matching a tree path against a ZIP entry by path suffix. */
function matchBySuffix(byName, p) {
  for (const [name, data] of byName) {
    if (name === p || name.endsWith("/" + p) || p.endsWith("/" + name)) return data;
  }
  return null;
}

function waitFor(emitter, event, timeout) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${event} timeout`)), timeout);
    emitter.once(event, (v) => {
      clearTimeout(t);
      resolve(v);
    });
  });
}

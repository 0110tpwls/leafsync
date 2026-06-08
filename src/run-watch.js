// run-watch.js — the foreground watch loop (live two-way sync).
//
//   live mode (default): initial pull, subscribe to every doc (joinDoc), then
//     • OL -> local: apply incoming otUpdateApplied ops to the mirror file
//       (echo-guarded, fs-guarded). Always on; safe; this is the solid path.
//     • local -> OL: on a local change, compute MINIMAL ops, flag comment-anchor
//       conflicts, and submit them over the socket — ONLY with --push (opt-in).
//       Without --push the intended ops are logged, so `watch` is read-only.
//   interval mode (--interval N): re-`pull` every N seconds (no live socket).
//
// WRITE-BACK STATUS (--push): validated end-to-end on a throwaway project —
// content edits, file create/delete (nested folders), and comment RE-ANCHORING
// (edit the commented word -> the thread + its messages move to the new text).
// Version is tracked continuously: joinDoc once, then +1 per applied op — ours
// confirmed by the sender-form otUpdateApplied [{v}] (read back via submitOps),
// remote ops via the otUpdateApplied broadcast. The server TRANSFORMS a stale op
// and reports the version it applied at, so a push lands even if the start
// version lagged, and we resync from that confirmation (no no-ops, no loops).
// Caveat: Overleaf shows brief cross-session replication lag, so a fresh
// pull/join right after a push can momentarily show old state (it converges).
// Still EXPERIMENTAL on real projects until more soak time; OL->local is default.
//
// Both loop guards (loopguard.js) are wired so the two directions can't feed
// back into each other.

import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { buildReport, writeReport } from "./comments.js";
import { applyOps, docText } from "./ot.js";
import { computeOps, detectCommentConflicts, submitOps, planReanchors } from "./writeback.js";
import { EditEchoGuard, FsSyncGuard } from "./loopguard.js";
import { stateDir } from "./config.js";

export async function runForegroundWatch({ root, cfg, args }) {
  const mirrorDir = path.resolve(root, args.mirror || cfg.mirrorDir || ".");
  const headless = !args.headful;
  const push = !!args.push; // write-back is opt-in

  const { openProject } = await import("./session.js");
  const { attachCapture } = await import("./cdp.js");
  const { pullProject, collectDocRanges, processProjectStructure, joinOneDoc } = await import("./mirror.js");
  const { reconcile, readManifest, writeManifest } = await import("./reconcile.js");
  const { injectedHook } = await import("./inject.js");
  const { watchMirror } = await import("./watcher.js");
  const { getCsrf, folderIdMap, ensureParentFolder, createDoc, deleteEntity, uploadFile, downloadFileB64 } = await import("./tree.js");
  const { acquireLock } = await import("./daemon.js");

  // Single-instance lock — refuse to start if another watch already drives this
  // project (prevents foreground+background double-applying). Released on exit.
  let releaseLock;
  try {
    releaseLock = acquireLock(root, { mode: args.interval ? "interval" : "live", push });
  } catch (e) {
    log(e.message);
    return;
  }

  const { browser, context, page } = await openProject(root, cfg, { headless });
  // Install the socket hook + capture BEFORE reload so we can both send joinDoc/
  // applyOtUpdate and receive the connect handshake.
  await page.addInitScript(injectedHook);
  const cap = await attachCapture(context, page);

  // Interval mode: simple periodic ZIP pull, no live socket.
  if (args.interval) {
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    let { docs } = await pullProject({ page, cap, deployment: cfg.deployment, projectId: cfg.projectId, mirrorDir, stateDir: stateDir(root), force: args.force, log });
    log(`interval mode: re-pull every ${args.interval}s (Ctrl-C to stop)`);
    setInterval(async () => {
      try {
        ({ docs } = await pullProject({ page, cap, deployment: cfg.deployment, projectId: cfg.projectId, mirrorDir, stateDir: stateDir(root), force: args.force, log }));
        await writeReport(stateDir(root), buildReport(docs, {}));
        log(`re-pulled ${docs.length} docs`);
      } catch (e) {
        log(`pull error: ${e.message}`);
      }
    }, args.interval * 1000);
    return keepAlive();
  }

  // Live mode. Subscribe to the project tree BEFORE reloading so we don't miss it.
  const treeP = onceEvent(cap, "project", 30000);
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  const project = await treeP;
  const { docs, files } = processProjectStructure(project);

  // Track binary files (figures) by path<->id so we can sync changes/deletes and
  // recognise our own upload echoes. Initial bytes come from `pull`; watch only
  // tracks + syncs subsequent changes.
  const binByPath = new Map();
  const binById = new Map();
  const uploadingPaths = new Set(); // in-flight local uploads, to drop their echo
  for (const f of files) {
    const abs = path.join(mirrorDir, f.path);
    const ent = { fileId: f.id, path: f.path, abs };
    if (f.id) { binByPath.set(abs, ent); binById.set(f.id, ent); }
  }

  // Join every doc — this both SUBSCRIBES us to live edits and yields the
  // authoritative canonical text + version + ranges (the OT base). We do NOT
  // use the ZIP here: it lags the live doc and adds a trailing newline, which
  // would make computeOps emit a corrupt diff on the first write-back.
  const rmap = await collectDocRanges(page, docs, { log });

  // Reconcile the canonical text against the mirror + manifest, exactly like
  // `pull` — so local edits are never clobbered, but where the local file is
  // untouched it fast-forwards to the canonical text. This makes
  // file == d.text == Overleaf, which write-back requires.
  const sd = stateDir(root);
  const manifest = await readManifest(sd);
  const entries = docs
    .filter((d) => rmap.get(d.docId) && Array.isArray(rmap.get(d.docId).lines))
    .map((d) => ({ name: d.path, data: Buffer.from(docText(rmap.get(d.docId).lines), "utf8") }));
  const { result: sync, manifest: nextManifest } = await reconcile({ mirrorDir, entries, manifest, force: args.force, log });
  await writeManifest(sd, nextManifest);
  const divergedPaths = new Set([...sync.kept, ...sync.conflicts.map((c) => c.path)]);

  const byId = new Map();
  for (const d of docs) {
    const r = rmap.get(d.docId);
    const canonical = r && Array.isArray(r.lines) ? docText(r.lines) : "";
    byId.set(d.docId, {
      docId: d.docId, path: d.path, abs: path.join(mirrorDir, d.path),
      text: canonical, version: r ? r.version | 0 : 0, ranges: r ? r.ranges : undefined,
      diverged: divergedPaths.has(d.path),
    });
  }
  for (const p of divergedPaths) {
    log(`⚠ ${p}: local copy differs from Overleaf — OL→local paused for it${push ? " (it will push when you next save it)" : "; run \`pull\` to reconcile, or use --push"}`);
  }
  const byPath = new Map([...byId.values()].map((d) => [d.abs, d]));
  await writeReport(stateDir(root), buildReport([...byId.values()], {}));
  log(`watching ${byId.size} docs under ${mirrorDir} — ${push ? "PUSH ENABLED (local→Overleaf)" : "read-only (use --push to enable write-back)"}`);

  const echoGuard = new EditEchoGuard();
  const fsGuard = new FsSyncGuard();

  // Tree-op context (create/delete on Overleaf): CSRF + folder-id map.
  const base = cfg.deployment;
  const pid = cfg.projectId;
  let csrf = await getCsrf(page).catch(() => null);
  const folders = folderIdMap(project);

  // OL -> local. Apply each incoming op to the in-memory base + the mirror file.
  cap.on("remoteEdit", async ({ docId, op, version }) => {
    const d = byId.get(docId);
    if (!d || !Array.isArray(op) || op.length === 0) return;
    if (d.diverged) return; // local copy differs; don't clobber it with remote ops
    if (echoGuard.shouldDrop(docId, op)) return; // our own write-back echo
    try {
      d.text = applyOps(d.text, op);
      // Remote op applied AT `version` -> realtime is now version+1. Track it
      // (never go backward) so our next push submits at the current version.
      d.version = Math.max(d.version | 0, (typeof version === "number" ? version : (d.version | 0)) + 1);
      fsGuard.markWrite(d.abs); // tell the watcher this write isn't a user edit
      await mkdir(path.dirname(d.abs), { recursive: true });
      await writeFile(d.abs, d.text, "utf8");
      log(`OL→local: ${d.path} (${op.length} op → v${d.version})`);
    } catch (e) {
      log(`apply error on ${d.path}: ${e.message} — re-syncing`);
      await resync(page, d, log);
    }
  });

  // local -> OL. change = content diff; add = create doc; unlink = delete doc.
  // (chokidar reports a rename as unlink+add, so a rename becomes delete+create:
  // the new doc gets the content; comments on the old doc don't carry over.)
  const watcher = await watchMirror(mirrorDir, fsGuard, async ({ type, path: fp, binary }) => {
    const rel = path.relative(mirrorDir, fp);

    // --- binary (figure/asset) sync ---
    if (binary) {
      const known = binByPath.get(fp);
      if (type === "unlink") {
        if (!known) return;
        if (!push) { log(`local delete STAGED: ${rel} (binary) — run \`watch --push\``); return; }
        try {
          if (!csrf) csrf = await getCsrf(page);
          await deleteEntity(page, base, pid, csrf, "file", known.fileId);
          binByPath.delete(fp); binById.delete(known.fileId);
          log(`local→OL: deleted ${rel} (binary)`);
        } catch (e) { log(`binary delete error on ${rel}: ${e.message}`); }
        return;
      }
      // add or change -> upload (replaces same-name file in the same folder)
      if (!push) { log(`local ${type} STAGED: ${rel} (binary) — run \`watch --push\``); return; }
      try {
        if (!csrf) csrf = await getCsrf(page);
        const parentId = await ensureParentFolder(page, base, pid, csrf, rel, folders);
        const b64 = (await readFile(fp)).toString("base64");
        uploadingPaths.add(fp); // suppress the reciveNewFile echo for this path
        const { id } = await uploadFile(page, base, pid, csrf, path.basename(rel), parentId, b64);
        if (known && known.fileId !== id) binById.delete(known.fileId); // old entity replaced
        const ent = { fileId: id, path: rel, abs: fp };
        binByPath.set(fp, ent); binById.set(id, ent);
        setTimeout(() => uploadingPaths.delete(fp), 4000);
        log(`local→OL: uploaded ${rel} (binary)`);
      } catch (e) { uploadingPaths.delete(fp); log(`binary upload error on ${rel}: ${e.message}`); }
      return;
    }

    const d = byPath.get(fp);

    // --- local DELETE -> delete the doc on Overleaf ---
    if (type === "unlink") {
      if (!d) return; // untracked (binary/unknown) — ignore
      if (!push) { log(`local delete STAGED: ${rel} — run \`watch --push\` to apply`); return; }
      try {
        if (!csrf) csrf = await getCsrf(page);
        await deleteEntity(page, base, pid, csrf, "doc", d.docId);
        byId.delete(d.docId);
        byPath.delete(fp);
        log(`local→OL: deleted ${rel}`);
      } catch (e) {
        log(`delete error on ${rel}: ${e.message}`);
      }
      return;
    }

    // --- local CREATE -> create the doc on Overleaf, then push its content ---
    if (type === "add" && !d) {
      if (!push) { log(`local create STAGED: ${rel} — run \`watch --push\` to apply`); return; }
      try {
        if (!csrf) csrf = await getCsrf(page);
        const name = path.basename(rel);
        const parentId = await ensureParentFolder(page, base, pid, csrf, rel, folders);
        const docId = await createDoc(page, base, pid, csrf, name, parentId);
        const content = await readFile(fp, "utf8");
        // Join the fresh doc to subscribe + learn its starting version/content.
        const r0 = await joinOneDoc(page, docId);
        const base0 = r0 && Array.isArray(r0.lines) ? docText(r0.lines) : "";
        const startV = r0 ? r0.version | 0 : 0;
        const entry = { docId, path: rel, abs: fp, text: base0, version: startV, ranges: r0 ? r0.ranges : undefined, diverged: false };
        byId.set(docId, entry);
        byPath.set(fp, entry);
        // push the file's content into the (usually empty) new doc
        const ops = computeOps(base0, content);
        if (ops.length) {
          echoGuard.markSubmitted(docId, ops);
          const { version: confirmed } = await submitOps(page, docId, ops, startV);
          entry.text = content;
          entry.version = (typeof confirmed === "number" ? confirmed : startV) + 1;
        }
        log(`local→OL: created ${rel} (${ops.length} content op(s))`);
      } catch (e) {
        log(`create error on ${rel}: ${e.message}`);
      }
      return;
    }

    // --- local CHANGE (or add to an already-tracked doc) -> content write-back ---
    if (!d) return;
    try {
      const next = await readFile(fp, "utf8");
      const ops = computeOps(d.text, next);
      if (!ops.length) return;
      const conflicts = detectCommentConflicts(ops, d.ranges);
      if (conflicts.length) log(`⚠ ${d.path}: edit overlaps ${conflicts.length} comment(s) — will re-anchor`);
      if (!push) {
        log(`local→OL STAGED: ${d.path} ${ops.length} op(s) — run \`watch --push\` to submit`);
        return;
      }
      echoGuard.markSubmitted(d.docId, ops);
      // The server transforms a stale op and reports the version it applied AT,
      // so the push lands even if d.version was slightly behind; we then resync
      // d.version from the confirmation (next op goes at confirmed+1).
      const { version: confirmed } = await submitOps(page, d.docId, ops, d.version);
      d.text = next;
      let v = Math.max(d.version | 0, (typeof confirmed === "number" ? confirmed : d.version | 0) + 1);
      // Re-anchor any comments the edit collapsed: re-attach each thread (by id)
      // to the changed region of the new text so the conversation isn't lost.
      const plan = conflicts.length ? planReanchors(ops, conflicts, next) : [];
      for (const ra of plan) {
        try {
          const { version: cv } = await submitOps(page, d.docId, [{ c: ra.c, p: ra.p, t: ra.t }], v);
          v = Math.max(v, (typeof cv === "number" ? cv : v) + 1);
        } catch (e) {
          log(`re-anchor failed for thread ${ra.t} on ${d.path}: ${e.message}`);
        }
      }
      d.version = v;
      if (plan.length) log(`re-anchored ${plan.length} comment(s) on ${d.path}`);
      if (d.diverged) { d.diverged = false; } // a successful push resolves divergence
      log(`local→OL: ${d.path} ${ops.length} op(s) → v${d.version}`);
    } catch (e) {
      log(`push error on ${d.path}: ${e.message} — re-syncing`);
      await resync(page, d, log);
    }
  });

  // ---- OL -> local tree ops: mirror create/delete/rename done on Overleaf ----
  const { rename, rm } = await import("node:fs/promises");
  const folderPathById = new Map();
  for (const [p, id] of folders.map) folderPathById.set(id, p);
  const resolveNewPath = (parentFolderId, name) => {
    const parent = folderPathById.get(parentFolderId) || "";
    return parent ? `${parent}/${name}` : name;
  };

  // Move/rename a folder subtree locally: mark every affected child (old+new abs)
  // in fsGuard FIRST so chokidar's move storm doesn't echo back as local ops, then
  // OS-rename the dir, then relabel doc/binary/folder maps to the new prefix.
  async function moveFolderSubtree(oldPath, newPath) {
    const under = (p) => p === oldPath || p.startsWith(oldPath + "/");
    const remap = (p) => newPath + p.slice(oldPath.length);
    for (const d of byId.values()) if (under(d.path)) { fsGuard.markWrite(d.abs); fsGuard.markWrite(path.join(mirrorDir, remap(d.path))); }
    for (const b of binByPath.values()) if (under(b.path)) { fsGuard.markWrite(b.abs); fsGuard.markWrite(path.join(mirrorDir, remap(b.path))); }
    await mkdir(path.dirname(path.join(mirrorDir, newPath)), { recursive: true });
    await rename(path.join(mirrorDir, oldPath), path.join(mirrorDir, newPath)).catch(() => {});
    for (const d of [...byId.values()]) if (under(d.path)) { byPath.delete(d.abs); d.path = remap(d.path); d.abs = path.join(mirrorDir, d.path); byPath.set(d.abs, d); }
    for (const b of [...binByPath.values()]) if (under(b.path)) { binByPath.delete(b.abs); b.path = remap(b.path); b.abs = path.join(mirrorDir, b.path); binByPath.set(b.abs, b); }
    for (const [p, fid] of [...folders.map]) if (under(p)) { folders.map.delete(p); const np = remap(p); folders.map.set(np, fid); folderPathById.set(fid, np); }
  }

  // Move/rename a single tracked file (doc or binary) to a new relative path.
  async function moveFileLocally(entry, isBin, newRel) {
    const abs = path.join(mirrorDir, newRel);
    fsGuard.markWrite(entry.abs); fsGuard.markWrite(abs);
    await mkdir(path.dirname(abs), { recursive: true });
    await rename(entry.abs, abs).catch(async () => {
      if (!isBin) { await writeFile(abs, entry.text, "utf8"); await rm(entry.abs, { force: true }); }
    });
    const map = isBin ? binByPath : byPath;
    map.delete(entry.abs); entry.path = newRel; entry.abs = abs; map.set(abs, entry);
  }

  cap.on("treeNew", async ({ kind, parentFolderId, id, name }) => {
    try {
      const rel = resolveNewPath(parentFolderId, name);
      const abs = path.join(mirrorDir, rel);
      if (byId.has(id) || byPath.has(abs)) return; // our own create echo
      if (kind !== "doc") {
        // new binary on Overleaf -> download the blob to the mirror
        if (binByPath.has(abs) || uploadingPaths.has(abs)) return; // our own upload echo
        fsGuard.markWrite(abs);
        const b64 = await downloadFileB64(page, base, pid, id);
        if (b64 == null) { log(`OL→local: new binary ${rel} — download failed (run \`pull\`)`); return; }
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, Buffer.from(b64, "base64"));
        const ent = { fileId: id, path: rel, abs };
        binByPath.set(abs, ent); binById.set(id, ent);
        log(`OL→local: new binary ${rel}`);
        return;
      }
      fsGuard.markWrite(abs);
      await mkdir(path.dirname(abs), { recursive: true });
      const r = await joinOneDoc(page, id);
      const text = r && Array.isArray(r.lines) ? docText(r.lines) : "";
      await writeFile(abs, text, "utf8");
      const entry = { docId: id, path: rel, abs, text, version: r ? r.version | 0 : 0, ranges: r ? r.ranges : undefined, diverged: false };
      byId.set(id, entry);
      byPath.set(abs, entry);
      log(`OL→local: new doc ${rel}`);
    } catch (e) { log(`OL→local new error: ${e.message}`); }
  });

  cap.on("treeNewFolder", async ({ parentFolderId, id, name }) => {
    try {
      const rel = resolveNewPath(parentFolderId, name);
      folders.map.set(rel, id);
      folderPathById.set(id, rel);
      await mkdir(path.join(mirrorDir, rel), { recursive: true });
      log(`OL→local: new folder ${rel}/`);
    } catch (e) { log(`OL→local new-folder error: ${e.message}`); }
  });

  cap.on("treeRename", async ({ id, name }) => {
    const renameTo = (oldRel) => { const dir = path.dirname(oldRel); return dir === "." ? name : `${dir}/${name}`; };
    try {
      const d = byId.get(id);
      if (d) { await moveFileLocally(d, false, renameTo(d.path)); log(`OL→local: renamed → ${d.path}`); return; }
      const b = binById.get(id);
      if (b) { await moveFileLocally(b, true, renameTo(b.path)); log(`OL→local: renamed binary → ${b.path}`); return; }
      const oldPath = folderPathById.get(id);
      if (oldPath != null) {
        const parent = path.dirname(oldPath);
        const newPath = parent === "." ? name : `${parent}/${name}`;
        await moveFolderSubtree(oldPath, newPath);
        log(`OL→local: renamed folder ${oldPath}/ → ${newPath}/`);
      }
    } catch (e) { log(`OL→local rename error: ${e.message}`); }
  });

  cap.on("treeRemove", async ({ id }) => {
    const d = byId.get(id);
    if (d) {
      try {
        fsGuard.markWrite(d.abs);
        await rm(d.abs, { force: true });
        byId.delete(id); byPath.delete(d.abs);
        log(`OL→local: deleted ${d.path}`);
      } catch (e) { log(`OL→local delete error: ${e.message}`); }
      return;
    }
    const bin = binById.get(id);
    if (bin) {
      try {
        fsGuard.markWrite(bin.abs);
        await rm(bin.abs, { force: true });
        binById.delete(id); binByPath.delete(bin.abs);
        log(`OL→local: deleted ${bin.path} (binary)`);
      } catch (e) { log(`OL→local delete-binary error: ${e.message}`); }
      return;
    }
    const folderPath = folderPathById.get(id);
    if (folderPath != null) {
      try {
        await rm(path.join(mirrorDir, folderPath), { recursive: true, force: true });
        for (const [p, fid] of [...folders.map]) {
          if (p === folderPath || p.startsWith(folderPath + "/")) { folders.map.delete(p); folderPathById.delete(fid); }
        }
        for (const e of [...byId.values()]) {
          if (e.path === folderPath || e.path.startsWith(folderPath + "/")) { byId.delete(e.docId); byPath.delete(e.abs); }
        }
        log(`OL→local: deleted folder ${folderPath}/`);
      } catch (e) { log(`OL→local delete-folder error: ${e.message}`); }
    }
  });

  cap.on("treeMove", async ({ id, destFolderId }) => {
    const destDir = folderPathById.get(destFolderId) || "";
    const into = (oldRel) => (destDir ? `${destDir}/${path.basename(oldRel)}` : path.basename(oldRel));
    try {
      const d = byId.get(id);
      if (d) { await moveFileLocally(d, false, into(d.path)); log(`OL→local: moved → ${d.path}`); return; }
      const b = binById.get(id);
      if (b) { await moveFileLocally(b, true, into(b.path)); log(`OL→local: moved binary → ${b.path}`); return; }
      const oldPath = folderPathById.get(id);
      if (oldPath != null) {
        const newPath = destDir ? `${destDir}/${path.basename(oldPath)}` : path.basename(oldPath);
        await moveFolderSubtree(oldPath, newPath);
        log(`OL→local: moved folder ${oldPath}/ → ${newPath}/`);
      }
    } catch (e) { log(`OL→local move error: ${e.message}`); }
  });

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`stopping (${sig})…`);
    try { releaseLock && releaseLock(); } catch { /* ignore */ }
    await watcher.close().catch(() => {});
    await browser.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM")); // `stop` sends SIGTERM
  process.on("exit", () => { try { releaseLock && releaseLock(); } catch { /* ignore */ } });
  return keepAlive();
}

/** Refresh one doc's base text/version/ranges from Overleaf after an error. */
async function resync(page, d, log) {
  const { joinOneDoc } = await import("./mirror.js");
  const r = await joinOneDoc(page, d.docId);
  if (r && Array.isArray(r.lines)) {
    d.text = docText(r.lines);
    d.version = r.version | 0;
    d.ranges = r.ranges;
    log(`re-synced ${d.path} → v${d.version}`);
  }
}

function keepAlive() {
  return new Promise(() => {});
}

/** Resolve on the next `event` from an emitter, or reject after `ms`. */
function onceEvent(emitter, event, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${event} timeout`)), ms);
    emitter.once(event, (v) => { clearTimeout(t); resolve(v); });
  });
}

function log(msg) {
  process.stdout.write(`[overleaf-sync ${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}

#!/usr/bin/env node
// cli.js — `leafsync` command dispatch.
//
// All heavy deps (playwright, chokidar) load lazily inside the live commands, so
// `--help`, `status`, and `unlink` work before `npm install`.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";
import {
  parseProjectUrl, readConfig, writeConfig, ensureStateDir, stateDir, statePath,
} from "./config.js";
import { buildReport, writeReport } from "./comments.js";
import {
  readDaemon, isAlive, spawnBackground, stopDaemon, clearLock,
} from "./daemon.js";
import { discoverDaemons, killDaemon } from "./daemons.js";

const __filename = fileURLToPath(import.meta.url);
const HELP = `leafsync — two-way sync + comment mirror for Overleaf (write-back is experimental)

Usage:
  leafsync link <project-url>     one-time login; record project + session
  leafsync pull [--force]         mirror Overleaf -> local + refresh comments
                                   (safe by default: keeps local edits, flags
                                    conflicts; --force overwrites local)
  leafsync comments               refresh the local comment report only
  leafsync watch [opts]           live two-way sync (loop-guarded)
  leafsync status                 daemon state / last sync
  leafsync stop                   stop the background daemon for --project-root
  leafsync stop --ls              list ALL running watch daemons (every project)
  leafsync stop --rm <pid|all>    stop chosen daemon(s) by pid (graceful)
  leafsync unlink                 forget session + config for this project

watch options:
  --push                enable local→Overleaf write-back (default: read-only)
  --background          detach; keep syncing after the CC session ends
  --interval <sec>      poll every N seconds instead of live (lower overhead)
  --headful             show the browser window (default: headless)

Diagnostics (pull/comments):
  --verbose, -v         print per-step progress (project tree, ZIP, files)
  --debug-frames        dump raw WebSocket frames to .overleaf/frames.log
  --headful             show the browser so you can watch the pull

Global:
  --project-root <dir>  project dir (default: cwd)
  --mirror <dir>        local mirror dir (default: project root)

This feature drives a real Chromium against your live Overleaf session. Review
Overleaf's terms before use, especially for institutional/paid accounts.`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--background" || a === "--headful" || a === "--force" || a === "--push" || a === "--ls" || a === "--rm") args[a.slice(2)] = true;
    else if (a === "--debug-frames") args.debugFrames = true;
    else if (a === "--verbose" || a === "-v") args.verbose = true;
    else if (a === "--interval") args.interval = Number(argv[++i]);
    else if (a === "--timeout") args.timeout = Number(argv[++i]);
    else if (a === "--project-root") args.projectRoot = argv[++i];
    else if (a === "--mirror") args.mirror = argv[++i];
    else if (a === "-h" || a === "--help") args.help = true;
    else args._.push(a);
  }
  return args;
}

function hasRanges(r) {
  return !!(r && ((Array.isArray(r.comments) && r.comments.length) || (Array.isArray(r.changes) && r.changes.length)));
}

async function requireConfig(root) {
  const cfg = await readConfig(root);
  if (!cfg) throw new Error("not linked — run `leafsync link <project-url>` first.");
  return cfg;
}

async function cmdLink(root, url) {
  if (!url) throw new Error("usage: leafsync link <project-url>");
  const { deployment, projectId } = parseProjectUrl(url);
  await ensureStateDir(root);
  const { login } = await import("./session.js");
  process.stderr.write(`Opening ${deployment} for login — sign in, then come back…\n`);
  await login(root, deployment);
  await writeConfig(root, {
    deployment, projectId, projectUrl: url,
    mirrorDir: ".", linkedAt: new Date().toISOString(),
  });
  console.log(`linked ${projectId} on ${deployment}. Session saved to ${stateDir(root)}.`);
}

async function capturePull({ root, cfg, mirrorDir, headless, writeFiles, args = {} }) {
  const { openProject } = await import("./session.js");
  const { attachCapture } = await import("./cdp.js");
  const { pullProject, collectDocRanges } = await import("./mirror.js");
  const { injectedHook } = await import("./inject.js");
  const { appendFile } = await import("node:fs/promises");

  const log = args.verbose || args.debugFrames ? (m) => process.stderr.write(`[pull] ${m}\n`) : () => {};
  const framesLog = statePath(root, "frames.log");
  // onRaw dumps every WS frame (truncated) for protocol diagnosis.
  const onRaw = args.debugFrames
    ? (dir, payload) => {
        const s = typeof payload === "string" ? payload : String(payload);
        appendFile(framesLog, `${dir} ${s.slice(0, 400)}\n`).catch(() => {});
      }
    : undefined;

  const { browser, context, page } = await openProject(root, cfg, { headless });
  try {
    // Install the socket hook (lets us SEND joinDoc) BEFORE reloading, and
    // attach CDP for the project-tree frame. Then reload so both see the
    // connect handshake. Attaching after the initial navigation misses it.
    await page.addInitScript(injectedHook);
    const cap = await attachCapture(context, page, { onRaw });
    // The app naturally joinDoc's the ROOT doc on load — capture those ranges
    // straight from CDP. Re-joining an already-joined doc can return empty
    // ranges, so the app's own join is the authoritative source for the root.
    const capRanges = new Map();
    cap.on("joinDoc", (jd) => { if (jd && jd.docId) capRanges.set(jd.docId, jd); });
    if (args.debugFrames) log(`dumping raw WS frames to ${framesLog}`);
    log("reloading page to capture the WebSocket handshake…");
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    const { docs, sync } = await pullProject({
      page, cap, deployment: cfg.deployment, projectId: cfg.projectId,
      mirrorDir, stateDir: stateDir(root), force: args.force, log,
    });

    // Comment ranges: send joinDoc per doc over the app's socket (classic
    // encodeRanges). Join ALL docs ourselves — the app's historyOT join returns
    // empty ranges. Dump per-doc ranges for diagnosis.
    const rmap = await collectDocRanges(page, docs, { log, skip: new Map(), debug: args.debugFrames ? statePath(root, "ranges-debug.json") : null });
    const stats = await page.evaluate(() => (window.__olsyncStats ? window.__olsyncStats() : null)).catch(() => null);
    if (stats) log(`socket hook: hooked=${stats.hooked} sent=${stats.sent} acks=${stats.acks} ready=${stats.ready}`);

    // Merge ranges (app-captured root doc wins where it has content) + dump a
    // real sample so the live ranges shape is visible if comments still miss.
    const { writeFile } = await import("node:fs/promises");
    let dumped = false;
    for (const d of docs) {
      const fromApp = capRanges.get(d.docId);
      const fromInj = rmap.get(d.docId);
      const chosen = fromApp && hasRanges(fromApp.ranges) ? fromApp : fromInj || fromApp;
      if (chosen) {
        if (chosen.ranges) d.ranges = chosen.ranges;
        if (Array.isArray(chosen.lines)) d.text = chosen.lines.join("\n");
      }
      const r = d.ranges || {};
      const nc = Array.isArray(r.comments) ? r.comments.length : 0;
      const nch = Array.isArray(r.changes) ? r.changes.length : 0;
      if ((nc || nch) && (args.verbose || args.debugFrames)) log(`ranges ${d.path}: ${nc} comments, ${nch} changes (src ${fromApp && hasRanges(fromApp.ranges) ? "app" : "injected"})`);
      if ((nc || nch) && !dumped) {
        if (args.debugFrames) await writeFile(statePath(root, "joindoc-sample.json"), JSON.stringify({ path: d.path, ranges: r }, null, 2)).catch(() => {});
        dumped = true;
      }
    }
    if (!dumped) log("no doc returned non-empty ranges — no anchored (unresolved) comments found");

    // Threads (comment messages): best-effort via the project's threads endpoint.
    const threads = await page
      .evaluate(async ({ url }) => {
        try {
          const r = await fetch(url, { credentials: "include" });
          return r.ok ? await r.json() : {};
        } catch {
          return {};
        }
      }, { url: `${cfg.deployment}/project/${cfg.projectId}/threads` })
      .catch(() => ({}));
    log(`threads endpoint returned ${Object.keys(threads || {}).length} thread(s)`);
    if (args.debugFrames) {
      await (await import("node:fs/promises"))
        .writeFile(statePath(root, "threads-raw.json"), JSON.stringify(threads, null, 2))
        .then(() => log(`wrote raw threads to ${statePath(root, "threads-raw.json")}`))
        .catch(() => {});
    }
    const report = buildReport(docs, threads);
    await writeReport(stateDir(root), report);
    log(`report: ${report.entries.length} comment(s) written`);
    report.sync = sync;
    return report;
  } finally {
    await browser.close();
  }
}

async function cmdPull(root, args) {
  const cfg = await requireConfig(root);
  const mirrorDir = path.resolve(root, args.mirror || cfg.mirrorDir || ".");
  await ensureStateDir(root);
  const report = await capturePull({ root, cfg, mirrorDir, headless: !args.headful, writeFiles: true, args });
  const open = report.entries.filter((e) => !e.resolved).length;
  const s = report.sync || { created: [], updated: [], kept: [], conflicts: [] };
  console.log(`pulled project to ${mirrorDir}`);
  console.log(`files: ${s.created.length} new, ${s.updated.length} updated, ${s.kept.length} kept (local edits), ${s.conflicts.length} conflict(s)`);
  if (s.kept.length) console.log(`  kept your local edits (not overwritten): ${s.kept.join(", ")}`);
  for (const c of s.conflicts) {
    console.log(`  ⚠ CONFLICT ${c.path}: changed locally AND on Overleaf — kept yours; Overleaf's version saved as ${path.basename(c.incoming)}`);
  }
  if (s.conflicts.length) console.log(`  resolve by merging, then delete the .overleaf-incoming file. (Use --force to take Overleaf's version wholesale.)`);
  console.log(`comments: ${report.entries.length} (${open} open) -> ${statePath(root, "COMMENTS.md")}`);
}

async function cmdComments(root, args) {
  const cfg = await requireConfig(root);
  const mirrorDir = path.resolve(root, args.mirror || cfg.mirrorDir || ".");
  const report = await capturePull({ root, cfg, mirrorDir, headless: !args.headful, writeFiles: false, args });
  const open = report.entries.filter((e) => !e.resolved).length;
  console.log(`comments: ${report.entries.length} (${open} open) -> ${statePath(root, "COMMENTS.md")}`);
}

async function cmdWatch(root, args) {
  const cfg = await requireConfig(root);
  if (args.background) {
    const pid = await spawnBackground(root, __filename, ["watch", ...rebuildWatchArgs(args)]);
    console.log(`watch daemon started (pid ${pid}). Logs: ${statePath(root, "daemon.log")}. Stop with: leafsync stop`);
    return;
  }
  // Foreground live loop. Phase 2 (OL->local monitor) is wired; Phase 3
  // (local->Overleaf write-back) computes ops + conflicts but does not submit
  // yet — see writeback.submitOps. This keeps `watch` safe to run today.
  const { runForegroundWatch } = await import("./run-watch.js");
  await runForegroundWatch({ root, cfg, args });
}

function rebuildWatchArgs(args) {
  const out = [];
  if (args.interval) out.push("--interval", String(args.interval));
  if (args.push) out.push("--push");
  if (args.force) out.push("--force");
  if (args.headful) out.push("--headful");
  if (args.mirror) out.push("--mirror", args.mirror);
  if (args.projectRoot) out.push("--project-root", args.projectRoot);
  return out;
}

async function cmdStatus(root) {
  const cfg = await readConfig(root);
  if (!cfg) return console.log("not linked.");
  const d = await readDaemon(root);
  console.log(`linked: ${cfg.projectId} @ ${cfg.deployment}`);
  if (!d) {
    console.log("watch: not running.");
  } else if (isAlive(d.pid)) {
    const mode = d.mode ? ` (${d.mode}${d.push ? ", push" : ", read-only"})` : "";
    console.log(`watch: ALIVE pid ${d.pid}${mode} since ${new Date(d.startedAt).toISOString()}`);
    const last = await lastLogLine(statePath(root, "daemon.log"));
    if (last) console.log(`last activity: ${last}`);
  } else {
    console.log(`watch: not running (stale pid file for ${d.pid}; \`stop\` to clear).`);
  }
}

/** Last non-empty line of a log file (best-effort), for status. */
async function lastLogLine(p) {
  try {
    const { readFile } = await import("node:fs/promises");
    const lines = (await readFile(p, "utf8")).trimEnd().split("\n");
    return lines[lines.length - 1] || "";
  } catch {
    return "";
  }
}

async function cmdStop(root, args) {
  if (args.ls) return listDaemons();
  if (args.rm) return removeDaemons(args._.slice(1)); // selectors are positional after "stop"
  // default: stop the background daemon for this project root
  const r = await stopDaemon(root);
  console.log(r.stopped ? `stopped daemon (pid ${r.pid}).` : `nothing to stop: ${r.reason}.`);
}

function printDaemon(d) {
  const mode = d.push ? "PUSH (writes Overleaf)" : "read-only";
  const iv = d.interval ? `, interval ${d.interval}s` : "";
  console.log(`  pid ${d.pid}  up ${d.etime || "?"}  ${d.push ? "⚠ " : ""}${mode}${iv}`);
  console.log(`      project: ${d.projectId || "(unknown)"}${d.projectUrl ? `  ${d.projectUrl}` : ""}`);
  console.log(`      folder:  ${d.projectRoot}`);
}

async function listDaemons() {
  const { supported, daemons } = await discoverDaemons();
  if (!supported) return console.log("daemon listing isn't supported on this platform (unix only).");
  if (!daemons.length) return console.log("no leafsync watch daemons are running.");
  console.log(`${daemons.length} running leafsync watch daemon(s):\n`);
  daemons.forEach(printDaemon);
  const pushers = daemons.filter((d) => d.push).length;
  if (pushers) console.log(`\n⚠ ${pushers} daemon(s) are in PUSH mode — they write to Overleaf. Stop ones you didn't intend.`);
  console.log(`\nStop with:  leafsync stop --rm <pid> [<pid> …]   (or --rm all)`);
}

async function removeDaemons(selectors) {
  const { supported, daemons } = await discoverDaemons();
  if (!supported) return console.log("daemon removal isn't supported on this platform (unix only).");
  if (!daemons.length) return console.log("no leafsync watch daemons are running.");
  if (!selectors.length) {
    console.log("which daemon(s)? re-run `stop --rm <pid>` (or `--rm all`). Currently running:\n");
    daemons.forEach(printDaemon);
    return;
  }
  let targets;
  if (selectors.includes("all")) {
    targets = daemons.slice();
  } else {
    const want = new Set(selectors.map((s) => Number(s)).filter(Number.isFinite));
    targets = daemons.filter((d) => want.has(d.pid));
    const missing = [...want].filter((p) => !daemons.some((d) => d.pid === p));
    if (missing.length) console.log(`not a running leafsync daemon (skipped): ${missing.join(", ")}`);
  }
  if (!targets.length) return console.log("nothing matched; run `leafsync stop --ls` to see pids.");
  for (const d of targets) {
    const r = await killDaemon(d);
    if (r.stopped) console.log(`stopped pid ${r.pid}${r.forced ? " (forced)" : ""} — ${d.projectId || d.projectRoot}`);
    else console.log(`could not stop pid ${r.pid} — try again or kill it manually.`);
  }
}

async function cmdUnlink(root) {
  await stopDaemon(root).catch(() => {});
  await clearLock(root).catch(() => {});
  await rm(statePath(root, "storageState.json"), { force: true });
  await rm(statePath(root, "config.json"), { force: true });
  console.log("unlinked: removed session + config (report files left in .overleaf/).");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (args.help || !cmd) {
    console.log(HELP);
    return cmd ? 0 : 0;
  }
  const root = path.resolve(args.projectRoot || process.cwd());
  switch (cmd) {
    case "link": return cmdLink(root, args._[1]);
    case "pull": return cmdPull(root, args);
    case "comments": return cmdComments(root, args);
    case "watch": return cmdWatch(root, args);
    case "status": return cmdStatus(root);
    case "stop": return cmdStop(root, args);
    case "unlink": return cmdUnlink(root);
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(`leafsync: ${e.message}`);
  process.exitCode = 1;
});

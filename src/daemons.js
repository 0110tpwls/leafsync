// daemons.js — discover and safely stop leafsync `watch` daemons ACROSS projects.
//
// The per-project PID file (daemon.js) only knows about one project. To clean up
// orphans (daemons left by crashed/killed sessions, possibly on several projects),
// we scan the process table for our own `watch` processes, confirm each is really
// a leafsync daemon (its --project-root has an .overleaf/config.json), and let the
// caller stop a chosen one by PID. We NEVER touch a process we didn't positively
// identify as one of ours.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { isAlive } from "./daemon.js";

/**
 * PURE: given a process command line, decide whether it's a leafsync `watch`
 * daemon and extract its parameters. Returns null if it isn't one.
 * Exported for unit testing.
 */
export function parseDaemonCommand(command) {
  if (typeof command !== "string") return null;
  if (!/\bcli\.js\b/.test(command) || !/\bwatch\b/.test(command)) return null;
  // capture the path after --project-root up to the next --flag or end of line
  // (tolerates spaces in the path).
  const m = command.match(/--project-root\s+(.+?)(?:\s+--[A-Za-z]|\s*$)/);
  const projectRoot = m ? m[1].trim() : null;
  if (!projectRoot) return null;
  const push = /(?:^|\s)--push(?:\s|$)/.test(command);
  const im = command.match(/--interval\s+(\d+)/);
  return { projectRoot, push, interval: im ? Number(im[1]) : null };
}

/** Run `ps` and return its raw stdout (unix only). */
function ps() {
  return new Promise((resolve) => {
    try {
      const p = spawn("ps", ["-axww", "-o", "pid=,etime=,args="]);
      let o = "";
      p.stdout.on("data", (c) => (o += c));
      p.on("close", () => resolve(o));
      p.on("error", () => resolve(""));
    } catch {
      resolve("");
    }
  });
}

/**
 * Discover every running leafsync `watch` daemon on this machine.
 * Returns { supported, daemons: [{ pid, etime, projectRoot, push, interval,
 * projectId, projectUrl, self }] }. `self` flags the current process tree.
 */
export async function discoverDaemons() {
  if (process.platform === "win32") return { supported: false, daemons: [] };
  const raw = await ps();
  const daemons = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const sp = t.split(/\s+/);
    const pid = Number(sp[0]);
    if (!Number.isFinite(pid)) continue;
    const etime = sp[1];
    const command = sp.slice(2).join(" ");
    const parsed = parseDaemonCommand(command);
    if (!parsed) continue;
    const projectRoot = path.resolve(parsed.projectRoot);
    // Confirm it's really one of ours: the project root must hold a linked config.
    const cfgPath = path.join(projectRoot, ".overleaf", "config.json");
    if (!existsSync(cfgPath)) continue;
    let projectId = null, projectUrl = null;
    try {
      const c = JSON.parse(readFileSync(cfgPath, "utf8"));
      projectId = c.projectId || null;
      projectUrl = c.projectUrl || null;
    } catch { /* unreadable config -> still ours, just unlabeled */ }
    daemons.push({ pid, etime, projectRoot, projectId, projectUrl, push: parsed.push, interval: parsed.interval });
  }
  // stable order: oldest-looking first by pid
  daemons.sort((a, b) => a.pid - b.pid);
  return { supported: true, daemons };
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForExit(pid, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (!isAlive(pid)) return true;
    await delay(100);
  }
  return !isAlive(pid);
}

/**
 * Gracefully stop a discovered daemon: SIGTERM (so it closes Chromium + releases
 * its lock), wait, then SIGKILL as a fallback. Clears the project's pid file if it
 * pointed at this pid. `daemon` MUST come from discoverDaemons() — callers should
 * never hand a raw pid here.
 */
export async function killDaemon(daemon) {
  const { pid, projectRoot } = daemon;
  let forced = false;
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  let gone = await waitForExit(pid, 3000);
  if (!gone) {
    forced = true;
    try { process.kill(pid, "SIGKILL"); } catch { /* */ }
    gone = await waitForExit(pid, 1500);
  }
  // clear a now-stale pid file for that project
  try {
    const pf = path.join(projectRoot, ".overleaf", "daemon.pid");
    if (existsSync(pf)) {
      const j = JSON.parse(readFileSync(pf, "utf8"));
      if (j && j.pid === pid) rmSync(pf, { force: true });
    }
  } catch { /* ignore */ }
  return { pid, projectRoot, stopped: gone, forced };
}

// daemon.js — sync-mode lifecycle for `watch` (plan: "Sync modes & scheduling").
//
//   foreground (default)        : runs in this process; dies with the CC session
//   --background                : re-spawn detached; survives session end
//   --background --interval N   : detached + periodic polling (lower overhead)
//
// A per-project PID lock (.overleaf/daemon.pid) prevents two daemons driving the
// same project and double-applying edits.

import { spawn } from "node:child_process";
import { writeFile, readFile, rm } from "node:fs/promises";
import { existsSync, openSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { statePath } from "./config.js";

export function pidFile(projectRoot) {
  return statePath(projectRoot, "daemon.pid");
}

export async function readDaemon(projectRoot) {
  const p = pidFile(projectRoot);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return null;
  }
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Re-spawn this CLI detached in foreground mode, recording the child PID. */
export async function spawnBackground(projectRoot, cliPath, argv) {
  const existing = await readDaemon(projectRoot);
  if (existing && isAlive(existing.pid)) {
    throw new Error(`a watch daemon is already running (pid ${existing.pid}); run \`stop\` first.`);
  }
  const logPath = statePath(projectRoot, "daemon.log");
  const out = openSync(logPath, "w"); // fresh log per daemon start (then appends)
  // Strip --background so the child runs the actual foreground loop.
  const childArgs = argv.filter((a) => a !== "--background");
  const child = spawn(process.execPath, [cliPath, ...childArgs], {
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  await writeFile(
    pidFile(projectRoot),
    JSON.stringify({ pid: child.pid, startedAt: Date.now(), argv: childArgs }, null, 2),
    "utf8"
  );
  return child.pid;
}

export async function stopDaemon(projectRoot) {
  const d = await readDaemon(projectRoot);
  if (!d) return { stopped: false, reason: "no daemon recorded" };
  if (isAlive(d.pid)) {
    try {
      process.kill(d.pid, "SIGTERM");
    } catch {
      /* ignore */
    }
  }
  await rm(pidFile(projectRoot), { force: true });
  return { stopped: true, pid: d.pid };
}

export async function clearLock(projectRoot) {
  await rm(pidFile(projectRoot), { force: true });
}

/**
 * Single-instance lock for the process that actually runs the watch loop
 * (foreground OR the detached child). Refuses if a DIFFERENT live watch holds it.
 * Returns a release() that removes the lock (sync-safe for exit handlers).
 */
export function acquireLock(projectRoot, info = {}) {
  const p = pidFile(projectRoot);
  if (existsSync(p)) {
    let prev = null;
    try { prev = JSON.parse(readFileSync(p, "utf8")); } catch { /* stale/corrupt */ }
    if (prev && prev.pid && prev.pid !== process.pid && isAlive(prev.pid)) {
      throw new Error(`a watch is already running (pid ${prev.pid}); run \`overleaf-sync stop\` first.`);
    }
  }
  const startedAt = info.startedAt || Date.now();
  writeFileSync(p, JSON.stringify({ pid: process.pid, startedAt, ...info }, null, 2), "utf8");
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { rmSync(p, { force: true }); } catch { /* ignore */ }
  };
}

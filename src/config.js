// config.js — project state under <projectRoot>/.overleaf/ (stdlib only).
//
// Layout:
//   .overleaf/config.json        { deployment, projectId, projectUrl, mirrorDir }
//   .overleaf/storageState.json  Playwright session (cookies) — chmod 600, gitignored
//   .overleaf/comments.json|.md  the sidecar comment report
//   .overleaf/daemon.pid|.log    background watch daemon

import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export const STATE_DIRNAME = ".overleaf";

export function stateDir(projectRoot) {
  return path.join(projectRoot, STATE_DIRNAME);
}

export function statePath(projectRoot, name) {
  return path.join(stateDir(projectRoot), name);
}

export async function ensureStateDir(projectRoot) {
  const d = stateDir(projectRoot);
  await mkdir(d, { recursive: true });
  return d;
}

export async function readConfig(projectRoot) {
  const p = statePath(projectRoot, "config.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return null;
  }
}

export async function writeConfig(projectRoot, cfg) {
  await ensureStateDir(projectRoot);
  await writeFile(
    statePath(projectRoot, "config.json"),
    JSON.stringify(cfg, null, 2) + "\n",
    "utf8"
  );
}

/** storageState.json holds session cookies — keep it owner-only. */
export async function saveStorageState(projectRoot, state) {
  await ensureStateDir(projectRoot);
  const p = statePath(projectRoot, "storageState.json");
  await writeFile(p, JSON.stringify(state), "utf8");
  try {
    await chmod(p, 0o600);
  } catch {
    /* best effort (e.g. Windows) */
  }
  return p;
}

/**
 * Parse an Overleaf project URL into { deployment, projectId }.
 * Accepts:
 *   https://www.overleaf.com/project/<id>
 *   https://www.overleaf.com/<id>            (read/share links sometimes)
 *   https://<self-hosted>/project/<id>
 */
export function parseProjectUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`not a valid URL: ${url}`);
  }
  const deployment = `${u.protocol}//${u.host}`;
  const m = u.pathname.match(/\/(?:project\/)?([a-f0-9]{16,})/i);
  if (!m) throw new Error(`could not find a project id in: ${url}`);
  return { deployment, projectId: m[1] };
}

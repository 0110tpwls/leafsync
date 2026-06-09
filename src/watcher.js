// watcher.js — local filesystem watch (Phase 3 write-back trigger).
// chokidar is imported lazily so offline/help paths don't need it installed.
// The FsSyncGuard filters out our own inbound-sync writes (loop prevention).

import path from "node:path";
const pathRel = (base, p) => path.relative(base, p);

const TEXT_EXT = new Set([
  ".tex", ".bib", ".cls", ".sty", ".bst", ".txt", ".md", ".markdown",
  ".tikz", ".pgf", ".bbl", ".asy",
]);

// Binary assets Overleaf stores as files (figures etc.) — synced via upload/blob.
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".pdf", ".gif", ".eps", ".svg", ".bmp",
  ".tif", ".tiff", ".webp", ".ico",
]);

function extOf(p) {
  const i = p.lastIndexOf(".");
  return i >= 0 ? p.slice(i).toLowerCase() : "";
}
function isText(p) {
  return TEXT_EXT.has(extOf(p));
}
function isBinary(p) {
  return BINARY_EXT.has(extOf(p));
}

async function chokidar() {
  try {
    return (await import("chokidar")).default;
  } catch {
    throw new Error(
      "chokidar is not installed. From the leafsync repo root run: ./setup.sh (or npm install)"
    );
  }
}

/**
 * Watch `mirrorDir`. Calls onChange({ type, path, binary }) for add/change/unlink
 * of text OR binary files that did NOT originate from our own inbound sync (per
 * fsGuard). `binary` flags figure/asset files. Returns a handle with .close().
 */
export async function watchMirror(mirrorDir, fsGuard, onChange, { ignoreInitial = true, isIgnored = null } = {}) {
  const ch = await chokidar();
  const builtin = /(^|[/\\])(\.overleaf|node_modules|\.git)([/\\]|$)/;
  const ignored = (p) => {
    if (builtin.test(p)) return true;
    if (isIgnored) {
      const rel = pathRel(mirrorDir, p);
      if (rel && !rel.startsWith("..") && isIgnored(rel)) return true; // .overleafignore
    }
    return false;
  };
  const w = ch.watch(mirrorDir, {
    ignoreInitial,
    ignored,
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
  });
  const handler = (type) => (filePath) => {
    const bin = isBinary(filePath);
    if (!isText(filePath) && !bin) return;
    if (fsGuard && fsGuard.isOwnWrite(filePath)) return; // our own write -> ACK, no push
    onChange({ type, path: filePath, binary: bin });
  };
  w.on("add", handler("add"));
  w.on("change", handler("change"));
  w.on("unlink", handler("unlink"));
  // Folder removal: chokidar emits unlinkDir (no extension to filter on). Without
  // this the files inside get deleted on Overleaf but the now-empty folder stays.
  w.on("unlinkDir", (dirPath) => {
    if (fsGuard && fsGuard.isOwnWrite(dirPath)) return; // our own OL→local removal
    onChange({ type: "unlinkDir", path: dirPath, binary: false });
  });
  return w;
}

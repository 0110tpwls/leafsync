// ignore.js — .overleafignore (gitignore-style) matching.
//
// A .overleafignore at the mirror root lets you keep files OUT of the sync in
// both directions: ignored paths are not written by `pull`, not pushed by
// `watch`, and not mirrored when they appear on Overleaf. Handy for LaTeX build
// junk (*.aux, *.log, *.synctex.gz) or local-only notes.
//
// Supported (a practical gitignore subset): blank lines, `#` comments, `!`
// negation, leading `/` (anchor to root), trailing `/` (directory), `*`
// (within a segment), `**` (across segments), `?`, and `[...]` classes.

import { readFile } from "node:fs/promises";
import path from "node:path";

function patternToRegex(pat) {
  const anchored = pat.startsWith("/");
  if (anchored) pat = pat.slice(1);
  if (pat.endsWith("/")) pat = pat.slice(0, -1); // dir pattern -> match dir + contents via trailing (/|$)
  let re = "";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === "*") {
      if (pat[i + 1] === "*") { re += ".*"; i++; if (pat[i + 1] === "/") i++; } // ** (and **/)
      else re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      let j = i + 1, cls = "[";
      while (j < pat.length && pat[j] !== "]") { cls += pat[j]; j++; }
      cls += "]"; i = j; re += cls;
    } else if ("\\^$.|+(){}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  const hasSlash = pat.includes("/");
  const head = anchored || hasSlash ? "^" : "(^|/)";
  return new RegExp(head + re + "(/|$)");
}

/** Compile .overleafignore text into a matcher (rel posix path) -> boolean. */
export function compileIgnore(text) {
  const rules = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) { negate = true; line = line.slice(1); }
    if (!line) continue;
    try { rules.push({ re: patternToRegex(line), negate }); } catch { /* skip bad pattern */ }
  }
  return (rel) => {
    const p = String(rel).split(path.sep).join("/").replace(/^\.?\//, "");
    let ignored = false;
    for (const r of rules) if (r.re.test(p)) ignored = !r.negate; // last match wins (negation)
    return ignored;
  };
}

/** Load `<dir>/.overleafignore`; returns a matcher (ignores nothing if absent). */
export async function loadIgnore(dir) {
  try {
    return compileIgnore(await readFile(path.join(dir, ".overleafignore"), "utf8"));
  } catch {
    return () => false;
  }
}

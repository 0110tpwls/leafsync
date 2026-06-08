// comments.js — turn Overleaf doc ranges + thread messages into the local
// sidecar comment report (.overleaf/comments.json + COMMENTS.md).
//
// buildReport() is PURE (no fs) so it is unit-tested with synthetic payloads.
// writeReport() persists it. This is the headline "see Overleaf comments
// locally" feature; comments are READ-ONLY here (surfaced, never posted back).

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { docText, offsetToLineCol, sliceAt } from "./ot.js";

/**
 * Extract comment anchors from a joinDoc `ranges` object.
 * Overleaf's RangesTracker shape: ranges.comments = [{ id, op:{ p, c, t } }]
 *   p = char offset, c = commented text, t = thread id.
 * Tolerant of missing fields and alternate key names.
 */
export function extractComments(ranges) {
  const out = [];
  const list = (ranges && (ranges.comments || ranges.comment)) || [];
  for (const c of list) {
    const op = c.op || c;
    const threadId = op.t || c.t || c.thread_id || c.id;
    const offset = op.p ?? c.p ?? 0;
    const quoted = op.c ?? c.c ?? "";
    out.push({
      threadId,
      offset,
      length: typeof quoted === "string" ? quoted.length : op.length || 0,
      quoted: typeof quoted === "string" ? quoted : "",
    });
  }
  return out;
}

/**
 * Build the report.
 * @param docs   [{ path, lines?|text?, ranges }]
 * @param threads { [threadId]: { messages:[{user,content,timestamp}], resolved, resolved_at } }
 * @returns { entries: [...], markdown: string }
 */
export function buildReport(docs, threads = {}) {
  const entries = [];
  for (const doc of docs || []) {
    const text = doc.text != null ? doc.text : docText(doc.lines);
    for (const c of extractComments(doc.ranges)) {
      const { line, col } = offsetToLineCol(text, c.offset);
      const quoted = c.quoted || sliceAt(text, c.offset, c.length);
      const thread = threads[c.threadId] || {};
      const messages = (thread.messages || []).map((m) => ({
        author: authorOf(m),
        content: (m.content || "").trim(),
        timestamp: m.timestamp || m.created_at || null,
      }));
      entries.push({
        file: doc.path,
        line,
        col,
        threadId: c.threadId,
        quoted,
        charRange: [c.offset, c.offset + c.length],
        resolved: !!(thread.resolved || thread.resolved_at),
        messages,
      });
    }
  }
  entries.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1
  );
  return { entries, markdown: renderMarkdown(entries) };
}

function authorOf(m) {
  const u = m.user || m.author || {};
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return name || u.name || u.email || "unknown";
}

function renderMarkdown(entries) {
  const open = entries.filter((e) => !e.resolved);
  const resolved = entries.filter((e) => e.resolved);
  const lines = [];
  lines.push("# Overleaf comments");
  lines.push("");
  lines.push(
    `${entries.length} comment${entries.length === 1 ? "" : "s"} — ` +
      `${open.length} open, ${resolved.length} resolved. ` +
      "Read-only mirror of the live Overleaf project; edit in Overleaf to reply/resolve."
  );
  lines.push("");
  const section = (title, list) => {
    if (!list.length) return;
    lines.push(`## ${title}`);
    lines.push("");
    for (const e of list) {
      lines.push(`### ${e.file}:${e.line}${e.resolved ? "  ✓ resolved" : ""}`);
      if (e.quoted) lines.push("> " + e.quoted.replace(/\n/g, "\n> "));
      lines.push("");
      if (e.messages.length === 0) {
        lines.push("_(no thread messages captured)_");
      } else {
        for (const m of e.messages) {
          const when = m.timestamp ? ` _(${formatTs(m.timestamp)})_` : "";
          lines.push(`- **${m.author}**${when}: ${m.content}`);
        }
      }
      lines.push("");
    }
  };
  section("Open", open);
  section("Resolved", resolved);
  return lines.join("\n") + "\n";
}

function formatTs(ts) {
  const n = typeof ts === "number" ? ts : Date.parse(ts);
  if (!Number.isFinite(n)) return String(ts);
  return new Date(n).toISOString().replace("T", " ").slice(0, 16);
}

/** Persist the report next to the project's .overleaf/ state dir. */
export async function writeReport(stateDir, report) {
  await writeFile(
    path.join(stateDir, "comments.json"),
    JSON.stringify(report.entries, null, 2) + "\n",
    "utf8"
  );
  await writeFile(path.join(stateDir, "COMMENTS.md"), report.markdown, "utf8");
}

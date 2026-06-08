// run.js — stdlib-only unit tests for the PURE logic (no browser, no deps).
// Run: node test/run.js
import assert from "node:assert/strict";
import { parseFrame, decodeApplyOtUpdate, decodeJoinDoc, findRanges } from "../src/socketio.js";
import { offsetToLineCol, applyOps, opHitsRange, docText, sliceAt } from "../src/ot.js";
import { buildReport, extractComments } from "../src/comments.js";
import { computeOps, detectCommentConflicts, planReanchors } from "../src/writeback.js";
import { EditEchoGuard, FsSyncGuard } from "../src/loopguard.js";
import { parseProjectUrl } from "../src/config.js";
import { processProjectStructure } from "../src/mirror.js";
import { unzip, stripCommonRoot } from "../src/unzip.js";
import { reconcile, sha256 } from "../src/reconcile.js";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`  ok  ${name}`); };

// --- socketio frame parsing ---
t("parseFrame legacy event", () => {
  const f = parseFrame('5:::{"name":"applyOtUpdate","args":["doc1",{"op":[{"i":"x","p":2}],"v":7}]}');
  assert.equal(f.type, "event");
  assert.equal(f.name, "applyOtUpdate");
  const ot = decodeApplyOtUpdate(f.args);
  assert.equal(ot.docId, "doc1");
  assert.equal(ot.version, 7);
  assert.equal(ot.op[0].i, "x");
});
t("parseFrame legacy ack (joinDoc body)", () => {
  const f = parseFrame('6:::12+[null,["line one","line two"],3,{"comments":[]}]');
  assert.equal(f.type, "ack");
  assert.equal(f.ack, 12);
  const jd = decodeJoinDoc(f.args);
  assert.deepEqual(jd.lines, ["line one", "line two"]);
  assert.equal(jd.version, 3);
});
t("decodeJoinDoc finds ranges at www's index 4 (6-element ack)", () => {
  // www.overleaf.com: [null, lines, version, changes[], ranges{comments}, otType]
  const body = [null, ["a", "\\section{Method}"], 4, [],
    { comments: [{ id: "t1", op: { c: "\\section{Method}", p: 2, t: "t1" } }], changes: [] },
    "sharejs-text-ot"];
  const jd = decodeJoinDoc(body);
  assert.deepEqual(jd.lines, ["a", "\\section{Method}"]);
  assert.equal(jd.version, 4);
  assert.equal(jd.ranges.comments.length, 1);
  assert.equal(jd.ranges.comments[0].op.c, "\\section{Method}");
});
t("decodeJoinDoc still finds classic index-3 ranges", () => {
  const jd = decodeJoinDoc([null, ["x"], 3, { comments: [{ op: { p: 0, c: "x", t: "t" } }] }]);
  assert.equal(jd.ranges.comments.length, 1);
});
t("findRanges ignores empty arrays/objects, returns null when none", () => {
  assert.equal(findRanges([null, ["x"], 1, [], {}, "ot"]), null);
});
t("parseFrame engine.io v2 event", () => {
  const f = parseFrame('42["applyOtUpdate",["d2",{"op":[{"d":"z","p":0}],"v":1}]]');
  assert.equal(f.type, "event");
  assert.equal(f.name, "applyOtUpdate");
});
t("parseFrame heartbeats", () => {
  assert.equal(parseFrame("2::").type, "heartbeat");
  assert.equal(parseFrame("2").type, "heartbeat");
});

// --- ot helpers ---
t("offsetToLineCol", () => {
  const text = "abc\ndefg\nhi";
  assert.deepEqual(offsetToLineCol(text, 0), { line: 1, col: 1 });
  assert.deepEqual(offsetToLineCol(text, 4), { line: 2, col: 1 }); // 'd'
  assert.deepEqual(offsetToLineCol(text, 9), { line: 3, col: 1 }); // 'h'
});
t("applyOps insert+delete", () => {
  assert.equal(applyOps("hello", [{ i: "X", p: 0 }]), "Xhello");
  assert.equal(applyOps("hello", [{ d: "he", p: 0 }]), "llo");
});
t("opHitsRange detects overlap only for deletes inside range", () => {
  assert.equal(opHitsRange({ d: "ll", p: 2 }, 2, 3), true);   // delete inside [2,5)
  assert.equal(opHitsRange({ d: "h", p: 0 }, 2, 3), false);   // delete before range
  assert.equal(opHitsRange({ i: "x", p: 3 }, 2, 3), false);   // insert never collapses
});
t("docText/sliceAt", () => {
  assert.equal(docText(["a", "b"]), "a\nb");
  assert.equal(sliceAt("hello world", 6, 5), "world");
});

// --- comments report (the headline) ---
t("buildReport maps a comment to file:line with thread messages", () => {
  const text = "Intro line.\nWe improve accuracy here.\nDone.";
  const offset = text.indexOf("accuracy");
  const docs = [{
    path: "methods.tex", text,
    ranges: { comments: [{ id: "c1", op: { p: offset, c: "accuracy", t: "thr1" } }] },
  }];
  const threads = { thr1: { messages: [{ user: { first_name: "Rev", last_name: "Iewer" }, content: "needs a citation", timestamp: 1700000000000 }], resolved: false } };
  const { entries, markdown } = buildReport(docs, threads);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].file, "methods.tex");
  assert.equal(entries[0].line, 2);
  assert.equal(entries[0].quoted, "accuracy");
  assert.equal(entries[0].resolved, false);
  assert.equal(entries[0].messages[0].author, "Rev Iewer");
  assert.match(markdown, /methods\.tex:2/);
  assert.match(markdown, /needs a citation/);
});
t("extractComments tolerates resolved + missing thread", () => {
  const docs = [{ path: "a.tex", text: "xxxxxxxx", ranges: { comments: [{ op: { p: 1, c: "xx", t: "T" } }] } }];
  const { entries } = buildReport(docs, { T: { resolved_at: 123, messages: [] } });
  assert.equal(entries[0].resolved, true);
  assert.equal(entries[0].messages.length, 0);
});

// --- writeback diff + conflict ---
t("computeOps is minimal (changed middle only)", () => {
  const ops = computeOps("the quick brown fox", "the slow brown fox");
  // only "quick" -> "slow" region changes
  assert.ok(ops.some((o) => o.d === "quick"));
  assert.ok(ops.some((o) => o.i === "slow"));
});
t("computeOps no-op when equal", () => {
  assert.deepEqual(computeOps("same", "same"), []);
});
t("detectCommentConflicts flags edit over a commented span", () => {
  const text = "we improve accuracy here";
  const ranges = { comments: [{ op: { p: text.indexOf("accuracy"), c: "accuracy", t: "t" } }] };
  const overlapping = computeOps(text, text.replace("accuracy", "speed"));
  const safe = computeOps(text, text.replace("here", "now"));
  assert.ok(detectCommentConflicts(overlapping, ranges).length >= 1);
  assert.equal(detectCommentConflicts(safe, ranges).length, 0);
});
t("planReanchors re-attaches a thread to the replacement text", () => {
  const text = "we improve accuracy here";
  const ranges = { comments: [{ op: { p: text.indexOf("accuracy"), c: "accuracy", t: "thr1" } }] };
  const next = text.replace("accuracy", "speed");
  const ops = computeOps(text, next);
  const plan = planReanchors(ops, detectCommentConflicts(ops, ranges), next);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].t, "thr1");
  assert.equal(plan[0].c, "speed");              // anchor to the replacement
  assert.equal(next.slice(plan[0].p, plan[0].p + plan[0].c.length), "speed"); // position valid
});
t("planReanchors handles pure deletion (anchor to a survivor char)", () => {
  const text = "alpha BETA gamma";
  const ranges = { comments: [{ op: { p: text.indexOf("BETA"), c: "BETA", t: "t2" } }] };
  const next = text.replace("BETA ", ""); // delete the commented word
  const ops = computeOps(text, next);
  const plan = planReanchors(ops, detectCommentConflicts(ops, ranges), next);
  assert.equal(plan.length, 1);
  assert.ok(plan[0].c.length >= 1);
  assert.equal(next.slice(plan[0].p, plan[0].p + plan[0].c.length), plan[0].c);
});

// --- loop guards ---
t("EditEchoGuard drops our echo once", () => {
  let now = 1000;
  const g = new EditEchoGuard({ ttl: 100, now: () => now });
  const op = [{ i: "x", p: 0 }];
  g.markSubmitted("d", op);
  assert.equal(g.shouldDrop("d", op), true);   // echo dropped
  assert.equal(g.shouldDrop("d", op), false);  // only once
  g.markSubmitted("d", op);
  now += 200;                                   // expired
  assert.equal(g.shouldDrop("d", op), false);
});
t("FsSyncGuard recognises own write", () => {
  const g = new FsSyncGuard();
  g.markWrite("/m/a.tex");
  assert.equal(g.isOwnWrite("/m/a.tex"), true);
  assert.equal(g.isOwnWrite("/m/a.tex"), false);
  assert.equal(g.isOwnWrite("/m/b.tex"), false);
});

// --- config + tree ---
t("parseProjectUrl", () => {
  const r = parseProjectUrl("https://www.overleaf.com/project/0123456789abcdef0123");
  assert.equal(r.deployment, "https://www.overleaf.com");
  assert.equal(r.projectId, "0123456789abcdef0123");
});
t("processProjectStructure BFS", () => {
  const project = { rootFolder: [{
    docs: [{ _id: "d1", name: "main.tex" }],
    fileRefs: [{ _id: "f1", name: "fig.png", hash: "abc" }],
    folders: [{ name: "sections", docs: [{ _id: "d2", name: "intro.tex" }], folders: [], fileRefs: [] }],
  }] };
  const { folders, docs, files } = processProjectStructure(project);
  assert.deepEqual(folders, ["sections"]);
  assert.deepEqual(docs.map((d) => d.path).sort(), ["main.tex", "sections/intro.tex"]);
  assert.equal(files[0].path, "fig.png");
});

// --- zip extraction (content mirror path) ---
t("unzip extracts text + nested deflate entries", () => {
  // fixture: a real zip (m.tex="A\\section{x}\n", d/n.tex="BB\n"), base64.
  const b64 =
    "UEsDBAoAAAAAAPpwxlypTfIWDQAAAA0AAAAFABwAbS50ZXhVVAkAAyerI2onqyNqdXgLAAEE9QEAAAQAAAAAQVxzZWN0aW9ue3h9ClBLAwQKAAAAAAD6cMZcAAAAAAAAAAAAAAAAAgAcAGQvVVQJAAMnqyNqJ6sjanV4CwABBPUBAAAEAAAAAFBLAwQKAAAAAAD6cMZcJUTFrgMAAAADAAAABwAcAGQvbi50ZXhVVAkAAyerI2onqyNqdXgLAAEE9QEAAAQAAAAAQkIKUEsBAh4DCgAAAAAA+nDGXKlN8hYNAAAADQAAAAUAGAAAAAAAAQAAAKSBAAAAAG0udGV4VVQFAAMnqyNqdXgLAAEE9QEAAAQAAAAAUEsBAh4DCgAAAAAA+nDGXAAAAAAAAAAAAAAAAAIAGAAAAAAAAAAQAO1BTAAAAGQvVVQFAAMnqyNqdXgLAAEE9QEAAAQAAAAAUEsBAh4DCgAAAAAA+nDGXCVExa4DAAAAAwAAAAcAGAAAAAAAAQAAAKSBiAAAAGQvbi50ZXhVVAUAAyerI2p1eAsAAQT1AQAABAAAAABQSwUGAAAAAAMAAwDgAAAAzAAAAAAA";
  const entries = stripCommonRoot(unzip(Buffer.from(b64, "base64")));
  const byName = new Map(entries.filter((e) => !e.dir).map((e) => [e.name, e.data.toString("utf8")]));
  assert.equal(byName.get("m.tex"), "A\\section{x}\n");
  assert.equal(byName.get("d/n.tex"), "BB\n");
});
t("unzip throws on non-zip", () => {
  assert.throws(() => unzip(Buffer.from("not a zip at all")), /not a ZIP/);
});

// --- reconcile: pull must never silently overwrite local edits ---
await (async () => {
  const E = (name, s) => ({ name, data: Buffer.from(s) });
  // fresh dir, no baseline -> everything is "created"
  let dir = mkdtempSync(path.join(os.tmpdir(), "olrec-"));
  let r = await reconcile({ mirrorDir: dir, entries: [E("a.tex", "v1"), E("b.tex", "x")], manifest: {} });
  t("reconcile: new files created", () => {
    assert.deepEqual(r.result.created.sort(), ["a.tex", "b.tex"]);
    assert.equal(readFileSync(path.join(dir, "a.tex"), "utf8"), "v1");
  });
  const base = r.manifest;

  // local untouched, remote changed -> fast-forward update
  r = await reconcile({ mirrorDir: dir, entries: [E("a.tex", "v2"), E("b.tex", "x")], manifest: base });
  t("reconcile: untouched local fast-forwards", () => {
    assert.deepEqual(r.result.updated, ["a.tex"]);
    assert.equal(readFileSync(path.join(dir, "a.tex"), "utf8"), "v2");
  });

  // local edited, remote unchanged -> KEEP local (no clobber)
  dir = mkdtempSync(path.join(os.tmpdir(), "olrec-"));
  writeFileSync(path.join(dir, "a.tex"), "BASE");
  const m = { "a.tex": sha256(Buffer.from("BASE")) };
  writeFileSync(path.join(dir, "a.tex"), "MY LOCAL EDIT"); // user edits after baseline
  r = await reconcile({ mirrorDir: dir, entries: [E("a.tex", "BASE")], manifest: m });
  t("reconcile: local edit kept when remote unchanged", () => {
    assert.deepEqual(r.result.kept, ["a.tex"]);
    assert.equal(readFileSync(path.join(dir, "a.tex"), "utf8"), "MY LOCAL EDIT");
  });

  // local edited AND remote changed -> conflict, local kept, incoming stashed
  r = await reconcile({ mirrorDir: dir, entries: [E("a.tex", "REMOTE NEW")], manifest: m });
  t("reconcile: both-changed -> conflict, local preserved, sidecar written", () => {
    assert.equal(r.result.conflicts.length, 1);
    assert.equal(readFileSync(path.join(dir, "a.tex"), "utf8"), "MY LOCAL EDIT");
    assert.equal(readFileSync(path.join(dir, "a.tex.overleaf-incoming"), "utf8"), "REMOTE NEW");
  });

  // --force overwrites regardless
  r = await reconcile({ mirrorDir: dir, entries: [E("a.tex", "FORCED")], manifest: m, force: true });
  t("reconcile: --force clobbers local", () => {
    assert.equal(readFileSync(path.join(dir, "a.tex"), "utf8"), "FORCED");
  });
})();

console.log(`\n${pass} tests passed.`);

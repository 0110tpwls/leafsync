// run.js — stdlib-only unit tests for the PURE logic (no browser, no deps).
// Run: node test/run.js
import assert from "node:assert/strict";
import { parseFrame, decodeApplyOtUpdate, decodeJoinDoc, findRanges } from "../src/socketio.js";
import { offsetToLineCol, applyOps, opApplies, opHitsRange, docText, sliceAt } from "../src/ot.js";
import { buildReport, extractComments } from "../src/comments.js";
import { computeOps, detectCommentConflicts, planReanchors } from "../src/writeback.js";
import { EditEchoGuard, FsSyncGuard } from "../src/loopguard.js";
import { parseProjectUrl } from "../src/config.js";
import { processProjectStructure } from "../src/mirror.js";
import { unzip, stripCommonRoot } from "../src/unzip.js";
import { reconcile, sha256 } from "../src/reconcile.js";
import { ensureParentFolder } from "../src/tree.js";
import { parseDaemonCommand } from "../src/daemons.js";
import { merge3, MARK_START, MARK_MID, MARK_END, unifiedDiff } from "../src/merge.js";
import { reviewStatus, renderReview } from "../src/review.js";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { compileIgnore } from "../src/ignore.js";
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

// --- ensureParentFolder: a bulk add must not double-create a shared new folder ---
// Regression for the soak finding: dropping a whole project in fires many
// concurrent watcher events; several files share a brand-new folder. The naive
// version had each POST createFolder, so all-but-one got a fatal HTTP 400.
await (async () => {
  let folderPosts = 0;
  const created = new Map(); // (parentId/name) -> id, mimics Overleaf's uniqueness
  const fakePage = {
    // stands in for api()'s page.evaluate -> returns {ok,status,data}
    evaluate: async (_fn, arg) => {
      if (arg.method === "POST" && arg.path.endsWith("/folder")) {
        folderPosts++;
        const key = `${arg.body.parent_folder_id}/${arg.body.name}`;
        if (created.has(key)) return { ok: false, status: 400, data: { message: "exists" } };
        const id = "F" + created.size;
        created.set(key, id);
        return { ok: true, status: 200, data: { _id: id } };
      }
      return { ok: true, status: 200, data: {} };
    },
  };
  const folders = { rootId: "root", map: new Map([["", "root"]]) };
  const files = ["sections/a.tex", "sections/b.tex", "sections/c.tex", "sections/d.tex", "sections/e.tex"];
  const ids = await Promise.all(files.map((f) => ensureParentFolder(fakePage, "B", "P", "C", f, folders)));
  t("ensureParentFolder dedupes concurrent bulk-add (no createFolder 400 storm)", () => {
    assert.equal(new Set(ids).size, 1, "all files resolve to the same folder id");
    assert.equal(folderPosts, 1, "the shared folder is created exactly once");
    assert.equal(folders.map.get("sections"), ids[0]);
  });

  // nested shared folder: figures/experiments/* — both levels created once
  folderPosts = 0; created.clear();
  const folders2 = { rootId: "root", map: new Map([["", "root"]]) };
  const nested = ["figures/experiments/x.pdf", "figures/experiments/y.png", "figures/teaser.jpg"];
  await Promise.all(nested.map((f) => ensureParentFolder(fakePage, "B", "P", "C", f, folders2)));
  t("ensureParentFolder creates each nested folder once under concurrency", () => {
    assert.equal(folderPosts, 2, "figures + figures/experiments, one POST each");
    assert.ok(folders2.map.get("figures"));
    assert.ok(folders2.map.get("figures/experiments"));
  });
})();

// --- daemon discovery: identify our own watch processes from a ps command line ---
t("parseDaemonCommand: a leafsync watch daemon (project-root last)", () => {
  const cmd = "/usr/bin/node /Users/x/leafsync/src/cli.js watch --push --project-root /Users/x/paper";
  const d = parseDaemonCommand(cmd);
  assert.equal(d.projectRoot, "/Users/x/paper");
  assert.equal(d.push, true);
  assert.equal(d.interval, null);
});
t("parseDaemonCommand: interval + project-root followed by another flag", () => {
  const cmd = "node /opt/leafsync/src/cli.js watch --interval 120 --project-root /home/u/my paper --mirror sub";
  const d = parseDaemonCommand(cmd);
  assert.equal(d.projectRoot, "/home/u/my paper"); // tolerate spaces, stop at --mirror
  assert.equal(d.interval, 120);
  assert.equal(d.push, false);
});
t("parseDaemonCommand: read-only daemon (no --push)", () => {
  const d = parseDaemonCommand("node /a/src/cli.js watch --project-root /p");
  assert.equal(d.push, false);
  assert.equal(d.projectRoot, "/p");
});
t("parseDaemonCommand: ignores non-watch and non-cli processes", () => {
  assert.equal(parseDaemonCommand("node /a/src/cli.js stop --ls"), null); // not watch
  assert.equal(parseDaemonCommand("node /a/src/cli.js pull --project-root /p"), null);
  assert.equal(parseDaemonCommand("/Applications/Foo.app watch --project-root /p"), null); // not cli.js
  assert.equal(parseDaemonCommand("node /a/src/cli.js watch"), null); // no project-root
  assert.equal(parseDaemonCommand(""), null);
});

// --- remote-edit decode: the three otUpdateApplied / applyOtUpdate shapes ---
t("decodeApplyOtUpdate: client send [docId, {op,v}]", () => {
  const d = decodeApplyOtUpdate(["doc1", { op: [{ i: "x", p: 2 }], v: 7 }]);
  assert.equal(d.docId, "doc1");
  assert.equal(d.version, 7);
  assert.equal(d.op[0].i, "x");
});
t("decodeApplyOtUpdate: server broadcast [{op,v,meta}] (remote edit, NO doc id)", () => {
  // verified live shape — routing must fall back to version, docId is undefined
  const d = decodeApplyOtUpdate([{ op: [{ i: "ZZ", p: 0 }], v: 10, meta: { source: "P.x", user_id: "u" } }]);
  assert.equal(d.docId, undefined);
  assert.equal(d.version, 10);
  assert.deepEqual(d.op, [{ i: "ZZ", p: 0 }]);
  assert.equal(d.meta.source, "P.x");
});
t("decodeApplyOtUpdate: sender ack [{v}] decodes to an empty op (ignored upstream)", () => {
  const d = decodeApplyOtUpdate([{ v: 11 }]);
  assert.equal(d.version, 11);
  assert.deepEqual(d.op, []);
});

// --- opApplies: which doc does a doc-id-less op belong to? ---
t("opApplies: clean insert/delete vs out-of-range / mismatched delete", () => {
  assert.equal(opApplies("hello", [{ i: "X", p: 5 }]), true); // insert at end ok
  assert.equal(opApplies("hello", [{ i: "X", p: 99 }]), false); // OOB
  assert.equal(opApplies("hello", [{ d: "lo", p: 3 }]), true); // matches "lo"
  assert.equal(opApplies("hello", [{ d: "XX", p: 0 }]), false); // text isn't "XX"
  assert.equal(opApplies("ab", [{ i: "Z", p: 0 }, { d: "a", p: 1 }]), true); // sequential
});

// --- echo guard: drop our own edit by op signature alone (broadcast omits docId) ---
t("EditEchoGuard.shouldDropByOp drops our submitted op without a docId", () => {
  const g = new EditEchoGuard({ now: () => 1000 });
  g.markSubmitted("docA", [{ i: "hi", p: 0 }]);
  assert.equal(g.shouldDropByOp([{ i: "hi", p: 0 }]), true); // first time -> drop
  assert.equal(g.shouldDropByOp([{ i: "hi", p: 0 }]), false); // consumed
  assert.equal(g.shouldDropByOp([{ i: "other", p: 0 }]), false);
});

// --- merge3: git-style 3-way line merge ---
const J = (s) => s.join("\n");
t("merge3: only local changed -> take local, clean", () => {
  const r = merge3(J(["a", "b", "c"]), J(["a", "X", "c"]), J(["a", "b", "c"]));
  assert.equal(r.clean, true);
  assert.equal(r.text, J(["a", "X", "c"]));
});
t("merge3: only incoming changed -> take incoming, clean", () => {
  const r = merge3(J(["a", "b", "c"]), J(["a", "b", "c"]), J(["a", "Y", "c"]));
  assert.equal(r.clean, true);
  assert.equal(r.text, J(["a", "Y", "c"]));
});
t("merge3: non-overlapping edits auto-merge cleanly", () => {
  // local edits line 1, incoming edits line 3 — both should land
  const r = merge3(J(["a", "b", "c"]), J(["A", "b", "c"]), J(["a", "b", "C"]));
  assert.equal(r.clean, true);
  assert.equal(r.text, J(["A", "b", "C"]));
});
t("merge3: same region changed differently -> conflict markers", () => {
  const r = merge3(J(["a", "b", "c"]), J(["a", "X", "c"]), J(["a", "Y", "c"]));
  assert.equal(r.clean, false);
  assert.equal(r.conflicts.length, 1);
  assert.deepEqual(r.conflicts[0], { local: ["X"], incoming: ["Y"] });
  assert.ok(r.text.includes(MARK_START) && r.text.includes(MARK_MID) && r.text.includes(MARK_END));
  // local side appears before the divider, incoming after
  assert.ok(r.text.indexOf("X") < r.text.indexOf(MARK_MID));
  assert.ok(r.text.indexOf("Y") > r.text.indexOf(MARK_MID));
});
t("merge3: identical change on both sides -> clean (no conflict)", () => {
  const r = merge3(J(["a", "b"]), J(["a", "Z"]), J(["a", "Z"]));
  assert.equal(r.clean, true);
  assert.equal(r.text, J(["a", "Z"]));
});
t("merge3: trailing-newline-only difference is not a conflict", () => {
  const r = merge3("a\nb", "a\nb\n", "a\nb");
  assert.equal(r.clean, true);
});

// --- reconcile 3-way (base shadow) + resolve + stash (full git-like flow) ---
await (async () => {
  const { reconcile } = await import("../src/reconcile.js");
  const { listConflicts, resolveAll, stashSave, stashPop } = await import("../src/resolve.js");
  const E = (name, s) => ({ name, data: Buffer.from(s) });
  const mk = () => mkdtempSync(path.join(os.tmpdir(), "olm-"));
  // establish a baseline so .overleaf/base + manifest exist
  const setup = async (baseText) => {
    const dir = mk(); const sd = path.join(dir, ".overleaf");
    const r = await reconcile({ mirrorDir: dir, entries: [E("f.tex", baseText)], manifest: {}, stateDir: sd });
    return { dir, sd, manifest: r.manifest };
  };

  // auto-merge: local edits one line, Overleaf another -> both land, clean
  {
    const { dir, sd, manifest } = await setup("L1\nL2\nL3");
    writeFileSync(path.join(dir, "f.tex"), "L1\nLOCAL\nL3");
    const r = await reconcile({ mirrorDir: dir, entries: [E("f.tex", "OL1\nL2\nL3")], manifest, stateDir: sd });
    t("reconcile: 3-way auto-merge of non-overlapping edits", () => {
      assert.deepEqual(r.result.merged, ["f.tex"]);
      assert.equal(readFileSync(path.join(dir, "f.tex"), "utf8"), "OL1\nLOCAL\nL3");
    });
  }

  // true conflict: both edit the SAME line differently
  {
    const { dir, sd, manifest } = await setup("L1\nL2\nL3");
    writeFileSync(path.join(dir, "f.tex"), "L1\nMINE\nL3");
    const r = await reconcile({ mirrorDir: dir, entries: [E("f.tex", "L1\nTHEIRS\nL3")], manifest, stateDir: sd });
    const cj = await listConflicts(sd);
    const markered = readFileSync(path.join(sd, "conflicts", "f.tex"), "utf8");
    const theirs = readFileSync(path.join(sd, "conflicts", "f.tex.theirs"), "utf8");
    t("reconcile: true conflict keeps local live + writes markered sidecar + conflicts.json", () => {
      assert.equal(r.result.conflicts.length, 1);
      assert.equal(readFileSync(path.join(dir, "f.tex"), "utf8"), "L1\nMINE\nL3"); // live keeps YOURS
      assert.deepEqual(cj.map((c) => c.path), ["f.tex"]);
      assert.ok(markered.includes("MINE") && markered.includes("THEIRS") && markered.includes("<<<<<<<"));
      assert.equal(theirs, "L1\nTHEIRS\nL3");
    });
    // resolve --theirs clears it
    const res = await resolveAll(sd, dir, "theirs");
    const after = await listConflicts(sd);
    t("resolve --theirs takes Overleaf's version and clears the conflict", () => {
      assert.deepEqual(res.resolved, ["f.tex"]);
      assert.equal(readFileSync(path.join(dir, "f.tex"), "utf8"), "L1\nTHEIRS\nL3");
      assert.equal(after.length, 0);
    });
  }

  // stash: save local, revert to base, then pop merges onto a (changed) pull
  {
    const { dir, sd, manifest } = await setup("B1\nB2\nB3");
    writeFileSync(path.join(dir, "f.tex"), "B1\nMINE\nB3");
    const saved = await stashSave(sd, dir, manifest);
    const reverted = readFileSync(path.join(dir, "f.tex"), "utf8");
    writeFileSync(path.join(dir, "f.tex"), "OL1\nB2\nB3"); // simulate a pull that changed another line
    const pop = await stashPop(sd, dir);
    t("stash + pop: shelves local, reverts to base, re-applies via 3-way merge", () => {
      assert.deepEqual(saved, ["f.tex"]);
      assert.equal(reverted, "B1\nB2\nB3"); // reverted to base after stash
      assert.deepEqual(pop.popped, ["f.tex"]);
      assert.equal(readFileSync(path.join(dir, "f.tex"), "utf8"), "OL1\nMINE\nB3"); // both changes
    });
  }
})();

// --- .overleafignore matching ---
t("compileIgnore: glob, dir, anchor, segment patterns", () => {
  const ig = compileIgnore("# build junk\n*.aux\nbuild/\n/main.pdf\nfigures/*.png\n");
  assert.equal(ig("paper.aux"), true);          // *.aux at root
  assert.equal(ig("sec/paper.aux"), true);      // *.aux at any depth
  assert.equal(ig("build/x.tex"), true);        // directory pattern
  assert.equal(ig("rebuild/x.tex"), false);     // word boundary, not 'build'
  assert.equal(ig("main.pdf"), true);           // anchored to root
  assert.equal(ig("sub/main.pdf"), false);      // anchored -> not nested
  assert.equal(ig("figures/a.png"), true);
  assert.equal(ig("figures/sub/a.png"), false); // * does not cross '/'
  assert.equal(ig("main.tex"), false);
});
t("compileIgnore: '!' negation (last match wins)", () => {
  const ig = compileIgnore("*.tex\n!keep.tex");
  assert.equal(ig("a.tex"), true);
  assert.equal(ig("keep.tex"), false);
});

// --- pull --dry-run: classify without touching disk ---
await (async () => {
  const { reconcile } = await import("../src/reconcile.js");
  const dir = mkdtempSync(path.join(os.tmpdir(), "oldry-"));
  const sd = path.join(dir, ".overleaf");
  const r = await reconcile({ mirrorDir: dir, entries: [{ name: "new.tex", data: Buffer.from("hi") }], manifest: {}, stateDir: sd, dryRun: true });
  t("reconcile --dry-run classifies but writes nothing", () => {
    assert.deepEqual(r.result.created, ["new.tex"]);
    assert.equal(existsSync(path.join(dir, "new.tex")), false);   // file NOT written
    assert.equal(existsSync(path.join(sd, "base", "new.tex")), false); // base NOT written
  });
})();

// --- unifiedDiff + review classification ---
t("unifiedDiff: hunk with -/+ and a valid @@ header", () => {
  const d = unifiedDiff("a\nb\nc\nd\ne", "a\nb\nX\nd\ne", { aLabel: "old", bLabel: "new" });
  assert.ok(d.includes("--- old") && d.includes("+++ new"));
  assert.ok(d.includes("-c") && d.includes("+X"));
  assert.ok(/@@ -\d+,\d+ \+\d+,\d+ @@/.test(d));
  assert.ok(d.includes(" b") && d.includes(" d")); // context kept
});
t("unifiedDiff: identical -> empty", () => {
  assert.equal(unifiedDiff("a\nb", "a\nb"), "");
});
t("reviewStatus: outgoing / incoming / conflict / insync / differs", () => {
  assert.equal(reviewStatus("base", "MINE", "base"), "outgoing");
  assert.equal(reviewStatus("base", "base", "THEIRS"), "incoming");
  assert.equal(reviewStatus("base", "MINE", "THEIRS"), "conflict");
  assert.equal(reviewStatus("base", "same", "same"), "insync");
  assert.equal(reviewStatus(null, "x", "y"), "differs");
});
t("renderReview: groups + shows outgoing diff (+ = what you'd push)", () => {
  const r = renderReview([
    { path: "a.tex", base: "L1\nL2", local: "L1\nMINE", overleaf: "L1\nL2" }, // outgoing
    { path: "b.tex", base: "L1\nL2", local: "L1\nL2", overleaf: "L1\nTHEIRS" }, // incoming
    { path: "c.tex", base: "x", local: "x", overleaf: "x" }, // insync
  ]);
  assert.ok(r.includes("1 outgoing, 1 incoming, 0 conflict, 1 in sync"));
  assert.ok(r.includes("OUTGOING") && r.includes("a.tex") && r.includes("+MINE"));
  assert.ok(r.includes("INCOMING") && r.includes("+THEIRS"));
});

console.log(`\n${pass} tests passed.`);

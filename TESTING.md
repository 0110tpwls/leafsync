# leafsync — real-project soak testing guide

How to soak-test leafsync against a live Overleaf project (e.g. `IMDL_midterm`)
before trusting it on a real paper. Every test lists **what** it checks, **how**
to run it, and **what to look for** (pass signals + red flags).

> **Golden rule:** soak only against a **throwaway** project, and keep a **git
> backup** of the local mirror the whole time. Treat any *silent* data loss
> (a local edit or a reviewer comment that disappears with no message) as a
> release blocker, not a quirk.

---

## 0. Setup

```bash
# one-time
cd /path/to/leafsync && ./setup.sh

# pick/!create! a throwaway Overleaf project, then in a fresh local folder:
mkdir ~/soak && cd ~/soak
node /path/to/leafsync/src/cli.js link https://www.overleaf.com/project/<id>
git init && echo ".overleaf/" > .gitignore   # so you can diff/restore the mirror
```

Keep two terminals: one running `watch` (or tailing `.overleaf/daemon.log`), one
for edits + `git status`/`git diff` on the mirror.

> ⚠️ If `pull` fails with `ZIP download failed ... status 500` repeatedly on a
> project (see **Known issues**), that project's bulk-download endpoint is wedged
> — start the soak on a **freshly created** project instead.

---

## 1. Baseline read (link + pull)

- **What:** auth works, the whole project mirrors locally, comments surface.
- **How:**
  ```bash
  node $CLI pull --verbose --project-root "$(pwd)"
  cat .overleaf/COMMENTS.md
  ```
- **Look for:** `project tree: N docs, M binary files, K folders` matches the web
  UI; local files match the web; `COMMENTS.md` lists every open reviewer comment as
  `file.tex:line` with author + quote. **Red flags:** 0-byte files, missing
  subfolders, a wrong line number on a comment, ZIP-500.

## 2. Bulk-add an authentic project (local → OL) ← the scenario that found a bug

- **What:** dropping a realistic nested project into the mirror uploads *every*
  file/folder/figure (this is where the concurrent-folder-create race lived).
- **How:** with `watch --push` running, copy a real paper layout in at once:
  ```
  paper/
    main.tex  preamble.tex
    sections/{01-intro,02-related,03-method,04-exp,05-concl}.tex
    figures/{logo.png,teaser.jpg,system.pdf}
    figures/experiments/{accuracy.pdf,loss.png}
    bib/references.bib  tables/results.tex
  ```
  ```bash
  cp -R paper "$(pwd)/paper"     # bulk drop while the daemon watches
  tail -f .overleaf/daemon.log
  ```
- **Look for:** every file logs `local→OL: created …`/`uploaded …`; the web tree
  gains exactly those docs/folders/binaries. **Red flags (the old bug):**
  `createFolder X: HTTP 400` lines, or files in a shared new folder (`sections/`,
  `figures/`) that never upload. Verify the tree count delta equals what you added.

## 3. Binary integrity round-trip

- **What:** images/PDFs are byte-identical after a round-trip (no corruption).
- **How:** after they upload, re-pull into a clean dir and compare:
  ```bash
  shasum -a 256 paper/figures/system.pdf
  # …pull elsewhere, then shasum the pulled copy and compare
  ```
- **Look for:** identical SHA-256 and byte length for `.pdf/.png/.jpg`.
  **Red flags:** size drift, a text-ified binary, a 0-byte figure.

## 4. OL → local content edit

- **What:** an edit made in the Overleaf web editor reaches the local file.
- **How:** with `watch` running, type a sentence into a doc on the web and save.
- **Look for:** `OL→local: applied edit …` in the log within a few seconds; the
  local file now contains the new text; `git diff` shows exactly that change.
  **Red flags:** the edit never arrives, arrives duplicated, or clobbers unrelated
  local lines.

## 5. local → OL content edit + version tracking

- **What:** a local edit reaches the web editor, and stale-version pushes still land.
- **How:** with `watch --push`, edit a `.tex` locally and save. Then make several
  quick successive edits.
- **Look for:** `local→OL: … (N content op(s))` and the text appearing in the web
  editor within seconds; rapid edits all land in order. **Red flags:** an edit
  silently dropped, the whole document re-sent (should be *minimal ops*), or the
  push stalling after the first op.

## 6. Comment surfacing + live refresh

- **What:** reviewer comments show locally, and new ones appear during `watch`.
- **How:** add a comment on the web (select text → comment). Re-run
  `node $CLI comments`. (Then check whether an active `watch` reflects it without a
  manual refresh.)
- **Look for:** the new thread in `COMMENTS.md` at the right `file:line` with the
  quoted span and author; resolving it on the web flips its status on refresh.
  **Red flag / known gap:** comments are snapshotted at `watch` start — a comment
  added *during* a watch session may not refresh until the next `pull`/`comments`.

## 7. Comment preservation (re-anchoring) ← most important correctness test

- **What:** editing near or over commented text never *silently* drops the comment.
- **How (a, near):** with `watch --push`, edit text just *outside* a commented span.
- **How (b, over):** rewrite the *exact* commented words locally and save.
- **Look for:** (a) the comment stays attached, unchanged; (b) the log shows a
  comment-overlap detection + `re-anchor`, the thread + its replies survive on the
  web (possibly moved to the new text). **Red flag:** the comment thread vanishes
  with no log line — a silent loss (blocker).

## 8. Tree ops, OL → local

- **What:** create / rename / move / delete of docs *and folders* on the web mirror
  locally (a folder rename should relabel its whole subtree).
- **How:** on the web: new folder + file in it; rename a folder; drag a file into
  another folder; delete a file. Watch the log + local tree.
- **Look for:** `OL→local: new folder/doc …`, `renamed …`, `moved …`, `removed …`;
  the local tree matches exactly, subtree intact after a folder rename.
  **Red flags:** orphaned local files after a remote delete/move; a folder rename
  that drops children.

## 9. Tree ops, local → OL

- **What:** the same operations performed locally reflect on the web.
- **How:** `mkdir`, `mv`, `rm` files/folders in the mirror under `watch --push`.
- **Look for:** the web tree follows. **Known gaps to confirm:** a *local doc
  rename* currently becomes delete+create on Overleaf (content carries, **comments
  on that doc do not**) — verify whether that matters for your workflow.

## 10. Conflict handling (both sides edit)

- **What:** simultaneous edits to the *same file* never silently clobber.
- **How:** stop `watch`. Edit `methods.tex` locally AND differently on the web.
  Run `node $CLI pull`.
- **Look for:** the file is reported a **conflict**; your local copy is kept and
  Overleaf's lands as `methods.tex.overleaf-incoming`; nothing is lost.
  `--force` should instead take Overleaf's copy wholesale. **Red flag:** local
  edits overwritten with no `.overleaf-incoming` and no conflict message.

## 11. Loop safety

- **What:** the echo + filesystem guards prevent infinite edit→sync→edit loops.
- **How:** under `watch --push`, make a burst of rapid local edits; separately, make
  simultaneous edits on both sides.
- **Look for:** the log settles (no endless back-and-forth on one unchanged file),
  text isn't duplicated, CPU returns to idle. **Red flag:** the same doc syncing
  over and over with no new input.

## 12. Background daemon lifecycle + process hygiene

- **What:** `--background` survives the session, `status`/`stop` work, and it leaves
  **no orphans**.
- **How:**
  ```bash
  node $CLI watch --push --background --project-root "$(pwd)"
  node $CLI status --project-root "$(pwd)"     # ALIVE + pid + uptime
  # close the terminal / Claude Code session, edit on the web, reopen:
  node $CLI status --project-root "$(pwd)"     # still ALIVE, last activity recent
  node $CLI stop   --project-root "$(pwd)"
  pgrep -fl "cli.js watch"                      # must be EMPTY afterwards
  ps aux | grep -i ms-playwright/chromium | grep -v grep   # must be EMPTY
  ```
- **Look for:** `stop` ends it cleanly *and kills its Chromium*. **Red flag (seen in
  this soak):** after crashes/kills, orphaned `watch` daemons and Chromium linger —
  always check `pgrep`/`ps` and `kill` leftovers; a forgotten `--push` daemon keeps
  writing.

## 13. Interval (polling) mode

- **What:** `--interval N` syncs every N s with lower steady overhead.
- **How:** `watch --push --background --interval 60`; edit on the web; wait ≤60 s.
- **Look for:** changes appear within the interval; CPU is near-idle between ticks.

## 14. Session expiry / re-auth

- **What:** what happens when cookies expire mid-watch.
- **How:** run a long `watch`; or simulate by editing `.overleaf/storageState.json`
  to invalidate it, then trigger a sync.
- **Look for:** a clear "session expired — re-run `link`" message and **no lost
  edits**. **Red flag / known gap:** an unhandled crash, or silently stops syncing
  with edits queued and dropped.

## 15. Pull robustness

- **What:** `pull` should not be a single point of failure.
- **How:** `node $CLI pull --verbose` repeatedly during/after heavy writes.
- **Look for:** consistent success. **Known issue:** the ZIP bulk-download endpoint
  can return persistent HTTP 500 on a heavily-edited project; `pull` currently has
  **no fallback** to per-doc/per-file fetch, so it fails entirely even though the
  tree + individual files are reachable. If you hit this, use a fresh project.

## 16. Scale / endurance

- **What:** behavior on a realistic-size paper over time.
- **How:** 30–60+ files, several MB of figures, multi-hour `watch --push` with real
  editing on both sides.
- **Look for:** stable memory/CPU, no creeping drift, no orphan accumulation, all
  edits + comments accounted for at the end. Diff the mirror against a fresh pull.

---

## Throughout: monitor these

- `tail -f .overleaf/daemon.log` — every sync action and every error.
- `git status` / `git diff` in the mirror — catches unexpected local changes.
- `pgrep -fl "cli.js watch"` and `ps aux | grep ms-playwright` — process hygiene.
- The web project history — confirms what actually landed on Overleaf.

## Known issues found in the 2026-06-08 soak (IMDL_midterm)

1. **FIXED — concurrent folder-create race.** Bulk-adding a nested project made
   files in a shared new folder fail with `createFolder … HTTP 400`. Fixed in
   `tree.js` (in-flight dedup + idempotent "already exists"); +2 regression tests.
   Re-validated live: 14-file nested project, 0 errors, 5/5 binaries byte-identical.
2. **OPEN — `pull` ZIP-500 has no fallback.** After heavy writes the
   `…/download/zip` endpoint returned persistent 500; `pull` fails wholesale though
   the tree and per-file download still work. Needs a non-ZIP fallback path.
3. **OPEN — orphaned daemons/Chromium.** Killed/crashed `watch` sessions leave
   detached daemons (and Chromium) running, including `--push` ones. `stop` works
   for a tracked daemon, but crash-orphans must be cleaned by hand. Needs lifecycle
   hardening (stale-lock reaping, child-process cleanup).
4. **MINOR — false "diverged" warning.** A freshly-created doc can later be reported
   as "local copy differs from Overleaf" (likely trailing-newline normalization);
   harmless (pauses OL→local for it) but noisy.

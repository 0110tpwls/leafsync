---
name: overleaf-sync
description: Link a local folder to a live Overleaf project and (1) mirror it locally, (2) surface Overleaf reviewer comments + tracked changes as a local sidecar report (.overleaf/COMMENTS.md), and (3) optionally keep the two in sync. Drives a real Chromium via Playwright as the authenticated session host (no browser extension, no passwords). Use when the user invokes /leafsync:overleaf-sync or asks to "sync with Overleaf", "see Overleaf comments locally", "pull my Overleaf project", or "link this folder to Overleaf". Opt-in dependencies (Node + Playwright); write-back is still experimental; review Overleaf's Terms of Service before use.
argument-hint: "link <project-url> | pull | comments | watch [--background --interval N] | status | stop | unlink"
allowed-tools: Bash Read AskUserQuestion Glob
---

# Overleaf ⇄ local sync (EXPERIMENTAL)

This is an **experimental** feature that connects a local folder to a live
Overleaf project. Its headline use is **seeing Overleaf reviewer comments locally**
while you edit in Claude Code — comments live in Overleaf's OT/ranges layer, so
Git and local tooling normally can't see them. It works by running Overleaf's own
web app inside a Playwright-controlled Chromium that holds your authenticated
session, and reading the project's own WebSocket traffic (no browser extension).

> ⚠️ **Before using.** This drives an automated browser against your live Overleaf
> account. Review Overleaf's Terms of Service first, especially for
> institutional/paid accounts. Default to the visible (`--headful`) browser if you
> want to watch what it does. Your session cookies are stored under `.overleaf/`
> (gitignored, `chmod 600`) — treat that folder as a secret.

## One-time setup (opt-in dependencies)

leafsync needs Node ≥18 + Playwright + a Chromium download. One command does it all:

```bash
cd "${CLAUDE_PLUGIN_ROOT}"
./setup.sh                         # node check + npm install + chromium (~150 MB, one time)
```

(Equivalently: `npm run setup`.) Check Node is present first (`node --version`,
needs ≥18). If the user hasn't run setup, the live commands print the exact setup
line — surface it and stop.

## Commands

Dispatch everything to the bundled CLI (resolve via `${CLAUDE_PLUGIN_ROOT}`; run in
the user's project directory so `.overleaf/` and the mirror land there):

```bash
CLI="${CLAUDE_PLUGIN_ROOT}/src/cli.js"
node "$CLI" <command> [options] --project-root "$(pwd)"
```

| Command | What it does |
| --- | --- |
| `link <project-url>` | Opens a **headful** browser to log in once; saves the session + records the project. Ask the user for their `https://www.overleaf.com/project/<id>` URL. |
| `pull [--force]` | Mirrors the Overleaf project to the local folder **and** writes the comment report. Read-only toward Overleaf. **Safe, git-style 3-way merge:** against a shadow base (`.overleaf/base/`, the last-synced Overleaf content) it auto-merges edits that don't overlap, keeps untouched files fast-forwarding, and on a true overlap **keeps your local file live** (so it still compiles) while writing git-style conflict markers to `.overleaf/conflicts/<file>` + a summary in `.overleaf/CONFLICTS.md`. `--force` takes Overleaf's version wholesale (discards local). |
| `resolve [--ours\|--theirs\|--merged]` | Resolve merge conflicts. **No flag → interactive**, per file: `(o)urs` keeps your version, `(t)heirs` takes Overleaf's, `(e)dit` opens the marked-up file in `$EDITOR` to hand-merge. A flag resolves **all** conflicts the same way (works when piped). Reads `.overleaf/conflicts.json`. |
| `stash` / `stash pop` | `stash` shelves your local changes and reverts the files to base so you can `pull` cleanly; `stash pop` re-applies them on top via a 3-way merge (conflicts handled as above). Like `git stash`. |
| `comments` | Refreshes just the comment report (`.overleaf/COMMENTS.md` + `comments.json`). |
| `watch [--push] [--background] [--interval N] [--headful]` | Live sync (loop-guarded). **OL→local is on and solid.** **local→Overleaf write-back is opt-in via `--push`** — validated end-to-end on a throwaway project (clean single-op append, correct version tracking, no loop) but still **experimental** on real projects; default is read-only. In live mode the base text comes from `joinDoc` (not the ZIP) and is reconciled against the manifest, so a diverged local file is flagged and OL→local is paused for it until a save pushes it. See **Sync modes**. |
| `status` / `stop` | Background-daemon state for this project / stop it. |
| `stop --ls` | List **all** running leafsync watch daemons on the machine (every project), with each one's pid, uptime, push-vs-read-only, project id/URL, and folder. Use this to find orphans left by crashed sessions. |
| `stop --rm <pid> [<pid> …]` | Gracefully stop the chosen daemon(s) by pid (`--rm all` stops every one). SIGTERM first so each closes its Chromium + releases its lock, SIGKILL fallback, and clears the stale pid file. Only ever acts on processes confirmed to be leafsync daemons. |
| `unlink` | Forget the saved session + config for this project. |

After `pull`/`comments`, **Read `.overleaf/COMMENTS.md`** and present the open
comments to the user, grouped by file, each as `file.tex:line` with the quoted span
and the thread — then offer to act on them (e.g. add the requested citation).

## Sync modes (`watch`)

- **Foreground (default)** — runs in this session; stops when Claude Code closes.
- **`--background`** — detaches and keeps syncing after the session ends (until
  `stop`). Records a PID in `.overleaf/daemon.pid`, logs to `.overleaf/daemon.log`.
- **`--background --interval N`** — periodic polling every `N` seconds instead of a
  hot live socket: lower steady overhead, at the cost of up to `N` seconds of drift.

Explain the trade-off when the user asks to run in the background: live = minimal
divergence at constant cost; interval = cheaper but a small drift window; foreground
= nothing left running afterward. Only one daemon per project (PID lock).

## Current implementation status (phased)

- **Active now:** `link`, `pull`, `comments`, and the **OL→local** direction of
  `watch` — remote content edits applied to the mirror, **plus full tree changes**:
  docs and **folders** created / renamed / deleted / moved on Overleaf (a folder
  rename/move relabels its whole subtree locally), and **binary files** (figures)
  created/deleted on Overleaf are mirrored locally (downloaded via
  `/project/{id}/file/{id}`), all fs-guarded so they don't loop back. `watch`
  defaults to read-only.
- **Active with `--push` (experimental, validated end-to-end on a throwaway
  project):** **local→Overleaf write-back** — content edits as minimal OT ops,
  **file create/delete** (`POST /project/{id}/doc`, `DELETE …`, nested folders
  auto-created via `POST …/folder`), **binary upload/delete** (figures, via
  `POST …/upload` with a `name` form field), and **comment re-anchoring** (below).
  A **rename** arrives from the watcher as delete+create, so the new doc gets the
  content but comments on the old doc don't carry over.
  - **Version handling:** each doc's version is tracked continuously from the
    `otUpdateApplied` stream — the initial `joinDoc` version, then `+1` on every
    applied op (ours, confirmed by the sender-form `otUpdateApplied [{v}]`, and
    remote broadcasts). The server *transforms* a slightly-stale op and reports the
    version it actually applied at, so a push lands even if the start version lagged,
    and we resync from the confirmation. No no-ops, no loops.
  - **Note on verification lag:** Overleaf's backend can show brief cross-session
    **replication lag** — a fresh `pull`/`joinDoc` immediately after a push may show
    the old state for a few seconds even though the op applied (the OT confirmation
    is authoritative). This is why a `pull` right after editing can briefly report a
    file as `kept`/diverged; it converges.
- **Mostly minor gaps left:** a *local* doc rename reaches us from the watcher as
  unlink+add, so it becomes delete+create on Overleaf (content carries; comments on
  the renamed doc don't). A genuine line-level merge of *simultaneous* edits to the
  same span on both sides isn't attempted — last-writer plus the OT transform wins.
  Real-project soak is the remaining confidence step.

## How comments are preserved (re-anchoring)

Overleaf comments are anchored to character ranges, not stored in the `.tex`. The
write-back path uses **minimal-diff OT ops** (never a whole-document replace), so
edits *outside* a commented span never disturb it. If an edit would change the
*exact* commented characters, the tool detects the **comment-overlap conflict** and
**re-anchors**: it reuses the comment's `threadId` and submits a comment OT op
(`{c, p, t}`) at the changed region of the new text, so the thread + its messages are
preserved rather than detached. (Mechanism verified live: a comment op + thread
message round-trips through `applyOtUpdate` + `POST …/thread/{id}/messages`; the
re-anchor planner is unit-tested. End-to-end depends on the write-back reliability
caveat above.)

## Troubleshooting a slow or empty pull

If `pull` is slow and writes 0-byte files, each doc is timing out waiting for a
`joinDoc` frame we never captured. Run with diagnostics:

```bash
node "$CLI" pull --verbose --project-root "$(pwd)"        # per-step progress + bytes/doc
node "$CLI" pull --debug-frames --project-root "$(pwd)"   # dump raw WS frames -> .overleaf/frames.log
node "$CLI" pull --timeout 5 --project-root "$(pwd)"      # shorter per-doc wait while debugging
```

How the read path works now: the **project tree** is captured from the
`joinProjectResponse` WebSocket frame (CDP, after a reload), and **all content** is
pulled in ONE authenticated request to the "Download as ZIP" endpoint
(`/project/{id}/download/zip`), then extracted locally. This sidesteps both the
file-tree DOM (files in collapsed folders have no node — the original 0-byte cause)
and the docstore REST route (which 404s on www.overleaf.com).

`--verbose` prints `downloading project ZIP…`, the ZIP size, and `extracted N
files`. Common causes if it still fails:
- **`no joinProjectResponse captured`** — the tree frame wasn't seen / parsed.
  `frames.log` shows the real Socket.IO/Engine.IO shape so `socketio.js parseFrame()`
  can be extended (it already handles legacy `5:::` and Engine.IO v2 `42[…]`).
- **`ZIP download failed (status …)`** — the download route differs or the session
  expired; re-run `link`, or report the status.
- **`comment sync: socket hook not active`** — the injected WebSocket wrapper
  (`inject.js`) didn't capture the app's socket, so ranges couldn't be fetched. The
  content mirror is still fine. Check `--debug-frames`: www.overleaf.com uses legacy
  Socket.IO 0.9 (`5:::` / `6:::<seq>+`), which both `socketio.js` and `inject.js`
  target; a framing change would show here.
- **comments still `0` but the hook is active** — the doc genuinely has no comments,
  or the live `ranges.comments` shape differs from `{op:{p,c,t}}`; `extractComments`
  is tolerant of key variants but report a sample range object if needed.

Comment ranges are fetched by sending `joinDoc` over the app's own socket (via the
`inject.js` hook), not from the ZIP — `--verbose` logs `[ranges i/N] file: K comment(s)`.

## Notes for the assistant

- Always run with `--project-root "$(pwd)"` so state is scoped to the user's project.
- For `link`, you must ask the user for the project URL; never guess it.
- If a command reports an expired session, tell the user to re-run `link`.
- **Removing daemons safely:** to stop background daemons, first run `stop --ls`
  (no `--project-root` needed — it scans the whole machine) and **present the list
  to the user**, calling out any in **PUSH** mode (those write to Overleaf) and any
  on a project they may not have meant to leave running. Let the **user choose**
  which to stop (e.g. via AskUserQuestion), then run `stop --rm <pid> …` with their
  selection. Never `--rm all` or stop a daemon on the user's behalf without an
  explicit choice — a daemon may be one they intentionally left running.
- Treat `.overleaf/` as secret; never print `storageState.json` contents.
- leafsync is its own opt-in plugin/program (Node + Playwright); it is independent
  of latex-sentinel. Run `./setup.sh` once before any live command.

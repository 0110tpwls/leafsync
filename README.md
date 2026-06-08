# leafsync

Link a local folder to a live **Overleaf** project — mirror it locally, **see
Overleaf reviewer comments and tracked changes as a local report**, and optionally
keep the two in two-way sync. The headline trick is the comments: they live in
Overleaf's OT/ranges layer, so Git and ordinary local tooling can't see them —
leafsync surfaces them as `.overleaf/COMMENTS.md` next to your files.

It works by driving a **Playwright-controlled Chromium** that holds your
authenticated Overleaf session and reading the project's own WebSocket traffic — **no
browser extension, no passwords stored**. Inspired by
[`overleaf-cli`](https://github.com/BruceChenSF/overleaf-cli), reimplemented around
Playwright.

> ⚠️ **Read first.** leafsync drives an automated browser against your live Overleaf
> account. **Review [Overleaf's Terms of Service](https://www.overleaf.com/legal)
> before using it**, especially on institutional or paid accounts. Two-way
> *write-back* is **experimental** — validated end-to-end on a throwaway project but
> not yet soak-tested on real papers. Keep a backup. Your session cookies are stored
> under `.overleaf/` (gitignored, `chmod 600`) — treat that folder as a secret.

## Requirements

- **Node.js ≥ 18**
- Playwright + a one-time Chromium download (~150 MB) — installed by `./setup.sh`

## Setup (one step)

```bash
git clone https://github.com/0110tpwls/leafsync.git
cd leafsync
./setup.sh          # checks Node, installs deps, downloads Chromium
```

`./setup.sh` is re-runnable and idempotent (`npm run setup` does the same thing).

## Quick start

Run commands from the folder you want to mirror (state lands in `./.overleaf/`):

```bash
node /path/to/leafsync/src/cli.js link https://www.overleaf.com/project/<id>   # one-time login
node /path/to/leafsync/src/cli.js pull         # mirror the project + write the comment report
node /path/to/leafsync/src/cli.js comments     # refresh just the comment report
node /path/to/leafsync/src/cli.js watch        # live sync (read-only toward Overleaf by default)
```

`link` opens a real browser window so you can log in once; the session is reused
afterward. After `pull`/`comments`, open **`.overleaf/COMMENTS.md`** to read the open
reviewer comments, each as `file.tex:line` with author, quoted span, and thread.

Tip: install it on your `PATH` so you can just type `leafsync`:

```bash
npm link            # from the leafsync repo → exposes the `leafsync` command
leafsync pull
```

## Use it inside Claude Code (optional)

leafsync is also a Claude Code plugin. Add it as a marketplace and install:

```
/plugin marketplace add 0110tpwls/leafsync
/plugin install leafsync@leafsync
```

Then run the one-time `./setup.sh` (the plugin prints the exact path), and invoke
`/leafsync:overleaf-sync` — it dispatches to the same CLI and presents the comment
report for you.

## Commands

| Command | What it does |
| --- | --- |
| `link <project-url>` | One-time headful login; saves the session + records the project. |
| `pull [--force]` | Mirror Overleaf → local **and** write the comment report. **Safe by default:** a baseline manifest 3-way reconciles like `git pull` — files you didn't touch fast-forward, your local edits are kept, and a both-sides change becomes a conflict (your copy stays; Overleaf's lands as `<file>.overleaf-incoming`). `--force` takes Overleaf's version wholesale. |
| `comments` | Refresh just the comment report (`.overleaf/COMMENTS.md` + `comments.json`). |
| `watch [--push] [--background] [--interval N] [--headful]` | Live sync (loop-guarded). **Overleaf→local is on by default.** **local→Overleaf write-back is opt-in via `--push`** and still experimental. See **Sync modes**. |
| `status` / `stop` | Background-daemon state / stop it. |
| `unlink` | Forget the saved session + config for this project. |

## Sync modes (`watch`)

- **Foreground (default)** — runs in your terminal/session; stops when you close it.
- **`--background`** — detaches and keeps syncing until `stop` (PID in
  `.overleaf/daemon.pid`, logs to `.overleaf/daemon.log`).
- **`--background --interval N`** — periodic polling every `N` seconds instead of a
  hot live socket: lower steady overhead, at the cost of up to `N` seconds of drift.

Only one daemon per project (PID lock).

## What works today

- **Overleaf → local:** content edits, full tree changes (docs **and folders**
  created / renamed / deleted / moved), and binary files (figures) — all mirrored
  locally and loop-guarded.
- **Local → Overleaf (`--push`, experimental):** content edits as minimal OT ops,
  file/folder create + delete, binary upload/delete, and reviewer-comment
  **re-anchoring** so comments survive edits to commented text.
- **Comment report:** open/resolved reviewer comments + tracked changes mapped to
  `file:line`, read-only and never written into your `.tex`.

See **[ROADMAP.md](ROADMAP.md)** for the gap list between today's experimental state
and a fully production-ready tool (re-auth, reconnect robustness, CI against a mock
Overleaf, conflict UX, real-project soak, and more).

## Files leafsync writes (all under `.overleaf/`, gitignored)

| File | Purpose |
| --- | --- |
| `config.json` | deployment URL, project id, mirror path |
| `storageState.json` | your Overleaf session cookies — **secret**, `chmod 600` |
| `comments.json` / `COMMENTS.md` | the reviewer-comment report |
| `manifest.json` | baseline hashes for safe 3-way `pull` |
| `daemon.pid` / `daemon.log` | background `watch` daemon |
| `<file>.overleaf-incoming` | Overleaf's copy of a file that conflicts with your local edits |

## Tests

```bash
npm test        # 29 offline unit tests (protocol parsing, OT diff, reconcile, loop guards…)
```

The offline tests need no Overleaf account and no Chromium.

## License

MIT — see [LICENSE](LICENSE).

## Credits

Inspired by [`overleaf-cli`](https://github.com/BruceChenSF/overleaf-cli) by
BruceChenSF, reimplemented around Playwright (single process, no browser extension).
Originally built as an experimental feature of
[latex-sentinel](https://github.com/0110tpwls/latex-sentinel); now its own project.

# overleaf-sync → main: productionization roadmap

Status: **experimental** (branch `experimental/overleaf-sync`, never merged to `main`).
This document is the gap list between "validated on a throwaway project" and
"a feature we'd ship to every latex-sentinel user." It is derived from the original
plan (`composed-tickling-wall.md`) plus everything learned building and testing the
implementation.

Legend — priority: **P0** = blocker for any merge to main · **P1** = needed before
recommending it to non-expert users · **P2** = polish / nice-to-have.

---

## 0. The headline decision: how does this ship?

Before any code, pick the distribution model. Everything else depends on it.

The tension: latex-sentinel is **pure stdlib, zero-install** by design (the README
sells this). overleaf-sync needs **Node ≥18 + `npm install` + a ~150 MB Chromium**.
Bolting that onto the base plugin breaks the "no install step" promise for everyone,
including the 95% who never touch Overleaf.

**Recommended model — "core stays clean, sync is an opt-in module":**

- Keep latex-sentinel's base install stdlib-only and untouched.
- Ship `overleaf-sync` as a skill that is **inert until explicitly enabled**: its
  SKILL.md detects missing Node/Playwright/Chromium and, instead of erroring,
  prints a single guided setup command and stops. No other skill imports it.
- Add a dedicated `overleaf-sync setup` subcommand (see §1) that runs
  `npm install` + `npx playwright install chromium` with progress, disk-cost
  disclosure, and a ToS consent gate.
- Treat the `node_modules`/Chromium as user-local state, never vendored in git.

**Alternatives considered (document why rejected):**
- *Separate plugin* (`latex-sentinel-overleaf`): cleanest dependency story, but
  forces a second `/plugin install` and splits docs/issues. Viable if we want hard
  isolation; revisit if the dependency surface grows.
- *Bundle everything in main*: rejected — violates the zero-install promise, bloats
  every clone, and pushes ToS/bot-detection risk onto users who never opted in.

**P0 deliverable:** a written, committed decision (this section, ratified) + the
feature-flag/opt-in mechanism that keeps it inert by default.

---

## 1. Dependency & install UX  (P0)

- **`overleaf-sync setup` command.** One command that: checks `node --version` (≥18),
  runs `npm ci`/`npm install` in `node/`, runs `npx playwright install chromium`,
  and reports disk cost up front (~150 MB browser + ~80 MB node_modules). Idempotent;
  re-runnable; prints a clear "already installed" fast path.
- **Pin dependencies.** Commit a `package-lock.json`; pin Playwright to a known-good
  range and document the exact Chromium revision it pulls. A silent Playwright major
  bump can break CDP behavior — make upgrades deliberate.
- **Preflight check helper.** A `node src/cli.js doctor` that verifies node version,
  deps present, Chromium present, and (optionally) a valid session — so users can
  self-diagnose before filing issues. Mirror the base plugin's `set-up` doctor ethos.
- **Graceful "not installed" path.** Every live command already prints the setup line
  when deps are missing; make that uniform and tested (no stack traces leaking).
- **Uninstall/cleanup.** Document/script removal of the Chromium download and
  `node_modules` for users reclaiming disk.

**Acceptance:** a fresh machine with only Node can go from `install` → `link` → `pull`
following on-screen instructions, with no manual `cd`/`npm` knowledge required.

---

## 2. Legal / ToS / bot-detection  (P0)

This is the single biggest reason it's experimental, and it's non-negotiable for main.

- **Explicit ToS review + written stance.** Read Overleaf's current Terms of Service
  and acceptable-use; record in `docs/` what we believe is and isn't permitted
  (automated browser sessions, especially for **institutional/paid** accounts where
  contracts differ). If anything is ambiguous, default to the conservative reading.
- **One-time consent gate.** First run of `setup`/`link` must show a consent prompt
  ("this drives an automated browser against your live Overleaf account; you are
  responsible for compliance with Overleaf's ToS; institutional accounts may have
  stricter terms") and record acceptance in `.overleaf/config.json`.
- **Default to headful / transparent.** A backend headless Chromium is more bot-like.
  Consider defaulting `link` (and optionally `watch`) to headful so the user can see
  the automation, with `--headless` as the explicit opt-in.
- **Rate limiting / politeness.** Bound request frequency (especially interval mode
  and ZIP re-pulls) so we don't hammer Overleaf; add jittered backoff on errors.
- **Kill switch.** Document how to fully stop + unlink + purge session if Overleaf or
  the user wants it off.

**Acceptance:** a user cannot enable write-back without seeing and accepting the ToS
consent; the stance doc exists and is linked from SKILL.md/README.

---

## 3. Session lifetime & re-authentication  (P0)

Currently the code assumes `storageState.json` cookies are valid; if they expire
mid-`watch`, it errors rather than recovering. For an "always-on" feature this is the
top *functional* gap.

- **Detect expiry.** Recognize the auth-redirect / 401 / "please log in" states from
  both REST calls (tree/threads/upload) and the socket (failed `joinDoc`).
- **Graceful re-auth.** On expiry during foreground `watch`: pause sync, surface a
  clear "session expired — run `link` to re-authenticate" message, and resume cleanly
  after. For `--background`: write the expiry to `daemon.log` + `status`, stop pushing
  (never silently drop edits), and optionally fire a notification.
- **Proactive refresh.** If Overleaf supports a refresh/keepalive, use it to extend
  sessions during long watches before they hard-expire.
- **Storage hardening.** Re-audit `storageState.json` handling: confirm `chmod 600`,
  confirm `.overleaf/` is gitignored everywhere, never log cookie contents, and
  consider OS keychain storage instead of a plaintext file (P1).

**Acceptance:** expiring the session (delete/expire cookies) during a `watch` produces
a clear, actionable message and **zero data loss**, and `link` restores sync.

---

## 4. Reconnect & network robustness  (P0)

- **Socket drop recovery.** If the WebSocket / CDP connection drops (network blip,
  Overleaf restart), auto-reconnect with backoff, re-`joinDoc` the active docs, and
  re-establish version tracking from the fresh `joinDoc` version. Today a drop likely
  wedges the live loop.
- **Chromium crash recovery.** If the browser process dies, relaunch it (or fail the
  daemon cleanly with a logged reason and PID-lock release), never leaving a zombie.
- **Replication-lag handling in `pull` UX.** We documented that a `pull` right after a
  push can briefly show stale state (OT confirmation is authoritative). Productionize
  the *messaging*: when reconcile sees a just-pushed file as diverged, say so
  ("Overleaf may not have replicated your last edit yet; re-run in a few seconds")
  rather than presenting a scary conflict.
- **Idempotent restart.** A daemon that's killed mid-op must resume to a consistent
  state on next start (the manifest + version tracking already help; verify under
  fault injection).

**Acceptance:** pull the network for 30 s during `watch`, restore it → sync resumes
automatically without manual intervention and without duplicated or lost edits.

---

## 5. Conflict & merge UX  (P1)

The 3-way reconcile (`pull`) and the divergence-pause (`watch`) are solid foundations,
but the user-facing story needs finishing.

- **Surface conflicts well.** `pull` writes `<file>.overleaf-incoming` sidecars on
  conflict — document this prominently, and add a `status`/report line that lists
  outstanding `.overleaf-incoming` files so they're not silently forgotten.
- **Resolve helper.** A small command to accept-theirs / accept-mine / open-a-diff for
  a conflicted file, so users aren't left hand-managing sidecars.
- **Simultaneous same-span edits.** Today: last-writer + OT transform wins, no
  line-level merge. Decide the policy and state it; optionally attempt a 3-way text
  merge for non-overlapping line edits before falling back.
- **Comment-overlap policy.** Re-anchoring is automatic in `--push` (non-interactive
  daemon). For main, consider a configurable policy (auto-reanchor / warn-only /
  skip-op) since auto-reanchor changes Overleaf state.

**Acceptance:** a conflicting both-sides edit yields a clear report, a kept local copy,
an `.overleaf-incoming`, and a one-command way to resolve it.

---

## 6. Comment freshness during `watch`  (P1)

Comments are currently snapshotted at startup; new/resolved threads created on Overleaf
*during* a watch session aren't re-reported until the next `pull`/`comments`. Since
"see reviewer comments locally" is the headline, live comment refresh matters.

- **Detect comment/range changes live** from the socket (comment OT ops + thread
  events) and incrementally update `comments.json` + `COMMENTS.md`.
- **Notify on new comments** (log line / optional desktop notification) so a reviewer
  comment landing while you edit is visible without a manual refresh.

**Acceptance:** add a comment on the web during an active `watch` → `COMMENTS.md`
updates within seconds without re-running `pull`.

---

## 7. Local→Overleaf doc rename preserves comments  (P2)

A local rename reaches the watcher as unlink+add → becomes delete+create on Overleaf,
so the new doc gets content but **comments on the old doc don't carry**.

- **Detect rename** (same content hash disappearing+appearing within a short window,
  or chokidar's rename signal) and issue Overleaf's native **entity rename** instead
  of delete+create, preserving doc id, comments, and history.

**Acceptance:** rename a `.tex` locally under `--push` → Overleaf shows the rename with
all existing comments still attached.

---

## 8. Cross-platform & daemon hardening  (P1)

Built and tested on macOS. Before main:

- **Daemon mechanism per OS.** Current `detached: true` + PID file works on
  macOS/Linux. Verify on Linux; decide Windows story (detached process model differs;
  consider documenting Windows as foreground-only initially, or use a wrapper).
- **Optional supervised mode.** For "always on," consider a launchd (macOS) /
  systemd-user (Linux) unit so the daemon restarts on crash/login — vs. the current
  fire-and-forget `nohup`-style. At minimum, document the trade-off.
- **PATH / node discovery** when spawned detached from a GUI-launched Claude Code
  (login shell PATH differs). Resolve `node` robustly.
- **Stale PID-lock cleanup** edge cases (machine reboot leaves a dead PID file) —
  already partly handled (`isAlive`); test the reboot path.

**Acceptance:** background `watch` survives a Claude Code session close on macOS and
Linux, `status`/`stop` work, and a reboot doesn't wedge the lock.

---

## 9. Tests & CI without a live Overleaf  (P0)

29 offline unit tests exist (parseFrame, OT helpers, reconcile, computeOps,
reanchor planning, loop guards, unzip, …). To merge to main we need confidence the
protocol layer keeps working without manual live testing.

- **Mock Socket.IO/Engine.IO server** that replays recorded `joinProjectResponse`,
  `joinDoc`, `applyOtUpdate`/`otUpdateApplied`, and tree-event frames, so the full
  read + write-back + loop-guard paths run in CI end-to-end against a fake.
- **Recorded-fixture corpus.** Capture (sanitized) real frames from www.overleaf.com
  into fixtures so `parseFrame`/`findRanges`/tree parsing are regression-tested
  against the actual wire shapes (ranges at index 4, 6-element acks, etc.).
- **CI wiring.** Run `node test/run.js` + the mock-server suite on push (GitHub
  Actions); gate merges on green. Add a lint pass.
- **Fault-injection tests** for §3/§4 (expiry, socket drop, replication lag).

**Acceptance:** CI runs the full protocol + sync logic against mocks on every push,
no live account required, and fails on protocol-shape regressions.

---

## 10. Protocol & selector drift monitoring  (P1)

www.overleaf.com's Socket.IO version, frame shapes, REST routes, and (the few)
DOM touch-points can change without notice — this is the long-term maintenance tax.

- **Note: we eliminated DOM dependence.** Tree/binary ops use REST endpoints and
  content uses the socket — there are effectively **no CSS selectors** to drift,
  which is a major robustness win over the original plan. Keep it that way; resist
  adding DOM scraping.
- **Canary/self-check.** A diagnostic (extend `doctor`) that links a scratch project
  and verifies each assumption still holds: ZIP download works, `joinProjectResponse`
  parses, `joinDoc` ranges land at the expected index, REST tree/upload routes return
  expected shapes. Run it periodically / on Playwright bumps.
- **Version-aware parsing.** `socketio.js parseFrame()` already handles legacy `5:::`
  and Engine.IO v2 `42[…]`; document the supported protocol matrix and fail loudly
  with a "protocol changed — see frames.log" message rather than silently mis-parsing.
- **Telemetry breadcrumbs** (local logs only) of which frame shapes were seen, to
  speed diagnosis when Overleaf changes something.

**Acceptance:** a protocol change produces a clear, single diagnostic message and the
canary catches it before users do.

---

## 11. Docs, onboarding & safety messaging  (P1)

- **Promote SKILL.md from "experimental" framing** to a real user guide: setup,
  consent, the three sync modes, the conflict/sidecar workflow, comment report
  format, troubleshooting, and limits (what it does NOT do).
- **README integration.** Move from the "Experimental" section to a first-class
  feature block, but keep the dependency/consent caveats prominent.
- **Explain the sidecar files** (`.overleaf/COMMENTS.md`, `comments.json`,
  `manifest.json`, `*.overleaf-incoming`, `daemon.log`) in one place.
- **Security note** for users: `.overleaf/` holds session cookies — treat as secret;
  it's gitignored and `chmod 600`.

**Acceptance:** a new user can set up, link, pull, read comments, and run a safe
`watch` from the docs alone, understanding the risks.

---

## 12. Real-project soak  (P0 — the confidence gate)

Everything write-side is validated only on a throwaway project (`IMDL_midterm`).
Before main, run a deliberate soak on a real (but backed-up) paper:

- Multi-day `watch --push` with real editing on both sides (web + local).
- Verify: no lost edits, no duplicated text, comments preserved/re-anchored, figures
  sync both ways, tree ops both ways, background daemon survives session close,
  re-auth on expiry, recovery from a forced network drop.
- Keep a full git backup of the paper throughout; treat any silent data loss as a
  release blocker.

**Acceptance:** a documented soak run on a real project with zero data-loss incidents
and a written report of any rough edges.

---

## Suggested sequencing

1. **Decide distribution model (§0)** — gates everything.
2. **Test infra (§9)** — so subsequent hardening is verifiable.
3. **Re-auth (§3) + reconnect (§4)** — the functional blockers for "always on."
4. **ToS/consent (§2) + install UX (§1)** — the gates for exposing it to users.
5. **Conflict UX (§5), live comments (§6), cross-platform (§8), drift canary (§10).**
6. **Docs (§11), then the real-project soak (§12)** as the final confidence gate.
7. **Polish (§7) and the merge.**

## Quick scorecard vs. the original plan

- **Implemented & validated (throwaway):** all commands (link/pull/comments/watch/
  status/stop/unlink), ride-the-app architecture, OL→local content+tree+figures+
  comments, local→OL content (OT) + tree + figures + comment re-anchoring, dual loop
  guards, 3-way reconcile pull safety, realtime version tracking, background daemon.
- **Beyond the plan (bonus):** 3-way reconcile/manifest pull safety, two-way binary
  sync, **zero DOM selectors** (all REST/socket), realtime version tracking.
- **Left for main (this doc):** distribution/opt-in model, install UX, ToS/consent,
  re-auth, reconnect robustness, conflict-resolve UX, live comment refresh, local
  doc-rename preservation, cross-platform daemon, CI/mock tests, drift canary, docs,
  real-project soak.

// session.js — Playwright session host for a linked Overleaf project.
//
// Playwright is imported LAZILY (inside functions) so the CLI's help/offline
// paths work before `npm install` / `npx playwright install chromium`. This is
// the only place that needs the heavy deps.
//
// Auth model: a one-time HEADFUL login. The user logs into Overleaf in a real
// window; we persist the resulting cookies as storageState.json and reuse them
// headless thereafter. No password ever touches this code.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { statePath, saveStorageState } from "./config.js";

async function pw() {
  try {
    return await import("playwright");
  } catch {
    throw new Error(
      "playwright is not installed. From the leafsync repo root run:\n" +
        "  ./setup.sh      (or: npm install && npx playwright install chromium)"
    );
  }
}

/**
 * Interactive login: open a headful browser at the deployment, wait until the
 * user is authenticated (project dashboard reachable), then save storageState.
 */
export async function login(projectRoot, deployment) {
  const { chromium } = await pw();
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${deployment}/project`, { waitUntil: "domcontentloaded" });

  // Wait until we land on the authenticated dashboard (login redirects away
  // from /project until signed in). Generous timeout for human login.
  await page.waitForURL((u) => /\/project\/?$/.test(u.pathname), {
    timeout: 5 * 60 * 1000,
  });

  const state = await context.storageState();
  const p = await saveStorageState(projectRoot, state);
  await browser.close();
  return p;
}

/**
 * Open an authenticated session for the linked project. Returns
 * { browser, context, page } — caller is responsible for browser.close().
 * Throws a clear error if the stored session is missing/expired.
 */
export async function openProject(projectRoot, { deployment, projectId }, { headless = true } = {}) {
  const stateFile = statePath(projectRoot, "storageState.json");
  if (!existsSync(stateFile)) {
    throw new Error("no saved session — run `overleaf-sync link <url>` first.");
  }
  const { chromium } = await pw();
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    storageState: JSON.parse(await readFile(stateFile, "utf8")),
  });
  const page = await context.newPage();
  await page.goto(`${deployment}/project/${projectId}`, {
    waitUntil: "domcontentloaded",
  });

  // Detect an expired session: Overleaf bounces unauthenticated users to /login.
  if (/\/login/.test(page.url())) {
    await browser.close();
    throw new Error(
      "session expired — run `overleaf-sync link <url>` again to re-authenticate."
    );
  }
  return { browser, context, page };
}

/** Scrape the CSRF token Overleaf embeds in the page (needed for some calls). */
export async function csrfToken(page) {
  return page
    .evaluate(() => {
      const el = document.querySelector('meta[name="ol-csrfToken"]');
      return el ? el.getAttribute("content") : null;
    })
    .catch(() => null);
}

// Minimal test harness + page helpers shared by the regression suite.
//
// The app is a static page with no build step, so the tests drive the real
// thing in a real browser: they start a static server, open the page, and
// click through it exactly as a chair would. Every test starts from a
// cleared localStorage so they can run in any order.

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIME = {
  ".html": "text/html", ".js": "text/javascript",
  ".css": "text/css", ".json": "application/json",
};

export async function startServer() {
  const server = createServer(async (req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]);
    const path = join(ROOT, normalize(rel === "/" ? "/index.html" : rel));
    if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(path);
      res.writeHead(200, { "content-type": MIME[extname(path)] || "text/plain" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

/* ---------- assertions ---------- */

export class Failure extends Error {}

export function assert(cond, msg) {
  if (!cond) throw new Failure(msg);
}

export function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Failure(`${msg}\n      expected: ${e}\n      actual:   ${a}`);
}

/* ---------- app-level page helpers ---------- */

export const STORAGE_KEY = "chair-meeting-manager:v1";

export const readState = (page) =>
  page.evaluate(k => JSON.parse(localStorage.getItem(k)), STORAGE_KEY);

/**
 * Serve the web-font requests locally as empty CSS.
 *
 * index.html links Google Fonts, and a render-blocking stylesheet holds up
 * DOMContentLoaded until it resolves — roughly 12s per navigation when the
 * network is unavailable, which is most CI boxes and every offline laptop.
 * The tests care about behaviour, not typefaces, so short-circuit it.
 */
export const stubWebFonts = (page) =>
  page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//,
    route => route.fulfill({ status: 200, contentType: "text/css", body: "" }));

/**
 * Navigate to the app. Waits for DOM ready rather than full `load`: the page
 * links Google Fonts, so `load` also waits on a network request that is slow
 * or refused when running offline, which has nothing to do with the app.
 */
export const gotoApp = (page, origin) => page.goto(origin, { waitUntil: "domcontentloaded" });

/** Open the app with a clean slate and draft an agenda (no meeting started). */
export async function openApp(page, origin, { title = "Board Sync", items = ["Opening", "Budget review"] } = {}) {
  await gotoApp(page, origin);
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Start Meeting");
  if (title) await page.fill('input[placeholder="e.g. Q3 Steering Committee"]', title);
  for (const name of items) {
    await page.fill('input[placeholder="New agenda item"]', name);
    await page.click('button:has-text("Add")');
  }
}

export async function startMeeting(page) {
  await page.click('button:has-text("Start Meeting")');
  await page.waitForSelector("#timer-display");
}

/** End the meeting and accept the confirmation toast. */
export async function endMeeting(page) {
  await page.click(".hero-actions button.primary");
  await page.waitForSelector(".toast-confirm .btn-primary");
  await page.click(".toast-confirm .btn-primary");
  await page.waitForSelector('button:has-text("File Meeting")');
}

/** Type into the live notes textarea (markers file themselves on Enter). */
export async function typeNote(page, text) {
  const ta = page.locator(".cockpit-notes textarea");
  await ta.click();
  await ta.type(text);
  await page.waitForTimeout(50);
}

export const clickNav = (page, label) =>
  page.click(`.nav-links button:has-text("${label}")`);

/** Text of the "N breaks taken (X min total)" line on the minutes. */
export async function breakLine(page) {
  return page.$eval("body", b => (b.innerText.match(/\d+ breaks? taken \([^)]*\)/) || ["none"])[0]);
}

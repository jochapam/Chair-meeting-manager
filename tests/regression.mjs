// Regression suite.
//
// Every test here pins a bug that actually shipped and was found in the
// wild. If one of these fails, that specific bug is back. Run with:
//
//   npm install && npm test
//
// Each case names the behaviour it protects, not the code it touches, so
// the suite stays meaningful through refactors.

import { chromium } from "playwright";
import {
  startServer, Failure, assert, assertEqual,
  openApp, startMeeting, endMeeting, typeNote, clickNav,
  readState, breakLine,
} from "./harness.mjs";

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* =====================================================================
   A finished meeting is never silently destroyed
   ===================================================================== */

test("leaving a finished meeting for Prepare offers to file it, and never drops it", async (page, origin) => {
  await openApp(page, origin);
  await startMeeting(page);
  await typeNote(page, "/decision Approved the budget\n");
  await endMeeting(page);

  await clickNav(page, "Prepare");
  // It must ask rather than act: the meeting is still intact at this point.
  await page.waitForSelector(".toast-confirm");
  let st = await readState(page);
  assertEqual(st.meeting.captures.length, 1, "the meeting must still be intact while the prompt is open");

  await page.click(".toast-confirm .btn-primary");
  await page.waitForSelector("text=Prepare the meeting");

  st = await readState(page);
  assertEqual(st.history.length, 1, "confirming should file the meeting to History");
  assertEqual(st.history[0].captures.length, 1, "the filed copy must keep its captures");
  assertEqual(st.meeting.title, "", "Setup should now hold a fresh empty draft");
});

test("dismissing the prompt keeps you on the minutes with the meeting intact", async (page, origin) => {
  await openApp(page, origin);
  await startMeeting(page);
  await typeNote(page, "/decision Keep me\n");
  await endMeeting(page);

  await clickNav(page, "Prepare");
  await page.waitForSelector(".toast-confirm");
  await page.click('.toast-confirm button:has-text("Cancel")');
  await page.waitForTimeout(100);

  const st = await readState(page);
  assertEqual(st.history.length, 0, "cancelling must not file anything");
  assertEqual(st.meeting.captures.length, 1, "cancelling must not touch the meeting");
  assert(await page.$('button:has-text("File Meeting")'), "should still be on the minutes");
});

/* =====================================================================
   Break bookkeeping
   ===================================================================== */

test("pressing Break twice does not open a second, never-closing break", async (page, origin) => {
  await openApp(page, origin);
  await startMeeting(page);
  await page.click('.hero-actions button:has-text("Break")');
  await page.waitForTimeout(50);
  await page.click('.hero-actions button:has-text("Break")');
  await page.waitForTimeout(50);

  const { meeting } = await readState(page);
  assertEqual(meeting.breaks.length, 1, "a second Break press should not stack another break");
  assertEqual(meeting.breaks.filter(b => b.endedAt == null).length, 1, "exactly one break should be open");
});

test("a filed meeting's break total does not grow as time passes", async (page, origin) => {
  await page.clock.install({ time: new Date("2026-01-01T09:00:00") });
  await openApp(page, origin);
  await startMeeting(page);
  await page.click('.hero-actions button:has-text("Break")');
  await page.waitForTimeout(50);
  await endMeeting(page); // ended while still on the break

  const { meeting } = await readState(page);
  assert(meeting.breaks.every(b => b.endedAt != null), "ending a meeting must close any open break");

  const before = await breakLine(page);
  // Come back to the same minutes much later; the record must not have moved.
  await page.clock.setSystemTime(new Date("2026-01-01T12:00:00"));
  await clickNav(page, "History");
  await page.waitForTimeout(80);
  await clickNav(page, "Minutes");
  await page.waitForSelector('button:has-text("File Meeting")');
  const after = await breakLine(page);

  assertEqual(after, before, "the break total must read the same three hours later");
});

/* =====================================================================
   Time that passed while the app was asleep isn't charged to the item
   ===================================================================== */

test("waking from sleep pauses instead of charging the gap to the current item", async (page, origin) => {
  await page.clock.install({ time: new Date("2026-01-01T09:00:00") });
  await openApp(page, origin, { items: ["Opening", "Second", "Third"] });
  await startMeeting(page);
  await page.clock.runFor(2000);

  const planned = (await readState(page)).meeting.sections.map(s => Math.round(s.plannedSeconds));

  // Sleep: the clock moves but no timer fires, exactly like a closed lid.
  await page.clock.setSystemTime(new Date("2026-01-01T23:00:00"));
  await page.clock.runFor(1100); // the first tick after waking

  const { meeting } = await readState(page);
  assertEqual(meeting.timerStatus, "paused", "waking from a long sleep should pause the meeting");
  assert(
    meeting.sections[0].pausedAccum < 120,
    `the sleep must not be charged to the item (got ${Math.round(meeting.sections[0].pausedAccum)}s)`,
  );
  assertEqual(
    meeting.sections.map(s => Math.round(s.plannedSeconds)), planned,
    "upcoming items must not be shaved to their floor by a sleep gap",
  );
});

test("reopening the tab after a long absence also pauses rather than charging the gap", async (page, origin) => {
  await page.clock.install({ time: new Date("2026-01-01T09:00:00") });
  await openApp(page, origin, { items: ["Opening", "Second"] });
  await startMeeting(page);
  await page.clock.runFor(2000); // let one tick record lastSeenAt

  await page.clock.setSystemTime(new Date("2026-01-02T08:00:00"));
  await page.reload();
  await page.waitForSelector("#timer-display");

  const { meeting } = await readState(page);
  assertEqual(meeting.timerStatus, "paused", "an overnight absence should come back paused");
  assert(
    meeting.sections[0].pausedAccum < 120,
    `the absence must not be charged to the item (got ${Math.round(meeting.sections[0].pausedAccum)}s)`,
  );
});

/* =====================================================================
   runner
   ===================================================================== */

const { server, origin } = await startServer();
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--no-sandbox"],
});

const TEST_TIMEOUT_MS = 45000;

// A hung test should report as a failure, not freeze the whole run — these
// drive a real browser with a mocked clock, so a stall is entirely possible.
const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Failure(`timed out after ${ms}ms (${label})`)), ms).unref()),
]);

let passed = 0;
const failures = [];

for (const { name, fn } of tests) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15000);
  const pageErrors = [];
  page.on("pageerror", err => pageErrors.push(err.message));
  try {
    await withTimeout(fn(page, origin), TEST_TIMEOUT_MS, "test body");
    if (pageErrors.length) throw new Failure(`page errors: ${pageErrors.join("; ")}`);
    console.log(`  ok   ${name}`);
    passed++;
  } catch (err) {
    const detail = err instanceof Failure ? err.message : (err.stack || err.message);
    console.log(`  FAIL ${name}\n      ${detail}`);
    failures.push(name);
  } finally {
    // A page with a mocked clock can be slow to tear down; don't let that
    // hold the suite hostage either.
    await withTimeout(page.close(), 10000, "page close").catch(() => {});
  }
}

await browser.close();
server.close();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);

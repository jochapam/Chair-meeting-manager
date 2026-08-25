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
   The exported record reports what actually happened
   ===================================================================== */

test("exported duration counts only items that actually ran", async (page, origin) => {
  await openApp(page, origin, { items: ["Opening", "Never reached A", "Never reached B"] });
  await startMeeting(page);
  await page.clock.install(); // freeze so "actual" is a stable, tiny number
  await endMeeting(page); // ends on item 1; the other two never ran

  const md = await page.evaluate(() =>
    buildMinutesMarkdown(JSON.parse(localStorage.getItem("chair-meeting-manager:v1")).meeting));

  const actual = md.match(/\*\*Actual duration:\*\* (\d+) min/);
  assert(actual, `markdown should report an actual duration:\n${md}`);
  assert(
    Number(actual[1]) < 5,
    `only item 1 ran, so actual must be near zero — not the 20 min of unrun budget (got ${actual[1]} min)`,
  );
  assert(md.includes("2 items not reached"), "the export should say two items were never reached");
});

test("viewing a filed meeting offers a way back, not a second filing", async (page, origin) => {
  await openApp(page, origin);
  await startMeeting(page);
  await endMeeting(page);
  await page.click('button:has-text("File Meeting")');
  await page.waitForSelector("text=Prepare the meeting");

  await clickNav(page, "History");
  await page.waitForSelector('.flat-row button:has-text("View")');
  assertEqual((await readState(page)).history.length, 1, "one meeting should be filed");

  await page.click('.flat-row button:has-text("View")');
  await page.waitForSelector(".page-eyebrow");

  assert(
    await page.$('button:has-text("Back to History")'),
    "an already-filed meeting should offer 'Back to History', not 'File Meeting'",
  );
  assert(!(await page.$('button:has-text("File Meeting")')), "'File Meeting' must not be offered twice");

  await page.click('button:has-text("Back to History")');
  await page.waitForSelector("text=Where the time goes");
  assertEqual((await readState(page)).history.length, 1, "returning must not duplicate the entry");
});

/* =====================================================================
   Notes and titles are data, never markup
   ===================================================================== */

test("history search renders user text literally instead of as HTML", async (page, origin) => {
  const nastyTitle = '<img src=x onerror="window.__executed=1">Board & <Co>';
  await openApp(page, origin, { title: nastyTitle, items: ["Opening"] });
  await startMeeting(page);
  await typeNote(page, "zebra marker\n");
  await endMeeting(page);
  await page.click('button:has-text("File Meeting")');
  await page.waitForSelector("text=Prepare the meeting");

  await clickNav(page, "History");
  await page.fill(".underline-search", "zebra");
  await page.waitForSelector(".search-match");

  assert(!(await page.evaluate(() => window.__executed)), "markup in a title must not execute");
  const shown = await page.$eval(".search-match strong", e => e.textContent);
  assertEqual(shown, nastyTitle, "the title should be shown verbatim, tags and all");
  assert(await page.$(".search-match mark"), "the matched term should still be highlighted");
});

/* =====================================================================
   Agenda editing on the Prepare screen
   ===================================================================== */

test("reordering the agenda renumbers the rows", async (page, origin) => {
  await openApp(page, origin, { items: ["Alpha", "Beta", "Gamma"] });
  const rows = () => page.$$eval(".section-row", rs =>
    rs.map(r => `${r.querySelector(".item-num").textContent}:${r.querySelector(".name-input").value}`));
  assertEqual(await rows(), ["1:Alpha", "2:Beta", "3:Gamma"], "starting order");

  const handles = await page.$$(".section-row .drag-handle");
  const last = await handles[2].boundingBox();
  const first = await handles[0].boundingBox();
  await page.mouse.move(last.x + 5, last.y + 5);
  await page.mouse.down();
  await page.mouse.move(first.x + 5, first.y - 10, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(150);

  assertEqual(await rows(), ["1:Gamma", "2:Alpha", "3:Beta"], "numbers must follow the new order");
  assertEqual(
    (await readState(page)).meeting.sections.map(s => s.name), ["Gamma", "Alpha", "Beta"],
    "stored order should match what's on screen",
  );
});

test("the agenda drag handler is attached once, not once per re-render", async (page, origin) => {
  await page.addInitScript(() => {
    window.__dragHandlers = 0;
    const add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, ...rest) {
      if (type === "pointerdown" && this.id === "section-list") window.__dragHandlers++;
      return add.call(this, type, ...rest);
    };
  });
  await openApp(page, origin, { items: ["A", "B", "C", "D"] });
  assertEqual(await page.evaluate(() => window.__dragHandlers), 1,
    "adding items must not stack another drag handler each time");
});

/* =====================================================================
   Stepping back and forth doesn't lose time or position
   ===================================================================== */

test("stepping back and forward again keeps the time each item had banked", async (page, origin) => {
  await page.clock.install({ time: new Date("2026-01-01T09:00:00") });
  await openApp(page, origin, { items: ["First", "Second"] });
  await startMeeting(page);

  await page.clock.runFor(30000);            // 30s on First
  await page.click('button:has-text("Next Item")');
  await page.waitForTimeout(100);
  await page.clock.runFor(10000);            // 10s on Second

  await page.click('button:has-text("Previous Item")');
  await page.waitForTimeout(100);
  let secs = (await readState(page)).meeting.sections;
  assert(Math.round(secs[0].pausedAccum) >= 29, `First should resume near 30s, got ${Math.round(secs[0].pausedAccum)}s`);
  assert(Math.round(secs[1].pausedAccum) >= 9, `Second's 10s must not be discarded, got ${Math.round(secs[1].pausedAccum)}s`);

  await page.click('button:has-text("Next Item")');
  await page.waitForTimeout(100);
  secs = (await readState(page)).meeting.sections;
  assert(Math.round(secs[1].pausedAccum) >= 9,
    `coming forward should resume Second, not restart it (got ${Math.round(secs[1].pausedAccum)}s)`);
});

test("un-deferring an item puts it back where it was", async (page, origin) => {
  await openApp(page, origin, { items: ["A", "B", "C", "D"] });
  await startMeeting(page); // A is current; B, C, D upcoming

  const cRow = page.locator(".agenda-item", { hasText: "C" }).first();
  await cRow.locator(".icon-btn", { hasText: "✕" }).click();
  await page.waitForTimeout(150);
  assertEqual((await readState(page)).meeting.sections.map(s => s.name), ["A", "B", "D"], "C deferred");

  await page.click('.deferred-row button:has-text("Undo")');
  await page.waitForTimeout(150);
  assertEqual(
    (await readState(page)).meeting.sections.map(s => s.name), ["A", "B", "C", "D"],
    "C should return to its original slot, not the end of the agenda",
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

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
  openApp, startMeeting, endMeeting, typeNote, clickNav, gotoApp, stubWebFonts,
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
  await page.reload({ waitUntil: "domcontentloaded" });
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
   Meetings filed by older versions still show everything they recorded
   ===================================================================== */

test("decisions and actions stored only in the old flat arrays are not lost", async (page, origin) => {
  // A history entry exactly as an older build wrote it: one decision that
  // went through the note markers (so it reached captures, with the item
  // name) and two typed into the old manual forms (flat arrays only).
  const legacy = {
    view: "history",
    meeting: null,
    savedAgendas: [],
    history: [{
      id: "legacy-1",
      title: "Old Board Meeting",
      attendees: "",
      createdAt: Date.parse("2026-01-05T09:00:00"),
      endedAt: Date.parse("2026-01-05T10:00:00"),
      currentIndex: 0,
      timerStatus: "ended",
      generalNotes: "",
      breaks: [],
      deferred: [],
      sections: [{
        id: "s1", name: "Budget review",
        plannedSeconds: 600, originalPlannedSeconds: 600,
        status: "done", startedAt: null, pausedAccum: 0,
        actualSeconds: 540, notes: "", autoReclaimed: 0,
      }],
      captures: [
        { id: "c1", kind: "decision", text: "Filed through the notes", owner: "",
          sectionName: "Budget review", timestamp: Date.parse("2026-01-05T09:10:00") },
      ],
      decisions: ["Filed through the notes", "Typed into the old form"],
      actionItems: [{ text: "Chase the auditor", owner: "Bob" }],
    }],
  };

  await gotoApp(page, origin);
  await page.evaluate(s => localStorage.setItem("chair-meeting-manager:v1", JSON.stringify(s)), legacy);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Where the time goes");

  const kinds = (await readState(page)).history[0].captures;
  assertEqual(kinds.length, 3, "the two flat-array entries should be adopted alongside the existing capture");
  assert(!kinds.some(c => c.text === "Filed through the notes" && !c.sectionName),
    "the entry that already had an item must keep it");
  assertEqual(
    kinds.filter(c => c.text === "Filed through the notes").length, 1,
    "an entry recorded in both places must not be duplicated",
  );

  const action = kinds.find(c => c.kind === "action");
  assertEqual(action.text, "Chase the auditor", "the flat action item should survive");
  assertEqual(action.owner, "Bob", "its owner should survive too");

  // And all three must actually appear on the minutes for that meeting.
  await page.click('.flat-row button:has-text("View")');
  await page.waitForSelector(".page-eyebrow");
  const text = await page.$eval("body", b => b.innerText);
  for (const expected of ["Filed through the notes", "Typed into the old form", "Chase the auditor"]) {
    assert(text.includes(expected), `"${expected}" should be visible on the minutes`);
  }
});

test("repeated wording in an old meeting is kept, not collapsed into one", async (page, origin) => {
  // Real minutes reuse the same words constantly — "noted" once per paper,
  // "approved" once per policy. Matching on text alone would fold a dozen
  // separate resolutions into a single line.
  const legacy = {
    view: "history", meeting: null, savedAgendas: [],
    history: [{
      id: "m1", title: "Board", attendees: "",
      createdAt: Date.parse("2026-01-05T09:00:00"), endedAt: Date.parse("2026-01-05T10:00:00"),
      currentIndex: 0, timerStatus: "ended", generalNotes: "",
      breaks: [], deferred: [], sections: [],
      // One "noted" already recorded properly, against its agenda item.
      captures: [
        { id: "c1", kind: "decision", text: "noted", owner: "",
          sectionName: "3.1 Strategic goals", timestamp: Date.parse("2026-01-05T09:10:00") },
      ],
      decisions: ["noted", "noted", "noted", "approved"],
      actionItems: [{ text: "come back in October", owner: "" }, { text: "come back in October", owner: "" }],
    }],
  };

  await gotoApp(page, origin);
  await page.evaluate(s => localStorage.setItem("chair-meeting-manager:v1", JSON.stringify(s)), legacy);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Where the time goes");

  const caps = (await readState(page)).history[0].captures;
  const count = (kind, text) => caps.filter(c => c.kind === kind && c.text === text).length;

  // Three "noted" in the flat array, one of which is the capture already
  // held — so three in total, not one and not four.
  assertEqual(count("decision", "noted"), 3, "each separate 'noted' resolution must survive");
  assertEqual(count("decision", "approved"), 1, "the single 'approved' should appear once");
  assertEqual(count("action", "come back in October"), 2, "both identical actions must survive");
  assertEqual(
    caps.filter(c => c.sectionName === "3.1 Strategic goals").length, 1,
    "the properly-recorded entry keeps its agenda item and isn't duplicated",
  );
});

/* =====================================================================
   The exported minutes read as a document someone can be held to
   ===================================================================== */

/** A finished meeting with known timings, seeded straight into storage. */
async function seedFinished(page, origin, { sections, captures = [], orderChanged = false, meeting = {} }) {
  const state = {
    view: "minutes", savedAgendas: [], history: [],
    meeting: {
      id: "m1", title: "Board", chair: "", attendees: "", apologies: "",
      createdAt: Date.parse("2026-01-05T09:00:00"), endedAt: Date.parse("2026-01-05T11:00:00"),
      currentIndex: sections.length - 1, timerStatus: "ended", generalNotes: "",
      breaks: [], deferred: [], orderChanged, captures,
      sections: sections.map(([name, planMin, actualSec, notes = ""], i) => ({
        id: "s" + i, name, plannedSeconds: planMin * 60, originalPlannedSeconds: planMin * 60,
        status: "done", startedAt: null, pausedAccum: 0, actualSeconds: actualSec,
        notes, autoReclaimed: 0,
      })),
      ...meeting,
    },
  };
  await gotoApp(page, origin);
  await page.evaluate(s => localStorage.setItem("chair-meeting-manager:v1", JSON.stringify(s)), state);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".page-head");
  return page.evaluate(() =>
    buildMinutesMarkdown(JSON.parse(localStorage.getItem("chair-meeting-manager:v1")).meeting));
}

test("the timing table totals, and the quoted totals match it", async (page, origin) => {
  const md = await seedFinished(page, origin, {
    sections: [["Opening", 1, 13 * 60], ["Budget", 10, 4 * 60], ["Close", 5, 2 * 60]],
  });
  const totalRow = md.split("\n").find(l => l.startsWith("| **Total"));
  assert(totalRow, `the table needs a total row:\n${md}`);
  assert(totalRow.includes("**16 min**"), `planned total should be 16 min, got: ${totalRow}`);
  assert(totalRow.includes("**19 min**"), `actual total should be 19 min, got: ${totalRow}`);
  // And the figures quoted above the table agree with that row.
  assert(md.includes("**Planned duration:** 16 min"), "quoted planned duration should match the table");
  assert(md.includes("**Actual duration:** 19 min"), "quoted actual duration should match the table");
});

test("an item dealt with in seconds reads as under a minute, not as nothing", async (page, origin) => {
  const md = await seedFinished(page, origin, {
    sections: [["Quickly noted", 1, 20], ["Discussed", 10, 9 * 60]],
  });
  const row = md.split("\n").find(l => l.startsWith("| Quickly noted"));
  assert(row.includes("<1 min"), `a 20-second item must not read as "0 min": ${row}`);
  assert(md.includes("1 item took under a minute"), "the export should explain the rounding");
  // The header total still tells the truth about the time spent.
  assert(md.includes("**Actual duration:** 9 min"), `header total should stay exact:\n${md}`);
});

test("the timing table shows variance so overruns are visible", async (page, origin) => {
  const md = await seedFinished(page, origin, {
    sections: [["Ran over", 10, 26 * 60], ["Ran under", 10, 4 * 60], ["Bang on", 5, 5 * 60]],
  });
  assert(md.includes("| Item | Planned | Actual | Variance |"), "the table needs a variance column");
  const row = name => md.split("\n").find(l => l.startsWith(`| ${name}`));
  assert(row("Ran over").endsWith("| +16 |"), `overrun should read +16: ${row("Ran over")}`);
  assert(row("Ran under").endsWith("| −6 |"), `under should read −6: ${row("Ran under")}`);
  assert(row("Bang on").endsWith("| 0 |"), `on-plan should read 0: ${row("Bang on")}`);
});

test("out-of-order items are only flagged when the order actually changed", async (page, origin) => {
  const asRun = { sections: [["4.5 Later item", 5, 60], ["4.4 Earlier item", 5, 60]] };
  const plain = await seedFinished(page, origin, asRun);
  assert(!plain.includes("order the items were taken"),
    "an agenda simply drafted in that order must not be labelled as re-ordered");

  const jumped = await seedFinished(page, origin, { ...asRun, orderChanged: true });
  assert(jumped.includes("order the items were taken"),
    "an agenda actually re-ordered on the day should say so");
});

test("a motion reads as a resolution about its agenda item", async (page, origin) => {
  const md = await seedFinished(page, origin, {
    sections: [["4.1 AI Usage Policy", 5, 60]],
    captures: [
      { id: "mo1", kind: "motion", text: "approved", owner: "", sectionName: "4.1 AI Usage Policy",
        timestamp: Date.now(), moved: "Mel", seconded: "Andrew" },
      { id: "mo2", kind: "motion", text: "noted", owner: "", sectionName: "4.1 AI Usage Policy",
        timestamp: Date.now() },
    ],
  });
  const body = md.split("## 4.1 AI Usage Policy")[1];
  assert(body, `the item should have its own section:\n${md}`);
  assert(
    body.includes("- approved. Moved: Mel. Seconded: Andrew"),
    `the resolution should name the parties:\n${body}`,
  );
  assert(body.includes("- noted"), "a motion without a mover should still be recorded");
  assert(
    !body.split("## ")[0].includes("**4.1 AI Usage Policy**"),
    "the item name is the heading — it must not be repeated on every row",
  );
});

/* ---- the record is organised by agenda item, not duplicated ---- */

test("everything recorded against an item sits under that one heading", async (page, origin) => {
  const md = await seedFinished(page, origin, {
    sections: [
      ["5.1 Property Plan", 10, 26 * 60, "@mel is it divestment or recycling?"],
      ["5.2 Budget", 10, 8 * 60],
    ],
    captures: [
      { id: "d1", kind: "decision", text: "criteria to be drafted", owner: "",
        sectionName: "5.1 Property Plan", timestamp: Date.now() },
      { id: "a1", kind: "action", text: "to introduce Wayne to ASFI", owner: "andrew",
        sectionName: "5.1 Property Plan", timestamp: Date.now() },
    ],
  });

  const block = md.split("## 5.1 Property Plan")[1].split("\n## ")[0];
  assert(block.includes("@mel is it divestment or recycling?"), `notes belong to the item:\n${block}`);
  assert(block.includes("**Decision:** criteria to be drafted"), `decision belongs to the item:\n${block}`);
  assert(block.includes("**Action:** Andrew — to introduce Wayne to ASFI"), `action belongs to the item:\n${block}`);
  assert(block.includes("_Planned 10 min · Actual 26 min (+16)_"), `the item carries its own timing:\n${block}`);

  // The whole point of the restructure: the item is named in the timing
  // table, as its heading, and once more in the action register — and
  // nowhere else. It used to be repeated for every single thing filed.
  assertEqual(
    md.split("5.1 Property Plan").length - 1, 3,
    `the item name should be written three times, not once per capture:\n${md}`,
  );
  // An item nobody said anything about does not get an empty heading.
  assert(!md.includes("## 5.2 Budget"), `an item with no record needs no section:\n${md}`);
});

test("the action register gathers every action with the item it came from", async (page, origin) => {
  const md = await seedFinished(page, origin, {
    sections: [["1.2 In camera", 5, 300], ["5.1 Property Plan", 10, 600]],
    captures: [
      { id: "a1", kind: "action", text: "to share Heiga", owner: "jenica",
        sectionName: "1.2 In camera", timestamp: Date.now() },
      { id: "a2", kind: "action", text: "to come back in December", owner: "",
        sectionName: "5.1 Property Plan", timestamp: Date.now() },
    ],
  });
  const register = md.split("## Action Register")[1];
  assert(register, `actions are the one list worth repeating:\n${md}`);
  assert(
    register.includes("- [ ] Jenica — to share Heiga _(1.2 In camera)_"),
    `an action needs its owner and its item to be worked from:\n${register}`,
  );
  assert(
    register.includes("- [ ] to come back in December _(5.1 Property Plan)_"),
    `an unowned action still belongs in the register:\n${register}`,
  );
});

test("an owner typed as an @mention is written out as a name", async (page, origin) => {
  const md = await seedFinished(page, origin, {
    sections: [["Budget", 5, 300]],
    captures: [{ id: "a1", kind: "action", text: "to circulate the pack", owner: "mary anne",
      sectionName: "Budget", timestamp: Date.now() }],
  });
  assert(md.includes("Mary Anne — to circulate the pack"),
    `a name lifted from an @mention should still read as a name:\n${md}`);
});

test("who chaired and who sent apologies reach the minutes", async (page, origin) => {
  const md = await seedFinished(page, origin, {
    sections: [["Budget", 5, 300]],
    meeting: { chair: "Sam Reed", attendees: "Mel, Andrew", apologies: "Jenica" },
  });
  assert(md.includes("- **Chair:** Sam Reed"), `the chair belongs in the header:\n${md}`);
  assert(md.includes("- **Present:** Mel, Andrew"), `attendance belongs in the header:\n${md}`);
  assert(md.includes("- **Apologies:** Jenica"), `apologies belong in the header:\n${md}`);
  assert(md.includes("- **Date:** "), "the header should still carry the date");
  // Absent fields leave no empty rows behind.
  const bare = await seedFinished(page, origin, { sections: [["Budget", 5, 300]] });
  assert(!bare.includes("**Chair:**") && !bare.includes("**Apologies:**"),
    `an unfilled field should be left out, not printed blank:\n${bare}`);
});

test("moved: and seconded: are lifted off the motion text when filed live", async (page, origin) => {
  await openApp(page, origin, { items: ["4.1 AI Usage Policy"] });
  await startMeeting(page);
  await typeNote(page, "/motion approved moved:Mel seconded:Andrew\n");

  const [motion] = (await readState(page)).meeting.captures.filter(c => c.kind === "motion");
  assertEqual(motion.text, "approved", "the parties should not be left in the resolution text");
  assertEqual(motion.moved, "Mel", "mover recorded");
  assertEqual(motion.seconded, "Andrew", "seconder recorded");
  assertEqual(motion.sectionName, "4.1 AI Usage Policy", "still filed against the item");
});

test("the chair and apologies typed on Prepare survive into the meeting", async (page, origin) => {
  await openApp(page, origin, { items: ["Budget"] });
  await page.fill('input[placeholder="Optional — who is chairing"]', "Sam Reed");
  await page.fill('input[placeholder="Optional — names, comma separated"]', "Mel, Andrew");
  await page.fill('input[placeholder="Optional — who sent apologies"]', "Jenica");
  await startMeeting(page);
  const m = (await readState(page)).meeting;
  assertEqual([m.chair, m.attendees, m.apologies], ["Sam Reed", "Mel, Andrew", "Jenica"],
    "all three should be carried into the running meeting");
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
  await stubWebFonts(page);
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

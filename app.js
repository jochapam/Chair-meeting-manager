"use strict";

/* ---------- constants ---------- */

const STORAGE_KEY = "chair-meeting-manager:v1";
// Written every tick, so it lives in its own key rather than forcing a
// full re-serialise of the whole state once a second.
const LAST_SEEN_KEY = "chair-meeting-manager:last-seen";
const MIN_SECTION_SECONDS = 60; // a section can never be auto-shrunk below this
// A jump larger than this between two ticks (or across a reload) means the
// machine slept or the tab was closed — not that the item genuinely ran
// that long. Comfortably above the ~60s ticks a throttled background tab
// still fires, so switching away for a moment doesn't trip it.
const IDLE_GAP_SECONDS = 120;

/* ---------- state ---------- */

// Set by loadState() when it repairs an older saved shape. The repair is
// written back in the boot block at the bottom of this file — save() reads
// module state declared further down, so it can't run this early.
let migratedLegacy = false;
let state = loadState();
let tickHandle = null;
let liveRefs = null; // DOM references for surgical per-second updates on the live view
let lastTickAt = Date.now(); // wall clock at the previous tick, to spot sleep/suspend gaps

function defaultState() {
  return {
    view: "setup", // setup | live | minutes | history
    meeting: null,
    history: [], // array of completed meeting snapshots (most recent first)
    savedAgendas: [], // array of pre-meeting drafts saved for later (most recent first)
    railWidth: 280, // user-resizable width of the live view's agenda rail, in px
    capturesWidth: 260, // user-resizable width of the live view's captured rail, in px
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    const loaded = Object.assign(defaultState(), parsed);
    migratedLegacy = migrateLegacyCaptures(loaded);
    return loaded;
  } catch (e) {
    return defaultState();
  }
}

// Older meetings kept decisions and action items in two places: m.captures
// (which records the agenda item each belongs to) and flat m.decisions /
// m.actionItems arrays (which don't). Anything typed into the manual "add
// a decision" forms on the old minutes screen landed *only* in the flat
// arrays. Now that everything reads from m.captures, those entries would
// simply vanish from an old meeting — so fold them across on load.
//
// Matching on text alone is deliberate: the same wording filed twice is
// far likelier to be one item recorded two ways than two genuine entries.
function migrateLegacyCaptures(s) {
  let changed = false;
  const meetings = [s.meeting, ...(s.history || [])].filter(Boolean);
  for (const m of meetings) {
    if (!Array.isArray(m.captures)) m.captures = [];
    // Match by count, not by presence. Real minutes repeat the same wording
    // constantly ("noted", "approved", "endorsed" once per paper), so
    // treating a repeat as a duplicate would quietly collapse a dozen
    // separate resolutions into one. Each legacy entry cancels out at most
    // one capture already holding that exact text; the surplus is adopted.
    const spare = new Map();
    for (const c of m.captures) {
      const k = `${c.kind}|${(c.text || "").trim()}`;
      spare.set(k, (spare.get(k) || 0) + 1);
    }

    const adopt = (kind, text, owner) => {
      const clean = (text || "").trim();
      if (!clean) return;
      const key = `${kind}|${clean}`;
      const alreadyHeld = spare.get(key) || 0;
      if (alreadyHeld > 0) { spare.set(key, alreadyHeld - 1); return; }
      m.captures.push({
        id: uid(),
        kind,
        text: clean,
        owner: owner || "",
        // Genuinely unknown — these were never recorded against an item.
        sectionName: "",
        timestamp: m.createdAt || Date.now(),
      });
      changed = true;
    };

    for (const d of m.decisions || []) adopt("decision", typeof d === "string" ? d : d && d.text);
    for (const a of m.actionItems || []) adopt("action", a && a.text, a && a.owner);

    if ("decisions" in m || "actionItems" in m) {
      delete m.decisions;
      delete m.actionItems;
      changed = true;
    }
  }
  return changed;
}

let storageWarned = false;

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    storageWarned = false;
  } catch (e) {
    // Out of quota (or storage blocked). Silently doing nothing here meant
    // every later edit was lost without a word — say it once, loudly.
    if (!storageWarned) {
      storageWarned = true;
      showToast({
        kind: "warning",
        message: "Couldn't save — this browser's storage is full. Export or file older meetings from History to free space.",
        duration: 10000,
      });
    }
  }
}

function markSeen(ts) {
  try { localStorage.setItem(LAST_SEEN_KEY, String(ts)); } catch (e) { /* quota — not worth failing a tick over */ }
}

function lastSeenAt() {
  const raw = Number(localStorage.getItem(LAST_SEEN_KEY));
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ---------- time helpers ---------- */

function fmtClock(totalSeconds) {
  const neg = totalSeconds < 0;
  const s = Math.abs(Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  const core = h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  return (neg ? "-" : "") + core;
}

function fmtMinutes(totalSeconds) {
  const m = Math.round(totalSeconds / 60);
  return `${m} min`;
}

// For a single row of the timing table. An item dealt with in twenty
// seconds rounds to "0 min", which in a formal record can't be told apart
// from one that was skipped — so anything under half a minute is reported
// as under a minute rather than as nothing.
function fmtMinutesRow(totalSeconds) {
  if (totalSeconds > 0 && Math.round(totalSeconds / 60) === 0) return "<1 min";
  return fmtMinutes(totalSeconds);
}

// Signed difference in whole minutes, e.g. "+13" / "−6" / "0".
function fmtVariance(deltaSeconds) {
  const mins = Math.round(deltaSeconds / 60);
  if (mins === 0) return "0";
  return (mins > 0 ? "+" : "−") + Math.abs(mins);
}

function fmtDateTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function fmtTimeOfDay(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }).toLowerCase();
}

function fmtDateTimeLower(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const datePart = d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  return `${datePart}, ${fmtTimeOfDay(ts)}`;
}

/* ---------- agenda text import ---------- */

// Parses lines like "1.2 In camera session   10mins" (tab, spaces, or a
// trailing dash before the number all work). Lines with no trailing
// "Nmin(s)" are skipped, which conveniently drops category headers
// (e.g. "1. Board Governance") and untimed sub-item references
// (e.g. "1.3.a Related Party Transactions") without any special-casing.
// What an item is on the agenda for. A chair runs "for noting" very
// differently from "for discussion", and a reader of the minutes should be
// able to see what was being asked of the meeting rather than infer it.
const PURPOSES = [
  { key: "discussion", label: "Discussion", full: "For discussion" },
  { key: "feedback", label: "Feedback", full: "For feedback" },
  { key: "note", label: "Note", full: "For noting" },
];

const purposeOf = key => PURPOSES.find(p => p.key === key) || null;

// Agendas usually already say this — "1.2 In camera session (for discussion)".
// Lift it off the name when one is pasted in, rather than making a chair
// re-tag thirty items by hand.
const PURPOSE_SUFFIX = /[\s(\[–—:|-]*\bfor\s+(discussion|feedback|noting|note|information|info)\b[)\]]?[\s.]*$/i;

function splitPurpose(name) {
  const hit = name.match(PURPOSE_SUFFIX);
  if (!hit) return { name, purpose: "" };
  const word = hit[1].toLowerCase();
  const stripped = name.slice(0, hit.index).replace(/[-–—:|(\[\s]+$/, "").trim();
  // A line that is nothing but the marker keeps its text — better a badly
  // named item than an empty one.
  if (!stripped) return { name, purpose: "" };
  return { name: stripped, purpose: word === "discussion" ? "discussion" : word === "feedback" ? "feedback" : "note" };
}

function parseAgendaText(text) {
  const parsed = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(.*?)[\s\-–—:|]*(\d+)\s*(?:mins?|minutes?|m)\.?\s*$/i);
    if (!m) continue;
    const raw_name = m[1].trim().replace(/[-–—:|]\s*$/, "").trim();
    const minutes = parseInt(m[2], 10);
    if (!raw_name || !minutes) continue;
    const { name, purpose } = splitPurpose(raw_name);
    parsed.push({ name, minutes, purpose });
  }
  return parsed;
}

/* ---------- meeting model ---------- */

function newSection(name, minutes, purpose = "") {
  const planned = Math.max(1, Math.round(minutes)) * 60;
  return {
    id: uid(),
    name: name || "Untitled section",
    purpose, // "" | discussion | feedback | note — see PURPOSES
    plannedSeconds: planned,
    originalPlannedSeconds: planned,
    status: "upcoming", // upcoming | current | done
    startedAt: null, // epoch ms when this section's timer last (re)started
    pausedAccum: 0, // seconds already elapsed before the current run
    actualSeconds: null, // filled in once the section is done
    notes: "",
    autoReclaimed: 0, // seconds already pulled from upcoming sections due to running overtime
  };
}

function newMeeting() {
  return {
    id: uid(),
    title: "",
    chair: "",
    attendees: "",   // who was present
    apologies: "",
    createdAt: null,
    endedAt: null,
    sections: [],
    currentIndex: -1,
    timerStatus: "idle", // idle | running | paused | ended
    generalNotes: "",
    breaks: [], // {startedAt, endedAt} — endedAt null while a break is in progress
    captures: [], // {id, kind: decision|action|motion, text, owner, sectionName, timestamp} filed from notes
    deferred: [], // sections removed mid-meeting to carry to next time: {id, name, originalPlannedSeconds, deferredAt}
  };
}

/* ---------- saved agendas (pre-meeting drafts) ---------- */

function saveAgendaForLater(isStanding) {
  const m = state.meeting;
  if (m.sections.length === 0) {
    showToast({ message: "Add at least one agenda section before saving.", kind: "warning" });
    return;
  }
  if (isStanding) {
    // Only one standing agenda at a time — keep it unambiguous which one auto-loads.
    for (const a of state.savedAgendas) a.isStanding = false;
  }
  state.savedAgendas.unshift({
    id: uid(),
    title: m.title,
    chair: m.chair,
    attendees: m.attendees,
    sections: JSON.parse(JSON.stringify(m.sections)),
    savedAt: Date.now(),
    isStanding: !!isStanding,
  });
  save();
  renderSetup();
  showToast({ message: isStanding ? `Set "${m.title || "Untitled Meeting"}" as the standing agenda.` : `Saved "${m.title || "Untitled Meeting"}" for later.` });
}

function loadSavedAgenda(id) {
  const saved = state.savedAgendas.find(a => a.id === id);
  if (!saved) return;
  const m = state.meeting;
  const applyLoad = () => {
    m.title = saved.title;
    // Agendas saved before these fields existed have neither.
    m.chair = saved.chair || "";
    m.attendees = saved.attendees || "";
    m.sections = JSON.parse(JSON.stringify(saved.sections));
    save();
    renderSetup();
  };
  if (m.sections.length > 0) {
    showToast({
      kind: "confirm",
      message: `Load "${saved.title || "Untitled Meeting"}"? This replaces your current draft.`,
      confirmLabel: "Load",
      onConfirm: applyLoad,
    });
  } else {
    applyLoad();
  }
}

function deleteSavedAgenda(id) {
  const idx = state.savedAgendas.findIndex(a => a.id === id);
  if (idx === -1) return;
  const [removed] = state.savedAgendas.splice(idx, 1);
  save();
  renderSetup();
  showToast({
    kind: "undo",
    message: `Deleted "${removed.title || "Untitled Meeting"}".`,
    onUndo: () => {
      state.savedAgendas.splice(idx, 0, removed);
      save();
      renderSetup();
    },
  });
}

// History-based duration suggestion: if the last few meetings all had a
// section with this exact name and it ran over every time, suggest the
// honest average instead of the drafted number.
function durationSuggestion(name) {
  const norm = name.trim().toLowerCase();
  if (!norm) return null;
  const samples = [];
  for (const m of state.history) {
    const s = m.sections.find(x => x.name.trim().toLowerCase() === norm && x.actualSeconds != null);
    if (s) samples.push(s);
  }
  if (samples.length < 2) return null;
  const recent = samples.slice(0, 3);
  const overCount = recent.filter(s => s.actualSeconds > s.originalPlannedSeconds).length;
  if (overCount < recent.length) return null; // only suggest when it overran every time on record
  const avgActual = recent.reduce((sum, s) => sum + s.actualSeconds, 0) / recent.length;
  const suggestedMinutes = Math.max(1, Math.round(avgActual / 60 / 5) * 5); // round to nearest 5 min
  return { count: recent.length, minutes: suggestedMinutes };
}

function currentSection() {
  if (!state.meeting || state.meeting.currentIndex < 0) return null;
  return state.meeting.sections[state.meeting.currentIndex];
}

function elapsedSeconds(section) {
  if (!section) return 0;
  let elapsed = section.pausedAccum;
  if (section.status === "current" && state.meeting.timerStatus === "running" && section.startedAt) {
    elapsed += (Date.now() - section.startedAt) / 1000;
  }
  return elapsed;
}

// Positive = running behind the original agenda; negative = ahead of it.
// Finished sections count their full actual-vs-original-planned gap (a
// section that wrapped up early is a realized saving). The in-progress
// section only ever contributes if it has *already* run past its own
// original budget — unused remaining budget is never counted as "ahead,"
// since that time hasn't actually been saved until the section ends.
// Extends/auto-shrinks don't move the baseline (originalPlannedSeconds),
// so this tracks the schedule as first drafted, not as adjusted live.
function scheduleVarianceSeconds() {
  const m = state.meeting;
  let variance = 0;
  for (const s of m.sections) {
    if (s.status === "done") {
      variance += s.actualSeconds - s.originalPlannedSeconds;
    } else if (s.status === "current") {
      variance += Math.max(0, elapsedSeconds(s) - s.originalPlannedSeconds);
    }
  }
  return variance;
}

function scheduleBadgeInfo() {
  const diff = scheduleVarianceSeconds();
  if (Math.abs(diff) < 30) return { text: "On schedule", word: "ON PLAN", cls: "on" };
  const mins = Math.round(Math.abs(diff) / 60);
  return diff > 0
    ? { text: `${mins} min behind schedule`, word: `+${fmtClock(diff)} BEHIND`, cls: "behind" }
    : { text: `${mins} min ahead of schedule`, word: `${fmtClock(diff).replace("-", "")} AHEAD`, cls: "ahead" };
}

/* ---------- proportional shrink ---------- */

function shrinkUpcomingSections(neededSeconds) {
  const m = state.meeting;
  const upcoming = m.sections.filter(s => s.status === "upcoming");
  let remaining = neededSeconds;
  let guard = 0;
  while (remaining > 0.5 && guard < 50) {
    guard++;
    const eligible = upcoming.filter(s => s.plannedSeconds > MIN_SECTION_SECONDS);
    if (eligible.length === 0) break;
    const totalEligible = eligible.reduce((sum, s) => sum + s.plannedSeconds, 0);
    let distributed = 0;
    for (const s of eligible) {
      const share = (s.plannedSeconds / totalEligible) * remaining;
      const maxReducible = s.plannedSeconds - MIN_SECTION_SECONDS;
      const reduce = Math.min(share, maxReducible);
      s.plannedSeconds -= reduce;
      distributed += reduce;
    }
    remaining -= distributed;
    if (distributed < 0.5) break;
  }
  return neededSeconds - remaining; // amount actually reclaimed
}

function extendCurrentSection(minutes) {
  const sec = currentSection();
  if (!sec) return;
  const addSeconds = minutes * 60;
  sec.plannedSeconds += addSeconds;
  shrinkUpcomingSections(addSeconds);
  save();
  renderLive();
}

function deferSection(id) {
  const m = state.meeting;
  const idx = m.sections.findIndex(s => s.id === id);
  if (idx === -1) return;
  const [removed] = m.sections.splice(idx, 1);
  m.deferred.push({ id: removed.id, name: removed.name, originalPlannedSeconds: removed.originalPlannedSeconds, deferredAt: Date.now(), fromIndex: idx });
  save();
  renderLive();
  showToast({ message: `"${removed.name}" deferred to next meeting.` });
}

function undoDefer(id) {
  const m = state.meeting;
  const idx = m.deferred.findIndex(d => d.id === id);
  if (idx === -1) return;
  const [d] = m.deferred.splice(idx, 1);
  const restored = newSection(d.name, d.originalPlannedSeconds / 60);
  restored.id = d.id;
  // Put it back where it was rather than at the end, but never ahead of
  // the item currently running.
  const at = Math.min(
    m.sections.length,
    Math.max(m.currentIndex + 1, d.fromIndex ?? m.sections.length),
  );
  m.sections.splice(at, 0, restored);
  save();
  renderLive();
}

/* ---------- notes that file themselves ---------- */

function fileCapture(kind, text, owner, extra) {
  const m = state.meeting;
  const sec = currentSection();
  if (!sec) return;
  m.captures.push(Object.assign(
    { id: uid(), kind, text, owner: owner || "", sectionName: sec.name, timestamp: Date.now() },
    extra || {},
  ));
  save();
  updateCapturesPanel();
}

function extractOwner(text) {
  const m = text.match(/@(\S+)/);
  return m ? m[1] : null;
}

// Most constitutions want a mover and a seconder on the record. Written as
// "moved:Mel seconded:Andrew" anywhere in the motion line; both optional,
// and stripped from the resolution text itself.
// "Approved" on its own records nothing: the agenda item is the subject of
// the resolution, so it has to lead rather than trail in brackets.
// Owners are typed inline as "@jenica", so they arrive lower-cased. Only
// the first letter is touched: "WW" and "McDonald" must survive intact.
function displayName(name) {
  if (!name) return "";
  return String(name).split(/\s+/).map(w => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}

// "25 Aug 2026, 5:20 pm – 7:15 pm" once the meeting has ended.
function meetingWhen(m) {
  if (!m.createdAt) return "";
  const start = fmtDateTimeLower(m.createdAt);
  return m.endedAt ? `${start} – ${fmtTimeOfDay(m.endedAt)}` : start;
}

// Everything recorded against one agenda item, so the minutes can be laid
// out item by item instead of scattering an item's record across four
// separate sections that each repeat its name.
// Grow a note box to fit what's in it. The minutes are read far more often
// than they're edited, so an unused box should not take up a fixed block.
function autoGrow(ta) {
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
}

// The little "DISCUSSION" / "FEEDBACK" / "NOTE" marker. Returns null for an
// untagged item so it can be appended unconditionally.
function purposeChip(section) {
  const p = purposeOf(section.purpose);
  return p ? el("span", { class: `purpose-chip purpose-${p.key}` }, p.label) : null;
}

function itemRecord(m, section) {
  const of = kind => (m.captures || []).filter(c => c.kind === kind && c.sectionName === section.name);
  return {
    decisions: of("decision"),
    actions: of("action"),
    motions: of("motion"),
    notes: (section.notes || "").trim(),
  };
}

function itemHasRecord(r) {
  return !!(r.notes || r.decisions.length || r.actions.length || r.motions.length);
}

// One line per action, used in both the item body and the register.
function actionLine(a, { withItem = false } = {}) {
  const who = displayName(a.owner);
  const item = withItem && a.sectionName ? ` _(${a.sectionName})_` : "";
  return `${who ? `${who} — ` : ""}${a.text}${item}`;
}

// "**Motion:** approved" for one, a bulleted list for several.
function labelledBlock(singular, plural, entries) {
  if (!entries.length) return [];
  if (entries.length === 1) return [`**${singular}:** ${entries[0]}`, ""];
  return [`**${plural}:**`, ...entries.map(e => `- ${e}`), ""];
}

function motionParts(mo) {
  const parties = [];
  if (mo.moved) parties.push(`Moved: ${mo.moved}`);
  if (mo.seconded) parties.push(`Seconded: ${mo.seconded}`);
  return { item: mo.sectionName || "", outcome: (mo.text || "").trim(), parties: parties.join(". ") };
}

function extractMotionParties(text) {
  let moved = null;
  let seconded = null;
  let rest = text
    .replace(/\bmoved\s*:\s*@?([^\s,;]+)/i, (_, n) => { moved = n; return " "; })
    .replace(/\bseconded\s*:\s*@?([^\s,;]+)/i, (_, n) => { seconded = n; return " "; });
  return { moved, seconded, text: rest.replace(/\s{2,}/g, " ").trim() };
}

/* ---------- timer controls ---------- */

function startMeeting() {
  const m = state.meeting;
  m.createdAt = Date.now();
  m.currentIndex = 0;
  m.timerStatus = "running";
  m.sections[0].status = "current";
  m.sections[0].startedAt = Date.now();
  m.sections[0].pausedAccum = 0;
  state.view = "live";
  save();
  render();
}

function togglePause() {
  const m = state.meeting;
  const sec = currentSection();
  if (!sec) return;
  if (m.timerStatus === "running") {
    sec.pausedAccum = elapsedSeconds(sec);
    sec.startedAt = null;
    m.timerStatus = "paused";
  } else if (m.timerStatus === "paused") {
    sec.startedAt = Date.now();
    m.timerStatus = "running";
    closeOpenBreaks(m, Date.now());
  }
  save();
  renderLive();
}

// A break is a labeled pause: it stops the item clock exactly like Pause,
// but is recorded so the minutes can show it, rather than a recess being
// silently absorbed into whichever section happens to be running.
function takeBreak() {
  const m = state.meeting;
  const sec = currentSection();
  if (!sec) return;
  // Already on a break: don't open a second one. Only the most recent open
  // break ever gets closed on resume, so a stacked one would stay open for
  // the life of the meeting and inflate every break total that reads it.
  if (m.breaks.some(b => b.endedAt == null)) return;
  if (m.timerStatus === "running") {
    sec.pausedAccum = elapsedSeconds(sec);
    sec.startedAt = null;
    m.timerStatus = "paused";
  }
  m.breaks.push({ startedAt: Date.now(), endedAt: null });
  save();
  renderLive();
}

function goToNextSection() {
  const m = state.meeting;
  const sec = currentSection();
  if (!sec) return;
  sec.actualSeconds = elapsedSeconds(sec);
  sec.status = "done";
  sec.startedAt = null;

  const nextIndex = m.currentIndex + 1;
  if (nextIndex >= m.sections.length) {
    endMeeting();
    return;
  }
  m.currentIndex = nextIndex;
  const next = m.sections[nextIndex];
  next.status = "current";
  next.startedAt = Date.now();
  // Don't zero this: an item stepped away from with Previous has banked
  // time, and coming forward again should resume it, not restart it. A
  // genuinely fresh item is already at 0.
  next.pausedAccum = next.pausedAccum || 0;
  m.timerStatus = "running";
  save();
  render();
}

// The play button on any upcoming item: moves that item to the front of
// the queue (right after whatever's current) and starts it immediately.
// Items it jumps over aren't lost — they just now run after it.
function jumpToSection(id) {
  const m = state.meeting;
  if (!m) return;
  const idx = m.sections.findIndex(s => s.id === id);
  if (idx === -1 || m.sections[idx].status !== "upcoming") return;
  const [sec] = m.sections.splice(idx, 1);
  m.sections.splice(m.currentIndex + 1, 0, sec);
  m.orderChanged = true;
  goToNextSection();
}

// Steps back to the previous item: puts the current one back to upcoming
// (untimed, as if it hadn't started), and resumes the previous item's
// clock from exactly where it left off rather than restarting it.
function goToPreviousSection() {
  const m = state.meeting;
  if (!m || m.currentIndex <= 0) return;
  const sec = currentSection();
  if (!sec) return;
  // Keep whatever time this item has already banked. Zeroing it meant a
  // mis-click on Previous silently threw away the elapsed time of the item
  // you were on; stepping forward again now resumes where it left off.
  // Read the elapsed time before touching status — elapsedSeconds() only
  // counts the running portion while the section is still "current".
  const banked = elapsedSeconds(sec);
  sec.status = "upcoming";
  sec.pausedAccum = banked;
  sec.startedAt = null;
  sec.actualSeconds = null;

  const prevIndex = m.currentIndex - 1;
  m.currentIndex = prevIndex;
  const prev = m.sections[prevIndex];
  prev.status = "current";
  prev.pausedAccum = prev.actualSeconds || 0;
  prev.actualSeconds = null;
  // Stay paused if we were paused — stepping back shouldn't start a clock
  // the chair had deliberately stopped.
  if (m.timerStatus === "running") prev.startedAt = Date.now();
  else prev.startedAt = null;
  save();
  render();
}

function endMeeting() {
  const m = state.meeting;
  const sec = currentSection();
  if (sec && sec.status === "current") {
    sec.actualSeconds = elapsedSeconds(sec);
    sec.status = "done";
    sec.startedAt = null;
  }
  m.timerStatus = "ended";
  m.endedAt = Date.now();
  // Close any break still open, so its duration is fixed at the moment the
  // meeting ended. Left open, every later read of the minutes would measure
  // it against "now" and the filed record would keep growing.
  closeOpenBreaks(m, m.endedAt);
  state.view = "minutes";
  save();
  render();
}

// A break with no endedAt is still running. Anything that finishes a
// meeting (or resumes from a break) has to close it, or duration maths
// downstream measures it against the current time forever.
function closeOpenBreaks(m, at) {
  if (!m || !m.breaks) return;
  for (const b of m.breaks) {
    if (b.endedAt == null) b.endedAt = at;
  }
}

// Total time spent in breaks. Falls back to the meeting's end (not "now")
// for any break that was somehow left open, so a filed meeting always
// reports the same number no matter when it's read.
function breakTotalSeconds(m) {
  if (!m || !m.breaks || !m.breaks.length) return 0;
  const fallback = m.endedAt || Date.now();
  return m.breaks.reduce((s, b) => s + ((b.endedAt ?? fallback) - b.startedAt) / 1000, 0);
}

// A meeting is "filed" once a copy of it is in history. Keyed on id rather
// than a flag so that viewing a history entry (which points state.meeting
// straight at it) correctly reports as already filed.
function isFiled(m) {
  return !!m && state.history.some(h => h.id === m.id);
}

// Idempotent: filing twice is a no-op rather than a duplicate entry.
function fileMeeting(m) {
  if (!m || isFiled(m)) return false;
  state.history.unshift(JSON.parse(JSON.stringify(m)));
  return true;
}

/* ---------- markdown export ---------- */

function buildMinutesMarkdown(m) {
  const lines = [];
  lines.push(`# ${m.title || "Untitled Meeting"}`);
  lines.push("");
  lines.push(`- **Date:** ${meetingWhen(m)}`);
  if (m.chair) lines.push(`- **Chair:** ${m.chair}`);
  if (m.attendees) lines.push(`- **Present:** ${m.attendees}`);
  if (m.apologies) lines.push(`- **Apologies:** ${m.apologies}`);
  const totalPlanned = m.sections.reduce((s, x) => s + x.originalPlannedSeconds, 0);
  // Only time that was actually spent. Falling back to plannedSeconds here
  // counted items that never ran as though they had, so ending a meeting
  // early reported far more time than the meeting took.
  const totalActual = m.sections.reduce((s, x) => s + (x.actualSeconds ?? 0), 0);
  const unrun = m.sections.filter(x => x.actualSeconds == null).length;
  lines.push(`- **Planned duration:** ${fmtMinutes(totalPlanned)}`);
  lines.push(`- **Actual duration:** ${fmtMinutes(totalActual)}${unrun ? ` (${unrun} item${unrun === 1 ? "" : "s"} not reached)` : ""}`);
  if (m.breaks && m.breaks.length) {
    lines.push(`- **Breaks:** ${m.breaks.length} (${fmtMinutes(breakTotalSeconds(m))} total)`);
  }
  lines.push("");

  lines.push("## Timing summary");
  lines.push("");
  // Only claim this when the running order actually departed from the
  // prepared one — recorded at the moment it happens, since item names
  // aren't reliably numbered and can't be re-derived here.
  if (m.orderChanged) {
    lines.push("_Listed in the order the items were taken, which differed from the agenda._");
    lines.push("");
  }
  // The Purpose column only appears on an agenda that was actually tagged,
  // so a meeting that doesn't use them isn't given a column of dashes.
  const anyPurpose = m.sections.some(s => purposeOf(s.purpose));
  const purposeCell = s => {
    const p = purposeOf(s.purpose);
    return anyPurpose ? ` ${p ? p.label : "—"} |` : "";
  };
  lines.push(`| Item |${anyPurpose ? " Purpose |" : ""} Planned | Actual | Variance |`);
  lines.push(`|---|${anyPurpose ? "---|" : ""}---|---|---|`);
  for (const s of m.sections) {
    const ran = s.actualSeconds != null;
    const actual = ran ? fmtMinutesRow(s.actualSeconds) : "—";
    const variance = ran ? fmtVariance(s.actualSeconds - s.originalPlannedSeconds) : "—";
    lines.push(`| ${s.name} |${purposeCell(s)} ${fmtMinutesRow(s.originalPlannedSeconds)} | ${actual} | ${variance} |`);
  }
  // A total row, so the figures quoted above the table can be checked
  // against it. Both come from the same unrounded seconds — without this
  // a reader adding the column would land a few minutes off, because each
  // row is rounded on its own.
  lines.push(`| **Total** |${anyPurpose ? " |" : ""} **${fmtMinutes(totalPlanned)}** | **${fmtMinutes(totalActual)}** | **${fmtVariance(totalActual - totalPlanned)}** |`);
  lines.push("");
  // Say plainly why the column need not add up to the total, rather than
  // leaving a reader to wonder whether the figures are wrong.
  const briefItems = m.sections.filter(x => x.actualSeconds != null && x.actualSeconds > 0 && Math.round(x.actualSeconds / 60) === 0).length;
  if (briefItems) {
    lines.push(`_Each row is rounded to the nearest minute; ${briefItems} item${briefItems === 1 ? "" : "s"} took under a minute. The totals are exact._`);
    lines.push("");
  }

  // The body of the minutes, item by item. Everything recorded against an
  // item — notes, decisions, motions, actions — sits under its heading, so
  // the item name is written once and the whole record of it is in one
  // place. Items with nothing recorded stay in the timing table above
  // rather than becoming empty headings here.
  for (const sec of m.sections) {
    const r = itemRecord(m, sec);
    if (!itemHasRecord(r)) continue;
    lines.push(`## ${sec.name}`);
    lines.push("");
    // No timing line here. The table above already gives every item its
    // planned, actual and variance, and repeating it under the heading was
    // the same duplication this structure exists to remove.
    const p = purposeOf(sec.purpose);
    if (p) {
      lines.push(`_${p.full}_`);
      lines.push("");
    }
    if (r.notes) {
      lines.push(r.notes);
      lines.push("");
    }
    lines.push(...labelledBlock("Decision", "Decisions", r.decisions.map(d => d.text)));
    lines.push(...labelledBlock("Motion", "Motions", r.motions.map(mo => {
      const p = motionParts(mo);
      return `${p.outcome}${p.parties ? `. ${p.parties}` : ""}`;
    })));
    lines.push(...labelledBlock("Action", "Actions", r.actions.map(a => actionLine(a))));
  }

  // Captures whose agenda item was never recorded — only migrated entries
  // from much older meetings. Better an honest heading than dropping them.
  const orphans = (m.captures || []).filter(c => !c.sectionName);
  if (orphans.length) {
    lines.push("## Not attributed to an item");
    lines.push("");
    lines.push(...labelledBlock("Decision", "Decisions", orphans.filter(c => c.kind === "decision").map(d => d.text)));
    lines.push(...labelledBlock("Motion", "Motions", orphans.filter(c => c.kind === "motion").map(mo => motionParts(mo).outcome)));
    lines.push(...labelledBlock("Action", "Actions", orphans.filter(c => c.kind === "action").map(a => actionLine(a))));
  }

  if (m.deferred && m.deferred.length) {
    lines.push("## Deferred to Next Meeting");
    lines.push("");
    for (const d of m.deferred) lines.push(`- ${d.name} (${fmtMinutes(d.originalPlannedSeconds)})`);
    lines.push("");
  }

  // The one list worth repeating. Actions are the part of the minutes with
  // a life after the meeting — people work from them, and nobody should
  // have to read 28 items to find what they owe.
  const actionItems = (m.captures || []).filter(c => c.kind === "action");
  if (actionItems.length) {
    lines.push("## Action Register");
    lines.push("");
    for (const a of actionItems) lines.push(`- [ ] ${actionLine(a, { withItem: true })}`);
    lines.push("");
  }

  if (m.generalNotes && m.generalNotes.trim()) {
    lines.push("## Closing Notes");
    lines.push("");
    lines.push(m.generalNotes.trim());
    lines.push("");
  }

  return lines.join("\n");
}

function downloadMarkdown(m) {
  const md = buildMinutesMarkdown(m);
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safeTitle = (m.title || "meeting").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const dateStr = new Date(m.createdAt || Date.now()).toISOString().slice(0, 10);
  a.href = url;
  a.download = `${safeTitle || "meeting"}-${dateStr}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function copyMinutesToClipboard(m) {
  const md = buildMinutesMarkdown(m);
  try {
    await navigator.clipboard.writeText(md);
    showToast({ message: "Minutes copied — ready to paste into an email." });
  } catch (e) {
    showToast({ message: "Couldn't access the clipboard. Try Export Markdown instead.", kind: "warning" });
  }
}

/* ---------- DOM helpers ---------- */

const app = document.getElementById("app");

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (k === "html") node.innerHTML = v;
      else node.setAttribute(k, v);
    }
  }
  if (children) {
    for (const c of [].concat(children)) {
      if (c == null) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
  }
  return node;
}

function clearTick() {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

/* Pointer-based drag reorder (works for mouse and touch, no library).
   `rowSelector` matches the draggable rows among container's descendants —
   for a list with fixed leading rows (e.g. done/current agenda items before
   the reorderable upcoming ones), only rows matching the selector ever
   participate, so the boundary is respected automatically. Rows need a
   `data-id` attribute and a `.drag-handle` child to grab. */
function enableDragReorder(container, rowSelector, onDrop) {
  let dragEl = null;
  let startY = 0;

  function getRows() {
    return Array.from(container.querySelectorAll(rowSelector));
  }

  function onPointerMove(e) {
    if (!dragEl) return;
    dragEl.style.transform = `translateY(${e.clientY - startY}px)`;
    const rows = getRows();
    const dragIndex = rows.indexOf(dragEl);
    const dragRect = dragEl.getBoundingClientRect();
    const dragMid = dragRect.top + dragRect.height / 2;
    for (let i = 0; i < rows.length; i++) {
      if (i === dragIndex) continue;
      const mid = rows[i].getBoundingClientRect().top + rows[i].getBoundingClientRect().height / 2;
      if (i < dragIndex && dragMid < mid) {
        container.insertBefore(dragEl, rows[i]);
        dragEl.style.transform = "";
        startY = e.clientY;
        break;
      }
      if (i > dragIndex && dragMid > mid) {
        container.insertBefore(dragEl, rows[i].nextSibling);
        dragEl.style.transform = "";
        startY = e.clientY;
        break;
      }
    }
  }

  function onPointerUp(e) {
    if (!dragEl) return;
    dragEl.releasePointerCapture(e.pointerId);
    dragEl.classList.remove("dragging");
    dragEl.style.transform = "";
    container.removeEventListener("pointermove", onPointerMove);
    container.removeEventListener("pointerup", onPointerUp);
    container.removeEventListener("pointercancel", onPointerUp);
    const finalOrder = getRows().map(r => r.dataset.id);
    dragEl = null;
    onDrop(finalOrder);
  }

  container.addEventListener("pointerdown", (e) => {
    const handle = e.target.closest(".drag-handle");
    if (!handle) return;
    const row = handle.closest(rowSelector);
    if (!row) return;
    e.preventDefault();
    dragEl = row;
    startY = e.clientY;
    dragEl.classList.add("dragging");
    dragEl.setPointerCapture(e.pointerId);
    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerup", onPointerUp);
    container.addEventListener("pointercancel", onPointerUp);
  });
}

const PANEL_MIN_WIDTH = 200;
const PANEL_MAX_WIDTH = 520;

// Drags a side panel's width via a CSS custom property (rather than setting
// grid-template-columns inline), so the narrow-viewport media query that
// collapses the grid to a single column can still win — an inline
// grid-template-columns would out-specificity it at any width. Mutates live
// during the drag for a smooth feel; only writes to state (+ saves) on
// release, since a full renderLive() mid-drag would fight the pointer
// capture. `invert` is for a panel on the right edge (captures rail),
// where dragging left (negative dx) is what widens it.
function enablePanelResize(handle, bodyEl, { cssVar, stateKey, defaultWidth, invert }) {
  let startX = 0;
  let startWidth = 0;
  let currentWidth = 0;
  const sign = invert ? -1 : 1;

  function onPointerMove(e) {
    currentWidth = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, startWidth + sign * (e.clientX - startX)));
    bodyEl.style.setProperty(cssVar, `${currentWidth}px`);
  }

  function onPointerUp(e) {
    handle.releasePointerCapture(e.pointerId);
    handle.classList.remove("dragging");
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    document.removeEventListener("pointercancel", onPointerUp);
    if (currentWidth > 0) {
      state[stateKey] = currentWidth;
      save();
    }
  }

  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    startX = e.clientX;
    startWidth = state[stateKey] || defaultWidth;
    currentWidth = startWidth;
    handle.classList.add("dragging");
    handle.setPointerCapture(e.pointerId);
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerUp);
  });
}

/* ---------- toast (replaces native confirm()/alert()) ---------- */

let toastEl = null;
let toastTimer = null;

function ensureToastEl() {
  if (toastEl) return toastEl;
  toastEl = document.createElement("div");
  toastEl.className = "toast";
  document.body.appendChild(toastEl);
  return toastEl;
}

function hideToast() {
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  if (toastEl) toastEl.classList.remove("visible");
}

// kind: "info" | "warning" | "confirm" | "undo"
function showToast({ message, kind = "info", confirmLabel = "Confirm", onConfirm, onCancel, onUndo, duration }) {
  const t = ensureToastEl();
  if (toastTimer) clearTimeout(toastTimer);
  t.innerHTML = "";
  t.className = `toast visible toast-${kind}`;
  t.appendChild(el("span", { class: "toast-msg" }, message));
  if (kind === "confirm") {
    const confirmBtn = el("button", { class: "btn btn-primary" }, confirmLabel);
    confirmBtn.addEventListener("click", () => { hideToast(); if (onConfirm) onConfirm(); });
    const cancelBtn = el("button", { class: "btn" }, "Cancel");
    cancelBtn.addEventListener("click", () => { hideToast(); if (onCancel) onCancel(); });
    t.appendChild(confirmBtn);
    t.appendChild(cancelBtn);
  } else if (kind === "undo") {
    const undoBtn = el("button", { class: "btn" }, "Undo");
    undoBtn.addEventListener("click", () => { hideToast(); if (onUndo) onUndo(); });
    t.appendChild(undoBtn);
    toastTimer = setTimeout(hideToast, duration || 7000);
  } else {
    toastTimer = setTimeout(hideToast, duration || 4000);
  }
}

function switchView(view) {
  state.view = view;
  save();
  render();
}

/* ---------- top nav (setup / minutes / history — live view has its own header) ---------- */

// Four explicit tabs, used identically in the plain topbar (Setup/Minutes/
// History) and the live cockpit header — Prepare is disabled while a
// meeting is actually running/paused (there's only ever one meeting in
// flight, so starting a fresh draft would blow away the live one); Live is
// disabled until a meeting is actually running/paused; Minutes is disabled
// until one has ended.
function navButtons(activeKey) {
  const m = state.meeting;
  const meetingActive = m && (m.timerStatus === "running" || m.timerStatus === "paused");
  const meetingEnded = m && m.timerStatus === "ended";

  const prepareBtn = el("button", { class: activeKey === "prepare" ? "active" : "" }, "Prepare");
  if (meetingActive) {
    prepareBtn.disabled = true;
    prepareBtn.title = "Finish or end the current meeting first";
  } else if (meetingEnded && !isFiled(m)) {
    // Preparing a new meeting replaces this one. It's finished but not yet
    // in history, so leaving without filing would lose the whole record —
    // ask rather than assume.
    prepareBtn.title = "These minutes aren't filed yet";
    prepareBtn.addEventListener("click", () => {
      showToast({
        kind: "confirm",
        message: `"${m.title || "Untitled meeting"}" hasn't been filed yet. File it to History before starting a new meeting?`,
        confirmLabel: "File & Continue",
        onConfirm: () => { fileMeeting(m); save(); switchView("setup"); },
      });
    });
  } else {
    prepareBtn.addEventListener("click", () => switchView("setup"));
  }

  const liveBtn = el("button", { class: activeKey === "live" ? "active" : "" }, "Live");
  if (!meetingActive) {
    liveBtn.disabled = true;
    liveBtn.title = "No meeting running yet — prepare one first";
  } else {
    liveBtn.addEventListener("click", () => switchView("live"));
  }

  const minutesBtn = el("button", { class: activeKey === "minutes" ? "active" : "" }, "Minutes");
  if (!meetingEnded) {
    minutesBtn.disabled = true;
    minutesBtn.title = "Minutes appear once a meeting has ended";
  } else {
    minutesBtn.addEventListener("click", () => switchView("minutes"));
  }

  const historyBtn = el("button", { class: activeKey === "history" ? "active" : "" }, "History");
  historyBtn.addEventListener("click", () => switchView("history"));

  return [prepareBtn, liveBtn, minutesBtn, historyBtn];
}

function renderTopbar(activeView) {
  const activeKey = activeView === "setup" ? "prepare" : activeView === "live" ? "live" : activeView === "minutes" ? "minutes" : "history";
  const nav = el("div", { class: "nav-links" }, navButtons(activeKey));
  const m = state.meeting;
  const rightText = activeView === "setup" && m
    ? `Baseline ${Math.round(m.sections.reduce((s, x) => s + x.plannedSeconds, 0) / 60)} min`
    : (m ? (m.title || "Untitled Meeting") : "");
  return el("div", { class: "topbar" }, [
    el("h1", null, [el("span", { class: "brand-dot" }), "Chair's Meeting Manager"]),
    nav,
    el("div", { class: "spacer" }),
    el("div", { class: "topbar-right" }, rightText),
  ]);
}

/* ---------- SETUP VIEW ---------- */

function agendaTotalMinutes(sections) {
  return Math.round(sections.reduce((s, x) => s + x.plannedSeconds, 0) / 60);
}

function renderSetup() {
  clearTick();
  if (!state.meeting || state.meeting.timerStatus !== "idle") {
    // Last-resort safety net. The nav asks before it gets here, but any
    // other route into Setup must still never drop a finished meeting on
    // the floor — file it instead of overwriting it.
    if (state.meeting && state.meeting.timerStatus === "ended") fileMeeting(state.meeting);
    state.meeting = newMeeting();
    save();
  }
  const m = state.meeting;

  app.innerHTML = "";
  app.appendChild(renderTopbar("setup"));

  const layout = el("div", { class: "two-col" });
  const main = el("div", null);
  const sidebar = el("div", { class: "side-col" });

  const headRow = el("div", { class: "row", style: "justify-content:space-between;align-items:flex-start" });
  headRow.appendChild(el("h1", { class: "page-head" }, "Prepare the meeting"));
  const newMeetingBtn = el("button", { class: "btn btn-small" }, "New Meeting");
  newMeetingBtn.addEventListener("click", startNewMeetingDraft);
  headRow.appendChild(newMeetingBtn);
  main.appendChild(headRow);
  main.appendChild(el("p", { class: "page-sub" }, "Durations set the baseline the whole meeting is measured against. Where you've run this item before, the suggestion is what actually happened."));
  main.appendChild(el("hr", { class: "page-hr" }));

  const titleField = el("div", { class: "field" });
  titleField.appendChild(el("label", { class: "field-label" }, "Title"));
  const titleInput = el("input", {
    class: "underline-input", type: "text", value: m.title, placeholder: "e.g. Q3 Steering Committee",
    oninput: (e) => { m.title = e.target.value; save(); },
  });
  titleField.appendChild(titleInput);
  main.appendChild(titleField);

  // Chair, Present and Apologies are what a reader of the minutes checks
  // first — who ran it, who was in the room, and who was excused. They go
  // in here rather than being reconstructed afterwards from memory.
  const textField = (label, key, placeholder) => {
    const field = el("div", { class: "field" });
    field.appendChild(el("label", { class: "field-label" }, label));
    field.appendChild(el("input", {
      class: "underline-input", type: "text", value: m[key] || "", placeholder,
      oninput: (e) => { m[key] = e.target.value; save(); },
    }));
    return field;
  };
  main.appendChild(textField("Chair", "chair", "Optional — who is chairing"));
  main.appendChild(textField("Present", "attendees", "Optional — names, comma separated"));
  main.appendChild(textField("Apologies", "apologies", "Optional — who sent apologies"));

  main.appendChild(el("div", { class: "section-label-row" }, [
    el("span", { class: "section-label" }, "Agenda"),
    el("span", { class: "rule" }),
    el("span", { class: "value", id: "agenda-total" }, agendaSummary(m.sections)),
  ]));

  const list = el("div", { id: "section-list" });
  renderSectionRows(list);
  // Attached here, not in renderSectionRows — that runs again on every add,
  // delete and suggestion, and each call used to stack another handler on
  // the same element. Re-render on drop so the item numbers renumber.
  enableDragReorder(list, ".section-row", (orderedIds) => {
    const byId = new Map(m.sections.map(sec => [sec.id, sec]));
    m.sections = orderedIds.map(id => byId.get(id)).filter(Boolean);
    save();
    renderSectionRows(list);
    refreshAgendaTotals();
  });
  main.appendChild(list);

  const addRow = el("div", { class: "row", style: "margin-top:10px;gap:12px" });
  const nameField = el("input", { class: "underline-input", type: "text", placeholder: "New agenda item", style: "flex:1" });
  const purposeField = el("select", { class: "purpose-select", title: "What this item is on the agenda for" });
  purposeField.appendChild(el("option", { value: "" }, "Purpose"));
  for (const p of PURPOSES) purposeField.appendChild(el("option", { value: p.key }, p.label));
  const durField = el("input", { class: "underline-input dur-input", type: "number", min: "1", value: "10", style: "width:64px;text-align:right" });
  const addBtn = el("button", { class: "btn btn-black" }, "Add");
  addBtn.addEventListener("click", () => {
    // A name may already carry its own marker — "Price Review (for feedback)"
    // — whether it was typed or pasted, so read it either way.
    const typed = splitPurpose(nameField.value.trim() || "Untitled item");
    const dur = Math.max(1, parseInt(durField.value, 10) || 10);
    m.sections.push(newSection(typed.name, dur, purposeField.value || typed.purpose));
    save();
    renderSectionRows(list);
    updateAgendaTotal();
    nameField.value = "";
    durField.value = "10";
    nameField.focus();
  });
  nameField.addEventListener("keydown", (e) => { if (e.key === "Enter") addBtn.click(); });
  addRow.appendChild(nameField);
  addRow.appendChild(purposeField);
  addRow.appendChild(durField);
  addRow.appendChild(el("span", { class: "min-label" }, "min"));
  addRow.appendChild(addBtn);
  main.appendChild(addRow);

  const pasteBox = el("div", { class: "paste-box" });
  pasteBox.appendChild(el("div", { class: "paste-head" }, "Paste an agenda"));
  const importArea = el("textarea", { placeholder: "1.2 In camera session (for discussion)   10 mins\n1.3 Related party transactions   15 mins" });
  pasteBox.appendChild(importArea);
  const pasteFoot = el("div", { class: "paste-foot" });
  pasteFoot.appendChild(el("p", null, "Lines ending in a duration become items. Headers and untimed references are skipped. A trailing \u201cfor discussion\u201d, \u201cfor feedback\u201d or \u201cfor noting\u201d is read as the item\u2019s purpose."));
  const importBtn = el("button", { class: "btn" }, "Parse and Add");
  const importStatus = el("span", { style: "font-size:0.8rem;color:var(--text-dim)" });
  importBtn.addEventListener("click", () => {
    const found = parseAgendaText(importArea.value);
    if (found.length === 0) {
      importStatus.textContent = "No timed lines found.";
      importStatus.style.color = "var(--bad)";
      return;
    }
    for (const item of found) m.sections.push(newSection(item.name, item.minutes, item.purpose));
    save();
    renderSetup();
  });
  pasteFoot.appendChild(importStatus);
  pasteFoot.appendChild(importBtn);
  pasteBox.appendChild(pasteFoot);
  main.appendChild(pasteBox);

  function updateAgendaTotal() {
    const totalEl = document.getElementById("agenda-total");
    if (totalEl) totalEl.textContent = agendaSummary(m.sections);
    const baselineEl = document.getElementById("sidebar-baseline");
    if (baselineEl) baselineEl.textContent = `${agendaTotalMinutes(m.sections)} min`;
    const countEl = document.getElementById("sidebar-count");
    if (countEl) countEl.textContent = `${m.sections.length} item${m.sections.length === 1 ? "" : "s"} on the agenda`;
    const topbarRight = document.querySelector(".topbar-right");
    if (topbarRight) topbarRight.textContent = `Baseline ${agendaTotalMinutes(m.sections)} min`;
  }

  // --- sidebar ---
  const standing = state.savedAgendas.find(a => a.isStanding);
  const savedCard = el("div", { class: "side-card" });
  savedCard.appendChild(el("div", { class: "side-head" }, "Standing & Saved"));
  if (state.savedAgendas.length === 0) {
    savedCard.appendChild(el("div", { class: "side-note" }, "Save this agenda to reuse it. Mark one as standing and every new meeting starts from it."));
  } else {
    state.savedAgendas.forEach(a => {
      const row = el("div", { style: "padding:8px 0;border-bottom:1px solid var(--line-soft)" });
      const nameLine = el("div", { style: "display:flex;justify-content:space-between;align-items:baseline;gap:8px" }, [
        el("span", { style: "font-weight:600;font-size:0.88rem" }, a.title || "Untitled Meeting"),
        a.isStanding ? el("span", { class: "standing-badge" }, "standing") : null,
      ]);
      row.appendChild(nameLine);
      row.appendChild(el("div", { class: "side-note", style: "margin:2px 0 6px" }, `${a.sections.length} item${a.sections.length === 1 ? "" : "s"} · ${agendaTotalMinutes(a.sections)} min`));
      const actions = el("div", { class: "row" });
      const loadBtn = el("button", { class: "btn btn-small" }, "Load");
      loadBtn.addEventListener("click", () => loadSavedAgenda(a.id));
      const delBtn = el("button", { class: "btn-icon btn-danger" }, "✕");
      delBtn.addEventListener("click", () => deleteSavedAgenda(a.id));
      actions.appendChild(loadBtn);
      actions.appendChild(delBtn);
      row.appendChild(actions);
      savedCard.appendChild(row);
    });
  }
  sidebar.appendChild(savedCard);

  const baselineCard = el("div", { class: "side-card" });
  baselineCard.appendChild(el("div", { class: "side-head" }, "Baseline"));
  baselineCard.appendChild(el("div", { class: "side-big", id: "sidebar-baseline" }, `${agendaTotalMinutes(m.sections)} min`));
  baselineCard.appendChild(el("div", { class: "side-note", id: "sidebar-count" }, `${m.sections.length} item${m.sections.length === 1 ? "" : "s"} on the agenda`));
  const startBtn = el("button", { class: "btn btn-primary" }, "Start Meeting");
  startBtn.addEventListener("click", () => {
    if (m.sections.length === 0) {
      showToast({ message: "Add at least one agenda item first.", kind: "warning" });
      return;
    }
    startMeeting();
  });
  baselineCard.appendChild(startBtn);
  const saveBtn = el("button", { class: "btn" }, "Save Agenda");
  saveBtn.addEventListener("click", () => saveAgendaForLater(false));
  baselineCard.appendChild(saveBtn);
  const standingLink = el("button", { class: "reset-link", style: "margin-top:10px" },
    standing && standing.title === m.title ? "Update standing agenda" : "Save as standing agenda for a series");
  standingLink.addEventListener("click", () => saveAgendaForLater(true));
  baselineCard.appendChild(standingLink);
  sidebar.appendChild(baselineCard);

  layout.appendChild(main);
  layout.appendChild(sidebar);
  app.appendChild(layout);
}

// Rewinds the current meeting back to its pre-start state and returns to
// Setup so the agenda can be adjusted before starting again. The agenda
// itself — title, attendees, section names and durations — is kept
// exactly as-is; only this run's progress (timing, notes typed live,
// captures, breaks, any live shrink/extend drift) is cleared. Not a
// delete: it's "let me fix something and restart," not "throw this away."
// For an actual blank slate, use the New Meeting button on Setup instead.
function resetMeeting() {
  const m = state.meeting;
  if (!m) { switchView("setup"); return; }
  m.currentIndex = -1;
  m.timerStatus = "idle";
  m.createdAt = null;
  m.endedAt = null;
  m.breaks = [];
  m.orderChanged = false;
  m.captures = [];
  m.deferred = [];
  m.generalNotes = "";
  for (const s of m.sections) {
    s.status = "upcoming";
    s.startedAt = null;
    s.pausedAccum = 0;
    s.actualSeconds = null;
    s.notes = "";
    s.autoReclaimed = 0;
    s.plannedSeconds = s.originalPlannedSeconds;
  }
  save();
  switchView("setup");
  showToast({ message: "Back to Setup — your agenda is unchanged, ready to adjust and restart." });
}

// The explicit "start from blank" action — separate from Reset, which
// keeps the current agenda. This is the only thing that clears title,
// attendees, and sections back to nothing.
function startNewMeetingDraft() {
  const old = state.meeting;
  const hadContent = old && (old.title || old.attendees || old.sections.length > 0);
  state.meeting = newMeeting();
  save();
  renderSetup();
  if (hadContent) {
    showToast({
      kind: "undo",
      message: "Started a new meeting draft.",
      onUndo: () => { state.meeting = old; save(); renderSetup(); },
    });
  }
}

// The list scrolls inside itself once it's long, so the count is the only
// thing that says how much of the agenda is out of sight.
function agendaSummary(sections) {
  return `${sections.length} item${sections.length === 1 ? "" : "s"} · ${agendaTotalMinutes(sections)} min`;
}

function refreshAgendaTotals() {
  const m = state.meeting;
  const totalEl = document.getElementById("agenda-total");
  if (totalEl) totalEl.textContent = agendaSummary(m.sections);
  const baselineEl = document.getElementById("sidebar-baseline");
  if (baselineEl) baselineEl.textContent = `${agendaTotalMinutes(m.sections)} min`;
  const topbarRight = document.querySelector(".topbar-right");
  if (topbarRight) topbarRight.textContent = `Baseline ${agendaTotalMinutes(m.sections)} min`;
}

function renderSectionRows(list) {
  const m = state.meeting;
  list.innerHTML = "";
  if (m.sections.length === 0) {
    list.appendChild(el("p", { style: "margin:4px 0" }, "Nothing on the agenda yet — add an item below, paste one in, or load a standing agenda."));
  }
  m.sections.forEach((s, idx) => {
    const row = el("div", { class: "section-row", "data-id": s.id });

    row.appendChild(el("div", { class: "item-num" }, String(idx + 1)));

    const handle = el("div", { class: "drag-handle", title: "Drag to reorder" }, "⠿");

    const nameCol = el("div", { style: "flex:1;min-width:0" });
    const nameInput = el("input", { type: "text", class: "name-input underline-input", value: s.name, style: "font-size:1rem;padding:4px 2px" });
    nameInput.addEventListener("input", (e) => { s.name = e.target.value; save(); });
    nameCol.appendChild(nameInput);
    const suggestion = durationSuggestion(s.name);
    if (suggestion) {
      const suggEl = el("div", { class: "suggestion" }, `Ran over ${suggestion.count} of last ${suggestion.count} — suggest ${suggestion.minutes} min`);
      const useSuggBtn = el("button", null, `Use ${suggestion.minutes}`);
      useSuggBtn.addEventListener("click", () => {
        s.plannedSeconds = suggestion.minutes * 60;
        s.originalPlannedSeconds = suggestion.minutes * 60;
        save();
        renderSectionRows(list);
      });
      suggEl.appendChild(useSuggBtn);
      nameCol.appendChild(suggEl);
    }

    // Set here rather than in the moment: deciding an item is "for noting"
    // is a preparation decision, and it changes how the chair runs it.
    const purposeSel = el("select", { class: "purpose-select", title: "What this item is on the agenda for" });
    purposeSel.appendChild(el("option", { value: "" }, "Purpose"));
    for (const p of PURPOSES) purposeSel.appendChild(el("option", { value: p.key }, p.label));
    purposeSel.value = s.purpose || "";
    purposeSel.addEventListener("change", (e) => { s.purpose = e.target.value; save(); });

    const durInput = el("input", { type: "number", min: "1", class: "dur-input underline-input", value: String(Math.round(s.plannedSeconds / 60)) });
    durInput.addEventListener("input", (e) => {
      const v = Math.max(1, parseInt(e.target.value, 10) || 1);
      s.plannedSeconds = v * 60;
      s.originalPlannedSeconds = v * 60;
      save();
      refreshAgendaTotals();
    });

    const delBtn = el("button", { class: "btn-icon btn-danger", title: "Remove" }, "✕");
    delBtn.addEventListener("click", () => {
      const idx = m.sections.indexOf(s);
      if (idx === -1) return;
      m.sections.splice(idx, 1);
      save();
      renderSetup();
      showToast({
        kind: "undo",
        message: `Removed "${s.name}".`,
        onUndo: () => {
          m.sections.splice(idx, 0, s);
          save();
          renderSetup();
        },
      });
    });

    row.appendChild(nameCol);
    row.appendChild(purposeSel);
    row.appendChild(durInput);
    row.appendChild(el("span", { class: "min-label" }, "min"));
    row.appendChild(handle);
    row.appendChild(delBtn);
    list.appendChild(row);
  });
}

/* ---------- LIVE VIEW (cockpit) ---------- */

// Everything a render or a tick needs to know about "right now."
function computeLiveStats() {
  const m = state.meeting;
  const sec = currentSection();
  const elapsed = elapsedSeconds(sec);
  const remaining = sec.plannedSeconds - elapsed;
  const pct = Math.min(100, Math.max(0, (elapsed / sec.plannedSeconds) * 100));
  // The current section's contribution is floored at 0: once it's run past
  // its budget, auto-reclaim has already shrunk upcoming sections to absorb
  // that overrun (or, agenda exhausted, there's nothing left to shrink) —
  // either way, letting this go negative would subtract the overrun a
  // second time on top of that, projecting an end time earlier than real.
  const projectedRemainingTotal = m.sections.reduce((s, x) => {
    if (x.status === "done") return s;
    if (x.status === "current") return s + Math.max(0, x.plannedSeconds - elapsedSeconds(x));
    return s + x.plannedSeconds;
  }, 0);
  const projectedEndTs = Date.now() + Math.max(0, projectedRemainingTotal) * 1000;
  return { sec, elapsed, remaining, pct, projectedEndTs };
}

function renderLive() {
  const m = state.meeting;
  if (!m || m.currentIndex < 0) { switchView("setup"); return; }

  const focusInfo = captureFocus();
  liveRefs = { railMeta: new Map(), railBadges: new Map() };

  const stats = computeLiveStats();
  const { sec, remaining, pct } = stats;
  const isOvertime = remaining < 0;

  app.innerHTML = "";
  const cockpit = el("div", { class: "cockpit" });

  /* ---- header ---- */
  const header = el("div", { class: "cockpit-header" });
  const topbar = el("div", { class: "cockpit-topbar" });
  const navMenu = el("div", { class: "cockpit-nav-menu" });
  const brandBtn = el("button", { class: "cockpit-brand" }, [el("span", { class: "brand-dot" }), "Chair", el("span", { class: "nav-caret" }, "▾")]);
  const dropdown = el("div", { class: "nav-dropdown" }, navButtons("live"));
  dropdown.appendChild(el("div", { class: "nav-dropdown-divider" }));
  const resetMenuBtn = el("button", null, "Reset Meeting");
  resetMenuBtn.addEventListener("click", () => { dropdown.classList.remove("open"); resetMeeting(); });
  dropdown.appendChild(resetMenuBtn);
  brandBtn.addEventListener("click", () => dropdown.classList.toggle("open"));
  navMenu.appendChild(brandBtn);
  navMenu.appendChild(dropdown);
  topbar.appendChild(navMenu);
  topbar.appendChild(el("div", { class: "cockpit-topbar-right" }, [el("span", null, m.title || "Untitled Meeting")]));
  header.appendChild(topbar);

  // Current item bar: everything a chair glances at lives in this one bar
  // now — the item, its countdown, against-plan/projected-end context, and
  // the transport controls — so there's only one banded row instead of two.
  const currentItemBar = el("div", { class: "current-item-bar" });
  currentItemBar.appendChild(el("div", { class: "notes-header" }, [
    el("h2", null, sec.name),
    purposeChip(sec),
  ]));

  const statusZone = el("div", { class: "item-bar-status" });
  const itemBarTop = el("div", { class: "item-bar-top" });
  const statsGroup = el("div", { class: "item-bar-stats" });

  const itemTimerBlock = el("div", { class: "item-timer-block" });
  const remainValueClass = isOvertime ? "item-timer-value overtime" : (pct > 85 ? "item-timer-value warn" : "item-timer-value");
  const remainValueEl = el("div", { id: "timer-display", class: remainValueClass }, fmtClock(remaining));
  itemTimerBlock.appendChild(remainValueEl);
  statsGroup.appendChild(itemTimerBlock);

  const planStat = el("div", { class: "hero-stat" });
  planStat.appendChild(el("div", { class: "hero-label" }, "Against plan"));
  const badgeInfo0 = scheduleBadgeInfo();
  const scheduleBadgeEl = el("div", { id: "schedule-badge", class: `hero-value hero-big schedule-badge ${badgeInfo0.cls}` }, badgeInfo0.word);
  planStat.appendChild(scheduleBadgeEl);
  statsGroup.appendChild(planStat);

  const endStat = el("div", { class: "hero-stat" });
  endStat.appendChild(el("div", { class: "hero-label" }, "Projected end"));
  const projectedEndEl = el("div", { id: "projected-end", class: "hero-value" }, fmtTimeOfDay(stats.projectedEndTs));
  endStat.appendChild(projectedEndEl);
  statsGroup.appendChild(endStat);

  itemBarTop.appendChild(statsGroup);

  const heroActions = el("div", { class: "hero-actions" });
  const pauseBtn = el("button", null, m.timerStatus === "running" ? "Pause" : "Resume");
  pauseBtn.addEventListener("click", togglePause);
  const breakBtn = el("button", null, "Break");
  breakBtn.addEventListener("click", takeBreak);
  const topEndBtn = el("button", { class: "primary" }, "End Meeting");
  topEndBtn.addEventListener("click", () => {
    showToast({
      kind: "confirm",
      message: "End the meeting now and go to notes & minutes?",
      confirmLabel: "End Meeting",
      onConfirm: endMeeting,
    });
  });
  heroActions.appendChild(pauseBtn);
  heroActions.appendChild(breakBtn);
  heroActions.appendChild(topEndBtn);
  itemBarTop.appendChild(heroActions);
  statusZone.appendChild(itemBarTop);

  const track = el("div", { class: "progress-track" });
  const fillEl = el("div", { id: "progress-fill", class: "progress-fill" + (isOvertime ? " overtime" : ""), style: `width:${pct}%` });
  track.appendChild(fillEl);
  statusZone.appendChild(track);
  currentItemBar.appendChild(statusZone);

  // Decision/Action/Motion move to the footer row below the notes, next to
  // Reset/End Meeting — they're about filing a note, not about the item
  // header, so they sit with the other end-of-note actions instead of
  // crowding the title.
  const decisionBtn = el("button", { class: "btn btn-small" }, "Decision");
  decisionBtn.addEventListener("click", () => stampFromToolbar("decision"));
  const actionBtn = el("button", { class: "btn btn-small" }, "Action");
  actionBtn.addEventListener("click", () => stampFromToolbar("action"));
  const motionBtn = el("button", { class: "btn btn-small" }, "Motion");
  motionBtn.addEventListener("click", () => stampFromToolbar("motion"));

  header.appendChild(currentItemBar);

  cockpit.appendChild(header);

  /* ---- body: agenda rail + notes centre + captures rail ---- */
  const railWidth = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, state.railWidth || 280));
  const capturesWidth = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, state.capturesWidth || 260));
  const body = el("div", { class: "cockpit-body", style: `--rail-w: ${railWidth}px; --captures-w: ${capturesWidth}px` });

  const rail = el("aside", { class: "cockpit-rail" });
  const doneCount = m.sections.filter(s => s.status === "done").length;
  rail.appendChild(el("div", { class: "rail-header" }, [
    el("span", null, "Agenda"),
    el("span", null, `${doneCount + 1} / ${m.sections.length}`),
  ]));
  const railList = el("div", { id: "rail-list" });
  m.sections.forEach((s, idx) => {
    const isNextUp = s.status === "upcoming" && idx === m.currentIndex + 1;
    const item = el("div", { class: `agenda-item ${s.status}${isNextUp ? " next-up" : ""}`, "data-id": s.id });
    const statusIcon = s.status === "done" ? "✓" : s.status === "current" ? "▶" : String(idx + 1);
    item.appendChild(el("div", { class: "agenda-status" }, statusIcon));
    const info = el("div", { class: "info" });
    info.appendChild(el("div", { class: "name" }, [s.name, purposeChip(s)]));
    const metaEl = el("div", { class: "meta" }, railMetaText(s));
    info.appendChild(metaEl);
    if (s.status === "upcoming") {
      const actionsEl = el("div", { class: "rail-actions" });
      const goBtn = el("button", { class: "icon-btn go-next", title: "Jump to this item now" }, "▶");
      goBtn.addEventListener("click", (e) => { e.stopPropagation(); jumpToSection(s.id); });
      actionsEl.appendChild(goBtn);
      const deferBtn = el("button", { class: "icon-btn", title: "Defer to next meeting" }, "✕");
      deferBtn.addEventListener("click", (e) => { e.stopPropagation(); deferSection(s.id); });
      actionsEl.appendChild(deferBtn);
      info.appendChild(actionsEl);
    }
    item.appendChild(info);
    const badgesEl = el("div", { class: "badges" }, railBadges(s, isNextUp));
    item.appendChild(badgesEl);
    if (s.status === "upcoming") {
      item.appendChild(el("div", { class: "drag-handle", title: "Drag to reorder" }, "⠿"));
    }
    railList.appendChild(item);
    if (s.status !== "done") {
      liveRefs.railMeta.set(s.id, metaEl);
      liveRefs.railBadges.set(s.id, badgesEl);
    }
  });
  rail.appendChild(railList);

  if (m.deferred && m.deferred.length) {
    const deferredBlock = el("div", { class: "deferred-block" });
    deferredBlock.appendChild(el("div", { class: "deferred-title" }, "Deferred to next meeting"));
    m.deferred.forEach(d => {
      const row = el("div", { class: "deferred-row" });
      row.appendChild(el("span", { class: "name" }, d.name));
      const undoBtn = el("button", null, "Undo");
      undoBtn.addEventListener("click", () => undoDefer(d.id));
      row.appendChild(undoBtn);
      deferredBlock.appendChild(row);
    });
    rail.appendChild(deferredBlock);
  }

  const railResizeHandle = el("div", { class: "rail-resize-handle", title: "Drag to resize the agenda panel" });
  rail.appendChild(railResizeHandle);
  enablePanelResize(railResizeHandle, body, { cssVar: "--rail-w", stateKey: "railWidth", defaultWidth: 280, invert: false });

  body.appendChild(rail);

  enableDragReorder(railList, ".agenda-item.upcoming", (orderedIds) => {
    const byId = new Map(m.sections.map(sc => [sc.id, sc]));
    const firstUpcomingIdx = m.currentIndex + 1;
    const reordered = orderedIds.map(id => byId.get(id));
    m.sections.splice(firstUpcomingIdx, reordered.length, ...reordered);
    m.orderChanged = true;
    save();
    renderLive();
  });

  const notes = el("main", { class: "cockpit-notes" });

  const notesArea = el("textarea", { placeholder: "Capture points, decisions, or follow-ups. Start a line with /decision, /action or /motion to file it — @Name assigns an owner, and a motion takes moved:Name seconded:Name." });
  notesArea.value = sec.notes;
  notesArea.addEventListener("input", (e) => { sec.notes = e.target.value; save(); });
  notesArea.addEventListener("keydown", onNotesKeydown);
  notes.appendChild(notesArea);

  function stampFromToolbar(kind) {
    const ta = notesArea;
    const marker = `/${kind} `;
    const needsNewline = ta.value.length > 0 && !ta.value.endsWith("\n");
    ta.value += (needsNewline ? "\n" : "") + marker;
    sec.notes = ta.value;
    save();
    ta.focus();
    ta.selectionStart = ta.selectionEnd = ta.value.length;
  }

  const endRow = el("div", { style: "padding:0 22px 14px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap" });
  const stampGroup = el("div", { style: "display:flex;gap:8px" });
  stampGroup.appendChild(decisionBtn);
  stampGroup.appendChild(actionBtn);
  stampGroup.appendChild(motionBtn);
  endRow.appendChild(stampGroup);

  const footerActions = el("div", { style: "display:flex;gap:8px" });
  const prevBtn = el("button", { class: "btn" }, "Previous Item");
  prevBtn.disabled = m.currentIndex <= 0;
  prevBtn.addEventListener("click", goToPreviousSection);
  const nextBtn = el("button", { class: "btn" }, "Next Item");
  nextBtn.addEventListener("click", goToNextSection);
  footerActions.appendChild(prevBtn);
  footerActions.appendChild(nextBtn);
  endRow.appendChild(footerActions);
  notes.appendChild(endRow);

  notes.appendChild(el("div", { class: "kbd-hint" }, "P pause · ← previous · → next · + extend · B break · D/A/M stamp (when not typing) · /decision /action /motion in notes"));

  body.appendChild(notes);

  const capturesRail = el("aside", { id: "captures-rail", class: "captures-rail" });
  const capturesResizeHandle = el("div", { class: "captures-resize-handle", title: "Drag to resize the captured panel" });
  capturesRail.appendChild(capturesResizeHandle);
  enablePanelResize(capturesResizeHandle, body, { cssVar: "--captures-w", stateKey: "capturesWidth", defaultWidth: 260, invert: true });
  capturesRail.appendChild(el("div", { class: "rail-header" }, [el("span", null, "Captured"), el("span", { id: "captures-count" }, String((m.captures || []).length))]));
  const capturesList = el("div", { id: "captures-list" });
  renderCapturesList(capturesList);
  capturesRail.appendChild(capturesList);
  body.appendChild(capturesRail);

  cockpit.appendChild(body);

  const thumbRail = el("div", { class: "thumb-rail" });
  const tPause = el("button", null, m.timerStatus === "running" ? "Pause" : "Resume");
  tPause.addEventListener("click", togglePause);
  const tPrev = el("button", null, "Previous");
  tPrev.disabled = m.currentIndex <= 0;
  tPrev.addEventListener("click", goToPreviousSection);
  const tDecision = el("button", null, "Decision");
  tDecision.addEventListener("click", () => stampFromToolbar("decision"));
  const tNext = el("button", { class: "primary" }, "Next");
  tNext.addEventListener("click", goToNextSection);
  thumbRail.appendChild(tPause);
  thumbRail.appendChild(tPrev);
  thumbRail.appendChild(tDecision);
  thumbRail.appendChild(tNext);
  cockpit.appendChild(thumbRail);

  app.appendChild(cockpit);

  restoreFocus(focusInfo);
  startTick();
}

function onNotesKeydown(e) {
  if (e.key !== "Enter") return;
  const ta = e.target;
  const cursorPos = ta.selectionStart;
  const textBefore = ta.value.slice(0, cursorPos);
  const lastNewline = textBefore.lastIndexOf("\n");
  const line = textBefore.slice(lastNewline + 1);
  const match = line.match(/^\/(decision|action|motion)\s+(.+)$/i);
  if (!match) return;
  const kind = match[1].toLowerCase();
  const text = match[2].trim();
  if (!text) return;
  const owner = extractOwner(text);
  let cleanText = text.replace(/@\S+\s*/, "").trim();
  let extra = null;
  if (kind === "motion") {
    const parties = extractMotionParties(cleanText);
    cleanText = parties.text;
    if (parties.moved || parties.seconded) {
      extra = { moved: parties.moved || "", seconded: parties.seconded || "" };
    }
  }
  if (!cleanText) return;
  e.preventDefault();
  const newValue = ta.value.slice(0, lastNewline + 1) + ta.value.slice(cursorPos);
  ta.value = newValue;
  ta.selectionStart = ta.selectionEnd = lastNewline + 1;
  const sec = currentSection();
  if (sec) sec.notes = newValue;
  save();
  fileCapture(kind, cleanText, owner, extra);
}

function renderCapturesList(listEl) {
  const m = state.meeting;
  listEl.innerHTML = "";
  const captures = m.captures || [];
  if (captures.length === 0) {
    listEl.appendChild(el("div", { class: "captures-empty" }, [
      "Nothing filed yet. A line beginning ",
      el("code", null, "/decision"),
      " lands here stamped with the time and the item it belongs to.",
    ]));
    return;
  }
  for (let i = captures.length - 1; i >= 0; i--) {
    const c = captures[i];
    const item = el("div", { class: "capture-item" });
    item.appendChild(el("div", { class: "capture-top" }, [
      el("span", { class: `capture-kind ${c.kind}` }, c.kind),
      el("span", { class: "capture-time" }, fmtTimeOfDay(c.timestamp)),
    ]));
    item.appendChild(el("div", { class: "capture-text" }, [c.text, c.owner ? el("span", { class: "capture-owner" }, "@" + c.owner) : null]));
    if (c.sectionName) item.appendChild(el("div", { class: "capture-section" }, c.sectionName));
    listEl.appendChild(item);
  }
}

function updateCapturesPanel() {
  const listEl = document.getElementById("captures-list");
  if (listEl) renderCapturesList(listEl);
  const countEl = document.getElementById("captures-count");
  if (countEl) countEl.textContent = String((state.meeting.captures || []).length);
}

function railMetaText(s) {
  if (s.status === "done") return `Actual ${fmtMinutes(s.actualSeconds)} / planned ${fmtMinutes(s.originalPlannedSeconds)}`;
  return `Planned ${fmtMinutes(s.plannedSeconds)}`;
}

function railBadges(s, isNextUp) {
  const badges = [];
  if (isNextUp) badges.push(el("span", { class: "pill" }, "up next"));
  return badges;
}

// Refreshes every DOM node that can change from a pure tick — the current
// item's countdown/progress, the header's projected-end and against-plan
// numbers, and (only when a reclaim just happened) the rail's live meta
// text and badges. Deliberately never touches the notes textarea or
// rebuilds the DOM: this is what used to be
// a full renderLive() every second, which fought typing during an
// overrun. Runs whether the meeting is running or paused, since projected
// end must keep drifting later in real time even while the section clock
// is frozen.
function updateLiveDisplays(reclaimHappened) {
  if (!liveRefs) return;
  const m = state.meeting;
  const sec = currentSection();
  const stats = computeLiveStats();
  const { remaining, pct } = stats;
  const isOvertime = remaining < 0;

  const timeEl = document.getElementById("timer-display");
  const fillEl = document.getElementById("progress-fill");
  if (!timeEl) { clearTick(); return; }

  timeEl.textContent = fmtClock(remaining);
  timeEl.className = "item-timer-value" + (isOvertime ? " overtime" : (pct > 85 ? " warn" : ""));
  if (fillEl) {
    fillEl.style.width = pct + "%";
    fillEl.className = "progress-fill" + (isOvertime ? " overtime" : "");
  }

  const projectedEndEl = document.getElementById("projected-end");
  if (projectedEndEl) projectedEndEl.textContent = fmtTimeOfDay(stats.projectedEndTs);

  const badgeEl = document.getElementById("schedule-badge");
  if (badgeEl) {
    const badgeInfo = scheduleBadgeInfo();
    badgeEl.textContent = badgeInfo.word;
    badgeEl.className = `hero-value hero-big schedule-badge ${badgeInfo.cls}`;
  }

  if (reclaimHappened) {
    m.sections.forEach((s, idx) => {
      if (s.status === "done") return;
      const metaEl = liveRefs.railMeta.get(s.id);
      if (metaEl) metaEl.textContent = railMetaText(s);
      const badgesEl = liveRefs.railBadges.get(s.id);
      if (badgesEl) {
        const isNextUp = s.status === "upcoming" && idx === m.currentIndex + 1;
        badgesEl.innerHTML = "";
        for (const b of railBadges(s, isNextUp)) badgesEl.appendChild(b);
      }
    });
  }
}

// Wall clock jumped by more than IDLE_GAP_SECONDS: the machine slept, or
// the tab was closed and reopened. That time didn't belong to the current
// item, so hand it back and pause rather than letting the auto-reclaim
// treat it as a genuine overrun and shave every upcoming item to its floor.
// Returns true if a gap was absorbed.
function absorbIdleGap(gapSeconds) {
  const m = state.meeting;
  if (!m || m.timerStatus !== "running") return false;
  if (gapSeconds <= IDLE_GAP_SECONDS) return false;
  const sec = currentSection();
  if (!sec) return false;

  const elapsed = elapsedSeconds(sec);
  sec.pausedAccum = Math.max(0, elapsed - gapSeconds);
  sec.startedAt = null;
  m.timerStatus = "paused";
  save();

  const mins = Math.max(1, Math.round(gapSeconds / 60));
  showToast({
    message: `Paused — this tab was asleep for about ${mins} min. That time wasn't charged to "${sec.name}".`,
    duration: 8000,
  });
  return true;
}

function startTick() {
  clearTick();
  lastTickAt = Date.now();
  tickHandle = setInterval(() => {
    const m = state.meeting;
    if (!m) { clearTick(); return; }
    const sec = currentSection();
    if (!sec) { clearTick(); return; }

    // Measure the gap before anything else: a suspended tab resumes with
    // one enormous tick, and the reclaim below must not see that as overrun.
    const now = Date.now();
    const gapSeconds = (now - lastTickAt) / 1000;
    lastTickAt = now;
    markSeen(now);
    if (absorbIdleGap(gapSeconds)) { renderLive(); return; }

    let reclaimHappened = false;

    // Running past the planned time auto-extends this section by pulling
    // the overage from upcoming sections, continuously, until "Next
    // Section" locks in the actual time used. Only while actually running —
    // elapsedSeconds() is frozen while paused, so there's no overage to
    // chase then.
    if (m.timerStatus === "running") {
      const elapsed = elapsedSeconds(sec);
      const overage = elapsed - sec.plannedSeconds;
      const alreadyReclaimed = sec.autoReclaimed;
      const toReclaim = overage - alreadyReclaimed;
      if (toReclaim > 0.5) {
        shrinkUpcomingSections(toReclaim);
        sec.autoReclaimed = alreadyReclaimed + toReclaim;
        save();
        reclaimHappened = true;
      }
    }

    // Always refreshed — including while paused, since real time (and so
    // the projected end) keeps moving even when the section clock doesn't.
    updateLiveDisplays(reclaimHappened);
  }, 1000);
}

/* focus preservation across the rarer full re-renders (e.g. Next Item) */
function captureFocus() {
  const active = document.activeElement;
  if (active && active.tagName === "TEXTAREA" && active.closest(".cockpit-notes")) {
    return { isNotes: true, selStart: active.selectionStart, selEnd: active.selectionEnd, scrollTop: active.scrollTop };
  }
  return null;
}
function restoreFocus(info) {
  if (!info || !info.isNotes) return;
  const textarea = app.querySelector(".cockpit-notes textarea");
  if (textarea) {
    textarea.focus();
    try { textarea.setSelectionRange(info.selStart, info.selEnd); } catch (e) {}
    textarea.scrollTop = info.scrollTop;
  }
}

/* ---------- nav dropdown (live view "Chair" menu) ---------- */

document.addEventListener("click", (e) => {
  if (e.target.closest(".cockpit-nav-menu")) return;
  document.querySelectorAll(".nav-dropdown.open").forEach(d => d.classList.remove("open"));
});

/* ---------- keyboard shortcuts (live view only, inert while typing notes) ---------- */

document.addEventListener("keydown", (e) => {
  if (state.view !== "live" || !state.meeting) return;
  const active = document.activeElement;
  const typing = active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT");
  if (typing) return; // hands are on the keyboard for notes/markers instead
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  switch (e.key) {
    case "p":
    case "P":
      e.preventDefault();
      togglePause();
      break;
    case "ArrowRight":
      e.preventDefault();
      goToNextSection();
      break;
    case "ArrowLeft":
      e.preventDefault();
      goToPreviousSection();
      break;
    case "+":
    case "=":
      e.preventDefault();
      extendCurrentSection(1);
      break;
    case "b":
    case "B":
      e.preventDefault();
      takeBreak();
      break;
    case "d":
    case "D": {
      e.preventDefault();
      const ta = app.querySelector(".cockpit-notes textarea");
      if (ta) { ta.focus(); ta.value += (ta.value.endsWith("\n") || !ta.value ? "" : "\n") + "/decision "; ta.selectionStart = ta.selectionEnd = ta.value.length; }
      break;
    }
    case "a":
    case "A": {
      e.preventDefault();
      const ta = app.querySelector(".cockpit-notes textarea");
      if (ta) { ta.focus(); ta.value += (ta.value.endsWith("\n") || !ta.value ? "" : "\n") + "/action "; ta.selectionStart = ta.selectionEnd = ta.value.length; }
      break;
    }
    case "m":
    case "M": {
      e.preventDefault();
      const ta = app.querySelector(".cockpit-notes textarea");
      if (ta) { ta.focus(); ta.value += (ta.value.endsWith("\n") || !ta.value ? "" : "\n") + "/motion "; ta.selectionStart = ta.selectionEnd = ta.value.length; }
      break;
    }
    case "Escape":
      hideToast();
      break;
    default:
      break;
  }
});

/* ---------- MINUTES VIEW ---------- */

// The agenda item a capture belongs to. Migrated legacy entries genuinely
// don't have one, so show nothing rather than an empty gap.
function sectionTag(name) {
  if (!name) return null;
  return el("span", { class: "stat dim", style: "margin-left:8px" }, name);
}

function flatSectionLabel(text, value) {
  const row = el("div", { class: "section-label-row" }, [
    el("span", { class: "section-label" }, text),
    el("span", { class: "rule" }),
  ]);
  if (value != null) row.appendChild(el("span", { class: "value" }, value));
  return row;
}

function renderMinutes() {
  clearTick();
  // Viewing a filed meeting points state.meeting straight at the history
  // entry, so edits land in History. A save/reload round-trip turns that
  // one object into two — same id, separate objects — and every later edit
  // would be written to the copy and lost. Re-alias on the way in.
  if (state.meeting) {
    const filed = state.history.find(h => h.id === state.meeting.id);
    if (filed && filed !== state.meeting) state.meeting = filed;
  }
  const m = state.meeting;
  if (!m) { switchView("setup"); return; }

  app.innerHTML = "";
  app.appendChild(renderTopbar("minutes"));

  const headRow = el("div", { class: "row", style: "justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px" });
  const headMain = el("div", null);
  headMain.appendChild(el("div", { class: "page-eyebrow" }, "Minutes"));
  headMain.appendChild(el("h1", { class: "page-head" }, m.title || "Untitled meeting"));
  headMain.appendChild(el("p", { class: "page-sub", style: "margin:0" }, meetingWhen(m)));
  const who = [
    m.chair ? `Chair: ${m.chair}` : null,
    m.attendees ? `Present: ${m.attendees}` : null,
    m.apologies ? `Apologies: ${m.apologies}` : null,
  ].filter(Boolean);
  if (who.length) headMain.appendChild(el("p", { class: "page-sub", style: "margin:2px 0 0" }, who.join(" · ")));
  headRow.appendChild(headMain);

  const headActions = el("div", { class: "row" });
  const copyBtn = el("button", { class: "btn" }, "Copy");
  copyBtn.addEventListener("click", () => copyMinutesToClipboard(m));
  const exportBtn = el("button", { class: "btn" }, "Markdown");
  exportBtn.addEventListener("click", () => downloadMarkdown(m));
  const printBtn = el("button", { class: "btn" }, "Print");
  printBtn.addEventListener("click", () => window.print());
  // Viewing a filed meeting from History points state.meeting straight at
  // the history entry, so this screen is reached in two different modes.
  // Offering "File Meeting" in both filed a second copy of something
  // already in History; now an already-filed meeting gets a way back out
  // instead.
  const alreadyFiled = isFiled(m);
  const fileBtn = el("button", { class: "btn btn-primary" }, alreadyFiled ? "Back to History" : "File Meeting");
  fileBtn.addEventListener("click", () => {
    if (alreadyFiled) {
      state.meeting = null;
      switchView("history");
      return;
    }
    fileMeeting(m);
    state.meeting = null;
    state.view = "setup";
    save();
    render();
  });
  headActions.appendChild(copyBtn);
  headActions.appendChild(exportBtn);
  headActions.appendChild(printBtn);
  headActions.appendChild(fileBtn);
  headRow.appendChild(headActions);
  app.appendChild(headRow);
  app.appendChild(el("hr", { class: "page-hr" }));

  // --- stats row ---
  const doneSections = m.sections.filter(s => s.status === "done" || s.actualSeconds != null);
  const plannedSoFar = doneSections.reduce((s, x) => s + x.originalPlannedSeconds, 0);
  const elapsed = doneSections.reduce((s, x) => s + x.actualSeconds, 0);
  const variance = elapsed - plannedSoFar;
  const baseline = m.sections.reduce((s, x) => s + x.originalPlannedSeconds, 0);
  const statRow = el("div", { class: "stat-row" });
  statRow.appendChild(el("div", { class: "stat-block" }, [el("div", { class: "stat-label" }, "Planned so far"), el("div", { class: "stat-value" }, fmtMinutes(plannedSoFar))]));
  statRow.appendChild(el("div", { class: "stat-block" }, [el("div", { class: "stat-label" }, "Elapsed"), el("div", { class: "stat-value" }, fmtMinutes(elapsed))]));
  const varianceText = (variance >= 0 ? "+" : "−") + fmtMinutes(Math.abs(variance));
  statRow.appendChild(el("div", { class: "stat-block" }, [el("div", { class: "stat-label" }, "Variance"), el("div", { class: `stat-value ${variance > 0 ? "behind" : variance < 0 ? "ahead" : ""}` }, varianceText)]));
  statRow.appendChild(el("div", { class: "stat-block" }, [el("div", { class: "stat-label" }, "Baseline"), el("div", { class: "stat-value" }, fmtMinutes(baseline))]));
  app.appendChild(statRow);
  app.appendChild(el("hr", { class: "page-hr" }));

  // Decisions, actions and motions are all just filtered views over
  // m.captures — the one place that actually remembers which agenda item
  // each was filed under. Deleting a row removes that capture directly,
  // so there's no second list to fall out of sync with.
  function removeCaptureRow(c) {
    const idx = m.captures.findIndex(x => x.id === c.id);
    if (idx !== -1) m.captures.splice(idx, 1);
    save();
    renderMinutes();
  }

  // One row for one thing said or decided, with the label that says which
  // kind it is. The agenda item isn't repeated — the heading above it
  // already says which item this is.
  function recordRow(c, label, body) {
    const row = el("div", { class: "flat-row" });
    row.appendChild(el("div", { class: "name" }, [
      el("span", { class: "record-label" }, label),
      ...[].concat(body),
    ]));
    const rm = el("button", { class: "btn-icon btn-danger" }, "✕");
    rm.addEventListener("click", () => removeCaptureRow(c));
    row.appendChild(rm);
    return row;
  }

  const decisionRow = d => recordRow(d, "Decision", d.text);
  const motionRow = mo => {
    const p = motionParts(mo);
    return recordRow(mo, "Motion", [
      p.outcome,
      p.parties ? el("span", { class: "stat dim", style: "margin-left:8px" }, p.parties) : null,
    ]);
  };
  const actionRow = a => recordRow(a, "Action", [
    a.owner ? el("strong", null, displayName(a.owner) + " — ") : null,
    a.text,
  ]);

  // --- the agenda, item by item ---
  //
  // One pass down the agenda, and only one. Each item is named once and
  // carries its own timing, what it was on the agenda for, and everything
  // recorded against it. There used to be a separate timing list above
  // this, which meant every item that ran was written out twice — the
  // heading row already says planned, actual and variance.
  const grow = [];
  app.appendChild(flatSectionLabel("Agenda", `${m.sections.length} item${m.sections.length === 1 ? "" : "s"}`));
  m.sections.forEach((sec, idx) => {
    const r = itemRecord(m, sec);
    const ran = sec.actualSeconds != null;
    const recorded = itemHasRecord(r);

    // Three tiers, and the item's name is the top one. It used to be set as
    // a small-caps label — the treatment the section headings use — which
    // made a long name like "1.4 ATO - NFP Annual Self Review Assessment"
    // both the hardest thing on the page to read and indistinguishable in
    // weight from the structure around it.
    const block = el("div", { class: `minute-item${recorded ? " has-record" : ""}${ran ? "" : " unreached"}` });

    const name = el("h3", { class: "minute-item-name" }, [sec.name, purposeChip(sec)]);
    const meta = el("div", { class: "minute-item-meta" });
    if (ran) {
      const delta = sec.actualSeconds - sec.originalPlannedSeconds;
      meta.appendChild(el("span", null, `${fmtMinutesRow(sec.originalPlannedSeconds)} planned`));
      meta.appendChild(el("span", { class: "sep" }, "·"));
      meta.appendChild(el("span", null, `${fmtMinutesRow(sec.actualSeconds)} actual`));
      // The one place colour is allowed on this page: over and under are
      // the behind/ahead indicator, which owns red and green everywhere.
      meta.appendChild(el("span", { class: `delta ${delta < 0 ? "under" : delta > 0 ? "over" : ""}` }, fmtVariance(delta)));
    } else {
      meta.appendChild(el("span", null, `${fmtMinutesRow(sec.originalPlannedSeconds)} planned`));
      meta.appendChild(el("span", { class: "sep" }, "·"));
      meta.appendChild(el("span", null, "not reached"));
    }
    block.appendChild(el("div", { class: "minute-item-head" }, [
      el("div", { class: "minute-item-num" }, String(idx + 1)),
      name,
      meta,
    ]));

    // Everything recorded against the item is indented under it, so the
    // record reads as belonging to the name above rather than as the next
    // thing in a flat stream.
    const bodyEl = el("div", { class: "minute-item-body" });

    // Nothing happened under an item that was never reached, so it gets no
    // note box to fill in — just its line in the agenda.
    if (ran) {
      const ta = el("textarea", { class: "item-notes", rows: "1", placeholder: "Add a note for the record" });
      ta.value = sec.notes || "";
      ta.addEventListener("input", (e) => { sec.notes = e.target.value; save(); autoGrow(ta); });
      bodyEl.appendChild(ta);
      // Sized after it's in the document — scrollHeight needs a layout. An
      // agenda can run to 30 items, so an empty note box is one line high
      // rather than a fixed block of nothing.
      grow.push(ta);
    }

    r.decisions.forEach(d => bodyEl.appendChild(decisionRow(d)));
    r.motions.forEach(mo => bodyEl.appendChild(motionRow(mo)));
    r.actions.forEach(a => bodyEl.appendChild(actionRow(a)));

    if (bodyEl.childNodes.length) block.appendChild(bodyEl);
    app.appendChild(block);
  });

  // Captures whose agenda item was never recorded — only migrated entries
  // from much older meetings. Better an honest heading than dropping them.
  const orphans = (m.captures || []).filter(c => !c.sectionName);
  if (orphans.length) {
    app.appendChild(flatSectionLabel("Not attributed to an item"));
    orphans.filter(c => c.kind === "decision").forEach(d => app.appendChild(decisionRow(d)));
    orphans.filter(c => c.kind === "motion").forEach(mo => app.appendChild(motionRow(mo)));
    orphans.filter(c => c.kind === "action").forEach(a => app.appendChild(actionRow(a)));
  }

  // --- deferred ---
  if (m.deferred && m.deferred.length) {
    app.appendChild(flatSectionLabel("Deferred to Next Meeting"));
    m.deferred.forEach(d => {
      const row = el("div", { class: "flat-row" });
      row.appendChild(el("div", { class: "name" }, d.name));
      row.appendChild(el("div", { class: "stat dim" }, fmtMinutes(d.originalPlannedSeconds)));
      app.appendChild(row);
    });
  }

  // The one list worth repeating. Actions are the part of the minutes with
  // a life after the meeting — people work from them, and nobody should
  // have to read every item to find what they owe. Deleting is done above,
  // against the item, so this stays a plain read-only register.
  const actionItems = (m.captures || []).filter(c => c.kind === "action");
  if (actionItems.length) {
    app.appendChild(flatSectionLabel("Action Register"));
    actionItems.forEach(a => {
      const row = el("div", { class: "flat-row register-row" });
      row.appendChild(el("div", { class: "name" }, [
        a.owner ? el("strong", null, displayName(a.owner) + " — ") : null,
        a.text,
        sectionTag(a.sectionName),
      ]));
      app.appendChild(row);
    });
  }

  grow.forEach(autoGrow);

  app.appendChild(flatSectionLabel("Closing Notes"));
  const closingField = el("div", { class: "field" });
  const generalArea = el("textarea", { class: "underline-input", placeholder: "Anything for the record that didn't belong to one item." }, m.generalNotes);
  generalArea.value = m.generalNotes;
  generalArea.addEventListener("input", (e) => { m.generalNotes = e.target.value; save(); });
  closingField.appendChild(generalArea);
  app.appendChild(closingField);

  if (m.breaks && m.breaks.length) {
    app.appendChild(el("p", { style: "margin-top:8px" }, `${m.breaks.length} break${m.breaks.length === 1 ? "" : "s"} taken (${fmtMinutes(breakTotalSeconds(m))} total).`));
  }
}

/* ---------- HISTORY VIEW ---------- */

// Wraps each occurrence of `query` in a <mark>, building real text nodes
// rather than an HTML string. Notes and titles are arbitrary user text —
// concatenating them into innerHTML let a stray "<" mangle the results and
// let a title containing a tag execute.
function highlightedSnippet(snippet, query) {
  const frag = document.createDocumentFragment();
  if (!query) { frag.appendChild(document.createTextNode(snippet)); return frag; }
  const hay = snippet.toLowerCase();
  let from = 0;
  for (;;) {
    const at = hay.indexOf(query, from);
    if (at === -1) break;
    if (at > from) frag.appendChild(document.createTextNode(snippet.slice(from, at)));
    frag.appendChild(el("mark", null, snippet.slice(at, at + query.length)));
    from = at + query.length;
  }
  frag.appendChild(document.createTextNode(snippet.slice(from)));
  return frag;
}

function renderHistory() {
  clearTick();
  app.innerHTML = "";
  app.appendChild(renderTopbar("history"));

  app.appendChild(el("div", { class: "page-eyebrow" }, "History"));
  app.appendChild(el("h1", { class: "page-head" }, "Where the time goes"));
  app.appendChild(el("p", { class: "page-sub" }, "Planned against actual for every item you've ever run, and one search across every note and decision."));
  app.appendChild(el("hr", { class: "page-hr" }));

  const searchInput = el("input", { type: "text", class: "underline-input underline-search", placeholder: "Search past notes, decisions, motions and actions" });
  app.appendChild(searchInput);
  const resultsEl = el("div", { style: "margin-top:8px" });
  app.appendChild(resultsEl);

  if (state.history.length === 0) {
    app.appendChild(el("hr", { class: "page-hr" }));
    app.appendChild(flatSectionLabel("Filed Meetings"));
    app.appendChild(el("p", { class: "page-sub" }, "No filed meetings yet. Run one through and file it from the minutes."));
    return;
  }

  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim().toLowerCase();
    resultsEl.innerHTML = "";
    if (!q) return;
    const matches = [];
    for (const m of state.history) {
      // Keep the original casing for display and match case-insensitively
      // separately, so results read the way they were typed.
      const hay = [
        m.title,
        ...(m.captures || []).map(c => c.text),
        ...m.sections.map(s => s.notes),
        m.generalNotes,
      ].filter(Boolean).join(" \n ");
      const idx = hay.toLowerCase().indexOf(q);
      if (idx !== -1) {
        const snippet = hay.slice(Math.max(0, idx - 30), idx + q.length + 30).trim();
        matches.push({ m, snippet });
      }
    }
    if (matches.length === 0) {
      resultsEl.appendChild(el("p", { style: "margin:0" }, "No matches."));
      return;
    }
    matches.forEach(({ m, snippet }) => {
      const row = el("div", { class: "search-match" }, [
        el("strong", null, m.title || "Untitled Meeting"),
        " — …",
        highlightedSnippet(snippet, q),
        "… ",
      ]);
      resultsEl.appendChild(row);
    });
  });

  // overrun analytics: which sections (by name) run over most often, across all history
  const byName = new Map();
  for (const m of state.history) {
    for (const s of m.sections) {
      if (s.actualSeconds == null) continue;
      const key = s.name.trim();
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(s.actualSeconds - s.originalPlannedSeconds);
    }
  }
  const analyticsRows = Array.from(byName.entries())
    .map(([name, deltas]) => ({ name, avg: deltas.reduce((a, b) => a + b, 0) / deltas.length, count: deltas.length }))
    .filter(r => r.count >= 2)
    .sort((a, b) => Math.abs(b.avg) - Math.abs(a.avg))
    .slice(0, 8);

  if (analyticsRows.length > 0) {
    app.appendChild(el("hr", { class: "page-hr" }));
    app.appendChild(flatSectionLabel("Where the Time Actually Goes"));
    app.appendChild(el("p", { class: "page-sub" }, "Average minutes over (red) or under (green) the planned time, by item name, across your history."));
    const maxAbs = Math.max(...analyticsRows.map(r => Math.abs(r.avg)), 1);
    const chart = el("div", { class: "overrun-chart" });
    analyticsRows.forEach(r => {
      const pct = Math.min(100, (Math.abs(r.avg) / maxAbs) * 100);
      const row = el("div", { class: "overrun-row" });
      row.appendChild(el("div", { class: "label" }, r.name));
      const track = el("div", { class: "overrun-bar-track" });
      track.appendChild(el("div", { class: "overrun-bar-fill" + (r.avg < 0 ? " under" : ""), style: `width:${pct}%` }));
      row.appendChild(track);
      row.appendChild(el("div", { class: "amount" }, `${r.avg >= 0 ? "+" : ""}${Math.round(r.avg / 60)}m`));
      chart.appendChild(row);
    });
    app.appendChild(chart);
  }

  app.appendChild(el("hr", { class: "page-hr" }));
  app.appendChild(flatSectionLabel("Filed Meetings"));
  state.history.forEach((m, idx) => {
    const row = el("div", { class: "flat-row" });
    row.appendChild(el("div", { class: "name" }, m.title || "Untitled meeting"));
    row.appendChild(el("div", { class: "stat dim" }, fmtDateTimeLower(m.createdAt)));
    const actions = el("div", { class: "row" });
    const viewBtn = el("button", { class: "btn btn-small" }, "View");
    // save(), or a refresh restores whatever state.meeting held before this
    // click and the boot block lands you on a different meeting's minutes.
    viewBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      state.meeting = m;
      state.view = "minutes";
      save();
      render();
    });
    const exportBtn = el("button", { class: "btn btn-small" }, "Export");
    exportBtn.addEventListener("click", (e) => { e.stopPropagation(); downloadMarkdown(m); });
    const delBtn = el("button", { class: "btn-icon btn-danger" }, "✕");
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const [removed] = state.history.splice(idx, 1);
      save();
      renderHistory();
      showToast({
        kind: "undo",
        message: `Deleted "${removed.title || "Untitled meeting"}".`,
        onUndo: () => {
          state.history.splice(idx, 0, removed);
          save();
          renderHistory();
        },
      });
    });
    actions.appendChild(viewBtn);
    actions.appendChild(exportBtn);
    actions.appendChild(delBtn);
    row.appendChild(actions);
    app.appendChild(row);
  });
}

/* ---------- master render ---------- */

function render() {
  if (state.view === "setup") renderSetup();
  else if (state.view === "live") renderLive();
  else if (state.view === "minutes") renderMinutes();
  else if (state.view === "history") renderHistory();
  else renderSetup();
}

/* ---------- boot ---------- */

// If we reloaded mid-meeting, land back on the running meeting. A finished
// meeting keeps whatever view was open instead — forcing minutes here threw
// you off History or Prepare on every refresh, and did it holding the last
// meeting that happened to be in state rather than the one you were reading.
if (state.meeting) {
  const status = state.meeting.timerStatus;
  if (status === "running" || status === "paused") state.view = "live";
  else if (state.view === "live") state.view = "minutes";
}

// Reopening after the tab was closed for a while is the same problem as
// waking from sleep: the clock kept moving but the meeting wasn't running.
// Persist any legacy-shape repair loadState() made, so it happens once
// rather than on every load.
if (migratedLegacy) save();

const seen = lastSeenAt();
if (state.meeting && seen) absorbIdleGap((Date.now() - seen) / 1000);
lastTickAt = Date.now();
markSeen(lastTickAt);

render();

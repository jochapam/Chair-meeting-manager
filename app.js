"use strict";

/* ---------- constants ---------- */

const STORAGE_KEY = "chair-meeting-manager:v1";
const MIN_SECTION_SECONDS = 60; // a section can never be auto-shrunk below this

/* ---------- state ---------- */

let state = loadState();
let tickHandle = null;
let liveRefs = null; // DOM references for surgical per-second updates on the live view

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
    return Object.assign(defaultState(), parsed);
  } catch (e) {
    return defaultState();
  }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
function parseAgendaText(text) {
  const parsed = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(.*?)[\s\-–—:|]*(\d+)\s*(?:mins?|minutes?|m)\.?\s*$/i);
    if (!m) continue;
    const name = m[1].trim().replace(/[-–—:|]\s*$/, "").trim();
    const minutes = parseInt(m[2], 10);
    if (!name || !minutes) continue;
    parsed.push({ name, minutes });
  }
  return parsed;
}

/* ---------- meeting model ---------- */

function newSection(name, minutes) {
  const planned = Math.max(1, Math.round(minutes)) * 60;
  return {
    id: uid(),
    name: name || "Untitled section",
    plannedSeconds: planned,
    originalPlannedSeconds: planned,
    status: "upcoming", // upcoming | current | done
    startedAt: null, // epoch ms when this section's timer last (re)started
    pausedAccum: 0, // seconds already elapsed before the current run
    actualSeconds: null, // filled in once the section is done
    notes: "",
    wasExtended: false,
    wasShrunk: false,
    autoReclaimed: 0, // seconds already pulled from upcoming sections due to running overtime
  };
}

function newMeeting() {
  return {
    id: uid(),
    title: "",
    attendees: "",
    createdAt: null,
    endedAt: null,
    sections: [],
    currentIndex: -1,
    timerStatus: "idle", // idle | running | paused | ended
    generalNotes: "",
    decisions: [],
    actionItems: [],
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
    m.attendees = saved.attendees;
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
      if (reduce > 0.5) s.wasShrunk = true;
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
  sec.wasExtended = true;
  shrinkUpcomingSections(addSeconds);
  save();
  renderLive();
}

function deferSection(id) {
  const m = state.meeting;
  const idx = m.sections.findIndex(s => s.id === id);
  if (idx === -1) return;
  const [removed] = m.sections.splice(idx, 1);
  m.deferred.push({ id: removed.id, name: removed.name, originalPlannedSeconds: removed.originalPlannedSeconds, deferredAt: Date.now() });
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
  m.sections.push(restored);
  save();
  renderLive();
}

/* ---------- notes that file themselves ---------- */

function fileCapture(kind, text, owner) {
  const m = state.meeting;
  const sec = currentSection();
  if (!sec) return;
  m.captures.push({ id: uid(), kind, text, owner: owner || "", sectionName: sec.name, timestamp: Date.now() });
  if (kind === "decision") m.decisions.push(text);
  if (kind === "action") m.actionItems.push({ text, owner: owner || "" });
  save();
  updateCapturesPanel();
}

function extractOwner(text) {
  const m = text.match(/@(\S+)/);
  return m ? m[1] : null;
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
    const openBreak = m.breaks[m.breaks.length - 1];
    if (openBreak && openBreak.endedAt === null) openBreak.endedAt = Date.now();
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
  next.pausedAccum = 0;
  m.timerStatus = "running";
  save();
  render();
}

// Steps back to the previous item: puts the current one back to upcoming
// (untimed, as if it hadn't started), and resumes the previous item's
// clock from exactly where it left off rather than restarting it.
function goToPreviousSection() {
  const m = state.meeting;
  if (!m || m.currentIndex <= 0) return;
  const sec = currentSection();
  if (!sec) return;
  sec.status = "upcoming";
  sec.startedAt = null;
  sec.pausedAccum = 0;
  sec.actualSeconds = null;

  const prevIndex = m.currentIndex - 1;
  m.currentIndex = prevIndex;
  const prev = m.sections[prevIndex];
  prev.status = "current";
  prev.pausedAccum = prev.actualSeconds || 0;
  prev.actualSeconds = null;
  prev.startedAt = Date.now();
  m.timerStatus = "running";
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
  state.view = "minutes";
  save();
  render();
}

/* ---------- markdown export ---------- */

function buildMinutesMarkdown(m) {
  const lines = [];
  lines.push(`# ${m.title || "Untitled Meeting"}`);
  lines.push("");
  lines.push(`- **Date:** ${fmtDateTime(m.createdAt)}`);
  if (m.attendees) lines.push(`- **Attendees:** ${m.attendees}`);
  const totalPlanned = m.sections.reduce((s, x) => s + x.originalPlannedSeconds, 0);
  const totalActual = m.sections.reduce((s, x) => s + (x.actualSeconds ?? x.plannedSeconds), 0);
  lines.push(`- **Planned duration:** ${fmtMinutes(totalPlanned)}`);
  lines.push(`- **Actual duration:** ${fmtMinutes(totalActual)}`);
  if (m.breaks && m.breaks.length) {
    const totalBreakSec = m.breaks.reduce((s, b) => s + ((b.endedAt || Date.now()) - b.startedAt) / 1000, 0);
    lines.push(`- **Breaks:** ${m.breaks.length} (${fmtMinutes(totalBreakSec)} total)`);
  }
  lines.push("");

  lines.push("## Agenda & Timing");
  lines.push("");
  lines.push("| Section | Planned | Actual |");
  lines.push("|---|---|---|");
  for (const s of m.sections) {
    const actual = s.actualSeconds != null ? fmtMinutes(s.actualSeconds) : "—";
    lines.push(`| ${s.name} | ${fmtMinutes(s.originalPlannedSeconds)} | ${actual} |`);
  }
  lines.push("");

  if (m.deferred && m.deferred.length) {
    lines.push("## Deferred to Next Meeting");
    lines.push("");
    for (const d of m.deferred) lines.push(`- ${d.name} (${fmtMinutes(d.originalPlannedSeconds)})`);
    lines.push("");
  }

  if (m.decisions.length) {
    lines.push("## Decisions");
    lines.push("");
    for (const d of m.decisions) lines.push(`- ${d}`);
    lines.push("");
  }

  if (m.actionItems.length) {
    lines.push("## Action Items");
    lines.push("");
    for (const a of m.actionItems) {
      lines.push(`- [ ] ${a.text}${a.owner ? ` (Owner: ${a.owner})` : ""}`);
    }
    lines.push("");
  }

  const motions = (m.captures || []).filter(c => c.kind === "motion");
  if (motions.length) {
    lines.push("## Motions");
    lines.push("");
    for (const mo of motions) lines.push(`- ${mo.text}`);
    lines.push("");
  }

  const notedSections = m.sections.filter(s => s.notes && s.notes.trim());
  if (notedSections.length) {
    lines.push("## Section Notes");
    lines.push("");
    for (const s of notedSections) {
      lines.push(`### ${s.name}`);
      lines.push(s.notes.trim());
      lines.push("");
    }
  }

  if (m.generalNotes && m.generalNotes.trim()) {
    lines.push("## General Notes");
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
    state.meeting = newMeeting();
    save();
  }
  const m = state.meeting;

  app.innerHTML = "";
  app.appendChild(renderTopbar("setup"));

  const layout = el("div", { class: "two-col" });
  const main = el("div", null);
  const sidebar = el("div", null);

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

  const attendeesField = el("div", { class: "field" });
  attendeesField.appendChild(el("label", { class: "field-label" }, "Attendees"));
  const attendeesInput = el("input", {
    class: "underline-input", type: "text", value: m.attendees, placeholder: "Optional — names, comma separated",
    oninput: (e) => { m.attendees = e.target.value; save(); },
  });
  attendeesField.appendChild(attendeesInput);
  main.appendChild(attendeesField);

  main.appendChild(el("div", { class: "section-label-row" }, [
    el("span", { class: "section-label" }, "Agenda"),
    el("span", { class: "rule" }),
    el("span", { class: "value", id: "agenda-total" }, `${agendaTotalMinutes(m.sections)} min`),
  ]));

  const list = el("div", { id: "section-list" });
  renderSectionRows(list);
  main.appendChild(list);

  const addRow = el("div", { class: "row", style: "margin-top:10px;gap:12px" });
  const nameField = el("input", { class: "underline-input", type: "text", placeholder: "New agenda item", style: "flex:1" });
  const durField = el("input", { class: "underline-input dur-input", type: "number", min: "1", value: "10", style: "width:64px;text-align:right" });
  const addBtn = el("button", { class: "btn btn-black" }, "Add");
  addBtn.addEventListener("click", () => {
    const name = nameField.value.trim() || "Untitled item";
    const dur = Math.max(1, parseInt(durField.value, 10) || 10);
    m.sections.push(newSection(name, dur));
    save();
    renderSectionRows(list);
    updateAgendaTotal();
    nameField.value = "";
    durField.value = "10";
    nameField.focus();
  });
  nameField.addEventListener("keydown", (e) => { if (e.key === "Enter") addBtn.click(); });
  addRow.appendChild(nameField);
  addRow.appendChild(durField);
  addRow.appendChild(el("span", { class: "min-label" }, "min"));
  addRow.appendChild(addBtn);
  main.appendChild(addRow);

  const pasteBox = el("div", { class: "paste-box" });
  pasteBox.appendChild(el("div", { class: "paste-head" }, "Paste an agenda"));
  const importArea = el("textarea", { placeholder: "1.2 In camera session   10 mins\n1.3 Related party transactions   15 mins" });
  pasteBox.appendChild(importArea);
  const pasteFoot = el("div", { class: "paste-foot" });
  pasteFoot.appendChild(el("p", null, "Lines ending in a duration become items. Headers and untimed references are skipped."));
  const importBtn = el("button", { class: "btn" }, "Parse and Add");
  const importStatus = el("span", { style: "font-size:0.8rem;color:var(--text-dim)" });
  importBtn.addEventListener("click", () => {
    const found = parseAgendaText(importArea.value);
    if (found.length === 0) {
      importStatus.textContent = "No timed lines found.";
      importStatus.style.color = "var(--bad)";
      return;
    }
    for (const item of found) m.sections.push(newSection(item.name, item.minutes));
    save();
    renderSetup();
  });
  pasteFoot.appendChild(importStatus);
  pasteFoot.appendChild(importBtn);
  pasteBox.appendChild(pasteFoot);
  main.appendChild(pasteBox);

  function updateAgendaTotal() {
    const totalEl = document.getElementById("agenda-total");
    if (totalEl) totalEl.textContent = `${agendaTotalMinutes(m.sections)} min`;
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
  m.captures = [];
  m.deferred = [];
  m.decisions = [];
  m.actionItems = [];
  m.generalNotes = "";
  for (const s of m.sections) {
    s.status = "upcoming";
    s.startedAt = null;
    s.pausedAccum = 0;
    s.actualSeconds = null;
    s.notes = "";
    s.wasExtended = false;
    s.wasShrunk = false;
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

function refreshAgendaTotals() {
  const m = state.meeting;
  const totalEl = document.getElementById("agenda-total");
  if (totalEl) totalEl.textContent = `${agendaTotalMinutes(m.sections)} min`;
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
    row.appendChild(durInput);
    row.appendChild(el("span", { class: "min-label" }, "min"));
    row.appendChild(handle);
    row.appendChild(delBtn);
    list.appendChild(row);
  });

  enableDragReorder(list, ".section-row", (orderedIds) => {
    const byId = new Map(m.sections.map(sec => [sec.id, sec]));
    m.sections = orderedIds.map(id => byId.get(id));
    save();
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
  const totalElapsedSoFar = m.sections.reduce((s, x) => {
    if (x.status === "done") return s + x.actualSeconds;
    if (x.status === "current") return s + elapsedSeconds(x);
    return s;
  }, 0);
  const projectedRemainingTotal = m.sections.reduce((s, x) => {
    if (x.status === "done") return s;
    if (x.status === "current") return s + (x.plannedSeconds - elapsedSeconds(x));
    return s + x.plannedSeconds;
  }, 0);
  const projectedEndTs = Date.now() + Math.max(0, projectedRemainingTotal) * 1000;
  const originalEndTs = (m.createdAt || Date.now()) + m.sections.reduce((s, x) => s + x.originalPlannedSeconds, 0) * 1000;
  return { sec, elapsed, remaining, pct, totalElapsedSoFar, projectedEndTs, originalEndTs };
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
  ]));

  const itemBarTop = el("div", { class: "item-bar-top" });
  const statsGroup = el("div", { class: "item-bar-stats" });

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

  const itemTimerBlock = el("div", { class: "item-timer-block" });
  const remainValueClass = isOvertime ? "item-timer-value overtime" : (pct > 85 ? "item-timer-value warn" : "item-timer-value");
  const remainValueEl = el("div", { id: "timer-display", class: remainValueClass }, fmtClock(remaining));
  itemTimerBlock.appendChild(remainValueEl);
  statsGroup.appendChild(itemTimerBlock);
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

  currentItemBar.appendChild(itemBarTop);

  const track = el("div", { class: "progress-track" });
  const fillEl = el("div", { id: "progress-fill", class: "progress-fill" + (isOvertime ? " overtime" : ""), style: `width:${pct}%` });
  track.appendChild(fillEl);
  currentItemBar.appendChild(track);

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
    info.appendChild(el("div", { class: "name" }, s.name));
    const metaEl = el("div", { class: "meta" }, railMetaText(s));
    info.appendChild(metaEl);
    if (s.status === "upcoming") {
      const actionsEl = el("div", { class: "rail-actions" });
      if (isNextUp) {
        const goBtn = el("button", { class: "icon-btn go-next", title: "Go to this item now" }, "▶");
        goBtn.addEventListener("click", (e) => { e.stopPropagation(); goToNextSection(); });
        actionsEl.appendChild(goBtn);
      }
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
    save();
    renderLive();
  });

  const notes = el("main", { class: "cockpit-notes" });

  const notesArea = el("textarea", { placeholder: "Capture points, decisions, or follow-ups. Start a line with /decision, /action or /motion to file it — @Name assigns an owner." });
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
  const cleanText = text.replace(/@\S+\s*/, "").trim();
  e.preventDefault();
  const newValue = ta.value.slice(0, lastNewline + 1) + ta.value.slice(cursorPos);
  ta.value = newValue;
  ta.selectionStart = ta.selectionEnd = lastNewline + 1;
  const sec = currentSection();
  if (sec) sec.notes = newValue;
  save();
  fileCapture(kind, cleanText, owner);
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
    item.appendChild(el("div", { class: "capture-section" }, c.sectionName));
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

function startTick() {
  clearTick();
  tickHandle = setInterval(() => {
    const m = state.meeting;
    if (!m) { clearTick(); return; }
    const sec = currentSection();
    if (!sec) { clearTick(); return; }

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
        sec.wasExtended = true;
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
  const m = state.meeting;
  if (!m) { switchView("setup"); return; }

  app.innerHTML = "";
  app.appendChild(renderTopbar("minutes"));

  const headRow = el("div", { class: "row", style: "justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px" });
  const headMain = el("div", null);
  headMain.appendChild(el("div", { class: "page-eyebrow" }, "Minutes"));
  headMain.appendChild(el("h1", { class: "page-head" }, m.title || "Untitled meeting"));
  headMain.appendChild(el("p", { class: "page-sub", style: "margin:0" }, fmtDateTimeLower(m.createdAt) + (m.attendees ? " · " + m.attendees : "")));
  headRow.appendChild(headMain);

  const headActions = el("div", { class: "row" });
  const copyBtn = el("button", { class: "btn" }, "Copy");
  copyBtn.addEventListener("click", () => copyMinutesToClipboard(m));
  const exportBtn = el("button", { class: "btn" }, "Markdown");
  exportBtn.addEventListener("click", () => downloadMarkdown(m));
  const printBtn = el("button", { class: "btn" }, "Print");
  printBtn.addEventListener("click", () => window.print());
  const fileBtn = el("button", { class: "btn btn-primary" }, "File Meeting");
  fileBtn.addEventListener("click", () => {
    state.history.unshift(JSON.parse(JSON.stringify(m)));
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

  // --- timing ---
  app.appendChild(flatSectionLabel("Timing"));
  m.sections.forEach(s => {
    const row = el("div", { class: "flat-row" });
    row.appendChild(el("div", { class: "name" }, s.name));
    row.appendChild(el("div", { class: "stat dim" }, fmtMinutes(s.originalPlannedSeconds)));
    if (s.actualSeconds != null) {
      row.appendChild(el("div", { class: "stat" }, fmtMinutes(s.actualSeconds)));
      const delta = s.actualSeconds - s.originalPlannedSeconds;
      const deltaText = Math.abs(Math.round(delta / 60)) < 1 ? "0m" : (delta >= 0 ? "+" : "−") + Math.round(Math.abs(delta) / 60) + "m";
      row.appendChild(el("div", { class: `stat delta ${delta < 0 ? "under" : delta > 0 ? "over" : ""}` }, deltaText));
    } else {
      row.appendChild(el("div", { class: "stat dim" }, "—"));
      row.appendChild(el("div", { class: "stat" }, ""));
    }
    app.appendChild(row);
  });

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

  // --- decisions ---
  if (m.decisions.length) {
    app.appendChild(flatSectionLabel("Decisions"));
    m.decisions.forEach((d, i) => {
      const row = el("div", { class: "flat-row" });
      row.appendChild(el("div", { class: "name" }, d));
      const rm = el("button", { class: "btn-icon btn-danger" }, "✕");
      rm.addEventListener("click", () => { m.decisions.splice(i, 1); save(); renderMinutes(); });
      row.appendChild(rm);
      app.appendChild(row);
    });
  }

  // --- action items ---
  if (m.actionItems.length) {
    app.appendChild(flatSectionLabel("Action Items"));
    m.actionItems.forEach((a, i) => {
      const row = el("div", { class: "flat-row" });
      row.appendChild(el("div", { class: "name" }, [a.text, a.owner ? el("span", { class: "stat dim", style: "margin-left:8px" }, "@" + a.owner) : null]));
      const rm = el("button", { class: "btn-icon btn-danger" }, "✕");
      rm.addEventListener("click", () => { m.actionItems.splice(i, 1); save(); renderMinutes(); });
      row.appendChild(rm);
      app.appendChild(row);
    });
  }

  // --- motions (filed via /motion, kept as free text) ---
  const motions = (m.captures || []).filter(c => c.kind === "motion");
  if (motions.length) {
    app.appendChild(flatSectionLabel("Motions"));
    motions.forEach(mo => {
      const row = el("div", { class: "flat-row" });
      row.appendChild(el("div", { class: "name" }, mo.text));
      app.appendChild(row);
    });
  }

  // --- notes by item (only items with actual notes) ---
  const notedSections = m.sections.filter(s => s.notes && s.notes.trim());
  if (notedSections.length) {
    app.appendChild(flatSectionLabel("Notes by Item"));
    notedSections.forEach(s => {
      const field = el("div", { class: "field" });
      field.appendChild(el("label", { class: "field-label" }, s.name));
      const ta = el("textarea", { class: "underline-input" }, s.notes);
      ta.value = s.notes;
      ta.addEventListener("input", (e) => { s.notes = e.target.value; save(); });
      field.appendChild(ta);
      app.appendChild(field);
    });
  } else {
    app.appendChild(flatSectionLabel("Notes by Item"));
  }

  const closingField = el("div", { class: "field" });
  closingField.appendChild(el("label", { class: "field-label" }, "Closing Notes"));
  const generalArea = el("textarea", { class: "underline-input", placeholder: "Anything for the record that didn't belong to one item." }, m.generalNotes);
  generalArea.value = m.generalNotes;
  generalArea.addEventListener("input", (e) => { m.generalNotes = e.target.value; save(); });
  closingField.appendChild(generalArea);
  app.appendChild(closingField);

  if (m.breaks && m.breaks.length) {
    const totalBreakSec = m.breaks.reduce((s, b) => s + ((b.endedAt || Date.now()) - b.startedAt) / 1000, 0);
    app.appendChild(el("p", { style: "margin-top:8px" }, `${m.breaks.length} break${m.breaks.length === 1 ? "" : "s"} taken (${fmtMinutes(totalBreakSec)} total).`));
  }
}

/* ---------- HISTORY VIEW ---------- */

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
      const hay = [
        m.title,
        ...m.decisions,
        ...m.actionItems.map(a => a.text),
        ...m.sections.map(s => s.notes),
        m.generalNotes,
      ].join(" \n ").toLowerCase();
      const idx = hay.indexOf(q);
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
      const row = el("div", { class: "search-match" });
      const highlighted = snippet.replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), (match) => `<mark>${match}</mark>`);
      row.innerHTML = `<strong>${m.title || "Untitled Meeting"}</strong> — …${highlighted}…`;
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
    viewBtn.addEventListener("click", (e) => { e.stopPropagation(); state.meeting = m; state.view = "minutes"; render(); });
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

// If we reloaded mid-meeting, land back on the right view.
if (state.meeting) {
  if (state.meeting.timerStatus === "running" || state.meeting.timerStatus === "paused") state.view = "live";
  else if (state.meeting.timerStatus === "ended") state.view = "minutes";
}

render();

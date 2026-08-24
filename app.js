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
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
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
    agendaExhausted: false, // true once an overrun couldn't be fully absorbed (upcoming sections floored)
  };
}

/* ---------- saved agendas (pre-meeting drafts) ---------- */

function saveAgendaForLater() {
  const m = state.meeting;
  if (m.sections.length === 0) {
    showToast({ message: "Add at least one agenda section before saving.", kind: "warning" });
    return;
  }
  state.savedAgendas.unshift({
    id: uid(),
    title: m.title,
    attendees: m.attendees,
    sections: JSON.parse(JSON.stringify(m.sections)),
    savedAt: Date.now(),
  });
  save();
  renderSetup();
  showToast({ message: `Saved "${m.title || "Untitled Meeting"}" for later.` });
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
    ? { text: `${mins} min behind schedule`, word: `+${mins}m BEHIND`, cls: "behind" }
    : { text: `${mins} min ahead of schedule`, word: `${mins}m AHEAD`, cls: "ahead" };
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

// Runs a reclaim attempt and updates the "agenda can't absorb more time"
// flag based on whether it fully succeeded — surfacing the moment the
// plan stops being physically possible, instead of failing silently.
function reclaimTime(neededSeconds) {
  const m = state.meeting;
  const reclaimed = shrinkUpcomingSections(neededSeconds);
  m.agendaExhausted = reclaimed < neededSeconds - 0.5;
  return reclaimed;
}

function extendCurrentSection(minutes) {
  const sec = currentSection();
  if (!sec) return;
  const addSeconds = minutes * 60;
  sec.plannedSeconds += addSeconds;
  sec.wasExtended = true;
  reclaimTime(addSeconds);
  save();
  renderLive();
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

function renderTopbar(activeView) {
  const nav = el("div", { class: "nav-links" }, [
    el("button", {
      class: activeView === "setup" || activeView === "live" || activeView === "minutes" ? "active" : "",
      onclick: () => switchView(state.meeting ? (state.meeting.timerStatus === "ended" ? "minutes" : (state.meeting.timerStatus === "idle" ? "setup" : "live")) : "setup"),
    }, "Meeting"),
    el("button", {
      class: activeView === "history" ? "active" : "",
      onclick: () => switchView("history"),
    }, "History"),
  ]);
  return el("div", { class: "topbar" }, [
    el("h1", null, [el("span", { class: "brand-dot" }), "Chair's Meeting Manager"]),
    nav,
  ]);
}

/* ---------- SETUP VIEW ---------- */

function renderSetup() {
  clearTick();
  if (!state.meeting || state.meeting.timerStatus !== "idle") {
    state.meeting = newMeeting();
    save();
  }
  const m = state.meeting;

  app.innerHTML = "";
  app.appendChild(renderTopbar("setup"));

  const card = el("div", { class: "card" });

  const titleInput = el("input", {
    type: "text", value: m.title, placeholder: "e.g. Q3 Steering Committee",
    oninput: (e) => { m.title = e.target.value; save(); },
  });
  card.appendChild(el("label", null, "Meeting title"));
  card.appendChild(titleInput);

  const attendeesInput = el("input", {
    type: "text", value: m.attendees, placeholder: "e.g. Alice, Bob, Chandra (optional)",
    oninput: (e) => { m.attendees = e.target.value; save(); },
  });
  card.appendChild(el("label", null, "Attendees"));
  card.appendChild(attendeesInput);

  app.appendChild(card);

  if (state.savedAgendas.length > 0) {
    const savedCard = el("div", { class: "card" });
    savedCard.appendChild(el("h3", null, "Saved Agendas"));
    savedCard.appendChild(el("p", null, "Drafts you prepped ahead of time. Load one to start editing or run the meeting."));
    state.savedAgendas.forEach(a => {
      const totalMin = Math.round(a.sections.reduce((s, x) => s + x.plannedSeconds, 0) / 60);
      const item = el("div", { class: "history-item" });
      const left = el("div", null, [
        el("div", { class: "name" }, a.title || "Untitled Meeting"),
        el("div", { class: "date" }, `${a.sections.length} section${a.sections.length === 1 ? "" : "s"} · ${totalMin} min · saved ${fmtDateTime(a.savedAt)}`),
      ]);
      const actions = el("div", { class: "row" });
      const loadBtn = el("button", { class: "btn btn-small" }, "Load");
      loadBtn.addEventListener("click", () => loadSavedAgenda(a.id));
      const delBtn = el("button", { class: "btn-icon btn-danger" }, "✕");
      delBtn.addEventListener("click", () => deleteSavedAgenda(a.id));
      actions.appendChild(loadBtn);
      actions.appendChild(delBtn);
      item.appendChild(left);
      item.appendChild(actions);
      savedCard.appendChild(item);
    });
    app.appendChild(savedCard);
  }

  const agendaCard = el("div", { class: "card" });
  agendaCard.appendChild(el("h3", null, "Agenda"));
  agendaCard.appendChild(el("p", null, "Add sections with a planned duration. You can extend any section live — remaining upcoming sections will automatically shrink to try to keep the meeting on schedule."));

  const list = el("div", { id: "section-list" });
  renderSectionRows(list);
  agendaCard.appendChild(list);

  const addRow = el("div", { class: "row", style: "margin-top:10px" });
  const nameField = el("input", { type: "text", placeholder: "New section name" });
  nameField.style.flex = "1";
  const durField = el("input", { type: "number", min: "1", value: "5", class: "dur-input" });
  const addBtn = el("button", { class: "btn btn-primary" }, "+ Add");
  addBtn.addEventListener("click", () => {
    const name = nameField.value.trim() || "Untitled section";
    const dur = Math.max(1, parseInt(durField.value, 10) || 5);
    m.sections.push(newSection(name, dur));
    save();
    renderSectionRows(list);
    nameField.value = "";
    durField.value = "5";
    nameField.focus();
  });
  nameField.addEventListener("keydown", (e) => { if (e.key === "Enter") addBtn.click(); });
  addRow.appendChild(nameField);
  addRow.appendChild(durField);
  addRow.appendChild(addBtn);
  agendaCard.appendChild(addRow);

  const importDetails = el("details", { style: "margin-top:14px" });
  importDetails.appendChild(el("summary", { style: "cursor:pointer;font-size:0.85rem;color:var(--text-dim)" }, "Or paste an agenda to import"));
  const importBody = el("div", { style: "margin-top:8px" });
  importBody.appendChild(el("p", { style: "font-size:0.8rem;margin-bottom:6px" },
    'One item per line, ending in a duration, e.g. "1.2 In camera session  10mins". Lines without a duration (section headers, document references) are skipped.'));
  const importArea = el("textarea", { placeholder: "Paste agenda text here...", style: "min-height:100px" });
  const importRow = el("div", { class: "row", style: "margin-top:8px" });
  const importBtn = el("button", { class: "btn btn-small" }, "Parse & Add Sections");
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
  importRow.appendChild(importBtn);
  importRow.appendChild(importStatus);
  importBody.appendChild(importArea);
  importBody.appendChild(importRow);
  importDetails.appendChild(importBody);
  agendaCard.appendChild(importDetails);

  const totalMin = Math.round(m.sections.reduce((s, x) => s + x.plannedSeconds, 0) / 60);
  agendaCard.appendChild(el("div", { class: "meeting-meta", style: "margin-top:12px" }, [
    el("span", null, `${m.sections.length} section${m.sections.length === 1 ? "" : "s"}`),
    el("span", null, `Total planned: ${totalMin} min`),
  ]));

  app.appendChild(agendaCard);

  const actionRow = el("div", { class: "row" });
  const saveForLaterBtn = el("button", { class: "btn", style: "padding:12px" }, "Save for Later");
  saveForLaterBtn.addEventListener("click", saveAgendaForLater);
  const startBtn = el("button", { class: "btn btn-primary", style: "flex:1;padding:12px;font-size:1rem" }, "Start Meeting");
  startBtn.addEventListener("click", () => {
    if (m.sections.length === 0) {
      showToast({ message: "Add at least one agenda section first.", kind: "warning" });
      return;
    }
    startMeeting();
  });
  actionRow.appendChild(saveForLaterBtn);
  actionRow.appendChild(startBtn);
  app.appendChild(actionRow);
}

function renderSectionRows(list) {
  const m = state.meeting;
  list.innerHTML = "";
  if (m.sections.length === 0) {
    list.appendChild(el("p", { style: "margin:4px 0" }, "No sections yet — add one below or paste an agenda."));
  }
  m.sections.forEach((s) => {
    const row = el("div", { class: "section-row", "data-id": s.id });

    const handle = el("div", { class: "drag-handle", title: "Drag to reorder" }, "⠿");

    const nameInput = el("input", { type: "text", class: "name-input", value: s.name });
    nameInput.addEventListener("input", (e) => { s.name = e.target.value; save(); });

    const durInput = el("input", { type: "number", min: "1", class: "dur-input", value: String(Math.round(s.plannedSeconds / 60)) });
    durInput.addEventListener("input", (e) => {
      const v = Math.max(1, parseInt(e.target.value, 10) || 1);
      s.plannedSeconds = v * 60;
      s.originalPlannedSeconds = v * 60;
      save();
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

    row.appendChild(handle);
    row.appendChild(nameInput);
    row.appendChild(durInput);
    row.appendChild(el("span", { class: "row" }, [el("span", { style: "color:var(--text-dim);font-size:0.8rem" }, "min")]));
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
  topbar.appendChild(el("div", { class: "cockpit-brand" }, [el("span", { class: "brand-dot" }), "Chair"]));
  const tabs = el("div", { class: "cockpit-tabs" });
  const meetingTab = el("button", { class: "active" }, "Meeting");
  meetingTab.addEventListener("click", () => {});
  const historyTab = el("button", null, "History");
  historyTab.addEventListener("click", () => switchView("history"));
  tabs.appendChild(meetingTab);
  tabs.appendChild(historyTab);
  topbar.appendChild(tabs);
  topbar.appendChild(el("div", { class: "cockpit-topbar-right" }, [el("span", null, m.title || "Untitled Meeting")]));
  header.appendChild(topbar);

  const hero = el("div", { class: "cockpit-hero" });

  const remainStat = el("div", { class: "hero-stat" });
  remainStat.appendChild(el("div", { class: "hero-label" }, sec.name));
  const remainValueClass = isOvertime ? "hero-value overtime" : (pct > 85 ? "hero-value warn" : "hero-value");
  const remainValueEl = el("div", { id: "timer-display", class: remainValueClass }, fmtClock(remaining));
  remainStat.appendChild(remainValueEl);
  const track = el("div", { class: "progress-track" });
  const fillEl = el("div", { id: "progress-fill", class: "progress-fill" + (isOvertime ? " overtime" : ""), style: `width:${pct}%` });
  track.appendChild(fillEl);
  remainStat.appendChild(track);
  hero.appendChild(remainStat);

  const endStat = el("div", { class: "hero-stat" });
  endStat.appendChild(el("div", { class: "hero-label" }, "Projected end"));
  const projectedEndEl = el("div", { id: "projected-end", class: "hero-value" }, fmtTimeOfDay(stats.projectedEndTs));
  endStat.appendChild(projectedEndEl);
  endStat.appendChild(el("div", { class: "hero-sub" }, `was ${fmtTimeOfDay(stats.originalEndTs)}`));
  hero.appendChild(endStat);

  const planStat = el("div", { class: "hero-stat" });
  planStat.appendChild(el("div", { class: "hero-label" }, "Against plan"));
  const badgeInfo0 = scheduleBadgeInfo();
  const scheduleBadgeEl = el("div", { id: "schedule-badge", class: `hero-value schedule-badge ${badgeInfo0.cls}` }, badgeInfo0.word);
  planStat.appendChild(scheduleBadgeEl);
  planStat.appendChild(el("div", { class: "hero-sub" }, isOvertime ? "auto-adjusting agenda" : " "));
  hero.appendChild(planStat);

  const heroActions = el("div", { class: "hero-actions" });
  const pauseBtn = el("button", null, m.timerStatus === "running" ? "Pause" : "Resume");
  pauseBtn.addEventListener("click", togglePause);
  const breakBtn = el("button", null, "Break");
  breakBtn.addEventListener("click", takeBreak);
  const nextBtn = el("button", { class: "primary" }, m.currentIndex === m.sections.length - 1 ? "Finish Meeting" : "Next Section");
  nextBtn.addEventListener("click", goToNextSection);
  heroActions.appendChild(pauseBtn);
  heroActions.appendChild(breakBtn);
  heroActions.appendChild(nextBtn);
  hero.appendChild(heroActions);

  header.appendChild(hero);

  const exhaustedBannerEl = el("div", { id: "exhausted-banner", class: "exhausted-banner" + (m.agendaExhausted ? " visible" : "") },
    "Agenda can't absorb any more time — upcoming sections are already down to their 1-minute floor.");
  header.appendChild(exhaustedBannerEl);

  cockpit.appendChild(header);

  /* ---- body: agenda rail + notes centre ---- */
  const body = el("div", { class: "cockpit-body" });

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
  notes.appendChild(el("div", { class: "notes-header" }, [
    el("h2", null, sec.name),
    el("div", { class: "notes-meta" }, `Planned ${fmtMinutes(sec.plannedSeconds)}`),
  ]));

  const notesActions = el("div", { class: "notes-actions" });
  const btn1 = el("button", { class: "btn btn-small" }, "+1 min");
  btn1.addEventListener("click", () => extendCurrentSection(1));
  const btn5 = el("button", { class: "btn btn-small" }, "+5 min");
  btn5.addEventListener("click", () => extendCurrentSection(5));
  const customInput = el("input", { type: "number", min: "1", value: "2" });
  const customBtn = el("button", { class: "btn btn-small" }, "Extend");
  customBtn.addEventListener("click", () => {
    const v = Math.max(1, parseInt(customInput.value, 10) || 1);
    extendCurrentSection(v);
  });
  notesActions.appendChild(btn1);
  notesActions.appendChild(btn5);
  notesActions.appendChild(customInput);
  notesActions.appendChild(customBtn);
  notesActions.appendChild(el("div", { class: "spacer" }));
  const endBtn = el("button", { class: "btn btn-danger" }, "End Meeting");
  endBtn.addEventListener("click", () => {
    showToast({
      kind: "confirm",
      message: "End the meeting now and go to notes & minutes?",
      confirmLabel: "End Meeting",
      onConfirm: endMeeting,
    });
  });
  notesActions.appendChild(endBtn);
  notes.appendChild(notesActions);

  const notesArea = el("textarea", { placeholder: "Capture points, decisions, or follow-ups for this section..." });
  notesArea.value = sec.notes;
  notesArea.addEventListener("input", (e) => { sec.notes = e.target.value; save(); });
  notes.appendChild(notesArea);

  body.appendChild(notes);
  cockpit.appendChild(body);

  app.appendChild(cockpit);

  restoreFocus(focusInfo);
  startTick();
}

function railMetaText(s) {
  if (s.status === "done") return `Actual ${fmtMinutes(s.actualSeconds)} / planned ${fmtMinutes(s.originalPlannedSeconds)}`;
  return `Planned ${fmtMinutes(s.plannedSeconds)}`;
}

function railBadges(s, isNextUp) {
  const badges = [];
  if (isNextUp) badges.push(el("span", { class: "pill" }, "up next"));
  if (s.wasExtended) badges.push(el("span", { class: "pill extended" }, "extended"));
  if (s.wasShrunk) badges.push(el("span", { class: "pill shrunk" }, "shrunk"));
  return badges;
}

// Refreshes every DOM node that can change from a pure tick — the current
// item's countdown/progress, the header's projected-end and against-plan
// numbers, and (only when a reclaim just happened) the rail's shrunk/
// extended indicators. Deliberately never touches the notes textarea or
// rebuilds the DOM: this is what used to be a full renderLive() every
// second, which fought typing during an overrun. Runs whether the meeting
// is running or paused, since projected end must keep drifting later in
// real time even while the section clock is frozen.
function updateLiveDisplays(reclaimHappened) {
  if (!liveRefs) return;
  const m = state.meeting;
  const stats = computeLiveStats();
  const { remaining, pct } = stats;
  const isOvertime = remaining < 0;

  const timeEl = document.getElementById("timer-display");
  const fillEl = document.getElementById("progress-fill");
  if (!timeEl) { clearTick(); return; }

  timeEl.textContent = fmtClock(remaining);
  timeEl.className = isOvertime ? "hero-value overtime" : (pct > 85 ? "hero-value warn" : "hero-value");
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
    badgeEl.className = `hero-value schedule-badge ${badgeInfo.cls}`;
  }

  const exhaustedBannerEl = document.getElementById("exhausted-banner");
  if (exhaustedBannerEl) exhaustedBannerEl.classList.toggle("visible", !!m.agendaExhausted);

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
        reclaimTime(toReclaim);
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

/* focus preservation across the rarer full re-renders (e.g. Next Section) */
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

/* ---------- MINUTES VIEW ---------- */

function renderMinutes() {
  clearTick();
  const m = state.meeting;
  if (!m) { switchView("setup"); return; }

  app.innerHTML = "";
  app.appendChild(renderTopbar("minutes"));

  app.appendChild(el("h2", null, m.title || "Untitled Meeting"));
  app.appendChild(el("p", null, `${fmtDateTime(m.createdAt)}${m.attendees ? " · " + m.attendees : ""}`));

  const summaryCard = el("div", { class: "card" });
  const totalPlanned = m.sections.reduce((s, x) => s + x.originalPlannedSeconds, 0);
  const totalActual = m.sections.reduce((s, x) => s + (x.actualSeconds ?? x.plannedSeconds), 0);
  summaryCard.appendChild(el("h3", null, "Timing Summary"));
  const table = el("table", { class: "minutes-table" });
  const thead = el("tr", null, [el("th", null, "Section"), el("th", null, "Planned"), el("th", null, "Actual")]);
  table.appendChild(thead);
  m.sections.forEach(s => {
    table.appendChild(el("tr", null, [
      el("td", null, s.name),
      el("td", null, fmtMinutes(s.originalPlannedSeconds)),
      el("td", null, s.actualSeconds != null ? fmtMinutes(s.actualSeconds) : "—"),
    ]));
  });
  table.appendChild(el("tr", null, [
    el("td", null, el("strong", null, "Total")),
    el("td", null, el("strong", null, fmtMinutes(totalPlanned))),
    el("td", null, el("strong", null, fmtMinutes(totalActual))),
  ]));
  summaryCard.appendChild(table);
  if (m.breaks && m.breaks.length) {
    const totalBreakSec = m.breaks.reduce((s, b) => s + ((b.endedAt || Date.now()) - b.startedAt) / 1000, 0);
    summaryCard.appendChild(el("p", { style: "margin-top:8px;margin-bottom:0" }, `${m.breaks.length} break${m.breaks.length === 1 ? "" : "s"} taken (${fmtMinutes(totalBreakSec)} total).`));
  }
  app.appendChild(summaryCard);

  // decisions
  const decisionsCard = el("div", { class: "card" });
  decisionsCard.appendChild(el("h3", null, "Decisions"));
  const decisionsList = el("div", { class: "chip-list" });
  decisionsCard.appendChild(decisionsList);
  const decisionInputRow = el("div", { class: "list-input-row" });
  const decisionInput = el("input", { type: "text", placeholder: "Add a decision..." });
  const decisionAddBtn = el("button", { class: "btn btn-small" }, "Add");
  const addDecision = () => {
    const v = decisionInput.value.trim();
    if (!v) return;
    m.decisions.push(v);
    save();
    decisionInput.value = "";
    renderDecisions();
  };
  decisionAddBtn.addEventListener("click", addDecision);
  decisionInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addDecision(); });
  decisionInputRow.appendChild(decisionInput);
  decisionInputRow.appendChild(decisionAddBtn);
  decisionsCard.appendChild(decisionInputRow);
  app.appendChild(decisionsCard);

  function renderDecisions() {
    decisionsList.innerHTML = "";
    m.decisions.forEach((d, i) => {
      const chip = el("div", { class: "chip" }, [
        el("span", { class: "txt" }, d),
      ]);
      const rm = el("button", { class: "btn-icon btn-danger" }, "✕");
      rm.addEventListener("click", () => { m.decisions.splice(i, 1); save(); renderDecisions(); });
      chip.appendChild(rm);
      decisionsList.appendChild(chip);
    });
  }
  renderDecisions();

  // action items
  const actionCard = el("div", { class: "card" });
  actionCard.appendChild(el("h3", null, "Action Items"));
  const actionList = el("div", { class: "chip-list" });
  actionCard.appendChild(actionList);
  const actionInputRow = el("div", { class: "list-input-row" });
  const actionText = el("input", { type: "text", placeholder: "Action item..." });
  const actionOwner = el("input", { type: "text", placeholder: "Owner (optional)", style: "max-width:140px" });
  const actionAddBtn = el("button", { class: "btn btn-small" }, "Add");
  const addAction = () => {
    const v = actionText.value.trim();
    if (!v) return;
    m.actionItems.push({ text: v, owner: actionOwner.value.trim() });
    save();
    actionText.value = "";
    actionOwner.value = "";
    renderActions();
  };
  actionAddBtn.addEventListener("click", addAction);
  actionText.addEventListener("keydown", (e) => { if (e.key === "Enter") addAction(); });
  actionInputRow.appendChild(actionText);
  actionInputRow.appendChild(actionOwner);
  actionInputRow.appendChild(actionAddBtn);
  actionCard.appendChild(actionInputRow);
  app.appendChild(actionCard);

  function renderActions() {
    actionList.innerHTML = "";
    m.actionItems.forEach((a, i) => {
      const chip = el("div", { class: "chip" }, [
        el("span", { class: "txt" }, a.text),
        a.owner ? el("span", { class: "owner" }, a.owner) : null,
      ]);
      const rm = el("button", { class: "btn-icon btn-danger" }, "✕");
      rm.addEventListener("click", () => { m.actionItems.splice(i, 1); save(); renderActions(); });
      chip.appendChild(rm);
      actionList.appendChild(chip);
    });
  }
  renderActions();

  // section notes review
  const sectionNotesCard = el("div", { class: "card" });
  sectionNotesCard.appendChild(el("h3", null, "Section Notes"));
  m.sections.forEach(s => {
    const block = el("div", { class: "section-notes-block" });
    block.appendChild(el("h4", null, s.name));
    const ta = el("textarea", null, s.notes);
    ta.value = s.notes;
    ta.addEventListener("input", (e) => { s.notes = e.target.value; save(); });
    block.appendChild(ta);
    sectionNotesCard.appendChild(block);
  });
  app.appendChild(sectionNotesCard);

  // general notes
  const generalCard = el("div", { class: "card" });
  generalCard.appendChild(el("label", null, "General Notes"));
  const generalArea = el("textarea", { placeholder: "Overall meeting notes, context, next steps..." }, m.generalNotes);
  generalArea.value = m.generalNotes;
  generalArea.addEventListener("input", (e) => { m.generalNotes = e.target.value; save(); });
  generalCard.appendChild(generalArea);
  app.appendChild(generalCard);

  const footer = el("div", { class: "footer-actions" });
  const exportBtn = el("button", { class: "btn" }, "Export Markdown");
  exportBtn.addEventListener("click", () => downloadMarkdown(m));
  const saveBtn = el("button", { class: "btn btn-primary" }, "Save & New Meeting");
  saveBtn.addEventListener("click", () => {
    state.history.unshift(JSON.parse(JSON.stringify(m)));
    state.meeting = null;
    state.view = "setup";
    save();
    render();
  });
  footer.appendChild(exportBtn);
  footer.appendChild(saveBtn);
  app.appendChild(footer);
}

/* ---------- HISTORY VIEW ---------- */

function renderHistory() {
  clearTick();
  app.innerHTML = "";
  app.appendChild(renderTopbar("history"));
  app.appendChild(el("h2", null, "Past Meetings"));

  if (state.history.length === 0) {
    app.appendChild(el("div", { class: "card empty-state" }, "No saved meetings yet. Run a meeting and save it to see it here."));
    return;
  }

  const card = el("div", { class: "card" });
  state.history.forEach((m, idx) => {
    const item = el("div", { class: "history-item" });
    const left = el("div", null, [
      el("div", { class: "name" }, m.title || "Untitled Meeting"),
      el("div", { class: "date" }, fmtDateTime(m.createdAt)),
    ]);
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
        message: `Deleted "${removed.title || "Untitled Meeting"}".`,
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
    item.appendChild(left);
    item.appendChild(actions);
    card.appendChild(item);
  });
  app.appendChild(card);
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

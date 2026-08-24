"use strict";

/* ---------- constants ---------- */

const STORAGE_KEY = "chair-meeting-manager:v1";
const MIN_SECTION_SECONDS = 60; // a section can never be auto-shrunk below this

/* ---------- state ---------- */

let state = loadState();
let tickHandle = null;

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
  };
}

/* ---------- saved agendas (pre-meeting drafts) ---------- */

function saveAgendaForLater() {
  const m = state.meeting;
  if (m.sections.length === 0) {
    alert("Add at least one agenda section before saving.");
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
}

function loadSavedAgenda(id) {
  const saved = state.savedAgendas.find(a => a.id === id);
  if (!saved) return;
  const m = state.meeting;
  if (m.sections.length > 0 && !confirm(`Load "${saved.title || "Untitled Meeting"}"? This replaces your current unsaved draft.`)) return;
  m.title = saved.title;
  m.attendees = saved.attendees;
  m.sections = JSON.parse(JSON.stringify(saved.sections));
  save();
  renderSetup();
}

function deleteSavedAgenda(id) {
  const idx = state.savedAgendas.findIndex(a => a.id === id);
  if (idx === -1) return;
  if (!confirm("Delete this saved agenda?")) return;
  state.savedAgendas.splice(idx, 1);
  save();
  renderSetup();
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

function moveUpcomingSection(idx, delta) {
  const m = state.meeting;
  const targetIdx = idx + delta;
  if (targetIdx < 0 || targetIdx >= m.sections.length) return;
  if (m.sections[idx].status !== "upcoming" || m.sections[targetIdx].status !== "upcoming") return;
  [m.sections[idx], m.sections[targetIdx]] = [m.sections[targetIdx], m.sections[idx]];
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
  }
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

function switchView(view) {
  state.view = view;
  save();
  render();
}

/* ---------- top nav ---------- */

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
    el("h1", null, "⏱️ Chair's Meeting Manager"),
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
  const saveForLaterBtn = el("button", { class: "btn", style: "padding:12px" }, "💾 Save for Later");
  saveForLaterBtn.addEventListener("click", () => {
    saveAgendaForLater();
    renderSetup();
  });
  const startBtn = el("button", { class: "btn btn-primary", style: "flex:1;padding:12px;font-size:1rem" }, "Start Meeting ▶");
  startBtn.addEventListener("click", () => {
    if (m.sections.length === 0) { alert("Add at least one agenda section first."); return; }
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
  m.sections.forEach((s, idx) => {
    const row = el("div", { class: "section-row" });

    const nameInput = el("input", { type: "text", class: "name-input", value: s.name });
    nameInput.addEventListener("input", (e) => { s.name = e.target.value; save(); });

    const durInput = el("input", { type: "number", min: "1", class: "dur-input", value: String(Math.round(s.plannedSeconds / 60)) });
    durInput.addEventListener("input", (e) => {
      const v = Math.max(1, parseInt(e.target.value, 10) || 1);
      s.plannedSeconds = v * 60;
      s.originalPlannedSeconds = v * 60;
      save();
    });

    const upBtn = el("button", { class: "btn-icon", title: "Move up", disabled: idx === 0 ? "disabled" : null }, "↑");
    upBtn.addEventListener("click", () => {
      if (idx === 0) return;
      [m.sections[idx - 1], m.sections[idx]] = [m.sections[idx], m.sections[idx - 1]];
      save(); renderSectionRows(list);
    });
    const downBtn = el("button", { class: "btn-icon", title: "Move down", disabled: idx === m.sections.length - 1 ? "disabled" : null }, "↓");
    downBtn.addEventListener("click", () => {
      if (idx === m.sections.length - 1) return;
      [m.sections[idx + 1], m.sections[idx]] = [m.sections[idx], m.sections[idx + 1]];
      save(); renderSectionRows(list);
    });
    const delBtn = el("button", { class: "btn-icon btn-danger", title: "Remove" }, "✕");
    delBtn.addEventListener("click", () => {
      m.sections.splice(idx, 1);
      save(); renderSectionRows(list);
      const setupCard = document.getElementById("section-list");
      if (setupCard) renderSetup();
    });

    row.appendChild(nameInput);
    row.appendChild(durInput);
    row.appendChild(el("span", { class: "row" }, [el("span", { style: "color:var(--text-dim);font-size:0.8rem" }, "min")]));
    row.appendChild(el("div", { class: "btn-group" }, [upBtn, downBtn, delBtn]));
    list.appendChild(row);
  });
}

/* ---------- LIVE VIEW ---------- */

function renderLive() {
  const m = state.meeting;
  if (!m || m.currentIndex < 0) { switchView("setup"); return; }

  const focusInfo = captureFocus();

  app.innerHTML = "";
  app.appendChild(renderTopbar("live"));

  app.appendChild(el("h2", { style: "margin-bottom:2px" }, m.title || "Untitled Meeting"));

  const sec = currentSection();
  const remaining = sec.plannedSeconds - elapsedSeconds(sec);
  const isOvertime = remaining < 0;
  const pct = Math.min(100, Math.max(0, (elapsedSeconds(sec) / sec.plannedSeconds) * 100));

  const timerCard = el("div", { class: "card timer-card" });
  timerCard.appendChild(el("div", { class: "section-name" }, `${m.currentIndex + 1}. ${sec.name}`));
  const displayClass = isOvertime ? "timer-display overtime" : (pct > 85 ? "timer-display warn" : "timer-display");
  const timeEl = el("div", { id: "timer-display", class: displayClass }, fmtClock(remaining));
  timerCard.appendChild(timeEl);

  const track = el("div", { class: "progress-track" });
  const fill = el("div", { id: "progress-fill", class: "progress-fill" + (isOvertime ? " overtime" : ""), style: `width:${pct}%` });
  track.appendChild(fill);
  timerCard.appendChild(track);

  timerCard.appendChild(el("div", { class: "meeting-meta" }, [
    el("span", null, `Planned: ${fmtMinutes(sec.plannedSeconds)}`),
    el("span", null, isOvertime ? "OVER TIME — auto-adjusting agenda" : `${Math.max(0, Math.round(100 - pct))}% remaining`),
  ]));

  const controlRow = el("div", { class: "control-row" });
  const pauseBtn = el("button", { class: "btn" }, m.timerStatus === "running" ? "⏸ Pause" : "▶ Resume");
  pauseBtn.addEventListener("click", togglePause);
  const nextBtn = el("button", { class: "btn btn-primary" },
    m.currentIndex === m.sections.length - 1 ? "Finish Meeting →" : "Next Section →");
  nextBtn.addEventListener("click", goToNextSection);
  const endBtn = el("button", { class: "btn btn-danger" }, "End Meeting");
  endBtn.addEventListener("click", () => {
    if (confirm("End the meeting now and go to notes & minutes?")) endMeeting();
  });
  controlRow.appendChild(pauseBtn);
  controlRow.appendChild(nextBtn);
  controlRow.appendChild(endBtn);
  timerCard.appendChild(controlRow);

  const extendRow = el("div", { class: "extend-row" });
  extendRow.appendChild(el("span", { style: "color:var(--text-dim);font-size:0.85rem" }, "Extend this section:"));
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
  extendRow.appendChild(btn1);
  extendRow.appendChild(btn5);
  extendRow.appendChild(customInput);
  extendRow.appendChild(customBtn);
  timerCard.appendChild(extendRow);

  app.appendChild(timerCard);

  // notes for current section
  const notesCard = el("div", { class: "card" });
  notesCard.appendChild(el("label", null, `Notes for "${sec.name}"`));
  const notesArea = el("textarea", { placeholder: "Capture points, decisions, or follow-ups for this section..." }, sec.notes);
  notesArea.value = sec.notes;
  notesArea.addEventListener("input", (e) => { sec.notes = e.target.value; save(); });
  notesCard.appendChild(notesArea);
  app.appendChild(notesCard);

  // full agenda overview
  const agendaCard = el("div", { class: "card" });
  agendaCard.appendChild(el("h3", null, "Agenda"));
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

  agendaCard.appendChild(el("div", { class: "meeting-meta", style: "margin-bottom:6px" }, [
    el("span", null, `Elapsed: ${fmtClock(totalElapsedSoFar)}`),
    el("span", null, `Projected end: ${new Date(projectedEndTs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`),
  ]));

  m.sections.forEach((s, idx) => {
    const isNextUp = s.status === "upcoming" && idx === m.currentIndex + 1;
    const item = el("div", { class: `agenda-item ${s.status}${isNextUp ? " next-up" : ""}` });
    const statusIcon = s.status === "done" ? "✓" : s.status === "current" ? "▶" : String(idx + 1);
    item.appendChild(el("div", { class: "agenda-status" }, statusIcon));
    const info = el("div", { class: "info" });
    info.appendChild(el("div", { class: "name" }, s.name));
    const metaBits = [];
    if (s.status === "done") {
      metaBits.push(`Actual ${fmtMinutes(s.actualSeconds)} / planned ${fmtMinutes(s.originalPlannedSeconds)}`);
    } else {
      metaBits.push(`Planned ${fmtMinutes(s.plannedSeconds)}`);
    }
    const meta = el("div", { class: "meta" }, metaBits.join(" · "));
    info.appendChild(meta);
    item.appendChild(info);
    if (isNextUp) item.appendChild(el("span", { class: "pill" }, "up next"));
    if (s.wasExtended) item.appendChild(el("span", { class: "pill extended" }, "extended"));
    if (s.wasShrunk) item.appendChild(el("span", { class: "pill shrunk" }, "shrunk"));
    if (s.status === "upcoming") {
      const prevIsUpcoming = idx > 0 && m.sections[idx - 1].status === "upcoming";
      const nextIsUpcoming = idx < m.sections.length - 1 && m.sections[idx + 1].status === "upcoming";
      const upBtn = el("button", { class: "btn-icon", title: "Move up the queue" }, "↑");
      upBtn.disabled = !prevIsUpcoming;
      upBtn.addEventListener("click", () => moveUpcomingSection(idx, -1));
      const downBtn = el("button", { class: "btn-icon", title: "Move down the queue" }, "↓");
      downBtn.disabled = !nextIsUpcoming;
      downBtn.addEventListener("click", () => moveUpcomingSection(idx, 1));
      item.appendChild(el("div", { class: "btn-group" }, [upBtn, downBtn]));
    }
    agendaCard.appendChild(item);
  });
  app.appendChild(agendaCard);

  restoreFocus(focusInfo);
  startTick();
}

function startTick() {
  clearTick();
  tickHandle = setInterval(() => {
    const m = state.meeting;
    if (!m || m.timerStatus !== "running") return;
    const sec = currentSection();
    if (!sec) return;

    // Running past the planned time auto-extends this section by pulling
    // the overage from upcoming sections, continuously, until "Next
    // Section" locks in the actual time used.
    const elapsed = elapsedSeconds(sec);
    const overage = elapsed - sec.plannedSeconds;
    const alreadyReclaimed = sec.autoReclaimed;
    const toReclaim = overage - alreadyReclaimed;
    if (toReclaim > 0.5) {
      shrinkUpcomingSections(toReclaim);
      sec.autoReclaimed = alreadyReclaimed + toReclaim;
      sec.wasExtended = true;
      save();
      renderLive(); // full refresh so the shrinking agenda list is visible; focus-preserving
      return;
    }

    const remaining = sec.plannedSeconds - elapsed;
    const timeEl = document.getElementById("timer-display");
    const fillEl = document.getElementById("progress-fill");
    if (timeEl) {
      timeEl.textContent = fmtClock(remaining);
      const pct = Math.min(100, Math.max(0, (elapsed / sec.plannedSeconds) * 100));
      timeEl.className = remaining < 0 ? "timer-display overtime" : (pct > 85 ? "timer-display warn" : "timer-display");
      if (fillEl) {
        fillEl.style.width = pct + "%";
        fillEl.className = "progress-fill" + (remaining < 0 ? " overtime" : "");
      }
    } else {
      clearTick();
    }
  }, 1000);
}

/* focus preservation across full re-renders (used sparingly on live view) */
function captureFocus() {
  const active = document.activeElement;
  if (active && active.tagName === "TEXTAREA" && active.parentElement && active.parentElement.querySelector("label")) {
    return { isNotes: true, selStart: active.selectionStart, selEnd: active.selectionEnd };
  }
  return null;
}
function restoreFocus(info) {
  if (!info || !info.isNotes) return;
  const textarea = app.querySelector(".card textarea");
  if (textarea) {
    textarea.focus();
    try { textarea.setSelectionRange(info.selStart, info.selEnd); } catch (e) {}
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
  const exportBtn = el("button", { class: "btn" }, "⬇ Export Markdown");
  exportBtn.addEventListener("click", () => downloadMarkdown(m));
  const saveBtn = el("button", { class: "btn btn-primary" }, "✓ Save & New Meeting");
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
      if (confirm("Delete this saved meeting?")) {
        state.history.splice(idx, 1);
        save();
        renderHistory();
      }
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

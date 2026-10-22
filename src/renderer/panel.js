// Halo's chat window: Home · Ask Halo · What needs you · Notes. The character
// lives on the desktop (or in the island), so it isn't drawn here.

import { renderMarkdown } from "./markdown.js";
import { Recorder, toPcm16k } from "./recorder.js";
import { HUSH, isEcho, MIC_OFF, NOISE, WakeWord } from "./wakeword.js";
import { $, ago, api, h, ICON, isMac, mark, openUrl, QUICK, SERVICE, toolLabel, toolService } from "./ui/common.js";

ICON.notes = '<svg viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/></svg>';
for (const el of document.querySelectorAll("[data-icon]")) el.innerHTML = ICON[el.dataset.icon] ?? "";

let S = await api.invoke("settings:get");
const meta = (id) => S.characters.find((c) => c.id === id) ?? S.characters[0];
const name = () => meta(S.settings.character).name;
const modelName = (m) => ({ "": "Default", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" })[m ?? ""] ?? m;
function applySettings() {
  paintWakeButton();
  $("model-btn").textContent = `Claude · ${modelName(S.settings.model)} ▾`;
  $("input").placeholder = `Ask ${name()}…`;
  renderSession();
}
api.on("settings:changed", (p) => { S = p; applySettings(); });

// ── theme (day / night) ───────────────────────────────────────────────────────

const dark = () => matchMedia("(prefers-color-scheme: dark)").matches;
function paintThemeButton() {
  const b = $("btn-theme");
  b.querySelector(".ico").innerHTML = dark() ? ICON.sun : ICON.moon;
  b.title = dark() ? "Switch to day" : "Switch to night";
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paintThemeButton);
$("btn-theme").addEventListener("click", () => api.send("app:theme", dark() ? "light" : "dark"));
paintThemeButton();

// ── mood (what Halo is doing) ─────────────────────────────────────────────────

let mood = await api.invoke("panel:mood");
const MOOD = {
  idle: { c: "#6B7079", t: "Ready" }, thinking: { c: "#A78BFA", t: "Thinking" }, working: { c: "#3B9EFF", t: "Working" },
  talking: { c: "#818CF8", t: "Answering" }, listening: { c: "#A78BFA", t: "Taking notes" }, alert: { c: "#F5A524", t: "Needs you" },
  done: { c: "#34D399", t: "Done" }, error: { c: "#F4505E", t: "Something went wrong" }, sleeping: { c: "#3A3D44", t: "Napping" },
};
api.on("panel:mood", (s) => { mood = s; renderSession(); });

// ── tabs ──────────────────────────────────────────────────────────────────────

let view = "home";
function show(v) {
  if (v === "today") v = "board";
  if (v === "settings") return api.send("room:open", "general");
  view = v;
  document.querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === v)));
  document.querySelectorAll(".view").forEach((s) => s.classList.toggle("active", s.id === `view-${v}`));
  closePopovers();
  if (v === "home") renderHome();
  if (v === "board") loadBoard();
  if (v === "notes") loadNotes();
  if (v === "chat") setTimeout(() => $("input").focus(), 30);
}
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => show(b.dataset.tab)));
api.on("panel:tab", (t) => show(t || "chat"));

$("btn-close").addEventListener("click", () => api.send("panel:hide"));
$("btn-settings").addEventListener("click", () => api.send("room:open", { page: "general", fromPanel: true }));
$("btn-full").addEventListener("click", () => api.send("panel:fullscreen"));
$("head").addEventListener("dblclick", (e) => { if (!e.target.closest("button")) api.send("panel:fullscreen"); });
$("btn-stop").addEventListener("click", () => {
  // Stop hushes Halo if it's talking; only otherwise does it stop the answer.
  if ("speechSynthesis" in window && (speechSynthesis.speaking || speechSynthesis.pending)) hush();
  else if (busy) api.send("chat:stop");
});
$("see-board").addEventListener("click", () => show("board"));
$("see-chats").addEventListener("click", () => api.send("room:open", "history"));

function closePopovers() { $("chats-menu").hidden = true; $("model-menu").hidden = true; }
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if ("speechSynthesis" in window && speechSynthesis.speaking) hush();
  else if (!$("chats-menu").hidden || !$("model-menu").hidden) closePopovers();
  else api.send("panel:hide");
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".popover, #btn-chats, #model-btn")) closePopovers();
});

// ── Home ──────────────────────────────────────────────────────────────────────

let today = await api.invoke("today:get");
let lastPrompt = "";
let currentStep = "";
let prevStep = "";

// ── Your Claude Code sessions (terminal, the Claude app, VS Code) ─────────────

let ccSessions = await api.invoke("sessions:list");
let ccFocus = "";
api.on("sessions:changed", (list) => {
  ccSessions = list;
  if (view === "home") renderSession();
});
const CC_STATE = { working: "Working", waiting: "Needs you", done: "Finished" };
const CC_WASH = { working: "wash-indigo", waiting: "wash-amber", done: "wash-green" };

// Permission requests from those sessions (with "Approve my sessions from Halo" on).
let ccPerms = await api.invoke("sessions:permissions");
let ccPermFocus = "";
api.on("sessions:permissions", (list) => {
  const fresh = list.find((p) => !ccPerms.some((q) => q.id === p.id));
  ccPerms = list;
  if (fresh) {
    ccPermFocus = fresh.id;
    // Bring Home forward, unless you're in the middle of typing a message.
    if (view !== "home" && !$("input").value.trim()) show("home");
  }
  if (view === "home") renderSession();
});
const answerPermission = (id, choice) => api.send("sessions:answer", { id, choice });

/** The amber "needs permission" card, in place of the session card until it's answered. */
function renderPermission(card, body) {
  const r = ccPerms.find((p) => p.id === ccPermFocus) ?? ccPerms[0];
  ccPermFocus = r.id;
  const s = ccSessions.find((x) => x.id === r.sessionId);
  const app = s?.app ?? r.app;
  card.className = "card session wash-amber cc-perm";
  body.replaceChildren(h("div", { class: "txt" },
    h("div", { class: "who cc" },
      h("span", { class: "dot", style: { "--c": s?.color ?? "#E9B949" } }),
      h("b", {}, s?.project ?? r.project),
      h("span", { class: "cc-app" }, app),
      h("span", { class: "cc-state waiting" }, ccPerms.length > 1 ? `Needs permission · ${ccPerms.indexOf(r) + 1} of ${ccPerms.length}` : "Needs permission")),
    h("div", { class: "headline" }, r.title),
    r.text ? h("pre", { class: "cc-cmd" }, r.text) : null,
    r.note ? h("div", { class: "sub" }, r.note) : null,
    h("details", {}, h("summary", {}, "Details"), h("pre", {}, JSON.stringify(r.input, null, 2))),
    h("div", { class: "cc-actions" },
      h("button", { class: "pill link", title: `Hand this back to ${app} and answer it there`, onclick: () => answerPermission(r.id, "pass") }, "Reply in Claude Code"),
      h("span", { class: "grow" }),
      h("button", { class: "pill", onclick: () => answerPermission(r.id, "deny") }, "Deny ", h("kbd", {}, "N")),
      r.canAlways ? h("button", { class: "pill", title: r.alwaysHint || "Allow, and don't ask again", onclick: () => answerPermission(r.id, "always") }, "Always") : null,
      h("button", { class: "pill primary", onclick: () => answerPermission(r.id, "allow") }, "Allow ", h("kbd", {}, "Y"))),
    ccPerms.length > 1
      ? h("div", { class: "cc-pills" }, ...ccPerms.map((p) => {
          const ps = ccSessions.find((x) => x.id === p.sessionId);
          return h("button", { class: `cc-pill${p.id === r.id ? " on" : ""}`, title: p.title, onclick: () => { ccPermFocus = p.id; renderSession(); } },
            h("span", { class: "dot", style: { "--c": ps?.color ?? "#E9B949" } }), ps?.project ?? p.project, h("span", { class: "bang" }, "!"));
        }))
      : null));
}

function renderClaudeSessions(card, body) {
  const s = ccSessions.find((x) => x.id === ccFocus) ?? ccSessions[0];
  card.className = `card session ${CC_WASH[s.status] ?? "wash-violet"}`;
  const prev = s.steps.length > 1 ? s.steps[s.steps.length - 2].label : "";
  body.replaceChildren(
    h("div", { class: "txt" },
      h("div", { class: "who cc" },
        h("span", { class: "dot", style: { "--c": s.color } }),
        h("b", {}, s.project),
        h("span", { class: "cc-app" }, s.app),
        h("span", { class: `cc-state ${s.status}` }, CC_STATE[s.status])),
      h("div", { class: "headline clamp" }, s.prompt || s.title || "Claude Code"),
      h("div", { class: "ticker" },
        prev && s.status !== "done" ? h("div", { class: "prev" }, prev) : null,
        h("div", { class: `now${s.status === "working" ? " shimmer" : ""}` }, s.status === "done" ? s.final : s.doing)),
      ccSessions.length > 1
        ? h("div", { class: "cc-pills" }, ...ccSessions.slice(0, 6).map((x) => h("button", {
            class: `cc-pill${x.id === s.id ? " on" : ""}`,
            title: `${x.project} · ${CC_STATE[x.status]}`,
            onclick: () => { ccFocus = x.id; renderSession(); },
          }, h("span", { class: "dot", style: { "--c": x.color } }), x.project, x.status === "waiting" ? h("span", { class: "bang" }, "!") : null)))
        : null),
    h("button", { class: "hicon jump", title: `Open in ${s.app}`, "aria-label": `Open in ${s.app}`, onclick: () => api.invoke("sessions:open", s.id) }, h("span", { class: "ico", html: ICON.jump })),
  );
}

function renderSession() {
  const m = MOOD[mood] ?? MOOD.idle;
  const card = $("session");
  card.className = `card session ${mood === "alert" ? "wash-amber" : mood === "error" ? "wash-red" : mood === "done" ? "wash-green" : ["thinking", "working", "talking"].includes(mood) ? "wash-indigo" : mood === "listening" ? "wash-red" : "wash-violet"}`;
  const busy = ["thinking", "working", "talking"].includes(mood);
  const body = $("session-body");
  if (ccPerms.length) {
    renderPermission(card, body);
  } else if (busy) {
    body.replaceChildren(h("div", { class: "txt" },
      h("div", { class: "who" }, h("span", { class: "dot", style: { "--c": m.c } }), `${name()} · ${m.t}`),
      h("div", { class: "headline" }, lastPrompt || "Working on it"),
      h("div", { class: "ticker" }, prevStep ? h("div", { class: "prev" }, prevStep) : null, h("div", { class: "now shimmer" }, currentStep || "Thinking…"))),
      h("button", { class: "pill", onclick: () => show("chat") }, "Open chat"));
  } else if (mood === "listening") {
    body.replaceChildren(h("div", { class: "txt" },
      h("div", { class: "who" }, h("span", { class: "dot", style: { "--c": "#F4505E" } }), "Taking notes"),
      h("div", { class: "headline" }, "Listening to your meeting."),
      h("div", { class: "sub" }, "Stop when it's over and I'll write the notes.")),
      h("button", { class: "pill", onclick: () => show("notes") }, "Open notes"));
  } else if (ccSessions.length) {
    renderClaudeSessions(card, body);
  } else {
    const n = needs().length;
    body.replaceChildren(h("div", { class: "txt" },
      h("div", { class: "who" }, h("span", { class: "dot", style: { "--c": m.c } }), `${name()} · ${m.t}`),
      h("div", { class: "headline" }, n ? `${n} thing${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} you.` : "Nothing running right now."),
      h("div", { class: "sub" }, "Ask me anything, drop me on a window to show it to me, or press ", h("kbd", {}, isMac ? "⌘⇧D" : "Ctrl+Shift+D"), " and say it.")),
      h("button", { class: "pill primary", onclick: () => show("chat") }, `Ask ${name()}`));
  }
}

const APPS = [
  { id: "ninety", label: "Ninety", count: (t) => (t.connectors?.rocks ?? []).filter((r) => r.status === "OFF_TRACK").length, ask: QUICK.rocks },
  { id: "jira", label: "Jira", count: (t) => t.jira?.issues?.length ?? 0, ask: QUICK.jira },
  { id: "github", label: "GitHub", count: (t) => (t.github?.reviewRequests?.length ?? 0) + (t.github?.myPrs ?? []).filter((p) => p.checks === "FAILURE").length, ask: QUICK.prs },
  { id: "slack", label: "Slack", count: (t) => t.connectors?.slack?.length ?? 0, ask: QUICK.slack },
  { id: "gmail", label: "Gmail", count: () => 0, ask: "Which emails from the last day still need a reply from me? One line each, most urgent first." },
  { id: "calendar", label: "Calendar", count: () => 0, ask: "What's left on my calendar today? Only meetings that haven't ended yet, with times in my time zone." },
];

function renderPills() {
  $("pills").replaceChildren(...APPS.map((a) => {
    const n = a.count(today);
    return h("button", { class: "app-pill", style: { "--c": SERVICE[a.id].color }, title: `Ask about ${a.label}`, onclick: () => ask(a.ask) },
      h("span", { class: "app-ico" }, mark(a.id, 20)), a.label, h("span", { class: `n${n ? "" : " zero"}` }, String(n)));
  }));
}

function needs() {
  const t = today;
  if (!t) return [];
  const dismissed = new Set(t.dismissed ?? []);
  const g = t.github ?? {}, c = t.connectors ?? {};
  const jiraItems = (t.jira?.issues ?? []).filter((i) => isHighPriority(i.priority)).map((i) => ({ id: `jira:${i.key}`, kind: "jira", priority: i.priority, status: i.status, urg: "normal", title: `${i.key} · ${i.title}`, src: [i.status, i.priority].filter(Boolean).join(" · "), svc: "jira", url: i.url, act: "Ask", ask: `Summarize Jira issue ${i.key}: status, latest comments, and what I should do next.` }));
  return [
    ...jiraItems,
    ...t.alerts.filter((a) => !a.read && Date.now() - a.at < 24 * 3600_000).map((a) => ({ id: `alert:${a.id}`, kind: "alert", urg: a.tone === "bad" ? "high" : a.tone === "good" ? "low" : "normal", title: a.title, src: a.body, svc: a.source, url: a.url, act: a.source === "slack" || a.source === "gmail" ? "Draft a reply" : "Ask", ask: `${a.title}: ${a.body}${a.url ? ` (${a.url})` : ""}. ${a.source === "slack" || a.source === "gmail" ? "Draft a reply for me and show it to me first." : "Tell me what this is and what I should do."}` })),
    ...(g.myPrs ?? []).filter((p) => p.checks === "FAILURE" || p.checks === "ERROR").map((p) => ({ id: `ci:${p.id}:${p.sha}`, kind: "ci", urg: "high", title: `Checks failing · ${p.title}`, src: `${p.repo}#${p.number}`, svc: "github", url: p.url, act: "Fix it", ask: `Why are the checks failing on ${p.url}? Show the failing step and a likely fix.` })),
    ...(c.rocks ?? []).filter((r) => r.status === "ON_TRACK" && daysUntil(r.dueDate) <= 21).map((r) => ({ id: `rockdue:${r.id}`, kind: "rock", status: r.status, due: r.dueDate, urg: "normal", title: `Rock due soon · ${r.title}`, src: `Ninety · due ${r.dueDate}`, svc: "ninety", url: r.url, act: "Plan it", ask: `My Rock "${r.title}" is due ${r.dueDate}. What's left, and what should I do this week to land it?` })),
    ...(c.rocks ?? []).filter((r) => r.status === "OFF_TRACK").map((r) => ({ id: `rock:${r.id}`, kind: "rock", status: r.status, due: r.dueDate, urg: "high", title: `Rock off track · ${r.title}`, src: r.dueDate ? `Ninety · due ${r.dueDate}` : "Ninety", svc: "ninety", url: r.url, act: "Plan it", ask: `My Rock "${r.title}" is off track. What's left and what should I do this week?` })),
    ...(g.reviewRequests ?? []).map((p) => ({ id: `review:${p.id}`, kind: "review", updatedAt: p.updatedAt, urg: "normal", title: `Review · ${p.title}`, src: `${p.repo}#${p.number} · ${p.author ?? ""}`, svc: "github", url: p.url, act: "Review", ask: `Review ${p.url}: summarize the change, risks, and anything I should comment on.` })),
    ...(c.slack ?? []).map((m) => ({ id: `slack:${m.id}`, kind: "slack", dm: /^(dm|direct)/i.test(m.channel || ""), urg: "normal", title: m.text, src: `${m.from}${m.channel ? ` · ${m.channel}` : ""}`, svc: "slack", url: m.url, act: "Draft a reply", ask: `Draft a reply to this Slack message from ${m.from}: "${m.text}". Show it to me first.` })),
  ].filter((n) => !dismissed.has(n.id));
}

// ── four quadrants (urgent × important) ───────────────────────────────────────

const HOUR = 3600_000;
const daysUntil = (d) => (d ? (Date.parse(d) - Date.now()) / (24 * HOUR) : Infinity);
const isHighPriority = (p = "") => /highest|high|critical|blocker|urgent|p0|p1/i.test(p) && !/p2|p3|p4|low|normal|medium/i.test(p);

/** Puts each item in one of the four boxes. Kept simple and explainable. */
function quadrant(n) {
  let urgent = false;
  let important = false;
  switch (n.kind) {
    case "ci": urgent = true; important = true; break; // your PR is blocked
    case "rock": important = true; urgent = n.status === "OFF_TRACK" || daysUntil(n.due) <= 14; break;
    case "review": important = true; urgent = Date.now() - Date.parse(n.updatedAt || 0) > 24 * HOUR; break;
    case "slack": urgent = true; important = n.dm; break; // DMs are asks; channel pings are FYI
    case "jira": important = isHighPriority(n.priority); urgent = isHighPriority(n.priority) && /progress|review|blocked/i.test(n.status || ""); break;
    case "alert": urgent = true; important = n.urg === "high"; break;
    default: urgent = n.urg === "high"; important = n.urg !== "low";
  }
  return urgent && important ? "do" : important ? "schedule" : urgent ? "delegate" : "later";
}

const QUADS = [
  { id: "do", title: "Do now", hint: "Urgent and important", tone: "red" },
  { id: "schedule", title: "Schedule", hint: "Important, not urgent", tone: "indigo" },
  { id: "delegate", title: "Delegate or reply quickly", hint: "Urgent, not important", tone: "amber" },
  { id: "later", title: "Later", hint: "Neither: batch or drop", tone: "soft" },
];

/** One "needs you" row: what it is, then [logo] App · detail, an action pill and Done. */
function needRow(n, { done = true } = {}) {
  const appName = SERVICE[n.svc]?.name ?? "";
  return h("div", { class: "row need", tabindex: "0", onclick: () => openUrl(n.url), onkeydown: (e) => e.key === "Enter" && openUrl(n.url) },
    h("span", { class: `urg ${n.urg}` }),
    h("div", { class: "main" },
      h("div", { class: "title" }, n.title),
      h("div", { class: "src" }, mark(n.svc, 14), h("span", { class: "app" }, appName), n.src && n.src !== appName ? h("span", { class: "det" }, n.src) : null)),
    h("div", { class: "acts" },
      n.ask ? h("button", { class: "act-btn", onclick: (e) => { e.stopPropagation(); ask(n.ask); } }, n.act || "Ask") : null,
      done ? h("button", { class: "done-btn", onclick: (e) => { e.stopPropagation(); api.send("today:dismiss", n.id); } }, "Done") : null),
  );
}

async function renderHome() {
  renderSession();
  renderPills();
  const order = { do: 0, schedule: 1, delegate: 2, later: 3 };
  const list = needs().sort((a, b) => order[quadrant(a)] - order[quadrant(b)]);
  $("home-board").replaceChildren(...(list.length ? list.slice(0, 4).map((n) => needRow(n)) : [h("div", { class: "empty" }, today?.loading?.local ? "Checking GitHub and Jira…" : "Nothing needs you right now.")]));
  const recent = (await api.invoke("chat:recent")).slice(0, 4);
  $("home-recent").replaceChildren(...(recent.length
    ? recent.map((c) => h("div", { class: "row", onclick: () => resumeChat(c) }, h("div", { class: "main" }, h("div", { class: "title" }, c.title)), h("span", { class: "when" }, ago(c.updatedAt))))
    : [h("div", { class: "empty" }, "Your chats show up here.")]));
  const badge = $("board-badge");
  badge.hidden = !list.length;
  badge.textContent = String(list.length);
}

api.on("today:data", (d) => {
  today = d;
  if (view === "home") renderHome();
  else {
    const n = needs().length;
    $("board-badge").hidden = !n;
    $("board-badge").textContent = String(n);
  }
  if (view === "board") renderBoard();
});

// ── chat ──────────────────────────────────────────────────────────────────────

const messages = $("messages");
const input = $("input");
const sendBtn = $("btn-send");
let current = null;
let busy = false;
let pendingImages = [];

function scrollDown(force = false) {
  const near = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 160;
  if (force || near) messages.scrollTop = messages.scrollHeight;
}

function setBusy(b) {
  busy = b;
  sendBtn.querySelector(".ico").innerHTML = b ? ICON.stop : ICON.up;
  sendBtn.title = b ? "Stop" : "Send";
  $("btn-stop").hidden = !b;
  if (!b) { currentStep = ""; prevStep = ""; }
}

function addUser(text, images) {
  $("chat-empty").hidden = true;
  messages.append(h("div", { class: "msg user" }, ...images.map((im) => h("img", { src: `data:${im.mediaType};base64,${im.data}`, alt: im.label ? `Picture of ${im.label}` : "Screenshot" })), text));
  scrollDown(true);
}

function startAssistant() {
  current = { el: h("div", { class: "msg assistant" }), textEl: null, buf: "", tools: new Map(), raf: 0 };
  current.waiting = h("div", { class: "steps" }, h("span", { class: "hop" }, h("i"), h("i"), h("i")));
  current.el.append(current.waiting);
  messages.append(current.el);
  scrollDown(true);
}
function clearWaiting() { current?.waiting?.remove(); if (current) current.waiting = null; }

function newTextSegment() {
  if (!current) startAssistant();
  if (current.textEl && !current.buf.trim()) return;
  current.textEl = h("div", { class: "text" });
  current.buf = "";
  current.el.append(current.textEl);
}
function renderCurrent() {
  if (!current?.textEl) return;
  current.raf = 0;
  current.textEl.innerHTML = renderMarkdown(current.buf);
  scrollDown();
}

function addTool(id, nm, toolInput) {
  if (!current) startAssistant();
  clearWaiting();
  if (current.tools.has(id)) return;
  if (current.textEl && !current.buf.trim()) current.textEl.remove();
  current.textEl = null;
  let box = current.el.lastElementChild?.classList.contains("steps") ? current.el.lastElementChild : null;
  if (!box) { box = h("div", { class: "steps" }); current.el.append(box); }
  const label = toolLabel(nm, toolInput);
  const chip = h("div", { class: "step running" }, mark(toolService(nm, toolInput), 16), h("span", { class: "label" }, label));
  box.append(chip);
  current.tools.set(id, { chip, name: nm, input: toolInput });
  prevStep = currentStep;
  currentStep = label;
  if (view === "home") renderSession();
  scrollDown();
}
function finishTool(id, ok) {
  const t = current?.tools.get(id);
  if (!t) return;
  t.chip.classList.remove("running");
  t.chip.classList.add(ok ? "done" : "failed");
}
function finishAssistant(note) {
  if (!current) return;
  clearWaiting();
  if (current.raf) cancelAnimationFrame(current.raf);
  renderCurrent();
  current.el.querySelectorAll(".step.running").forEach((n) => { n.classList.remove("running"); n.classList.add("done"); });
  if (current.textEl && !current.buf.trim() && current.el.children.length > 1) current.textEl.remove();
  if (note) current.el.append(h("div", { class: "meta" }, note));
  current = null;
}

api.on("chat:event", (ev) => {
  const d = ev.data;
  switch (ev.type) {
    case "textBlock":
      if (current && current.textEl === null) newTextSegment();
      break;
    case "text":
      if (!current) startAssistant();
      clearWaiting();
      if (!current.textEl) newTextSegment();
      current.buf += d;
      if (!current.raf) current.raf = requestAnimationFrame(renderCurrent);
      break;
    case "toolStart":
      addTool(d.id, d.name);
      break;
    case "toolUse": {
      addTool(d.id, d.name, d.input);
      const t = current?.tools.get(d.id);
      if (t) {
        t.input = d.input;
        t.chip.querySelector(".label").textContent = toolLabel(d.name, d.input);
        t.chip.replaceChild(mark(toolService(d.name, d.input), 16), t.chip.firstChild);
        if (d.name === "Bash" && d.input?.command) t.chip.title = d.input.command;
      }
      break;
    }
    case "toolResult":
      finishTool(d.id, !d.isError);
      break;
    case "result": {
      const secs = Math.max(1, Math.round((d.durationMs || 0) / 1000));
      if (current && !current.buf.trim() && d.text && !current.el.querySelector(".text")) { newTextSegment(); current.buf = d.text; }
      if (!d.ok && d.text) current?.el.append(h("div", { class: "err" }, d.text));
      const spoken = current?.buf || d.text || "";
      finishAssistant(d.ok ? `${secs}s` : "");
      setBusy(false);
      if (voiceRequest) {
        // A spoken question: answer out loud, then wait for the reply.
        if (!d.ok) endConversation();
        else if (!speak(spoken)) listenForReply();
      }
      voiceRequest = false;
      if (queuedVoice) { const next = queuedVoice; queuedVoice = ""; setTimeout(() => askByVoice(next), 300); }
      break;
    }
    case "error":
      if (!current) startAssistant();
      current.el.append(h("div", { class: "err" }, d.message));
      finishAssistant();
      setBusy(false);
      break;
    case "stopped":
      finishAssistant("Stopped");
      setBusy(false);
      break;
    case "cleared":
      current = null;
      messages.querySelectorAll(".msg, .meta").forEach((n) => n.remove());
      $("chat-empty").hidden = false;
      $("approvals").replaceChildren();
      $("thread-title").textContent = "";
      setBusy(false);
      break;
    case "rateLimit":
      showUsage(d);
      break;
  }
});

// ── things Halo does itself, without asking Claude ─────────────────────────────
// Typed in the chat or said out loud: "stop following me", "follow me again".

const ASKING = String.raw`^\W*(?:(?:ok(?:ay)?|hey|please|can you|could you|would you|will you)\W+)*`;
const FOLLOW_OFF = new RegExp(`${ASKING}(?:(?:stop|quit|don'?t keep|do not keep|no more)\\W+(?:following|chasing|walking after)(?:\\W+(?:me|my\\W+(?:cursor|pointer|mouse)|the\\W+(?:cursor|pointer|mouse)))?(?:\\W+around)?|stay(?:\\W+(?:put|there|here|still))?)\\W*(?:please)?\\W*$`, "i");
const FOLLOW_ON = new RegExp(`${ASKING}(?:start\\W+)?(?:follow(?:ing)?|come\\W+with)\\W+(?:me|my\\W+(?:cursor|pointer|mouse)|the\\W+(?:cursor|pointer|mouse))(?:\\W+(?:again|around))?\\W*(?:please)?\\W*$`, "i");

function appCommand(text) {
  if (FOLLOW_OFF.test(text)) return { patch: { followPointer: false }, reply: "Okay, I'll stay put. Say “follow me” when you want me to walk with you again." };
  if (FOLLOW_ON.test(text)) return { patch: { followPointer: true }, reply: "On my way! I'll follow your pointer, and hold still while this chat is open." };
  return null;
}

async function runAppCommand(text, cmd, voice) {
  if (!messages.querySelector(".msg")) $("thread-title").textContent = text.slice(0, 60);
  addUser(text, []);
  input.value = "";
  autosize();
  S = await api.invoke("settings:set", cmd.patch);
  messages.append(h("div", { class: "msg assistant" }, h("div", { class: "text" }, cmd.reply), h("div", { class: "meta" }, "Done")));
  scrollDown(true);
  // A quick command, not a conversation: say it and stop listening.
  voiceRequest = false;
  conversing = false;
  if (voice) speak(cmd.reply);
}

function send(text, { images, voice = false } = {}) {
  text = (text ?? input.value).trim();
  const imgs = images ?? pendingImages;
  if (!text && !imgs.length) return;
  if (busy) return;
  const cmd = !imgs.length && appCommand(text);
  if (cmd) return void runAppCommand(text, cmd, voice);
  if (!text && imgs.length === 1 && imgs[0].label) text = `This is a picture of the “${imgs[0].label}” window on my screen. Tell me what's happening in it and what matters, in a few lines.`;
  if (!messages.querySelector(".msg")) $("thread-title").textContent = text.replace(/\s+/g, " ").slice(0, 60);
  lastPrompt = text.replace(/\s+/g, " ").slice(0, 90);
  addUser(text, imgs);
  api.send("chat:send", { text, voice, images: imgs.map(({ mediaType, data }) => ({ mediaType, data })) });
  input.value = "";
  autosize();
  pendingImages = [];
  renderAttachments();
  setBusy(true);
  startAssistant();
}
function ask(prompt) { show("chat"); send(prompt, { images: [] }); }

function resumeChat(c) {
  api.send("chat:resume", c.id);
  showResumed(c);
}
function showResumed(c) {
  messages.querySelectorAll(".msg, .meta").forEach((n) => n.remove());
  $("chat-empty").hidden = true;
  $("thread-title").textContent = c.title;
  messages.append(h("div", { class: "meta" }, `Continuing “${c.title}”. Earlier messages are in History; I remember them.`));
  show("chat");
}
api.on("chat:resumeUi", showResumed);

$("composer").addEventListener("submit", (e) => { e.preventDefault(); voiceRequest = false; endConversation(); busy ? api.send("chat:stop") : send(); });
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!busy) send(); }
});
function autosize() { input.style.height = "auto"; input.style.height = `${Math.min(180, input.scrollHeight)}px`; }
input.addEventListener("input", autosize);

function runQuick(key) {
  if (key === "screen") return api.send("capture:screen");
  if (QUICK[key]) ask(QUICK[key]);
}
document.querySelectorAll("[data-quick]").forEach((b) => b.addEventListener("click", () => runQuick(b.dataset.quick)));
api.on("chat:quick", runQuick);
api.on("chat:prompt", (t) => ask(t));
$("btn-new").addEventListener("click", () => { api.send("chat:new"); show("chat"); });
$("btn-screen").addEventListener("click", () => api.send("capture:screen"));
$("btn-snip").addEventListener("click", () => api.send("capture:snip"));

// Chats list (the icon left of the model switcher).
$("btn-chats").addEventListener("click", async () => {
  const box = $("chats-menu");
  if (!box.hidden) return (box.hidden = true);
  $("model-menu").hidden = true;
  const list = await api.invoke("chat:recent");
  box.replaceChildren(
    h("div", { class: "hdr" }, "Chats"),
    h("button", { class: "opt", onclick: () => { box.hidden = true; api.send("chat:new"); } }, h("span", { class: "t" }, "+ New chat")),
    ...list.slice(0, 12).map((c) => h("button", { class: "opt", onclick: () => { box.hidden = true; resumeChat(c); } }, h("span", { class: "t" }, c.title), h("small", {}, ago(c.updatedAt)))),
    h("button", { class: "opt", onclick: () => { box.hidden = true; api.send("room:open", "history"); } }, h("span", { class: "t" }, "All chats in History…")),
  );
  box.hidden = false;
});

// Model and effort menu (two columns).
$("model-btn").addEventListener("click", () => {
  const menu = $("model-menu");
  if (!menu.hidden) return (menu.hidden = true);
  $("chats-menu").hidden = true;
  const opt = (label, on, fn) => h("button", { class: "opt", onclick: fn }, h("span", { class: "t" }, label), on ? h("span", { class: "ck" }, "✓") : null);
  const setM = async (patch) => { S = await api.invoke("settings:set", patch); applySettings(); menu.hidden = true; };
  menu.replaceChildren(
    h("div", { class: "col" }, h("div", { class: "hdr" }, "Claude Code"), ...[["", "Default"], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"]].map(([v, l]) => opt(l, (S.settings.model ?? "") === v, () => setM({ model: v })))),
    h("div", { class: "col" }, h("div", { class: "hdr" }, "Effort"), ...[["", "Default"], ["low", "Low"], ["medium", "Medium"], ["high", "High"]].map(([v, l]) => opt(l, (S.settings.effort ?? "") === v, () => setM({ effort: v })))),
  );
  menu.hidden = false;
});

function renderAttachments() {
  const box = $("attachments");
  box.replaceChildren(...pendingImages.map((im, i) =>
    h("span", { class: "attach-chip", title: im.label ? `Picture of ${im.label}` : "Screenshot" },
      h("img", { src: `data:${im.mediaType};base64,${im.data}`, alt: "" }), h("span", { class: "nm" }, im.label || "Screenshot"),
      h("button", { type: "button", "aria-label": "Remove", onclick: () => { pendingImages.splice(i, 1); renderAttachments(); } }, "✕"))));
  box.hidden = !pendingImages.length;
  $("shot-chips").hidden = !pendingImages.length;
}
api.on("chat:attach", (img) => {
  show("chat");
  if (img.autoSend && !busy) return send("", { images: [img] });
  pendingImages.push(img);
  renderAttachments();
  input.focus();
});
document.querySelectorAll("[data-shot]").forEach((b) => b.addEventListener("click", () => send(b.dataset.shot)));

function showNotice(n, { open = true } = {}) {
  const box = $("notice");
  box.replaceChildren(h("span", { class: "grow" }, n.text));
  const settings = { permission: "settings:openScreenSettings", mic: "settings:openMicSettings" }[n.kind];
  if (settings) box.append(h("button", { class: "pill", onclick: () => api.send(settings) }, "Open Settings"));
  box.append(h("button", { class: "hicon sm", "aria-label": "Dismiss", onclick: () => (box.hidden = true), html: ICON.close }));
  box.hidden = false;
  if (open) show("chat");
}
api.on("chat:notice", (n) => showNotice(n));

/** The microphone is blocked: say so and how to fix it, instead of failing quietly. */
async function micDenied({ open = true } = {}) {
  showNotice({ text: await api.invoke("notes:micHelp"), kind: "mic" }, { open });
  api.send("notes:micDenied");
}
const blocked = (e) => ["NotAllowedError", "SecurityError"].includes(e?.name);

function showUsage(info) {
  if (!info) return;
  const box = $("usage");
  const pct = typeof info.utilization === "number" ? Math.round(info.utilization <= 1 ? info.utilization * 100 : info.utilization) : null;
  if (pct == null && info.status === "allowed") return;
  const color = pct == null ? "#F4505E" : pct >= 90 ? "#F4505E" : pct >= 70 ? "#F5A524" : "#34D399";
  box.replaceChildren(h("span", {}, pct == null ? "Limited" : `${pct}%`), h("span", { class: "bar" }, h("span", { style: { width: `${pct ?? 100}%`, background: color } })));
  box.title = info.resetsAt ? `Claude plan · resets ${new Date(info.resetsAt * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : "Claude plan usage";
  box.hidden = false;
}

// ── approvals (amber card, Y / N keys) ────────────────────────────────────────

const approvalCards = new Map();
function addApproval(r) {
  if (approvalCards.has(r.id)) return;
  const card = h("div", { class: "card approval", role: "group", "aria-label": `Needs your OK: ${r.title}` },
    h("div", { class: "who" }, mark(r.service, 18), h("b", {}, name()), "needs your OK", h("span", { class: "grow" }), approvalCards.size ? `${approvalCards.size + 1}` : ""),
    h("div", { class: "title" }, r.title),
    r.note ? h("div", { class: "note" }, r.note) : null,
    r.text ? h("pre", {}, r.text) : null,
    h("details", {}, h("summary", {}, "Details"), h("pre", {}, JSON.stringify(r.input, null, 2))),
    h("div", { class: "actions" },
      h("button", { class: "pill", onclick: () => api.send("approval:answer", { id: r.id, allow: false }) }, "Deny ", h("kbd", {}, "N")),
      r.canRemember ? h("button", { class: "pill", title: "Allow this kind of action for the rest of this chat", onclick: () => api.send("approval:answer", { id: r.id, allow: true, remember: true }) }, "Always") : null,
      h("button", { class: "pill primary", onclick: () => api.send("approval:answer", { id: r.id, allow: true }) }, "Allow ", h("kbd", {}, "Y"))));
  approvalCards.set(r.id, { card, r });
  $("approvals").append(card);
  show("chat");
}
api.on("approval:request", addApproval);
api.on("approval:resolved", ({ id, decision }) => {
  const a = approvalCards.get(id);
  if (!a) return;
  a.card.remove();
  approvalCards.delete(id);
  if (current) current.el.append(h("div", { class: "meta" }, `${decision === "allow" ? "Allowed" : "Denied"}: ${a.r.title}`));
});
document.addEventListener("keydown", (e) => {
  if (!approvalCards.size || ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  const first = approvalCards.values().next().value;
  if (e.key === "y" || e.key === "Y") api.send("approval:answer", { id: first.r.id, allow: true });
  if (e.key === "n" || e.key === "N") api.send("approval:answer", { id: first.r.id, allow: false });
});
// Y / N also answer a Claude Code session's request on Home (when Halo itself isn't asking).
document.addEventListener("keydown", (e) => {
  if (!ccPerms.length || approvalCards.size || view !== "home" || e.metaKey || e.ctrlKey || e.altKey || ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
  const r = ccPerms.find((p) => p.id === ccPermFocus) ?? ccPerms[0];
  if (e.key === "y" || e.key === "Y") answerPermission(r.id, "allow");
  if (e.key === "n" || e.key === "N") answerPermission(r.id, "deny");
});
for (const r of await api.invoke("approval:list")) addApproval(r);

// ── voice: the mic in the chat box, and spoken conversations ─────────────────
//
// Asking out loud (the mic, ⌘⇧D or "Hey Halo") starts a conversation: Halo
// reads its answer aloud, then listens for your reply without the wake word,
// until you go quiet, say "that's all", press Esc or start typing.

let dict = null;
const micBtn = $("btn-mic");
const REPLY_WAIT_MS = 8000; // how long Halo waits for you to answer before the conversation ends
let conversing = false;

/** `reply`: Halo is waiting for your answer (no speech in REPLY_WAIT_MS ends the conversation). */
async function startDictation({ reply = false } = {}) {
  if (dict || micBtn.classList.contains("busy")) return;
  show("chat");
  if (!(await api.invoke("notes:micAccess"))) {
    input.placeholder = "Microphone access is off.";
    endConversation();
    micDenied();
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    input.placeholder = `Couldn't use the microphone: ${e.message}`;
    endConversation();
    if (blocked(e)) micDenied();
    return;
  }
  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.start(250);
  const d = { stream, rec, chunks, reply, typed: input.value.trim() };
  d.vad = watchSilence(stream, { waitMs: reply ? REPLY_WAIT_MS : 15_000, onDone: (heard) => dict === d && stopDictation({ heard }) });
  dict = d;
  wake?.pause(true);
  micBtn.classList.add("listening");
  input.placeholder = reply ? "Listening… answer, or say “that's all”" : d.typed ? "Listening… click the mic when you're done" : "Listening… I'll send it when you stop talking";
  if (reply) api.send("wake:listening", true);
}

/** Calls onDone(true) a moment after you stop talking, or onDone(false) if you never start. */
function watchSilence(stream, { waitMs, onDone }) {
  const ctx = new AudioContext();
  const an = ctx.createAnalyser();
  an.fftSize = 2048;
  ctx.createMediaStreamSource(stream).connect(an);
  const buf = new Float32Array(an.fftSize);
  const t0 = Date.now();
  let floor = 0.006, heard = false, lastLoud = 0, done = false;
  const timer = setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length);
    const now = Date.now();
    if (rms > Math.max(0.015, floor * 3.2)) {
      if (now - t0 > 150) heard = true;
      lastLoud = now;
    } else if (!heard) floor = floor * 0.9 + rms * 0.1;
    if (heard && now - lastLoud > 1300) finish(true);
    else if (!heard && now - t0 > waitMs) finish(false);
    else if (now - t0 > 45_000) finish(true);
  }, 100);
  const stop = () => { done = true; clearInterval(timer); ctx.close().catch(() => {}); };
  function finish(h) { if (done) return; stop(); onDone(h); }
  return { stop };
}

async function stopDictation({ heard = true } = {}) {
  const d = dict;
  if (!d) return;
  dict = null;
  d.vad.stop();
  micBtn.classList.remove("listening");
  if (d.reply) api.send("wake:listening", false);
  const stopped = new Promise((r) => (d.rec.onstop = r));
  d.rec.stop();
  await stopped;
  d.stream.getTracks().forEach((t) => t.stop());
  wake?.pause(false);
  if (!heard) {
    // Nobody answered: the conversation is over.
    input.placeholder = `Ask ${name()}…`;
    endConversation();
    return;
  }
  micBtn.classList.add("busy");
  input.placeholder = "Writing down what you said…";
  let text = "";
  try {
    const blob = new Blob(d.chunks, { type: "audio/webm" });
    const engine = await api.invoke("notes:engine");
    const seg = engine.engine === "local" ? { pcm: await toPcm16k(blob) } : { audio: await blob.arrayBuffer(), mime: "audio/webm" };
    const res = await api.invoke("chat:transcribe", seg);
    if (!res.ok) throw new Error(res.error);
    text = res.text.replace(/^\s*\[(blank_audio|silence)\]\s*$/i, "").trim();
  } catch (e) {
    input.placeholder = `Couldn't transcribe: ${e.message}`;
  } finally {
    micBtn.classList.remove("busy");
    setTimeout(() => { if (!dict) input.placeholder = `Ask ${name()}…`; }, 2500);
  }
  if (d.typed) {
    // Dictating into a message you're already writing: add to it, don't send.
    if (text) { input.value = `${input.value.trim()} ${text}`; autosize(); }
    input.focus();
    return;
  }
  const said = lastSaid?.text ?? "";
  if (!text || NOISE.test(text) || (said && isEcho(text, said))) {
    if (!d.reply) input.placeholder = "I didn't catch that. Try again?";
    endConversation();
    return;
  }
  if (MIC_OFF.test(text)) {
    stopListening();
    return;
  }
  if (HUSH.test(text)) {
    hush();
    return;
  }
  askByVoice(text);
}
micBtn.addEventListener("click", () => (dict ? stopDictation() : startDictation()));
api.on("chat:dictate", () => (dict ? stopDictation() : startDictation()));

/** After Halo answers a spoken question: listen for the reply, no wake word needed. */
function listenForReply() {
  if (!conversing || busy || dict) return;
  startDictation({ reply: true });
}

function endConversation() {
  if (!conversing && !dict?.reply) return;
  conversing = false;
  if (dict?.reply) stopDictation({ heard: false });
  api.send("wake:listening", false);
}
// Typing takes over from talking.
input.addEventListener("input", () => { if (conversing || dict?.reply) endConversation(); });

// ── "Hey Halo": wake word + spoken replies ────────────────────────────────────

let wake = null;
let voiceRequest = false;
let queuedVoice = "";

function askByVoice(text) {
  conversing = true;
  voiceRequest = true;
  show("chat");
  send(text, { images: [], voice: true });
}
function hush() {
  endConversation();
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  if (lastSaid && lastSaid.until === Infinity) lastSaid.until = Date.now() + ECHO_TAIL_MS;
  $("btn-stop").hidden = !busy;
}
const ECHO_TAIL_MS = 700;
let lastSaid = null; // { text, from, until } — what Halo said out loud last

/** A rising chime when Halo starts listening; `down` falls, for "I've stopped listening". */
function chime(down = false) {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(down ? 1320 : 880, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(down ? 660 : 1320, ctx.currentTime + 0.12);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.27);
    setTimeout(() => ctx.close(), 400);
  } catch {}
}

/**
 * "Hey Halo, stop listening": the wake word goes off and stays off (it's saved)
 * until you turn it back on with the mic button up top, the menu or Settings.
 */
async function stopListening() {
  hush();
  await wake?.stop();
  wake = null;
  S.settings.wakeWord = { ...S.settings.wakeWord, enabled: false };
  paintWakeButton();
  api.send("wake:set", { on: false, byVoice: true });
  chime(true);
  if (S.settings.wakeWord?.speakReplies && "speechSynthesis" in window) {
    const u = new SpeechSynthesisUtterance("Okay, I've stopped listening. Turn me back on in the app when you want me.");
    u.rate = 1.05;
    speaking = u; // keep a hold on it, or Chromium may cut it short
    setTimeout(() => speechSynthesis.speak(u), 300);
  }
}

/** The mic button in the header: is Halo answering to "Hey Halo"? Click to switch. */
function paintWakeButton() {
  const b = $("btn-wake");
  if (!b) return;
  const on = !!S.settings.wakeWord?.enabled;
  b.classList.toggle("off", !on);
  b.setAttribute("aria-pressed", String(on));
  const n = meta(S.settings.character).name;
  b.title = on ? `Listening for “Hey Halo” or “Hey ${n}”. Click to stop, or say “Hey Halo, stop listening”.` : `Not listening for “Hey Halo”. Click to turn it on.`;
  b.setAttribute("aria-label", on ? "Stop listening for Hey Halo" : "Listen for Hey Halo");
}
$("btn-wake")?.addEventListener("click", () => {
  const on = !S.settings.wakeWord?.enabled;
  S.settings.wakeWord = { ...S.settings.wakeWord, enabled: on };
  paintWakeButton();
  api.send("wake:set", { on });
});
paintWakeButton();

async function setupWake() {
  const ww = S.settings.wakeWord ?? {};
  if (!ww.enabled) {
    await wake?.stop();
    wake = null;
    return;
  }
  if (wake) return;
  if (!(await api.invoke("notes:micAccess"))) {
    micDenied({ open: false });
    return;
  }
  wake = new WakeWord({
    character: () => S.settings.character,
    transcribe: async (pcm) => {
      const res = await api.invoke("chat:transcribe", { pcm, model: S.settings.wakeWord?.model || "onnx-community/whisper-base.en" });
      return res.ok ? res.text : "";
    },
    onWake: () => {
      // Just "Hey Halo": chime, then listen for the question right away.
      chime();
      api.send("wake:heard");
      conversing = true;
      setTimeout(() => startDictation({ reply: true }), 350);
    },
    onCommand: (text) => {
      chime();
      api.send("panel:showChat");
      if (busy) {
        // Halo is still answering: ask this next instead of dropping it.
        queuedVoice = text;
        return;
      }
      askByVoice(text);
    },
    onHush: () => {
      hush();
      if (busy) api.send("chat:stop");
    },
    onMicOff: () => stopListening(),
    said: () => lastSaid,
    onHeard: (text, secs) => console.debug(`[wake] heard (${secs.toFixed(1)} s): ${JSON.stringify(text)}`),
  });
  try {
    await wake.start();
    console.debug("[wake] listening");
  } catch (err) {
    console.warn("[wake] couldn't start the microphone:", err?.message ?? err);
    wake = null;
    if (blocked(err)) micDenied({ open: false });
  }
}

/** Reads the start of an answer aloud. Returns false when nothing is spoken. */
function speak(markdown) {
  if (!S.settings.wakeWord?.speakReplies || !("speechSynthesis" in window)) return false;
  const plain = markdown.replace(/```[\s\S]*?```/g, " ").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[#*_`>|-]/g, " ").replace(/\s+/g, " ").trim();
  const short = (plain.match(/[^.!?]+[.!?]+/g) ?? [plain]).slice(0, 2).join(" ").slice(0, 280);
  if (!short) return false;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(short);
  speaking = u; // Chromium can drop "end" for an utterance nothing holds on to
  u.rate = 1.05;
  // The wake word uses this to ignore Halo's own voice coming back through the mic.
  const said = { text: short, from: Date.now(), until: Infinity };
  lastSaid = said;
  let ended = false;
  const done = (natural) => {
    if (ended) return;
    ended = true;
    clearInterval(watch);
    if (speaking === u) speaking = null;
    said.until = Date.now() + ECHO_TAIL_MS; // speakers and the room ring on a little
    $("btn-stop").hidden = !busy;
    // Keep the conversation going: listen for the reply once Halo's voice has died down.
    if (natural) setTimeout(listenForReply, ECHO_TAIL_MS);
  };
  u.onend = () => done(true);
  u.onerror = (e) => done(e?.error !== "interrupted" && e?.error !== "canceled");
  // Belt and braces: if "end" never comes, notice that the voice went quiet.
  const watch = setInterval(() => { if (Date.now() - said.from > 1500 && !speechSynthesis.speaking) done(true); }, 400);
  $("btn-stop").hidden = false;
  speechSynthesis.speak(u);
  return true;
}
let speaking = null;

setTimeout(setupWake, 2500);
api.on("settings:changed", () => setupWake());

// ── What needs you (the board) ────────────────────────────────────────────────

async function loadBoard() {
  today = await api.invoke("today:get");
  renderBoard();
  if (today.alerts.some((a) => !a.read)) setTimeout(() => api.send("today:markRead"), 2500);
}
$("board-refresh").addEventListener("click", () => {
  const b = $("board-refresh");
  if (b.disabled) return;
  b.disabled = true;
  b.textContent = "Checking…";
  api.send("today:refresh", { claude: true });
});
$("board-brief").addEventListener("click", () => runQuick("brief"));

function group(label, svc, rows, { empty, error, loading } = {}) {
  const head = h("div", { class: "group-label" }, svc ? mark(svc, 14) : null, label, rows?.length ? ` · ${rows.length}` : "");
  let body;
  if (error) body = [h("div", { class: "empty bad" }, error)];
  else if (loading && !rows) body = [h("div", { class: "skeleton" }), h("div", { class: "skeleton" })];
  else if (!rows?.length) body = [h("div", { class: "empty" }, empty)];
  else body = rows;
  return h("div", {}, head, ...body);
}

function renderBoard() {
  const t = today;
  if (!t) return;
  const up = [t.updated.local && `GitHub and Jira ${ago(t.updated.local)}`, t.updated.claude && `Ninety and Slack ${ago(t.updated.claude)}`].filter(Boolean).join(" · ");
  $("board-updated").textContent = t.loading.local || t.loading.claude ? "Checking…" : up;
  // "Check now" stays locked until the answer is back.
  const busy = !!(t.loading.local || t.loading.claude);
  $("board-refresh").disabled = busy;
  $("board-refresh").textContent = busy ? "Checking…" : "Check now";
  const g = t.github ?? {}, j = t.jira ?? {}, c = t.connectors;
  const top = needs();
  const rockTag = { ON_TRACK: "On track", OFF_TRACK: "Off track", DONE: "Done", CANCELED: "Canceled", DRAFT: "Draft" };
  const rockUrg = { ON_TRACK: "good", OFF_TRACK: "high", DONE: "low" };
  const card = (...kids) => h("div", { class: "card list-card" }, ...kids);
  $("board").replaceChildren(
    h("div", { class: "quads" }, ...QUADS.map((q) => {
      const items = top.filter((n) => quadrant(n) === q.id);
      return h("div", { class: `card list-card quad wash-${q.tone}` },
        h("div", { class: "card-label" }, h("span", { class: "q-title" }, q.title), h("span", { class: "q-hint" }, q.hint), h("span", { class: "q-count" }, String(items.length))),
        ...(items.length ? items.map((n) => needRow(n)) : [h("div", { class: "empty" }, q.id === "do" ? "Nothing urgent. Nice." : "Nothing here.")]));
    })),
    top.length ? h("div", { class: "row-end", style: { marginTop: "0" } }, h("button", { class: "pill", onclick: () => ask(`Here is what needs me right now:\n${top.map((n) => `- [${quadrant(n)}] ${n.title} (${SERVICE[n.svc]?.name ?? n.svc}${n.src ? `, ${n.src}` : ""})`).join("\n")}\n\nSort these into the four Eisenhower quadrants (Do now, Schedule, Delegate, Later) with a one-line reason each, and tell me the single first thing to do.`) }, "Ask Halo to prioritize")) : null,
    card(
      c
        ? group("Ninety Rocks", "ninety", (c.rocks ?? []).map((r) => needRow({ id: `r:${r.id}`, urg: rockUrg[r.status] ?? "low", title: r.title, src: [rockTag[r.status], r.team, r.dueDate && `due ${r.dueDate}`].filter(Boolean).join(" · "), svc: "ninety", url: r.url, act: "Ask", ask: `Tell me about my Rock "${r.title}": milestones and what's left.` }, { done: false })), { empty: "No Rocks found.", error: c.rocksError || c.error, loading: t.loading.claude })
        : h("div", {}, h("div", { class: "group-label" }, mark("ninety", 14), "Ninety Rocks and Slack"), h("div", { class: "empty" }, t.loading.claude ? "Asking Claude Code…" : "These come through your Ninety and Slack connectors, so checking them uses a little of your Claude plan. Press Check now.")),
      // The single sign-on notice can be hidden; it comes back only if more get hidden.
      g.error || (g.warning && (g.ssoBlocked ?? 1) > (S.settings.ghSsoHidden ?? 0))
        ? h("div", { class: "empty bad" }, g.error || g.warning, " ",
            g.ssoUrl ? h("button", { class: "link", onclick: () => openUrl(g.ssoUrl) }, "Approve on GitHub") : null,
            !g.error && g.warning ? h("button", { class: "link", onclick: async () => { S = await api.invoke("settings:set", { ghSsoHidden: g.ssoBlocked ?? 1 }); renderBoard(); } }, "Hide") : null)
        : null,
      group("Pull requests waiting for you", "github", g.reviewRequests?.map((p) => needRow({ id: `review:${p.id}`, urg: "normal", title: p.title, src: `${p.repo}#${p.number} · ${p.author ?? ""}`, svc: "github", url: p.url, act: "Review", ask: `Review ${p.url}: summarize the change, risks, and anything I should comment on.` }, { done: false })), { empty: "No reviews waiting.", loading: t.loading.local }),
      group("Your open pull requests", "github", g.myPrs?.map((p) => needRow({ id: `pr:${p.id}`, urg: p.checks === "FAILURE" ? "high" : p.checks === "PENDING" ? "normal" : "good", title: p.title, src: `${p.repo}#${p.number}${p.checks ? ` · checks ${p.checks.toLowerCase()}` : ""}${p.review ? ` · ${p.review.replace(/_/g, " ").toLowerCase()}` : ""}`, svc: "github", url: p.url, act: p.checks === "FAILURE" ? "Fix it" : "Ask", ask: `What's the status of ${p.url}? Anything blocking the merge?` }, { done: false })), { empty: g.ssoBlocked ? `None that Halo can see. ${g.ssoBlocked} ${g.ssoBlocked === 1 ? "is" : "are"} hidden by your company's single sign-on.` : "No open pull requests.", loading: t.loading.local }),
      group("Jira", "jira", j.issues?.map((i) => needRow({ id: `j:${i.key}`, urg: i.statusColor === "green" ? "good" : i.statusColor === "yellow" ? "normal" : "low", title: `${i.key} · ${i.title}`, src: [i.status, i.priority].filter(Boolean).join(" · "), svc: "jira", url: i.url, act: "Ask", ask: `Summarize Jira issue ${i.key}: status, latest comments, and what I should do next.` }, { done: false })), { empty: "Nothing assigned to you.", error: j.error, loading: t.loading.local }),
      c ? group("Slack", "slack", (c.slack ?? []).map((m) => needRow({ id: `slack:${m.id}`, urg: "normal", title: m.text, src: `${m.from}${m.channel ? ` · ${m.channel}` : ""}${m.when ? ` · ${m.when}` : ""}`, svc: "slack", url: m.url, act: "Draft a reply", ask: `Draft a reply to this Slack message from ${m.from}: "${m.text}". Show it to me first.` }, { done: false })), { empty: "Nothing from the last 24 hours.", error: c.slackError, loading: t.loading.claude }) : null,
    ),
  );
}

// ── Notes ─────────────────────────────────────────────────────────────────────

let recorder = null;
let recSession = null;
let recSystem = false;
let recStart = 0;
let recTimer = 0;
const SIDE_NAME = { you: "You", them: "Them" };
const SIDE_COLOR = { you: "var(--violet)", them: "var(--cyan)" };
const partClock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const levelCtx = $("rec-level").getContext("2d");
/** Your level, and below it theirs (the system audio) when that's recorded too. */
function drawLevel(you, them = 0) {
  const c = levelCtx, w = c.canvas.width, hh = c.canvas.height, bars = 16;
  c.clearRect(0, 0, w, hh);
  const rows = recSystem ? [[you, "#A78BFA"], [them, "#22D3EE"]] : [[you, "#A78BFA"]];
  const rh = hh / rows.length, pad = rows.length > 1 ? 1 : 2;
  rows.forEach(([v, color], r) => {
    for (let i = 0; i < bars; i++) {
      c.fillStyle = i / bars < v ? (i > bars * 0.8 ? "#F4505E" : color) : dark() ? "rgba(255,255,255,.12)" : "rgba(0,0,0,.1)";
      c.fillRect(i * (w / bars) + 1, r * rh + pad, w / bars - 2, rh - 2 * pad);
    }
  });
}
drawLevel(0);
function noteProgress(text) {
  $("note-result").replaceChildren(h("div", { class: "card" }, h("span", { class: "hop" }, h("i"), h("i"), h("i")), `  ${text}`));
}
function setRecUi(on) {
  $("rec-btn").classList.toggle("on", on);
  $("rec-label").textContent = on ? "Stop and write notes" : "Take notes";
  $("rec-title").disabled = on;
  $("rec-system").disabled = on;
  $("rec-dot").hidden = !on;
}
async function startRecording() {
  if (recorder) return;
  if (!(await api.invoke("notes:micAccess"))) { $("rec-hint").textContent = "Microphone access is off."; micDenied(); return; }
  const title = $("rec-title").value.trim() || `Meeting ${new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
  recSession = await api.invoke("notes:start", { title });
  $("live-transcript").replaceChildren();
  $("live-transcript").hidden = false;
  $("note-result").replaceChildren();
  // Two tracks: your microphone ("You") and the system audio ("Them").
  const sessionId = recSession;
  recorder = new Recorder({
    onLevel: drawLevel,
    onSegment: (seg) => api.send("notes:segment", { sessionId, ...seg }),
  });
  try {
    const r = await recorder.start({ systemAudio: $("rec-system").checked });
    recSystem = r.systemAudio;
    if ($("rec-system").checked && !r.systemAudio) $("rec-hint").textContent = "System audio isn't available here, so only your microphone is recorded and everyone shows up as You.";
  } catch (e) {
    recorder = null;
    $("rec-hint").textContent = `Couldn't start recording: ${e.message}`;
    // Close the empty session so Halo doesn't stay in "Taking notes".
    api.invoke("notes:finish", { sessionId, durationMs: 0 }).then(() => $("note-result").replaceChildren());
    recSession = null;
    return;
  }
  recStart = Date.now();
  recTimer = setInterval(() => {
    const s = Math.floor((Date.now() - recStart) / 1000);
    $("rec-time").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }, 500);
  setRecUi(true);
  wake?.pause(true);
}
async function stopRecording() {
  if (!recorder) return;
  const r = recorder;
  recorder = null;
  clearInterval(recTimer);
  setRecUi(false);
  await r.stop();
  wake?.pause(false);
  noteProgress("Finishing the transcript and writing your notes…");
  const res = await api.invoke("notes:finish", { sessionId: recSession, durationMs: Date.now() - recStart, systemAudio: recSystem });
  recSession = null;
  if (!res.ok) $("note-result").replaceChildren(h("div", { class: "err" }, res.error));
}
$("rec-btn").addEventListener("click", () => (recorder ? stopRecording() : startRecording()));
api.on("notes:toggle", () => { show("notes"); recorder ? stopRecording() : startRecording(); });
api.on("notes:startCall", ({ title }) => { show("notes"); if (!recorder) { $("rec-title").value = title; startRecording(); } });
api.on("notes:stopIfRecording", () => { if (recorder) stopRecording(); });
// The live transcript: both sides in time order, and the parts still being
// written down or that failed (with "Try again").
api.on("notes:transcript", ({ sessionId, lines, parts }) => {
  const box = $("live-transcript");
  const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
  const rows = [
    ...lines.map((l) => ({ at: l.start, el: h("div", { style: { marginBottom: "4px" } }, h("b", { style: { color: SIDE_COLOR[l.side] } }, l.speaker), ` ${l.text}`) })),
    ...parts.map((p) => ({
      at: p.startMs,
      el: p.state === "failed"
        // After the meeting, a retried part goes into its note.
        ? failedPart(p, { sessionId }, (res, row) => { if (res.name) { row.replaceWith(h("div", { class: "meta" }, "Written down; it's in the note now.")); showNoteResult(res); } })
        : h("div", { class: "meta" }, `${SIDE_NAME[p.side]} · ${partClock(p.startMs)}: writing this part down…`),
    })),
  ].sort((a, b) => a.at - b.at);
  box.replaceChildren(...rows.map((r) => r.el));
  if (atEnd) box.scrollTop = box.scrollHeight;
});

/** A part of the recording that wasn't written down, with "Try again" (its audio is kept until then). */
function failedPart(p, target, onDone) {
  const why = h("span", {}, `${SIDE_NAME[p.side]} ${partClock(p.startMs)}–${partClock(p.endMs)} wasn't written down: ${p.error}`);
  const btn = h("button", { class: "pill", onclick: async () => {
    btn.disabled = true;
    btn.textContent = "Trying again…";
    const res = await api.invoke("notes:retry", { ...target, key: p.key });
    if (res.ok) return onDone?.(res, row);
    btn.disabled = false;
    btn.textContent = "Try again";
    why.textContent = res.error;
  } }, "Try again");
  const row = h("div", { class: "err", style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", margin: "4px 0" } }, why, btn);
  return row;
}
api.on("notes:modelProgress", (p) => {
  const box = $("model-progress");
  if (p.status === "ready" || (p.status === "done" && !p.file)) return (box.hidden = true);
  box.hidden = false;
  box.querySelector(".bar span").style.width = `${Math.round(p.progress || 0)}%`;
  box.querySelector(".label").textContent = `Getting the speech model ready… ${Math.round(p.progress || 0)}%`;
});
api.on("notes:modelReady", () => ($("model-progress").hidden = true));
api.on("notes:status", (s) => {
  // Notes written again from the room show their progress there.
  if (s.summarizing && !s.rewrite) noteProgress(s.step || "Writing your notes…");
});
api.on("notes:saved", (n) => { showNoteResult(n); if (view === "notes") loadNotes(); });

function followUps(n, editable = false) {
  return h("div", { class: "note-actions" },
    h("button", { class: "pill", onclick: () => ask(`Read my meeting notes at "${n.file}". Draft Jira issues for the to-dos (summary, description, assignee if clear). Show me the drafts first and only create them after I confirm.`) }, "Jira tickets from to-dos"),
    h("button", { class: "pill", onclick: () => ask(`Read my meeting notes at "${n.file}". Draft Ninety To-Dos for the to-dos that are mine, with due dates where the notes give one. Show them first and only create them after I confirm.`) }, "Ninety To-Dos"),
    h("button", { class: "pill", onclick: () => ask(`Read my meeting notes at "${n.file}". Draft a short Slack post summarizing the meeting (summary, key points, to-dos with owners). Ask me which channel, and only send after I confirm.`) }, "Post to Slack"),
    editable ? h("button", { class: "pill", onclick: () => editInRoom(n.name) }, "Edit transcript") : null,
    h("button", { class: "pill", onclick: () => api.send("notes:open", n.name) }, "Open file"));
}
/** Opens the note in the room, where speakers can be renamed and lines edited. */
function editInRoom(name) {
  try { localStorage.setItem("halo:openNote", name); } catch { /* the room opens on the list */ }
  api.send("room:open", "notes");
}
/** "Try again" for parts that weren't written down, and writing the notes (again). */
function noteRepairs(note, refresh) {
  const doc = note.doc;
  if (!doc) return [];
  const out = doc.failed.map((p) => failedPart(p, { name: note.name }, refresh));
  if (doc.notesError || doc.stale) {
    const label = doc.notes ? "Write the notes again" : "Write the notes";
    const btn = h("button", { class: "pill primary", onclick: async () => {
      btn.disabled = true;
      btn.textContent = "Writing…";
      const res = await api.invoke("notes:rewrite", { name: note.name });
      if (res.ok) return refresh();
      btn.disabled = false;
      btn.textContent = label;
      btn.after(h("div", { class: "err" }, res.error));
    } }, label);
    out.push(h("div", { class: "note-actions" }, btn));
  }
  return out;
}
async function showNoteResult(n) {
  const note = await api.invoke("notes:read", n.name);
  $("note-result").replaceChildren(h("div", { class: "card note-view wash-green" },
    followUps(n, !!note.doc),
    ...noteRepairs(note, () => showNoteResult(n)),
    h("div", { class: "text", html: renderMarkdown(note.text.split("\n## Transcript")[0]) })));
}
$("paste-go").addEventListener("click", async () => {
  const transcript = $("paste-text").value.trim();
  if (!transcript) return;
  noteProgress("Writing your notes…");
  const res = await api.invoke("notes:summarizeText", { title: $("paste-title").value.trim() || "Meeting", transcript });
  if (res.ok) $("paste-text").value = "";
  else $("note-result").replaceChildren(h("div", { class: "err" }, res.error));
});
$("quick-save").addEventListener("click", async () => {
  const body = $("quick-text").value.trim();
  if (!body) return;
  await api.invoke("notes:quick", { body });
  $("quick-text").value = "";
});
let searchTimer = 0;
$("notes-search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadNotes, 200); });
$("notes-folder").addEventListener("click", () => api.send("notes:openFolder"));
async function loadNotes() {
  const list = await api.invoke("notes:list", $("notes-search").value);
  $("notes-list").replaceChildren(...(list.length
    ? list.map((n) => h("div", { class: "row", onclick: () => viewNote(n) }, h("div", { class: "main" }, h("div", { class: "title" }, n.title), h("div", { class: "src" }, n.preview), n.attention ? h("div", { class: "src", style: { color: "var(--amber)" } }, n.attention) : null), h("span", { class: "when" }, ago(n.mtime))))
    : [h("div", { class: "empty" }, $("notes-search").value ? "No notes match." : "No notes yet. Take notes in a meeting, or jot a quick note.")]));
}
async function viewNote(n) {
  const note = await api.invoke("notes:read", n.name);
  const v = $("note-view");
  v.replaceChildren(
    h("div", { class: "note-actions" },
      h("button", { class: "pill", onclick: () => (v.hidden = true) }, "Close"),
      h("button", { class: "pill", onclick: () => { show("chat"); input.value = `Read my note at "${note.file}" and `; input.focus(); } }, "Ask about this note"),
      note.doc ? h("button", { class: "pill", onclick: () => editInRoom(n.name) }, "Edit transcript") : null,
      h("button", { class: "pill", onclick: () => api.send("notes:open", n.name) }, "Open file")),
    ...noteRepairs(note, () => { viewNote(n); loadNotes(); }),
    h("div", { class: "text", html: renderMarkdown(note.text) }));
  v.hidden = false;
  v.scrollIntoView({ behavior: "smooth" });
}

applySettings();
show("home");

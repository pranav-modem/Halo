// Halo's room: Home, Memory, Pieces, Skills, History, Notes, Activity and
// all the settings pages.

import { Character } from "./characters/engine.js";
import { renderMarkdown } from "./markdown.js";
import { $, ago, api, h, ICON, isMac, mark, openUrl } from "./ui/common.js";

for (const el of document.querySelectorAll("[data-icon]")) el.innerHTML = ICON[el.dataset.icon] ?? "";

// Extra pages in the sidebar: Memory, Skills, History, Recap, Calls.
{
  const side = document.querySelector(".sidebar");
  const after = (page) => side.querySelector(`[data-page="${page}"]`);
  const nav = (page, iconName, label) => h("button", { class: "nav", "data-page": page }, h("span", { class: "ico", html: ICON[iconName] }), label);
  after("home").after(nav("memory", "notes", "Memory"));
  after("pieces").after(nav("skills", "spark", "Skills"), nav("history", "clock", "History"), nav("recap", "pulse", "Recap"));
  after("notes").after(nav("calls", "mic", "Calls"));
  const notesIco = after("notes")?.querySelector(".ico");
  if (notesIco) notesIco.innerHTML = ICON.mic;
}

let S = await api.invoke("settings:get");
let health = null;
const live = []; // buddies drawn on the current page
const railChar = new Character($("rail-char"), { kind: S.settings.character, R: 15 }).start();

document.addEventListener("mousemove", (e) => {
  for (const { el, b } of [{ el: $("rail-char"), b: railChar }, ...live]) {
    const r = el.getBoundingClientRect();
    if (r.width) b.lookAt(Math.tanh((e.clientX - (r.left + r.width / 2)) / 260), Math.tanh((e.clientY - (r.top + r.height / 2)) / 200));
  }
});

api.on("settings:changed", (p) => {
  S = p;
  railChar.setKind(S.settings.character);
  if (["look", "general", "claude", "voice"].includes(page)) render();
});

// ── navigation ────────────────────────────────────────────────────────────────

const TITLES = {
  home: "Home", memory: "Memory", pieces: "Pieces", skills: "Skills", history: "History", recap: "Recap", notes: "Notes", calls: "Calls", activity: "Activity",
  general: "General", look: "Look", claude: "Claude Code", integrations: "Integrations", alerts: "Alerts", voice: "Notes and voice", shortcuts: "Shortcuts",
};
let page = "home";

function go(p) {
  if (!TITLES[p]) p = p === "settings" ? "general" : "home";
  page = p;
  $("crumb").textContent = TITLES[p];
  document.querySelectorAll(".nav").forEach((b) => b.classList.toggle("on", b.dataset.page === p));
  document.querySelectorAll(".rail-btn").forEach((b) => b.classList.toggle("on", b.dataset.page === p || (b.dataset.page === "general" && !["home", "activity", "memory", "pieces", "skills", "history", "recap", "notes", "calls"].includes(p))));
  render();
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-page]");
  if (b) go(b.dataset.page);
});
api.on("room:page", (p) => go(p));

let renderSeq = 0;
async function render() {
  for (const x of live.splice(0)) x.b.stop();
  // A fresh page element each time, so a slow page that finishes late can't
  // add itself on top of the page you moved to.
  const root = h("div", { class: "page", id: "page" });
  // Pages pass optional pieces as null; the DOM would print those as "null".
  for (const m of ["append", "replaceChildren"]) {
    const real = root[m].bind(root);
    root[m] = (...kids) => real(...kids.filter((k) => k != null && k !== false));
  }
  $("page").replaceWith(root);
  root.parentElement.scrollTop = 0;
  const seq = ++renderSeq;
  try {
    await PAGES[page]?.(root);
  } catch (err) {
    // One page failing must never blank the whole room.
    if (seq !== renderSeq) return;
    console.error(`[room] ${page} failed`, err);
    root.replaceChildren(...title(TITLES[page]), card(h("div", { class: "empty" }, h("b", {}, "This page didn't load."), h("span", {}, String(err?.message ?? err)), h("button", { class: "btn small", onclick: () => render() }, "Try again"))));
  }
}

// ── small UI pieces ───────────────────────────────────────────────────────────

const card = (...kids) => h("div", { class: "card" }, ...kids);
const label = (t) => h("div", { class: "label" }, t);
function setRow(title, desc, ...controls) {
  return h("div", { class: "setrow" }, h("div", { class: "txt" }, h("div", { class: "t" }, title), desc ? h("div", { class: "d" }, desc) : null), h("div", { class: "ctl" }, ...controls));
}
function toggle(on, onchange) {
  const b = h("button", { class: "toggle", "aria-pressed": String(!!on), role: "switch" });
  b.addEventListener("click", () => {
    const v = b.getAttribute("aria-pressed") !== "true";
    b.setAttribute("aria-pressed", String(v));
    onchange(v);
  });
  return b;
}
function seg(value, options, onchange) {
  const wrap = h("div", { class: "seg" });
  for (const [v, l] of options) {
    wrap.append(h("button", { "aria-pressed": String(String(value) === String(v)), onclick: () => { wrap.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", "false")); wrap.querySelector(`[data-v="${CSS.escape(String(v))}"]`).setAttribute("aria-pressed", "true"); onchange(v); }, "data-v": String(v) }, l));
  }
  return wrap;
}
function select(value, options, onchange) {
  const el = h("select", { onchange: (e) => onchange(e.target.value) }, ...options.map(([v, l]) => h("option", { value: v }, l)));
  el.value = value ?? "";
  return el;
}
function textInput(value, onchange, attrs = {}) {
  return h("input", { type: "text", value: value ?? "", onchange: (e) => onchange(e.target.value.trim()), ...attrs });
}
function chip(kind, text) { return h("span", { class: `chip ${kind}` }, text); }
async function save(patch) { S = await api.invoke("settings:set", patch); }
function title(t, lead) { return [h("h1", { class: "title" }, t), lead ? h("p", { class: "lead" }, lead) : null]; }
function itemRow({ urg = "", t, s, when, svc, onclick }) {
  return h("div", { class: "item", onclick }, h("span", { class: `urg ${urg}` }), svc ? mark(svc, 22) : null, h("div", { class: "main" }, h("div", { class: "t" }, t), s ? h("div", { class: "s" }, s) : null), when ? h("span", { class: "when" }, when) : null);
}
function askHalo(prompt) { api.send("room:ask", prompt); }

async function loadHealth() {
  health = await api.invoke("settings:health");
  const ok = !!health.claude.version;
  $("status-dot").className = `sdot ${ok ? (health.connectors.every((c) => c.status === "connected") ? "ok" : "warn") : "bad"}`;
  $("status-text").textContent = ok ? `Claude Code ${health.claude.apiKeySource === "none" ? "· your login" : "ready"}` : "Claude Code not found";
  if (["claude", "integrations", "general"].includes(page)) render();
}

// ── pages ─────────────────────────────────────────────────────────────────────

const PAGES = {};

PAGES.home = async (root) => {
  const t = await api.invoke("today:get");
  ccList = await api.invoke("sessions:list");
  ccBox = h("div", { class: "cc-box" });
  drawSessions();
  const cast = h("div", { class: "cast" });
  const hero = h("div", { class: "hero" },
    h("h2", {}, "Hi there"),
    h("p", {}, "Here's what needs you, from Ninety, Jira, GitHub and Slack."),
    checkButton(t),
    cast,
  );
  for (const c of S.characters) {
    const cv = h("canvas");
    cast.append(cv);
    live.push({ el: cv, b: new Character(cv, { kind: c.id, R: 17 }).start() });
  }
  const g = t.github ?? {}, j = t.jira ?? {}, c = t.connectors ?? {};
  const offTrack = (c.rocks ?? []).filter((r) => r.status === "OFF_TRACK").length;
  const unread = t.alerts.filter((a) => !a.read).length;
  const stat = (k, v, s) => h("div", { class: "stat" }, h("div", { class: "k" }, k), h("div", { class: "v" }, v), h("div", { class: "s" }, s));
  const needs = [
    ...t.alerts.filter((a) => Date.now() - a.at < 24 * 3600_000).map((a) => ({ urg: a.tone === "bad" ? "high" : a.tone === "good" ? "good" : "normal", t: a.title, s: a.body, when: ago(a.at), svc: a.source, url: a.url })),
    ...(g.reviewRequests ?? []).map((p) => ({ urg: "normal", t: `Review: ${p.title}`, s: `${p.repo}#${p.number} · ${p.author ?? ""}`, svc: "github", url: p.url })),
    ...(g.myPrs ?? []).filter((p) => p.checks === "FAILURE" || p.checks === "ERROR").map((p) => ({ urg: "high", t: `Checks failing: ${p.title}`, s: `${p.repo}#${p.number}`, svc: "github", url: p.url })),
    ...(c.rocks ?? []).filter((r) => r.status === "OFF_TRACK").map((r) => ({ urg: "high", t: `Off-track Rock: ${r.title}`, s: r.dueDate ? `due ${r.dueDate}` : "", svc: "ninety", url: r.url })),
  ];
  root.append(
    hero,
    h("div", { class: "stats" },
      stat("Needs you", String(needs.length), `${needs.filter((n) => n.urg === "high").length} urgent`),
      stat("PRs to review", g.reviewRequests ? String(g.reviewRequests.length) : "–", g.myPrs ? `${g.myPrs.length} of yours open` : "not loaded"),
      stat("Jira open", j.issues ? String(j.issues.length) : "–", "assigned to you"),
      stat("Rocks off track", c.rocks ? String(offTrack) : "–", c.rocks ? `${c.rocks.length} this quarter` : "press Check now"),
    ),
    ccBox,
    label("Needs you"),
    card(...(needs.length
      ? needs.slice(0, 12).map((n) => itemRow({ ...n, onclick: () => openUrl(n.url) }))
      : [h("div", { class: "empty" }, h("b", {}, "Nothing needs you right now."), h("span", {}, "Halo checks again on its own, or press Check now."))])),
    h("p", { class: "note" }, `Halo reads what it needs and tells you what it found. It sends, posts or changes things only when you say so, and you Allow each one. ${unread ? `${unread} new alert${unread > 1 ? "s" : ""}.` : ""}`),
  );
};

// Your Claude Code sessions, kept live on Home without redrawing the page.
let ccList = [];
let ccBox = null;
const CC_STATE = { working: "working", waiting: "needs you", done: "finished" };
function drawSessions() {
  if (!ccBox) return;
  ccBox.replaceChildren(...(ccList.length
    ? [label("Your Claude Code sessions"), card(...ccList.map((s) => h("div", { class: "item", title: `Open in ${s.app}`, onclick: () => api.invoke("sessions:open", s.id) },
        h("span", { class: "cc-dot", style: { "--c": s.color } }),
        h("div", { class: "main" },
          h("div", { class: "t" }, h("b", {}, s.project), ` · ${s.app} · `, h("span", { class: `cc-state ${s.status}` }, CC_STATE[s.status])),
          h("div", { class: "s" }, s.status === "done" ? s.final : [s.prompt, s.doing].filter(Boolean).join("  ›  "))),
        h("span", { class: "when" }, ago(s.updated)))))]
    : []));
}
api.on("sessions:changed", (list) => {
  ccList = list;
  drawSessions();
});

// "Check now" stays locked from the click until the answer is back.
let checkBtn = null;
function checkButton(t) {
  checkBtn = h("button", { class: "btn white", onclick: () => {
    if (checkBtn.disabled) return;
    setChecking(true);
    api.send("today:refresh", { claude: true });
  } });
  setChecking(t.loading.local || t.loading.claude);
  return checkBtn;
}
let checkTimer = 0;
function setChecking(on) {
  if (!checkBtn) return;
  checkBtn.disabled = on;
  checkBtn.textContent = on ? "Checking…" : "Check now";
  checkBtn.setAttribute("aria-busy", String(on));
  clearTimeout(checkTimer);
  // Never leave it stuck if an answer somehow never arrives.
  if (on) checkTimer = setTimeout(() => setChecking(false), 5 * 60_000);
}
api.on("today:data", (d) => {
  if (page !== "home") return;
  if (d.loading.local || d.loading.claude) setChecking(true);
  else render();
});

PAGES.memory = async (root) => {
  const m = await api.invoke("memory:get");
  const inp = h("input", { type: "text", placeholder: "My manager is Sam · I prefer short bullet answers · Our team is Data Platform" , style: { flex: "1", minWidth: "0" } });
  const add = async () => {
    if (!inp.value.trim()) return;
    await api.invoke("memory:add", inp.value.trim());
    render();
  };
  inp.addEventListener("keydown", (e) => e.key === "Enter" && add());
  root.append(
    ...title("Memory", "What Halo remembers about you and your work. Every new chat starts with this. In a chat, say “remember that…” and Halo adds it here."),
    card(h("div", { class: "setrow" }, inp, h("button", { class: "btn accent", onclick: add }, "Remember"))),
    label(`${m.items.length} thing${m.items.length === 1 ? "" : "s"} remembered`),
    card(...(m.items.length
      ? m.items.map((it, i) => setRow(it, null, h("button", { class: "btn small danger", onclick: async () => { await api.invoke("memory:remove", i); render(); } }, "Forget")))
      : [h("div", { class: "empty" }, h("b", {}, "Nothing yet."), h("span", {}, "Tell Halo about your team, your projects and how you like answers."))])),
    h("p", { class: "note" }, `Saved in ${m.file}.`),
  );
};

PAGES.pieces = async (root) => {
  const list = await api.invoke("pieces:list");
  const form = (p = {}) => {
    const name = h("input", { type: "text", value: p.name ?? "", placeholder: "Morning brief" });
    const kind = p.when?.every ? "every" : "at";
    const every = h("input", { type: "text", value: p.when?.every ?? "2h", placeholder: "2h" });
    const at = h("input", { type: "text", value: p.when?.at ?? "09:00", placeholder: "09:00" });
    const days = h("input", { type: "text", value: p.when?.days ?? "mon-fri", placeholder: "mon-fri" });
    const prompt = h("textarea", { placeholder: "What should Halo check, in plain English?" });
    prompt.value = p.prompt ?? "";
    let mode = kind;
    const whenBox = h("div", { class: "field" });
    const drawWhen = () => whenBox.replaceChildren(h("label", {}, "When"), seg(mode, [["at", "At a time"], ["every", "Every…"]], (v) => { mode = v; drawWhen(); }),
      mode === "every" ? h("div", { style: { display: "flex", gap: "8px", alignItems: "center" } }, "Every", every, h("span", { class: "muted" }, "like 30m or 2h")) : h("div", { style: { display: "flex", gap: "8px", alignItems: "center" } }, "At", at, "on", days));
    drawWhen();
    const err = h("div", { class: "note" });
    return card(
      h("div", { class: "field" }, h("label", {}, "Name"), name),
      whenBox,
      h("div", { class: "field" }, h("label", {}, "What to do"), prompt),
      h("div", { class: "row-end" }, err, h("span", { class: "grow" }),
        h("button", { class: "btn", onclick: () => render() }, "Cancel"),
        h("button", { class: "btn accent", onclick: async () => {
          const res = await api.invoke("pieces:save", { ...p, name: name.value, prompt: prompt.value, when: mode === "every" ? { every: every.value } : { at: at.value, days: days.value } });
          if (res.error) err.textContent = res.error; else render();
        } }, "Save")),
    );
  };
  root.append(
    ...title("Pieces", "Jobs Halo runs on its own schedule, like checking what needs you every two hours. They only read, and come back as a speech bubble and items on What needs you."),
    h("div", {}, h("button", { class: "btn accent", onclick: (e) => e.target.replaceWith(form()) }, "New piece")),
    card(...list.map((p) => setRow(p.name, `${p.label}${p.lastRun ? ` · last run ${ago(p.lastRun)}` : ""} · ${p.prompt.slice(0, 120)}${p.prompt.length > 120 ? "…" : ""}`,
      h("button", { class: "btn small", onclick: () => api.send("pieces:run", p.id) }, p.running ? "Running…" : "Run now"),
      h("button", { class: "btn small", onclick: (e) => e.target.closest(".card").after(form(p)) }, "Edit"),
      h("button", { class: "btn small danger", onclick: async () => { await api.invoke("pieces:remove", p.id); render(); } }, "Delete"),
      toggle(p.enabled, (v) => api.invoke("pieces:save", { ...p, enabled: v })),
    ))),
  );
};
api.on("pieces:changed", () => page === "pieces" && render());

PAGES.skills = async (root) => {
  const { skills, help } = await api.invoke("skills:list");
  const url = h("input", { type: "text", placeholder: "https://github.com/owner/repo/tree/main/skills/my-skill", style: { flex: "1", minWidth: "0" } });
  const search = h("input", { class: "search", placeholder: `Search ${skills.length} skills` });
  const listBox = h("div");
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const groups = new Map();
    for (const s of skills.filter((s) => !q || `${s.name} ${s.description}`.toLowerCase().includes(q))) {
      if (!groups.has(s.source)) groups.set(s.source, []);
      groups.get(s.source).push(s);
    }
    listBox.replaceChildren(...[...groups].flatMap(([src, items]) => [label(`${src} · ${items.length}`), card(...items.map((s) => setRow(s.name, s.description || "No description.", h("button", { class: "btn small", onclick: () => askHalo(`Use the ${s.name} skill. First tell me in two lines what it can do for me.`) }, "Try it"))))]));
  };
  search.addEventListener("input", draw);
  draw();
  root.append(
    ...title("Skills", "Everything Halo can use through your Claude Code: your skills and the ones that come with your plugins."),
    label("Add a skill"),
    card(
      ...help.steps.map((s, i) => setRow(`${i + 1}.`, s)),
      h("div", { class: "setrow" }, url, h("button", { class: "btn accent", onclick: () => {
        const u = url.value.trim();
        if (!/^https?:\/\//.test(u)) return;
        askHalo(`Add the Claude Code skill at ${u}. Fetch it, tell me in a few lines what it does and exactly which files you'll put in ${help.folder}, then install it there after I allow it. Don't run any of its scripts.`);
      } }, "Add from link")),
    ),
    search,
    listBox,
  );
};

PAGES.history = async (root) => {
  const list = await api.invoke("history:list");
  const view = h("div");
  root.append(
    ...title("History", "Your chats with Halo. Open one to read it, or continue where you left off."),
    card(...(list.length
      ? list.map((c) => itemRow({ t: c.title, s: `${c.turns} message${c.turns === 1 ? "" : "s"}${c.character ? ` · ${S.characters.find((x) => x.id === c.character)?.name ?? ""}` : ""}`, when: ago(c.updatedAt), svc: "halo", onclick: () => openChat(c, view) }))
      : [h("div", { class: "empty" }, h("b", {}, "No chats yet."), h("span", {}, "Click Halo on your desktop to start one."))])),
    view,
  );
};

async function openChat(c, view) {
  const msgs = await api.invoke("history:read", c.id);
  view.replaceChildren(
    label(c.title),
    h("div", { class: "note-view" },
      h("div", { style: { display: "flex", gap: "8px", marginBottom: "14px" } }, h("button", { class: "btn accent", onclick: () => api.send("history:resume", c.id) }, "Continue this chat"), h("button", { class: "btn", onclick: () => view.replaceChildren() }, "Close")),
      ...msgs.map((m) => h("div", { style: { margin: "0 0 14px" } },
        h("div", { class: "note", style: { marginBottom: "4px", fontWeight: "600" } }, m.role === "user" ? `You${m.images ? ` · ${m.images} screenshot${m.images > 1 ? "s" : ""}` : ""}` : "Halo"),
        m.role === "user" ? h("div", { style: { whiteSpace: "pre-wrap" } }, m.text) : h("div", { class: "text", html: renderMarkdown(m.text) }))),
    ),
  );
  view.scrollIntoView({ behavior: "smooth" });
}

// ── a meeting note: the notes, then a transcript you can fix ──────────────────

const SPEAKER_COLORS = ["#8B83FF", "#2DD4BF", "#F5A524", "#F472B6", "#60A5FA", "#34D399", "#FB923C"];
function lineClock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const p = (n) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${Math.floor(s / 60)}:${p(s % 60)}`;
}

/**
 * A note in the room. A meeting note shows its transcript under the notes:
 * rename a speaker (the same name as another makes them one), click a line to
 * fix its words or speaker or delete it, and try a part that failed again.
 */
function noteView(name, { askPrompt, askLabel = "Ask about this note", onChange = () => {} }) {
  const box = h("div", { class: "note-view" });
  const draw = async () => {
    const note = await api.invoke("notes:read", name);
    const doc = note.doc;
    const err = h("div");
    // Every change saves note.json and the Markdown, then draws the note again.
    const act = async (channel, args, btn, busyLabel) => {
      const label = btn?.textContent;
      if (btn) {
        btn.disabled = true;
        if (busyLabel) btn.textContent = busyLabel;
      }
      const res = await api.invoke(channel, { name, ...args });
      if (!res.ok) {
        if (btn) {
          btn.disabled = false;
          btn.textContent = label;
        }
        err.replaceChildren(h("div", { class: "chip bad", style: { display: "inline-block", marginBottom: "12px" } }, res.error));
        return;
      }
      onChange();
      await draw();
    };
    const head = h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "14px" } },
      h("button", { class: "btn", onclick: () => askHalo(askPrompt(note.file)) }, askLabel),
      h("button", { class: "btn", onclick: () => api.send("notes:open", name) }, "Open file"),
      doc && (doc.notesError || doc.stale)
        ? h("button", { class: "btn accent", onclick: (e) => act("notes:rewrite", {}, e.currentTarget, "Writing the notes…") }, doc.notes ? "Write the notes again" : "Write the notes")
        : null);
    if (!doc) {
      box.replaceChildren(head, h("div", { class: "text", html: renderMarkdown(note.text) }));
      return;
    }
    box.replaceChildren(head, err, h("div", { class: "text", html: renderMarkdown(note.text.split("\n## Transcript")[0]) }), transcript(doc, act));
  };
  draw();
  return box;
}

function transcript(doc, act) {
  const color = (id) => {
    const s = doc.speakers.find((x) => x.id === id);
    return s?.me ? SPEAKER_COLORS[0] : SPEAKER_COLORS[1 + (Math.max(0, doc.speakers.indexOf(s)) % (SPEAKER_COLORS.length - 1))];
  };
  const nameOf = (id) => doc.speakers.find((s) => s.id === id)?.name ?? "Someone";
  const dot = (id) => h("span", { style: { display: "inline-block", width: "8px", height: "8px", borderRadius: "50%", background: color(id), marginRight: "6px" } });

  const speakerChip = (s) => {
    const count = doc.lines.filter((l) => l.speaker === s.id).length;
    const chipEl = h("button", { class: "btn small", title: `Rename ${s.name}` }, dot(s.id), s.name, s.me ? " (me)" : "", h("span", { class: "note", style: { marginLeft: "6px" } }, String(count)));
    chipEl.addEventListener("click", () => {
      const input = h("input", { type: "text", value: s.name, "aria-label": `Rename ${s.name}`, style: { minWidth: "180px" } });
      const same = h("span", { class: "note" });
      let done = false;
      const finish = (save) => {
        if (done) return;
        done = true;
        const to = input.value.trim();
        if (save && to && to !== s.name) act("notes:speaker", { id: s.id, to }).then(() => editor.isConnected && editor.replaceWith(chipEl));
        else editor.replaceWith(chipEl);
      };
      input.addEventListener("input", () => {
        const other = doc.speakers.find((x) => x !== s && x.name.toLowerCase() === input.value.trim().toLowerCase());
        same.textContent = other ? `Same as ${other.name}: they'll become one speaker.` : "";
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") finish(false);
      });
      input.addEventListener("blur", () => finish(true));
      const editor = h("span", { class: "field", style: { padding: "0", flexDirection: "row", alignItems: "center", gap: "8px", display: "inline-flex" } }, input, same);
      chipEl.replaceWith(editor);
      input.focus();
      input.select();
    });
    return chipEl;
  };

  const lineRow = (l) => {
    const row = h("div", { title: "Click to fix this line", style: { display: "grid", gridTemplateColumns: "52px 130px 1fr", gap: "10px", padding: "7px 0", borderTop: "1px solid var(--line)", cursor: "text" } },
      h("span", { class: "note", style: { fontVariantNumeric: "tabular-nums" } }, doc.timed === false ? "" : lineClock(l.start)),
      h("b", { style: { color: color(l.speaker), overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, nameOf(l.speaker)),
      h("div", { style: { whiteSpace: "pre-wrap" } }, l.text));
    row.addEventListener("click", () => row.replaceWith(lineEditor(l, row)));
    return row;
  };

  const lineEditor = (l, row) => {
    const who = h("select", { "aria-label": "Speaker" }, ...doc.speakers.map((s) => h("option", { value: s.id }, s.name)), h("option", { value: "+" }, "Someone else…"));
    who.value = l.speaker;
    const other = h("input", { type: "text", placeholder: "Their name", hidden: true });
    who.addEventListener("change", () => {
      other.hidden = who.value !== "+";
      if (!other.hidden) other.focus();
    });
    const words = h("textarea", { rows: 3, "aria-label": "What was said" });
    words.value = l.text;
    const save = (btn) => act("notes:line", { id: l.id, text: words.value, ...(who.value === "+" ? { newName: other.value } : { speaker: who.value }) }, btn);
    let sure = false;
    const del = h("button", { class: "btn danger small" }, "Delete line");
    del.addEventListener("click", () => {
      if (!sure) {
        sure = true;
        del.textContent = "Delete it for good?";
        return;
      }
      act("notes:line", { id: l.id, remove: true }, del);
    });
    const saveBtn = h("button", { class: "btn accent small", onclick: (e) => save(e.currentTarget) }, "Save");
    const editor = h("div", { class: "field", style: { padding: "10px 0", borderTop: "1px solid var(--line)" } },
      h("div", { style: { display: "flex", gap: "8px", alignItems: "center" } }, h("span", { class: "note" }, doc.timed === false ? "" : lineClock(l.start)), who, other),
      words,
      h("div", { style: { display: "flex", gap: "8px" } }, saveBtn, h("button", { class: "btn small", onclick: () => editor.replaceWith(row) }, "Cancel"), h("span", { style: { flex: "1" } }), del));
    words.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save(saveBtn);
      if (e.key === "Escape") editor.replaceWith(row);
    });
    setTimeout(() => words.focus(), 0);
    return editor;
  };

  const failedRow = (f) => h("div", { style: { display: "flex", alignItems: "center", gap: "12px", padding: "8px 0", borderTop: "1px solid var(--line)" } },
    h("span", { class: "chip warn" }, `${f.side === "you" ? "You" : "Them"} ${lineClock(f.startMs)}–${lineClock(f.endMs)}`),
    h("span", { class: "note", style: { flex: "1" } }, `Not written down yet: ${f.error}`),
    h("button", { class: "btn small", onclick: (e) => act("notes:retry", { key: f.key }, e.currentTarget, "Trying again…") }, "Try again"));

  // Failed parts sit where they happened, between the lines.
  const rows = [...doc.lines.map((l) => ({ at: l.start, el: lineRow(l) })), ...(doc.failed ?? []).map((f) => ({ at: f.startMs, el: failedRow(f) }))].sort((a, b) => a.at - b.at);
  return h("div", { style: { marginTop: "18px" } },
    h("h3", { style: { margin: "0 0 6px" } }, "Transcript"),
    h("p", { class: "note", style: { margin: "0 0 10px" } }, doc.systemAudio === false
      ? "Only your microphone was recorded, so everyone shows up as You. Click a line to give it to the right person."
      : "Click a name to rename it; give two speakers the same name to make them one. Click a line to fix it."),
    h("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "10px" } }, ...doc.speakers.map(speakerChip)),
    ...rows.map((r) => r.el),
    doc.lines.length || doc.failed?.length ? null : h("div", { class: "note" }, "No lines."));
}

PAGES.notes = async (root) => {
  const list = card();
  const view = h("div");
  const open = (n) => {
    view.replaceChildren(noteView(n, { askPrompt: (file) => `Read my note at "${file}" and give me the to-dos that are still open.`, onChange: fill }));
    view.scrollIntoView({ behavior: "smooth" });
  };
  async function fill() {
    const notes = await api.invoke("notes:list", "");
    list.replaceChildren(...(notes.length
      ? notes.map((n) => itemRow({ urg: n.attention ? "normal" : "", t: n.title, s: n.attention ? `${n.attention} · ${n.preview}` : n.preview, when: ago(n.mtime), onclick: () => open(n.name) }))
      : [h("div", { class: "empty" }, h("b", {}, "No notes yet."), h("span", {}, "Record a meeting, or jot a quick note from the chat window."))]));
  }
  await fill();
  root.append(
    ...title("Notes", "Meeting notes and quick notes, saved as Markdown on this computer."),
    h("div", { style: { display: "flex", gap: "8px" } },
      h("button", { class: "btn accent", onclick: () => api.send("room:record") }, "Record a meeting"),
      h("button", { class: "btn", onclick: () => api.send("notes:openFolder") }, "Open folder")),
    list,
    view,
  );
  // "Edit transcript" in the chat window opens a note here.
  let wanted = null;
  try {
    wanted = localStorage.getItem("halo:openNote");
    localStorage.removeItem("halo:openNote");
  } catch { /* just the list */ }
  if (wanted) open(wanted);
};

PAGES.calls = async (root) => {
  const { calls, active, settings } = await api.invoke("calls:list");
  const dur = (c) => {
    const m = Math.round(((c.endedAt ?? Date.now()) - c.startedAt) / 60000);
    return m < 1 ? "under a minute" : `${m} min`;
  };
  const fmt = (t) => new Date(t).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const weekStart = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); })();
  const week = calls.filter((c) => c.startedAt >= weekStart);
  const minutes = week.reduce((m, c) => m + ((c.endedAt ?? Date.now()) - c.startedAt) / 60000, 0);
  const stat = (k, v, s) => h("div", { class: "stat" }, h("div", { class: "k" }, k), h("div", { class: "v" }, v), h("div", { class: "s" }, s));
  const view = h("div");
  root.append(
    ...title("Calls", "Halo notices Zoom, Teams, Google Meet, Webex, Slack huddles and FaceTime calls, offers to take notes, and keeps a log here."),
    active ? card(setRow(`On a ${active.app} call now`, `${active.title} · started ${fmt(active.startedAt)}`, active.recorded ? chip("ok", "Taking notes") : h("button", { class: "btn accent", onclick: () => api.send("calls:takeNotes") }, "Take notes"))) : null,
    h("div", { class: "stats" },
      stat("Calls this week", String(week.length), `${week.filter((c) => c.recorded).length} with notes`),
      stat("Time in calls", `${Math.round(minutes / 6) / 10} h`, "this week"),
      stat("Longest", week.length ? dur(week.reduce((a, b) => ((a.endedAt ?? Date.now()) - a.startedAt > (b.endedAt ?? Date.now()) - b.startedAt ? a : b))) : "–", "this week"),
      stat("All calls", String(calls.length), "logged by Halo"),
    ),
    label("Log"),
    card(...(calls.length
      ? calls.slice(0, 60).map((c) => itemRow({
          urg: c.recorded ? "good" : "",
          t: `${c.app} · ${c.title}`,
          s: `${fmt(c.startedAt)} · ${c.endedAt ? dur(c) : "in progress"}${c.noteTitle ? ` · notes: ${c.noteTitle}` : c.recorded ? " · notes on the way" : " · no notes"}`,
          onclick: () => {
            if (!c.noteName) return;
            view.replaceChildren(noteView(c.noteName, { askPrompt: (file) => `Read my meeting notes at "${file}" and list the to-dos that are still open.`, askLabel: "Open to-dos" }));
            view.scrollIntoView({ behavior: "smooth" });
          },
        }))
      : [h("div", { class: "empty" }, h("b", {}, "No calls yet."), h("span", {}, "Join a call and Halo will offer to take notes."))])),
    view,
    label("Settings"),
    card(
      setRow("Notice calls", "Looks at window names every 15 seconds. Nothing is recorded unless you say so.", toggle(settings.detect, (v) => api.invoke("calls:set", { detect: v }))),
      setRow("Offer to take notes", "A speech bubble when a call starts.", toggle(settings.offerNotes, (v) => api.invoke("calls:set", { offerNotes: v }))),
      setRow("Stop when the call ends", "Finish the notes automatically when the call window closes.", toggle(settings.autoStop, (v) => api.invoke("calls:set", { autoStop: v }))),
    ),
  );
};
api.on("calls:changed", () => page === "calls" && render());

PAGES.recap = async (root) => {
  let period = PAGES.recap.period ?? "day";
  const draw = async () => {
    const { stats, latest } = await api.invoke("recap:get", period);
    const stat = (k, v, s) => h("div", { class: "stat" }, h("div", { class: "k" }, k), h("div", { class: "v" }, v), h("div", { class: "s" }, s));
    const out = h("div");
    const btn = h("button", { class: "btn white" }, latest ? "Write it again" : `Recap my ${period}`);
    btn.addEventListener("click", async () => {
      btn.textContent = "Writing your recap…";
      btn.disabled = true;
      const res = await api.invoke("recap:write", period);
      if (!res.ok) { btn.textContent = "Try again"; btn.disabled = false; out.replaceChildren(card(h("div", { class: "empty" }, h("b", {}, "The recap didn't finish."), h("span", {}, res.error)))); return; }
      draw();
    });
    root.replaceChildren(
      ...title("Recap", "What you got done. The numbers come from Halo; the written recap reads GitHub, Jira, Ninety, Slack, your calendar and your meeting notes."),
      h("div", {}, seg(period, [["day", "Today"], ["week", "This week"]], (v) => { period = v; PAGES.recap.period = v; draw(); })),
      h("div", { class: "hero" }, h("h2", {}, period === "week" ? "Your week" : "Your day"), h("p", {}, latest ? `Last written ${ago(latest.at)}.` : "Halo hasn't written this recap yet."), btn),
      h("div", { class: "stats" },
        stat("Chats with Halo", String(stats.chats), period === "week" ? "this week" : "today"),
        stat("Calls", String(stats.calls), `${stats.callMinutes} min · ${stats.recorded} with notes`),
        stat("Notes written", String(stats.notes), "meetings and quick notes"),
        stat("Things handled", String(stats.handled), "marked Done"),
      ),
      out,
    );
    if (latest) out.replaceChildren(h("div", { class: "note-view" }, h("div", { class: "text", html: renderMarkdown(latest.markdown) })));
  };
  await draw();
};

PAGES.activity = async (root) => {
  const t = await api.invoke("today:get");
  root.append(
    ...title("Activity", "Everything Halo noticed recently."),
    card(...(t.alerts.length
      ? t.alerts.map((a) => itemRow({ urg: a.tone === "bad" ? "high" : a.tone === "good" ? "good" : "normal", t: a.title, s: a.body, when: ago(a.at), svc: a.source, onclick: () => openUrl(a.url) }))
      : [h("div", { class: "empty" }, h("b", {}, "Nothing yet."), h("span", {}, "Alerts from GitHub, Jira, Slack, Ninety and your pieces show up here."))])),
  );
};

// ── settings pages ────────────────────────────────────────────────────────────

PAGES.general = (root) => {
  const st = S.settings;
  root.append(
    ...title("General"),
    card(
      setRow("Open Halo when I log in", null, toggle(st.launchAtLogin, (v) => save({ launchAtLogin: v }))),
      isMac ? setRow("Show in the Dock", "Halo lives on your desktop and in the menu bar either way.", toggle(st.showDock, (v) => save({ showDock: v }))) : null,
      setRow("Where Halo rests", "On your desktop, or docked in the island at the top of the screen. Double-click Halo to switch.", seg(st.docked ? "island" : "desktop", [["desktop", "Desktop"], ["island", "Island"]], (v) => api.send("companion:dock", v === "island"))),
      setRow("Follow my pointer", "Halo walks after your pointer, across windows and screens, and stops just short of it. It holds still while the chat is open.", toggle(st.followPointer, (v) => save({ followPointer: v }))),
      setRow("Size", null, seg(st.size, [["small", "Small"], ["medium", "Medium"], ["large", "Large"]], (v) => save({ size: v }))),
      setRow("Appearance", "Day or night for Halo's windows. The island stays black, like the notch.", seg(st.theme || "light", [["light", "Day"], ["dark", "Night"], ["system", isMac ? "Match my Mac" : "Match Windows"]], (v) => { api.send("app:theme", v); S.settings.theme = v; })),
      setRow("Time zones", health?.timeZones ? `This computer: ${health.timeZones.computer}. Calendar account: ${health.timeZones.account?.zone || "not detected yet"}.` : "Checking…",
        h("button", { class: "btn small", onclick: async (e) => { e.target.textContent = "Checking…"; await api.invoke("settings:detectTimeZone"); await loadHealth(); render(); } }, "Detect again")),
    ),
    label("Halo"),
    card(setRow("Halo", "A little companion. A lot done.", h("button", { class: "btn danger", onclick: () => api.send("app:quit") }, "Quit Halo"))),
  );
  if (!health) loadHealth();
};

PAGES.look = (root) => {
  const st = S.settings;
  const grid = h("div", { class: "chars" }, ...S.characters.map((c) => {
    const cv = h("canvas");
    live.push({ el: cv, b: new Character(cv, { kind: c.id, R: 26 }).start() });
    return h("button", { class: "char", "aria-pressed": String(c.id === st.character), onclick: () => api.send("settings:character", c.id) },
      cv, h("div", { class: "n" }, c.name), h("div", { class: "tg" }, c.tagline), h("div", { class: "mo" }, c.motion));
  }));
  root.append(...title("Look", "Pick who lives on your desktop. Each one has its own personality in chat."), card(grid));
};

PAGES.claude = async (root) => {
  const st = S.settings;
  const hc = health;
  const hooks = await api.invoke("sessions:hooksStatus");
  const review = reviewCard();
  const key = h("input", { type: "password", placeholder: S.secrets.anthropicApiKey ? "Saved (hidden)" : "sk-ant-…", autocomplete: "off" });
  root.append(
    ...title("Claude Code", "Halo runs on your own Claude Code: your login, your connectors and your skills."),
    card(
      setRow("Claude Code", hc ? (hc.claude.version ? `${hc.claude.version} · ${hc.claude.path}` : "Not found. Install it and run claude once to sign in.") : "Checking…",
        hc ? chip(hc.claude.version ? "ok" : "bad", hc.claude.version ? (hc.claude.apiKeySource === "none" ? "Your login" : hc.claude.apiKeySource ? "API key" : "Ready") : "Missing") : null),
      setRow("Model", "Which Claude model answers. Default uses your Claude Code setting.", seg(st.model, [["", "Default"], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"]], (v) => save({ model: v }))),
      setRow("Effort", "Lower is faster; higher thinks longer.", seg(st.effort, [["", "Default"], ["low", "Low"], ["medium", "Medium"], ["high", "High"]], (v) => save({ effort: v }))),
      setRow("Claude Code location", "Found automatically. Set it only if Halo can't find claude.", textInput(st.claudePath, (v) => save({ claudePath: v }), { placeholder: hc?.claude?.path || "" })),
    ),
    label("Your sessions"),
    card(
      setRow("Show my Claude Code sessions", "What your sessions in the terminal, the Claude app and VS Code are doing, on Home. Halo reads the transcripts Claude Code keeps on this computer; nothing is installed into Claude Code and nothing leaves your computer.", toggle(st.watchSessions, (v) => save({ watchSessions: v }))),
      setRow("Approve my sessions from Halo",
        hooks.error
          ? hooks.error
          : `When one of those sessions asks for permission, answer it on Halo's Home card: Allow, Deny or Always. Halo adds its own hooks to ${hooks.file}; you see the exact change first, and a backup is saved. If Halo isn't running, Claude Code asks you as usual.${hooks.installed && !hooks.current ? " The hooks there point to another copy of Halo: press Update." : ""}`,
        hooks.installed && !hooks.current && !hooks.error ? h("button", { class: "btn small", onclick: () => reviewHooks(true) }, "Update") : null,
        hooks.error ? null : toggle(hooks.installed, (v) => reviewHooks(v))),
    ),
    review,
    label("API key (optional)"),
    card(
      setRow("Use my own Anthropic API key", "Off: Halo uses your Claude Code login and makes no separate API calls.", toggle(st.useApiKey, (v) => save({ useApiKey: v }).then(render))),
      st.useApiKey ? h("div", { class: "setrow" }, key,
        h("button", { class: "btn accent", onclick: async () => { S = await api.invoke("settings:secret", { name: "anthropicApiKey", value: key.value.trim() }); render(); } }, "Save"),
        S.secrets.anthropicApiKey ? h("button", { class: "btn danger", onclick: async () => { S = await api.invoke("settings:secret", { name: "anthropicApiKey", value: "" }); render(); } }, "Remove") : null) : null,
    ),
  );
  if (!health) loadHealth();
  if (review) requestAnimationFrame(() => review.scrollIntoView({ block: "nearest", behavior: "smooth" }));
};

// "Approve my sessions from Halo": nothing goes into ~/.claude/settings.json until you've seen the change.
let ccReview = null; // { plan } | { error, retry } | { note }
async function reviewHooks(enable) {
  const plan = await api.invoke("sessions:hooksPlan", { enable });
  if (plan.error) ccReview = { error: plan.error };
  else if (plan.noChange) ccReview = { note: enable ? "Halo's hooks are already in settings.json." : "Halo's hooks aren't in settings.json, so there's nothing to remove." };
  else ccReview = { plan };
  render();
}
async function applyHooks(p, btn) {
  btn.disabled = true;
  btn.textContent = "Writing…";
  const r = await api.invoke("sessions:hooksApply", p.id);
  if (r.ok) {
    const saved = r.backup ? ` The file as it was is saved as ${r.backup}.` : "";
    ccReview = { note: r.enable
      ? `Done. Claude Code sessions you start from now on ask through Halo; ones already open may keep asking in Claude Code until you restart them.${saved}`
      : `Done. Halo's hooks are out of settings.json, and everything else in it is as it was.${saved}` };
  } else ccReview = { error: r.error, retry: r.changed ? p.enable : undefined };
  render();
}
function reviewCard() {
  const close = () => { ccReview = null; render(); };
  if (!ccReview) return null;
  if (ccReview.plan) {
    const p = ccReview.plan;
    const n = (k, word) => `${k} line${k === 1 ? "" : "s"} ${word}`;
    return h("div", { class: "card review" },
      h("div", { class: "setrow" }, h("div", { class: "txt" },
        h("div", { class: "t" }, p.enable ? "Add Halo's hooks to settings.json?" : "Take Halo's hooks out of settings.json?"),
        h("div", { class: "d" }, `${p.file}: ${n(p.diff.added, "added")}, ${n(p.diff.removed, "removed")}. ${p.backup ? `Before writing, Halo saves the file as it is now as ${p.backup}, next to it.` : "The file doesn't exist yet, so Halo creates it."} Only Halo's own groups change; other tools' hooks, such as AI Character's, stay as they are.`))),
      h("div", { class: "diff", role: "region", "aria-label": "The change to settings.json" },
        ...p.diff.lines.map((l) => h("div", { class: l.kind, title: l.kind === "ctx" && l.text.length > 200 ? l.text : null }, l.kind === "ctx" && l.text.length > 200 ? `${l.text.slice(0, 200)}…` : l.text))),
      h("div", { class: "row-end review-actions" }, h("span", { class: "grow" }),
        h("button", { class: "btn", onclick: () => { api.send("sessions:hooksCancel", p.id); close(); } }, "Cancel"),
        h("button", { class: `btn ${p.enable ? "accent" : "danger"}`, onclick: (e) => applyHooks(p, e.target) }, p.enable ? "Add hooks" : "Remove hooks")));
  }
  return h("div", { class: "card review" },
    setRow(ccReview.error ? "Settings.json wasn't changed" : "Settings.json", ccReview.error ?? ccReview.note,
      ccReview.retry !== undefined ? h("button", { class: "btn small accent", onclick: () => reviewHooks(ccReview.retry) }, "Review again") : null,
      h("button", { class: "btn small", onclick: close }, "OK")));
}

PAGES.integrations = (root) => {
  const hc = health;
  const st = S.settings;
  const status = (s) => (s === "connected" ? chip("ok", "Connected") : s === "unknown" ? chip("off", "Check after a chat") : chip("bad", s || "Missing"));
  const desc = { Ninety: "Rocks, To-Dos, Issues, Scorecard and meetings.", Atlassian: "Jira issues and Confluence.", Slack: "Mentions, DMs, channels and threads." };
  root.append(
    ...title("Integrations", "Halo uses the connectors already set up in your Claude Code, plus the gh and acli command-line tools. Add more in claude.ai → Settings → Connectors."),
    label("Claude Code connectors"),
    card(...(hc ? hc.connectors.map((c) => setRow(c.name, desc[c.name] ?? "", status(c.status))) : [setRow("Checking…", null)])),
    label("Command-line tools"),
    card(
      setRow("GitHub CLI (gh)", hc?.gh ? `Signed in: ${hc.gh.accounts.join(", ")}` : "Not installed. Get it from cli.github.com.", hc ? chip(hc.gh?.ok ? "ok" : "bad", hc.gh?.ok ? "Ready" : "Missing") : null),
      setRow("Account for Today and alerts", null, select(st.githubUser, [["", "Active gh account"], ...(hc?.gh?.accounts ?? []).map((a) => [a, a])], (v) => save({ githubUser: v }))),
      setRow("Atlassian CLI (acli)", hc?.acli ? hc.acli.site || "Not signed in" : "Not installed.", hc ? chip(hc.acli?.ok ? "ok" : "bad", hc.acli?.ok ? "Ready" : "Missing") : null),
      setRow("Jira site", null, textInput(st.jiraSite, (v) => save({ jiraSite: v }), { placeholder: "yourcompany.atlassian.net" })),
    ),
    label("Permissions"),
    card(
      isMac ? setRow("Screen recording", "For dropping Halo onto a window to ask about it, and for screen asks. Quit and reopen Halo after you allow it.", hc ? chip(hc.screen === "granted" ? "ok" : "warn", hc.screen === "granted" ? "Allowed" : "Not allowed") : null, h("button", { class: "btn small", onclick: () => api.send("settings:openScreenSettings") }, "Open Settings")) : null,
      isMac ? setRow("Microphone", "For meeting notes.", hc ? chip(hc.mic === "granted" ? "ok" : hc.mic === "not-determined" ? "off" : "warn", hc.mic === "granted" ? "Allowed" : hc.mic === "not-determined" ? "Not asked yet" : "Not allowed") : null) : null,
      setRow("Check everything again", null, h("button", { class: "btn small", onclick: () => { health = null; render(); loadHealth(); } }, "Check")),
    ),
  );
  if (!health) loadHealth();
};

PAGES.alerts = (root) => {
  const a = S.settings.alerts;
  root.append(
    ...title("Alerts", "When something needs you, Halo bounces and shows a speech bubble."),
    card(
      setRow("Show alerts", null, toggle(a.enabled, (v) => save({ alerts: { enabled: v } }))),
      setRow("System notifications too", null, toggle(a.notifications, (v) => save({ alerts: { notifications: v } }))),
      setRow("Check GitHub and Jira", "Runs gh and acli on this computer. No Claude usage.", seg(String(a.localEveryMin), [["2", "2 min"], ["5", "5 min"], ["15", "15 min"], ["0", "Off"]], (v) => save({ alerts: { localEveryMin: Number(v) } }))),
      setRow("Check Slack and Ninety", "Runs through Claude Code, so each check uses a little of your plan.", seg(String(a.claudeEveryMin), [["30", "30 min"], ["60", "1 h"], ["180", "3 h"], ["0", "Off"]], (v) => save({ alerts: { claudeEveryMin: Number(v) } }))),
    ),
  );
};

PAGES.voice = (root) => {
  const t = S.settings.transcription;
  const key = h("input", { type: "password", placeholder: S.secrets.sttApiKey ? "Saved (hidden)" : "Paste key", autocomplete: "off" });
  root.append(
    ...title("Notes and voice", "Meeting audio is transcribed on this computer by default. Nothing is sent anywhere until Claude Code writes the notes from the text."),
    label("Wake word"),
    card(
      setRow(`Listen for “Hey Halo” or “Hey ${S.characters.find((c) => c.id === S.settings.character)?.name ?? "Nova"}”`, "Halo listens on this computer with a tiny speech model and only reacts to the wake phrase. Say the request right after it, or wait for the chime. Say “Hey Halo, stop listening” to turn this off; it stays off until you turn it back on here, with the mic button in Halo's window, or from the menu.", toggle(S.settings.wakeWord?.enabled, (v) => save({ wakeWord: { enabled: v } }))),
      setRow("Wake word model", "Accurate hears “Halo” much more reliably. Fast uses less of your computer.", select(S.settings.wakeWord?.model, [["onnx-community/whisper-base.en", "Accurate (recommended)"], ["onnx-community/whisper-tiny.en", "Fast"]], (v) => save({ wakeWord: { model: v, modelChosen: true } }))),
      setRow("Read answers aloud", "When you ask by voice, Halo says the first lines of its answer. Press Stop to hush it.", toggle(S.settings.wakeWord?.speakReplies, (v) => save({ wakeWord: { speakReplies: v } }))),
    ),
    label("Transcription"),
    card(
      setRow("Transcription", null, seg(t.engine, [["local", "On this computer"], ["openai-compatible", "A speech-to-text service"]], (v) => save({ transcription: { engine: v } }).then(render))),
      ...(t.engine === "local"
        ? [setRow("Speech model", "Downloads once, then works offline.", select(t.localModel, [["onnx-community/whisper-tiny", "Whisper Tiny (fastest)"], ["onnx-community/whisper-base", "Whisper Base"], ["onnx-community/whisper-small", "Whisper Small (best)"]], (v) => save({ transcription: { localModel: v } })), h("button", { class: "btn small", onclick: () => api.send("notes:warmup") }, "Download now"))]
        : [
            setRow("Service URL", "Any OpenAI-compatible /audio/transcriptions endpoint.", textInput(t.baseUrl, (v) => save({ transcription: { baseUrl: v } }))),
            setRow("Model", null, textInput(t.model, (v) => save({ transcription: { model: v } }))),
            h("div", { class: "setrow" }, key, h("button", { class: "btn accent", onclick: async () => { S = await api.invoke("settings:secret", { name: "sttApiKey", value: key.value.trim() }); render(); } }, "Save key")),
          ]),
      setRow("Notes folder", null, textInput(S.settings.notesDir, (v) => save({ notesDir: v }))),
    ),
  );
};

PAGES.shortcuts = (root) => {
  const sc = S.settings.shortcuts;
  const row = (k, t, d) => setRow(t, d, textInput(sc[k], (v) => save({ shortcuts: { [k]: v } })));
  root.append(
    ...title("Shortcuts", `Use names like CommandOrControl+Shift+Space. ${isMac ? "CommandOrControl is ⌘ here." : "CommandOrControl is Ctrl here."}`),
    card(
      row("toggle", "Open or hide the chat"),
      row("screen", "Show Halo my screen"),
      row("snip", "Snip a region"),
      row("record", "Start or stop a meeting recording"),
      row("dictate", "Talk to Halo (mic in the chat box)"),
      setRow("Show Halo a window", "Drag Halo over a window and hold still for a moment (about 1.5 seconds): it lights up, and when you let go Halo tells you what's happening in it. A quick drag just moves Halo.", h("span", { class: "chip off" }, "Drag, hold, let go")),
    ),
  );
};

loadHealth();
go(new URLSearchParams(location.search).get("page") || "home");

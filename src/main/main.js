// Halo: app start-up and wiring between the companion, the panel, Claude
// Code, approvals, screen capture, Today data and meeting notes.

import { app, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, Notification, session, shell, systemPreferences, Tray, desktopCapturer, utilityProcess } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHARACTERS, characterById } from "../shared/characters-meta.js";
import { ApprovalServer } from "./approvals.js";
import { Capturer, openScreenSettings, screenPermission } from "./capture.js";
import { ChatManager } from "./chat.js";
import { claudeVersion, hookCommand, resolveClaude, writeHookSettings } from "./claude-bridge.js";
import { githubToken, jiraSite } from "./dashboard.js";
import { loadUserPath, run, which } from "./env.js";
import { Notes, Transcriber } from "./notes.js";
import { Store } from "./store.js";
import { Watcher } from "./watcher.js";
import { CompanionWindow, CHAR, IslandWindow, PanelWindow, RoomWindow } from "./windows.js";
import { listHistory, listSkills, Memory, readHistory, skillsHelp } from "./library.js";
import { Pieces } from "./pieces.js";
import { CallWatcher } from "./calls.js";
import { latestRecap, periodRange, recapStats, writeRecap } from "./recap.js";
import { SessionWatcher, sessionTurns } from "./sessions.js";
import { CcPermissionServer } from "./cc-permissions.js";
import { applyPlan, cancelPlan, hookStatus, planHooks } from "./cc-settings.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..", "..");
const isMac = process.platform === "darwin";

// Logging to a terminal that has since closed must never crash Halo.
for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});

// HALO_PROFILE=<folder>: a separate copy with its own settings and data (for development).
if (process.env.HALO_PROFILE) app.setPath("userData", path.resolve(process.env.HALO_PROFILE));
if (!app.requestSingleInstanceLock()) app.quit();

// System audio for the notetaker on macOS is best effort (Windows supports it natively).
if (isMac) app.commandLine.appendSwitch("enable-features", "MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride");
app.setName("Halo");

// HALO_DEBUG=1: print what the windows log (wake word, errors) to the terminal.
if (process.env.HALO_DEBUG) {
  app.on("web-contents-created", (_e, wc) => {
    wc.on("console-message", (e) => console.log(`[${path.basename(wc.getURL().split("?")[0]) || "page"}] ${e.message}`));
  });
}

let store, approvals, chat, companion, panel, room, island, memory, pieces, calls, sessions, capturer, transcriber, notes, watcher, tray;
let ccPerms; // permission requests from your own Claude Code sessions (when that is on)
let ghToken = "";
let lastInit = null;

// ── Halo's mood (one state shown on the character) ────────────────────────────

const mood = { chat: null, approvals: 0, recording: false, flash: null, flashUntil: 0, sent: null };

function computeMood() {
  if (mood.approvals > 0) return "alert";
  if (mood.flash && Date.now() < mood.flashUntil) return mood.flash;
  if (mood.recording) return "listening";
  if (mood.conversing) return "listening"; // waiting for your spoken reply
  return mood.chat ?? "idle";
}

function pushMood() {
  const s = computeMood();
  if (s === mood.sent) return;
  mood.sent = s;
  companion?.send("companion:state", s);
  island?.send("companion:state", s);
  // The chat window shows "listening" only for meeting notes; a spoken reply shows in the chat itself.
  panel?.send("panel:mood", s === "listening" && !mood.recording ? (mood.chat ?? "idle") : s);
}

/** Halo's own approvals plus your Claude Code sessions' permission requests. */
const openApprovals = () => (approvals?.list().length ?? 0) + (ccPerms?.list().length ?? 0);

/** The command in ~/.claude/settings.json that runs the hook for your own sessions. */
const ccHookCommand = () => hookCommand(path.join(here, "..", "hook", "halo-cc-hook.cjs"));

function isInside(dir, p) {
  if (!dir || !p) return false;
  const norm = (x) => (process.platform === "linux" ? path.resolve(x) : path.resolve(x).toLowerCase());
  const rel = path.relative(norm(dir), norm(p));
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function pushBadge() {
  const n = openApprovals() + (watcher?.alerts.filter((a) => !a.read).length ?? 0);
  island?.send("island:badge", n);
}

function flash(state, ms) {
  mood.flash = state;
  mood.flashUntil = Date.now() + ms;
  pushMood();
  setTimeout(pushMood, ms + 30);
}

function bubble(b) {
  if (store?.get("docked")) {
    // Resting in the island: the desktop bubble is hidden, so use a system notification for things that matter.
    if (b.kind === "alert" && Notification.isSupported() && !panel?.win?.isFocused()) {
      const n = new Notification({ title: b.title || "Halo", body: b.body || "", silent: true });
      n.on("click", () => openPanel(b.action?.tab));
      n.show();
    }
    return;
  }
  companion?.send("companion:bubble", b);
}

function openPanel(tab) {
  if (tab === "settings") return room.open("general");
  if (store.get("docked") && island.isVisible()) {
    const { display, top } = island.bottom();
    panel.showDocked(display, top);
    if (tab) panel.send("panel:tab", tab);
  } else panel.showNear(companion.charScreenPoint(), tab);
}

function togglePanel() {
  if (panel.isVisible() && panel.win.isFocused()) panel.hide();
  else openPanel();
}

// ── resting in the island (double-click) and back on the desktop ──────────────

function dock() {
  if (store.get("docked")) return;
  store.set("docked", true);
  const g = island.geometry();
  const b = g.display.bounds;
  const x = Math.round(b.x + b.width / 2 - CHAR.x);
  const y = Math.round(b.y + g.height / 2 - CHAR.y);
  companion.send("companion:hideBubble");
  companion.animateTo(x, y, () => {
    companion.win?.hide();
    island.show();
    setTimeout(() => { pushMood(); pushBadge(); }, 400);
  });
  setupTray();
}

/** Back on the desktop. `point.carry`: pulled out of the island, and still being dragged. */
function undock(point) {
  if (!store.get("docked")) return;
  store.set("docked", false);
  let pos = companion.restorePosition();
  if (point?.carry) pos = { x: Math.round(point.screenX - CHAR.x), y: Math.round(point.screenY - CHAR.y) };
  else if (point) pos = companion.clamp(Math.round(point.screenX - CHAR.x), Math.round(point.screenY - CHAR.y + 30));
  // While carried, the island stays (invisible) to keep receiving the drag.
  if (point?.carry) island.win?.setOpacity(0);
  else island.hide();
  companion.win?.setBounds({ x: pos.x, y: pos.y, width: companion.win.getBounds().width, height: companion.win.getBounds().height });
  companion.win?.showInactive();
  if (point?.carry) companion.dragStart(point);
  companion.savePosition();
  companion.send("companion:emote", "surprised");
  mood.sent = null;
  pushMood();
  setupTray();
}

// ── start-up ──────────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  await loadUserPath();
  store = new Store();
  if (isMac && !store.get("showDock")) app.dock?.hide();
  nativeTheme.themeSource = store.get("theme") || "light";

  approvals = new ApprovalServer({ writable: () => ({ notesDir: store.get("notesDir"), memoryFile: memory?.file }) });
  await approvals.start();
  // Your own Claude Code sessions ask here only once you turn that on (Settings → Claude Code).
  ccPerms = new CcPermissionServer({
    infoFile: path.join(app.getPath("userData"), "cc-hook.json"),
    skip: (m) => isInside(store.get("workspaceDir"), m.cwd), // Halo's own chats
  });
  await ccPerms.start().catch((e) => console.error("[halo] Claude Code permission server:", e.message));
  const settingsFile = writeHookSettings(path.join(app.getPath("userData"), "claude-hook-settings.json"), path.join(here, "..", "hook", "approval-hook.cjs"));
  memory = new Memory(store);
  chat = new ChatManager({ store, approvals, settingsFile, memory });

  setupPermissions();

  companion = new CompanionWindow(store, {
    onDropOnWindow: (w) => showWindowToHalo(w),
    // Following the pointer pauses while the chat sits next to Halo or something needs an answer.
    holdStill: () => panel?.isVisible() || mood.approvals > 0 || mood.recording,
  });
  companion.create();
  if (process.env.HALO_DEBUG) companion.win.once("show", () => console.log("[halo] companion bounds", JSON.stringify(companion.win.getBounds())));
  panel = new PanelWindow(store);
  panel.create();
  room = new RoomWindow();
  island = new IslandWindow(store);
  if (store.get("docked")) {
    companion.win.once("ready-to-show", () => companion.win.hide());
    island.show();
  }

  capturer = new Capturer({
    hideAll: async () => {
      companion.win?.setOpacity(0);
      island.win?.setOpacity(0);
      const wasVisible = panel.isVisible();
      capturer.panelWasVisible = wasVisible;
      if (wasVisible) panel.win.hide();
      await new Promise((r) => setTimeout(r, 180));
    },
    showAll: () => {
      companion.win?.setOpacity(1);
      island.win?.setOpacity(1);
    },
  });

  transcriber = new Transcriber(store);
  // Have the wake word's model loaded before the first "Hey Halo".
  if (store.get("wakeWord.enabled")) setTimeout(() => transcriber.warmup(store.get("wakeWord.model")), 1500);
  notes = new Notes({ store, chat, transcriber });
  watcher = new Watcher({ store, chat, githubToken: () => ghToken, jiraSite: () => store.get("jiraSite") });
  pieces = new Pieces({ store, chat });
  pieces.on("changed", (list) => room.send("pieces:changed", list));
  pieces.on("result", ({ piece, data, error }) => {
    if (error) {
      bubble({ title: `${piece.name} didn't finish`, body: error.split("\n")[0], kind: "alert" });
      return;
    }
    for (const it of (data.items ?? []).slice(0, 8)) {
      watcher.alert({ source: it.source || "halo", title: it.text, body: piece.name, url: it.url || null, tone: it.urgency === "high" ? "bad" : undefined, silent: true });
    }
    bubble({ title: data.title || piece.name, body: data.summary || "Nothing needs you.", action: { tab: "today" }, timeoutMs: 15000 });
    flash(data.items?.length ? "alert" : "done", 4000);
    pushBadge();
  });
  pieces.start();

  // Calls: offer to take notes when a call starts, finish them when it ends.
  calls = new CallWatcher(store);
  calls.on("started", (c) => {
    room.send("calls:changed");
    if (mood.recording || !store.get("calls.offerNotes")) return;
    bubble({ title: `You're on a ${c.app} call`, body: "Want me to take notes? Click here and I'll start.", kind: "alert", action: { call: c.id }, timeoutMs: 45000 });
    if (store.get("docked") && Notification.isSupported()) {
      const n = new Notification({ title: `You're on a ${c.app} call`, body: "Click to have Halo take notes.", silent: true });
      n.on("click", () => startCallNotes(c));
      n.show();
    }
  });
  calls.on("ended", (c) => {
    room.send("calls:changed");
    if (mood.recording && c.recorded && store.get("calls.autoStop")) {
      panel.send("notes:stopIfRecording");
      bubble({ title: "Call ended", body: "Writing your notes now.", timeoutMs: 8000 });
    }
  });
  calls.start();

  // Your Claude Code sessions (terminal, the Claude app, VS Code), read from their transcripts.
  sessions = new SessionWatcher({ exclude: () => [store.get("workspaceDir")] });
  sessions.on("changed", (list) => {
    panel.send("sessions:changed", list);
    room.send("sessions:changed", list);
    announceSessions(list);
  });
  if (store.get("watchSessions")) sessions.start();

  wireChat();
  wireApprovals();
  wireWatcher();
  wireNotes();
  wireIpc();
  setupTray();
  registerShortcuts();
  if (store.get("launchAtLogin")) app.setLoginItemSettings({ openAtLogin: true });

  // Background: tokens and sites for the dashboard, then the first refresh.
  (async () => {
    ghToken = await githubToken(store.get("githubUser"));
    chat.setGithubToken(ghToken);
    if (!store.get("jiraSite")) {
      const site = await jiraSite();
      if (site) store.set("jiraSite", site);
    }
    watcher.start();
    chat.detectAccountTimeZone().catch(() => {});
  })();

  setTimeout(() => {
    const ch = characterById(store.get("character"));
    bubble({ title: `Hi, I'm ${ch.name}!`, body: "Click me to chat, or right-click for more.", timeoutMs: 6000 });
    companion.send("companion:emote", "happy");
  }, 1200);
});

app.on("second-instance", () => openPanel());
app.on("window-all-closed", (e) => e.preventDefault());
app.on("before-quit", () => {
  calls?.stop();
  sessions?.stop();
  panel && (panel.quitting = true);
  room && (room.quitting = true);
  store?.flush();
  chat?.dispose();
  approvals?.stop();
  ccPerms?.stop();
  transcriber?.dispose();
  globalShortcut.unregisterAll();
});

function setupPermissions() {
  const ses = session.defaultSession;
  // Only our own pages run here; allow the microphone and screen picker for the notetaker.
  ses.setPermissionRequestHandler((wc, permission, cb) => {
    const ok = wc.getURL().startsWith("file://") && ["media", "display-capture", "clipboard-sanitized-write"].includes(permission);
    cb(ok);
  });
  // getDisplayMedia from the notetaker: whole screen video (discarded) + system audio.
  ses.setDisplayMediaRequestHandler(async (_req, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen"] });
      callback({ video: sources[0], audio: "loopback" });
    } catch {
      callback({});
    }
  });
}

// ── chat ──────────────────────────────────────────────────────────────────────

function wireChat() {
  let lastTalk = 0;
  let answer = "";
  chat.on("event", (ev) => {
    panel.send("chat:event", ev);
    switch (ev.type) {
      case "sent":
        answer = "";
        mood.chat = "thinking";
        break;
      case "init":
        lastInit = ev.data;
        break;
      case "toolStart":
        mood.chat = "working";
        break;
      case "toolResult":
        mood.chat = "thinking";
        break;
      case "text": {
        answer += ev.data;
        mood.chat = "talking";
        const now = Date.now();
        if (now - lastTalk > 90) {
          companion.send("companion:talk");
          island.send("companion:talk");
          lastTalk = now;
        }
        break;
      }
      case "result":
        mood.chat = null;
        if (ev.data.ok) {
          flash("done", 2200);
          if (!panel.isVisible() || !panel.win.isFocused()) {
            const name = characterById(store.get("character")).name;
            const text = (ev.data.text || answer).replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim();
            bubble({ title: `${name} has an answer`, body: text.slice(0, 140) + (text.length > 140 ? "…" : ""), action: { tab: "chat" }, timeoutMs: 12000 });
          }
        } else flash("error", 4000);
        break;
      case "error":
        mood.chat = null;
        flash("error", 4000);
        if (!panel.isVisible()) bubble({ title: "Something went wrong", body: ev.data.message.split("\n")[0], action: { tab: "chat" }, kind: "alert" });
        break;
      case "stopped":
      case "cleared":
        mood.chat = null;
        break;
    }
    pushMood();
  });
}

// ── approvals ─────────────────────────────────────────────────────────────────

function wireApprovals() {
  approvals.on("request", (req) => {
    mood.approvals = openApprovals();
    pushMood();
    pushBadge();
    panel.send("approval:request", req);
    if (!panel.isVisible()) {
      bubble({ title: "Needs your OK", body: req.title, kind: "alert", action: { tab: "chat" }, timeoutMs: 0 });
    }
  });
  approvals.on("resolved", (r) => {
    mood.approvals = openApprovals();
    pushMood();
    pushBadge();
    panel.send("approval:resolved", r);
    if (!mood.approvals) companion.send("companion:hideBubble");
  });

  // Your own Claude Code sessions: the card is on Home, in the session card.
  ccPerms.on("changed", (list) => {
    mood.approvals = openApprovals();
    pushMood();
    pushBadge();
    sessions.setPermissions(list);
    panel.send("sessions:permissions", list);
  });
  ccPerms.on("request", (r) => {
    if (!panel.isVisible()) bubble({ title: `${r.project} needs permission`, body: [r.title, r.text].filter(Boolean).join(": ").slice(0, 140), kind: "alert", action: { tab: "home" }, timeoutMs: 0 });
  });
  ccPerms.on("resolved", () => { if (!openApprovals()) companion.send("companion:hideBubble"); });
  ccPerms.on("event", (ev) => sessions.hookEvent(ev));
}

// ── your Claude Code sessions: say when one finishes or asks you something ────

const seenSessions = new Map(); // session id → what it was doing at the last look

function announceSessions(list) {
  for (const { kind, session: s } of sessionTurns(seenSessions, list)) {
    const done = kind === "done";
    const title = done ? "Claude session finished" : `${s.project} needs you`;
    const text = done ? `${s.project}: ${s.final}` : s.doing;
    const body = text.length > 100 ? `${text.slice(0, 99)}…` : text;
    flash(done ? "done" : "alert", done ? 2200 : 6000);
    // A click opens Home in Halo's window, where the session's card is.
    if (!panel.isVisible() || !panel.win.isFocused()) bubble({ title, body, kind: done ? "good" : "info", action: { tab: "home" }, timeoutMs: done ? 12000 : 30000 });
    if (!panel.isVisible() && store.get("alerts.notifications") && Notification.isSupported()) {
      const n = new Notification({ title, body, silent: true });
      n.on("click", () => openPanel("home"));
      n.show();
    }
  }
}

// ── Today + alerts ────────────────────────────────────────────────────────────

function wireWatcher() {
  watcher.on("data", (d) => {
    panel.send("today:data", d);
    room.send("today:data", d);
    pushBadge();
  });
  watcher.on("alert", (a) => {
    pushBadge();
    if (!store.get("alerts.enabled") || a.silent) return;
    flash("alert", 6000);
    bubble({ title: a.title, body: a.body, kind: "alert", action: { tab: "today" }, timeoutMs: 15000 });
    if (store.get("alerts.notifications") && Notification.isSupported() && !panel.win?.isFocused()) {
      const n = new Notification({ title: a.title, body: a.body, silent: true });
      n.on("click", () => (a.url ? shell.openExternal(a.url) : openPanel("today")));
      n.show();
    }
  });
}

// ── notes ─────────────────────────────────────────────────────────────────────

function wireNotes() {
  notes.on("status", (s) => {
    if (s.recording && !mood.recording) {
      if (calls?.active) calls.attach({ recorded: true });
      else calls?.manual(s.title);
    }
    if (!s.recording && mood.recording) calls?.endManual();
    mood.recording = !!s.recording;
    if (s.summarizing) mood.chat = "working";
    else if (mood.chat === "working" && !chat.busy) mood.chat = null;
    pushMood();
    panel.send("notes:status", s);
    setupTray();
  });
  notes.on("transcript", (t) => panel.send("notes:transcript", t));
  notes.on("saved", (n) => {
    calls?.attach({ noteName: n.name, noteTitle: n.title });
    room.send("calls:changed");
    panel.send("notes:saved", n);
    flash("done", 2200);
    if (!panel.isVisible()) bubble({ title: "Notes saved", body: n.title, action: { tab: "notes" } });
  });
  transcriber.on("progress", (p) => panel.send("notes:modelProgress", p));
  transcriber.on("ready", (p) => panel.send("notes:modelReady", p));
}

/** Day / night / system. Every window follows prefers-color-scheme, which this sets. */
function setTheme(v) {
  const theme = ["light", "dark", "system"].includes(v) ? v : "light";
  store.set("theme", theme);
  store.set("themeChosen", true);
  nativeTheme.themeSource = theme;
  panel.win?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#121317" : "#F3F3F6");
  room.win?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#171A23" : "#F6F6F8");
}

// ── IPC from the pages ────────────────────────────────────────────────────────

function safeUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

async function health() {
  const bin = resolveClaude(store.get("claudePath"));
  const [version, gh, acli] = await Promise.all([
    claudeVersion(bin),
    which("gh") ? run(which("gh"), ["auth", "status"], { timeout: 15000 }) : null,
    which("acli") ? run(which("acli"), ["jira", "auth", "status"], { timeout: 15000 }) : null,
  ]);
  const want = ["Ninety", "Atlassian", "Slack"];
  const servers = lastInit?.mcpServers ?? [];
  return {
    claude: { path: bin, version, apiKeySource: lastInit?.apiKeySource ?? null, model: lastInit?.model ?? null },
    gh: gh ? { ok: gh.ok, accounts: [...(gh.stdout + gh.stderr).matchAll(/account (\S+)/g)].map((m) => m[1]) } : null,
    acli: acli ? { ok: acli.ok && /Authenticated/.test(acli.stdout), site: /Site:\s*(\S+)/.exec(acli.stdout)?.[1] ?? "" } : null,
    connectors: want.map((name) => {
      const s = servers.find((x) => x.name === `claude.ai ${name}` || x.name.toLowerCase().includes(name.toLowerCase()));
      return { name, status: s?.status ?? (lastInit ? "missing" : "unknown") };
    }),
    screen: screenPermission(),
    mic: isMac ? systemPreferences.getMediaAccessStatus("microphone") : "granted",
    rateLimit: chat.lastRateLimit,
    timeZones: { computer: Intl.DateTimeFormat().resolvedOptions().timeZone, account: store.get("accountTimeZone") },
  };
}

function settingsPayload() {
  return {
    settings: store.all(),
    secrets: { anthropicApiKey: store.hasSecret("anthropicApiKey"), sttApiKey: store.hasSecret("sttApiKey") },
    characters: CHARACTERS.map(({ id, name, tagline, motion }) => ({ id, name, tagline, motion })),
    platform: process.platform,
  };
}

/**
 * "Hey Halo" on or off: the mic button in Halo's window, the menu, Settings, or
 * saying "Hey Halo, stop listening". Off stays off until it's turned on again here.
 */
function setWakeWord(on, { byVoice = false } = {}) {
  store.set("wakeWord.enabled", !!on);
  const payload = settingsPayload();
  panel.send("settings:changed", payload);
  room.send("settings:changed", payload);
  setupTray();
  if (!on && byVoice) {
    bubble({ title: "I've stopped listening", body: "I won't answer to “Hey Halo” until you turn it back on: the mic button in my window, or right-click me.", timeoutMs: 10000 });
  }
}

let micWarned = false;

/** How to turn the microphone on, for this platform and this way of running Halo. */
function micHelp() {
  if (!isMac) return "Halo can't use the microphone. Turn on “Let desktop apps access your microphone” in Settings → Privacy & security → Microphone.";
  if (!app.isPackaged) return "Halo can't use the microphone. Running from a terminal, macOS asks on behalf of that app (Terminal, iTerm or VS Code): turn it on in System Settings → Privacy & Security → Microphone, then restart Halo.";
  return "Halo can't use the microphone. Turn on Halo in System Settings → Privacy & Security → Microphone, then reopen Halo.";
}

// Your time with your agents, counted in a background process (a week of transcripts takes seconds).
const agentCache = new Map(); // period → { at, result }
function agentRecap(period) {
  const hit = agentCache.get(period);
  if (hit && Date.now() - hit.at < 3 * 60_000) return hit.result;
  const result = new Promise((resolve) => {
    const child = utilityProcess.fork(path.join(here, "agent-recap-worker.mjs"), [], { serviceName: "Halo Recap", stdio: "ignore" });
    child.once("message", (m) => {
      resolve(m);
      child.kill();
    });
    child.once("exit", () => resolve({ ok: false, error: "Counting stopped before it finished." }));
    child.postMessage({ ...periodRange(period), exclude: [store.get("workspaceDir")] });
  });
  agentCache.set(period, { at: Date.now(), result });
  return result;
}

/** "Follow my pointer" on or off: the menu, Settings → General, or "stop following me" in the chat or out loud. */
function setFollowPointer(on) {
  store.set("followPointer", !!on);
  const payload = settingsPayload();
  panel.send("settings:changed", payload);
  room.send("settings:changed", payload);
  setupTray();
}

function setCharacter(id) {
  if (!CHARACTERS.some((c) => c.id === id)) return;
  store.set("character", id);
  companion.send("companion:kind", id);
  island.send("companion:kind", id);
  panel.send("settings:changed", settingsPayload());
  room.send("settings:changed", settingsPayload());
  // The personality is part of the session's system prompt, so a new
  // character starts a fresh chat (unless one is mid-answer).
  if (!chat.busy) chat.newChat();
  setupTray();
}

/** The companion was dropped on a window: capture just that window and ask about it. */
async function showWindowToHalo(w) {
  if (screenPermission() === "denied" || screenPermission() === "restricted") {
    bubble({ title: "Let me see your screen", body: "Turn on Screen Recording for Halo in System Settings → Privacy & Security, then drop me on the window again.", kind: "alert", action: { tab: "settings" } });
    openScreenSettings();
    return;
  }
  try {
    const img = await capturer.captureWindow(w);
    companion.send("companion:emote", "happy");
    openPanel("chat");
    panel.send("chat:attach", { ...img, autoSend: true });
  } catch (e) {
    bubble({ title: "I couldn't see that window", body: e.message, kind: "alert" });
  }
}

async function askAboutScreen(region = false) {
  if (screenPermission() === "denied" || screenPermission() === "restricted") {
    openPanel("chat");
    panel.send("chat:notice", { kind: "permission", text: "Halo needs Screen Recording permission. Turn it on in System Settings, then try again." });
    openScreenSettings();
    return;
  }
  try {
    const img = region ? await capturer.snip() : await capturer.captureScreen();
    if (!img) {
      if (capturer.panelWasVisible) openPanel();
      return;
    }
    openPanel("chat");
    panel.send("chat:attach", img);
  } catch (e) {
    openPanel("chat");
    panel.send("chat:notice", { kind: "error", text: e.message });
  }
}

function wireIpc() {
  ipcMain.handle("app:state", () => ({ character: store.get("character"), size: store.get("size"), platform: process.platform }));

  // companion
  ipcMain.on("companion:click", () => togglePanel());
  ipcMain.on("companion:menu", () => buildMenu().popup({ window: companion.win }));
  ipcMain.on("companion:dragStart", (_e, p) => companion.dragStart(p));
  ipcMain.on("companion:dragMove", (_e, p) => companion.dragMove(p));
  ipcMain.on("companion:dragEnd", () => companion.dragEnd());
  ipcMain.on("companion:bubbleRect", (_e, r) => companion.setBubbleRect(r));
  ipcMain.on("companion:asleep", (_e, a) => companion.setAsleep(!!a));
  ipcMain.on("companion:bubbleClick", (_e, action) => {
    if (action?.call && calls?.active?.id === action.call) return startCallNotes(calls.active);
    if (action?.url && safeUrl(action.url)) shell.openExternal(action.url);
    else openPanel(action?.tab);
  });

  // panel
  ipcMain.on("panel:hide", () => panel.hide());
  ipcMain.on("panel:pin", (_e, pinned) => panel.setPinned(!!pinned));
  ipcMain.on("panel:openExternal", (_e, u) => {
    const url = safeUrl(u);
    if (url) shell.openExternal(url);
  });
  ipcMain.handle("panel:mood", () => computeMood());

  // chat
  ipcMain.on("chat:send", (_e, msg) => chat.send(msg));
  ipcMain.on("chat:stop", () => chat.stop());
  ipcMain.on("chat:new", () => chat.newChat());
  ipcMain.on("chat:resume", (_e, id) => chat.resume(id));
  ipcMain.handle("chat:recent", () => store.get("recentChats"));
  ipcMain.handle("chat:info", () => ({ busy: chat.busy, chatId: chat.chatId, character: store.get("character") }));

  // approvals
  ipcMain.handle("approval:list", () => approvals.list());
  ipcMain.on("approval:answer", (_e, { id, allow, remember }) => approvals.answer(id, { allow: !!allow, remember: !!remember }));

  // room, memory, skills, history, pieces
  ipcMain.on("room:open", (_e, arg) => {
    const page = typeof arg === "object" && arg ? arg.page : arg;
    // Settings opened from the chat window: the chat steps aside for the big window.
    if (arg?.fromPanel || page === "general") panel.hide();
    room.open(page || "home");
  });
  ipcMain.on("room:ask", (_e, prompt) => {
    openPanel("chat");
    setTimeout(() => panel.send("chat:prompt", String(prompt || "")), 200);
  });
  ipcMain.on("room:record", () => toggleRecording());
  ipcMain.on("panel:fullscreen", () => panel.toggleFullScreen());
  ipcMain.on("app:theme", (_e, v) => setTheme(v));
  ipcMain.on("today:dismiss", (_e, id) => watcher.dismiss(String(id)));
  ipcMain.handle("memory:get", () => ({ file: memory.file, items: memory.items() }));
  ipcMain.handle("memory:add", (_e, t) => memory.add(t));
  ipcMain.handle("memory:remove", (_e, i) => memory.remove(Number(i)));
  ipcMain.handle("skills:list", () => ({ skills: listSkills(lastInit), help: skillsHelp() }));
  ipcMain.handle("history:list", () => listHistory(store));
  ipcMain.handle("history:read", (_e, id) => readHistory(store, String(id)));
  ipcMain.on("history:resume", (_e, id) => {
    const c = listHistory(store).find((x) => x.id === id);
    chat.resume(id);
    openPanel("chat");
    panel.send("chat:resumeUi", { id, title: c?.title ?? "Chat" });
  });
  ipcMain.handle("pieces:list", () => pieces.list());
  ipcMain.handle("pieces:save", (_e, p) => {
    try {
      return pieces.save(p);
    } catch (e) {
      return { error: e.message };
    }
  });
  ipcMain.handle("pieces:remove", (_e, id) => pieces.remove(id));
  ipcMain.on("pieces:run", (_e, id) => pieces.run(id));

  // calls and recap
  ipcMain.handle("calls:list", () => ({ calls: calls.list(), active: calls.active, settings: store.get("calls") }));
  ipcMain.handle("calls:set", (_e, patch) => {
    store.set("calls", { ...store.get("calls"), ...patch, log: store.get("calls.log") });
    calls.start();
    return store.get("calls");
  });
  ipcMain.on("calls:takeNotes", () => calls.active && startCallNotes(calls.active));
  ipcMain.handle("recap:agents", (_e, period) => agentRecap(String(period)));
  ipcMain.handle("recap:saveImage", (_e, { dataUrl, name }) => {
    const png = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
    if (!png) return { ok: false, error: "Not a PNG." };
    const dir = path.join(store.get("workspaceDir"), "Recaps");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${String(name).replace(/[^\w .–-]+/g, "").trim() || "Recap"}.png`);
    fs.writeFileSync(file, Buffer.from(png[1], "base64"));
    return { ok: true, file };
  });
  ipcMain.on("recap:showFile", (_e, file) => {
    const dir = path.join(store.get("workspaceDir"), "Recaps");
    if (path.dirname(path.resolve(String(file))) === path.resolve(dir)) shell.showItemInFolder(file);
  });
  ipcMain.handle("recap:get", (_e, period) => ({
    stats: recapStats({ store, notesList: notes.list(""), historyList: listHistory(store), period }),
    latest: latestRecap(store, period),
  }));
  ipcMain.handle("recap:write", async (_e, period) => {
    try {
      flash("working", 60000);
      const r = await writeRecap({ chat, store, period });
      flash("done", 2500);
      return { ok: true, recap: r };
    } catch (e) {
      flash("error", 3000);
      return { ok: false, error: e.message };
    }
  });

  // the island
  ipcMain.on("companion:dock", (_e, on) => (on ? dock() : undock(null)));
  ipcMain.handle("island:init", () => {
    const g = island.geometry();
    return { notch: g.notch, height: g.height, notchWidth: g.notchWidth, character: store.get("character"), state: computeMood(), badge: openApprovals() + watcher.alerts.filter((a) => !a.read).length };
  });
  ipcMain.on("island:mouse", (_e, over) => island.setMouse(!!over));
  ipcMain.on("island:click", () => togglePanel());
  ipcMain.on("island:undock", (_e, p) => undock(p));
  ipcMain.on("island:dragEnd", () => {
    const showedWindow = !!companion.dragging?.armed;
    companion.dragEnd();
    island.hide();
    island.win?.setOpacity(1);
    // Carried out of the island just to show Halo a window: rest in the island again.
    if (showedWindow) setTimeout(dock, 600);
  });

  // capture
  ipcMain.on("capture:screen", () => askAboutScreen(false));
  ipcMain.on("capture:snip", () => askAboutScreen(true));

  // today
  ipcMain.handle("today:get", () => watcher.snapshot());
  ipcMain.on("today:refresh", (_e, { claude } = {}) => {
    watcher.pollLocal();
    if (claude) watcher.pollClaude();
  });
  ipcMain.on("today:markRead", () => watcher.markRead());

  // notes
  ipcMain.handle("chat:transcribe", async (_e, seg) => {
    try {
      return { ok: true, text: await transcriber.transcribe({ pcm: seg.pcm, audio: seg.audio ? Buffer.from(seg.audio) : null, mime: seg.mime, model: seg.model }) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.on("panel:notice", (_e, n) => panel.send("chat:notice", n));
  // "Hey Halo": the wake word was heard (with or without a request after it).
  ipcMain.on("wake:listening", (_e, on) => {
    mood.conversing = !!on;
    pushMood();
  });
  ipcMain.on("wake:set", (_e, { on, byVoice } = {}) => setWakeWord(!!on, { byVoice: !!byVoice }));
  ipcMain.on("wake:heard", () => {
    flash("listening", 8000);
    companion.send("companion:emote", "surprised");
    island.send("companion:emote", "surprised");
    bubble({ title: "I'm listening", body: "Go ahead…", timeoutMs: 8000 });
  });
  ipcMain.on("panel:showChat", () => {
    companion.send("companion:hideBubble");
    openPanel("chat");
  });
  ipcMain.handle("notes:micAccess", async () => (isMac ? systemPreferences.askForMediaAccess("microphone") : true));
  ipcMain.handle("notes:start", (_e, { title }) => notes.start({ title }));
  ipcMain.on("notes:segment", (_e, seg) => notes.addSegment(seg));
  ipcMain.handle("notes:finish", async (_e, args) => {
    try {
      return { ok: true, note: await notes.finish(args) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle("notes:summarizeText", async (_e, { title, transcript }) => {
    try {
      return { ok: true, note: await notes.summarize({ title, transcript }) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle("notes:list", (_e, q) => notes.list(q || ""));
  ipcMain.handle("notes:read", (_e, name) => notes.read(name));
  ipcMain.handle("notes:quick", (_e, n) => notes.saveQuick(n));
  ipcMain.on("notes:openFolder", () => shell.openPath(store.get("notesDir")));
  ipcMain.on("notes:open", (_e, name) => shell.openPath(notes.read(name).file));
  ipcMain.on("notes:warmup", () => transcriber.warmup());
  ipcMain.handle("notes:engine", () => store.get("transcription"));

  // settings
  ipcMain.handle("sessions:list", () => (store.get("watchSessions") ? sessions.list : []));
  ipcMain.handle("sessions:open", (_e, id) => sessions.open(String(id)));

  // Approving your own Claude Code sessions from Halo
  ipcMain.handle("sessions:permissions", () => ccPerms.list());
  ipcMain.on("sessions:answer", (_e, { id, choice } = {}) => {
    if (!["allow", "always", "deny", "pass"].includes(choice)) return;
    const req = ccPerms.list().find((r) => r.id === id);
    ccPerms.answer(String(id), choice);
    // "Reply in Claude Code": the question goes back there, and that app comes forward.
    if (choice === "pass" && req) sessions.open(req.sessionId, { cwd: req.cwd, entrypoint: req.entrypoint });
  });
  ipcMain.handle("sessions:hooksStatus", () => hookStatus(ccHookCommand()));
  ipcMain.handle("sessions:hooksPlan", (_e, { enable } = {}) => {
    try {
      return planHooks(ccHookCommand(), !!enable);
    } catch (e) {
      return { error: e.message };
    }
  });
  ipcMain.handle("sessions:hooksApply", (_e, id) => applyPlan(String(id)));
  ipcMain.on("sessions:hooksCancel", (_e, id) => cancelPlan(String(id)));

  ipcMain.handle("settings:get", () => settingsPayload());
  ipcMain.handle("settings:health", () => health());
  ipcMain.handle("settings:set", async (_e, patch) => {
    const before = store.all();
    if (patch.character && patch.character !== before.character) setCharacter(patch.character);
    const rest = { ...patch };
    delete rest.character;
    store.patch(rest);
    if (rest.size) companion.send("companion:size", rest.size);
    if ("showDock" in rest && isMac) rest.showDock ? app.dock?.show() : app.dock?.hide();
    if ("launchAtLogin" in rest) app.setLoginItemSettings({ openAtLogin: !!rest.launchAtLogin });
    if (rest.shortcuts) registerShortcuts();
    if (rest.alerts) watcher.start();
    if (rest.wakeWord || "followPointer" in rest) setupTray(); // the menu's checkbox ticks
    if ("watchSessions" in rest) {
      if (rest.watchSessions) sessions.start();
      else {
        sessions.stop();
        sessions.list = [];
        seenSessions.clear(); // turned back on later: start fresh, without announcing what happened meanwhile
        panel.send("sessions:changed", []);
        room.send("sessions:changed", []);
      }
    }
    if (rest.githubUser && rest.githubUser !== before.githubUser) {
      ghToken = await githubToken(rest.githubUser);
      chat.setGithubToken(ghToken);
      watcher.pollLocal();
    }
    const affectsChat = ["model", "effort", "useApiKey", "claudePath", "githubUser", "jiraSite", "notesDir"].some((k) => k in rest);
    if (affectsChat && !chat.busy) chat.newChat();
    const payload = settingsPayload();
    panel.send("settings:changed", payload);
    room.send("settings:changed", payload);
    return payload;
  });
  ipcMain.handle("settings:secret", (_e, { name, value }) => {
    if (!["anthropicApiKey", "sttApiKey"].includes(name)) return settingsPayload();
    store.setSecret(name, value || "");
    if (name === "anthropicApiKey" && !chat.busy) chat.newChat();
    return settingsPayload();
  });
  ipcMain.on("settings:openScreenSettings", () => openScreenSettings());
  ipcMain.on("settings:openMicSettings", () => shell.openExternal(isMac ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone" : "ms-settings:privacy-microphone"));
  ipcMain.handle("notes:micHelp", () => micHelp());
  ipcMain.on("notes:micDenied", () => {
    if (micWarned) return;
    micWarned = true;
    bubble({ title: "I can't hear you", body: "Microphone access is off. Open my chat to see how to turn it on.", kind: "alert", action: { tab: "chat" }, timeoutMs: 12000 });
  });
  ipcMain.handle("settings:detectTimeZone", async () => {
    try {
      return { ok: true, value: await chat.detectAccountTimeZone({ force: true }) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.on("settings:character", (_e, id) => setCharacter(id));
  ipcMain.on("app:quit", () => app.quit());
}

// ── menus, tray, shortcuts ────────────────────────────────────────────────────

function buildMenu() {
  const sc = store.get("shortcuts");
  const cur = store.get("character");
  return Menu.buildFromTemplate([
    { label: "Open Halo", accelerator: sc.toggle, click: () => openPanel("chat") },
    { type: "separator" },
    { label: "Talk to Halo", accelerator: sc.dictate, click: () => { openPanel("chat"); panel.send("chat:dictate"); } },
    { label: "Ask about my screen", accelerator: sc.screen, click: () => askAboutScreen(false) },
    { label: "Snip a region…", accelerator: sc.snip, click: () => askAboutScreen(true) },
    { label: mood.recording ? "Stop recording" : "Record a meeting", accelerator: sc.record, click: () => toggleRecording() },
    { label: "Brief me", click: () => { openPanel("chat"); panel.send("chat:quick", "brief"); } },
    { label: "Today", click: () => openPanel("today") },
    { label: "Listen for “Hey Halo”", type: "checkbox", checked: !!store.get("wakeWord.enabled"), click: (item) => setWakeWord(item.checked) },
    { label: "Follow my pointer", type: "checkbox", checked: !!store.get("followPointer"), click: (item) => setFollowPointer(item.checked) },
    { type: "separator" },
    {
      label: "Character",
      submenu: CHARACTERS.map((c) => ({ label: `${c.name} · ${c.tagline}`, type: "radio", checked: c.id === cur, click: () => setCharacter(c.id) })),
    },
    {
      label: "Size",
      submenu: ["small", "medium", "large"].map((s) => ({
        label: s[0].toUpperCase() + s.slice(1),
        type: "radio",
        checked: store.get("size") === s,
        click: () => { store.set("size", s); companion.send("companion:size", s); },
      })),
    },
    { label: store.get("docked") ? "Put Halo on the desktop" : "Rest in the island", click: () => (store.get("docked") ? undock(null) : dock()) },
    { label: "Halo's room…", click: () => room.open("home") },
    { label: "Settings…", click: () => room.open("general") },
    { type: "separator" },
    store.get("docked") ? null : { label: companion.win?.isVisible() ? "Hide Halo" : "Show Halo", click: () => (companion.win?.isVisible() ? companion.win.hide() : companion.win?.showInactive()) },
    { label: "Quit Halo", click: () => app.quit() },
  ].filter(Boolean));
}

function setupTray() {
  if (!tray) {
    const icon = isMac
      ? nativeImage.createFromPath(path.join(ROOT, "assets", "trayTemplate.png"))
      : nativeImage.createFromPath(path.join(ROOT, "assets", "tray.png"));
    if (isMac) icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip("Halo · A little companion. A lot done.");
    if (!isMac) tray.on("click", () => togglePanel());
  }
  tray.setContextMenu(buildMenu());
}

function startCallNotes(c) {
  openPanel("notes");
  panel.send("notes:startCall", { title: `${c.app}: ${c.title}` });
}

function toggleRecording() {
  openPanel("notes");
  panel.send("notes:toggle");
}

function registerShortcuts() {
  globalShortcut.unregisterAll();
  const sc = store.get("shortcuts");
  const bind = (acc, fn) => {
    if (!acc) return;
    try {
      globalShortcut.register(acc, fn);
    } catch {}
  };
  bind(sc.toggle, () => togglePanel());
  bind(sc.screen, () => askAboutScreen(false));
  bind(sc.snip, () => askAboutScreen(true));
  bind(sc.record, () => toggleRecording());
  bind(sc.dictate, () => {
    openPanel("chat");
    panel.send("chat:dictate");
  });
}

// Your Claude Code sessions (terminal, the Claude app, VS Code…), shown live.
// Halo reads the transcripts Claude Code already writes to ~/.claude/projects,
// so nothing is installed into Claude Code, and it works on macOS and Windows.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "./env.js";

const isMac = process.platform === "darwin";
const POLL_MS = 3000;
const SHOW_FOR_MS = 30 * 60_000; // quiet longer than this: not shown
const DONE_FOR_MS = 15 * 60_000; // finished sessions stay this long
const TOOL_SLOW_MS = 90_000; // a tool still open after this is probably waiting on you
const TAIL_BYTES = 512 * 1024;

const COLORS = ["#7C5CFF", "#3B9EFF", "#22C3A6", "#34D399", "#E9B949", "#F29B38", "#F4505E", "#E062C8"];

export const APP_LABEL = { "claude-desktop": "Claude app", cli: "Terminal", "claude-vscode": "VS Code", "claude-jetbrains": "JetBrains", web: "Claude Code on the web" };

function projectsDir() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
}

function hash(s) {
  let x = 0;
  for (const ch of s.toLowerCase()) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return x;
}

const encodeDir = (p) => String(p).replace(/[^a-zA-Z0-9]/g, "-");

/** The folder a projects/<name> folder stands for, found by walking the disk (cached). */
const decoded = new Map();
function decodeDir(name) {
  if (decoded.has(name)) return decoded.get(name);
  const walk = (dir, depth) => {
    if (depth > 24) return "";
    let kids = [];
    try { kids = fs.readdirSync(dir, { withFileTypes: true }); } catch { return ""; }
    for (const k of kids) {
      if (!k.isDirectory() && !k.isSymbolicLink()) continue;
      const p = path.join(dir, k.name);
      const e = encodeDir(p);
      if (e === name) return p;
      if (name.startsWith(`${e}-`)) {
        const found = walk(p, depth + 1);
        if (found) return found;
      }
    }
    return "";
  };
  const found = walk(path.parse(os.homedir()).root, 0);
  decoded.set(name, found);
  return found;
}
const base = (p) => String(p ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
const short = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** "Edit room.js", "Run npm test" — what a tool call is doing, in a few words. */
export function describeTool(name, input = {}) {
  const file = base(input.file_path || input.notebook_path || input.path);
  switch (name) {
    case "Read": return `Read ${file || "a file"}`;
    case "Edit": case "MultiEdit": case "NotebookEdit": return `Edit ${file || "a file"}`;
    case "Write": return `Write ${file || "a file"}`;
    case "Bash": case "PowerShell": return input.description ? short(input.description, 60) : `Run ${short(input.command, 50)}`;
    case "Grep": return `Search for “${short(input.pattern, 40)}”`;
    case "Glob": return `Find ${short(input.pattern, 40)}`;
    case "WebFetch": try { return `Read ${new URL(input.url).hostname}`; } catch { return "Read a web page"; }
    case "WebSearch": return `Search the web: ${short(input.query, 45)}`;
    case "Agent": case "Task": return `Agent: ${short(input.description || input.prompt, 50)}`;
    case "TodoWrite": return "Update the plan";
    case "AskUserQuestion": return "Asking you a question";
    case "ExitPlanMode": return "Plan ready for you";
    case "Skill": return `Use the ${input.skill || input.name || ""} skill`.replace(/\s+skill$/, " skill");
  }
  const m = /^mcp__(.+?)__(.+)$/.exec(name || "");
  if (m) {
    const server = m[1].replace(/^claude_ai_/, "").replace(/^[0-9a-f-]{20,}$/i, "Connector").replace(/_/g, " ");
    return `${server}: ${m[2].replace(/_v\d+$/, "").replace(/_/g, " ")}`;
  }
  return name || "Working";
}

/** The text of a user record, or "" when it's a tool result or a system note. */
function userText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.some((c) => c?.type === "tool_result")) return "";
  return content.filter((c) => c?.type === "text").map((c) => c.text).join(" ");
}

function readTail(file, size, bytes = TAIL_BYTES) {
  const fd = fs.openSync(file, "r");
  try {
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    if (size > len) lines.shift(); // first line is cut
    return lines;
  } finally {
    fs.closeSync(fd);
  }
}

const isPrompt = (t) => !!t && !/^\s*(<|\[Image|\[Request interrupted)/.test(t);

/** The newest thing you asked, from the records that carry prompts. */
function promptIn(recs) {
  let prompt = "";
  for (const r of recs) {
    if (r.isSidechain) continue;
    if (r.type === "user" && r.message && !r.isMeta) { const t = userText(r.message.content); if (isPrompt(t)) prompt = t; }
    // Messages sent while Claude is mid-answer arrive as queued commands.
    if (r.type === "attachment" && r.attachment?.type === "queued_command") { const t = typeof r.attachment.prompt === "string" ? r.attachment.prompt : userText(r.attachment.prompt); if (isPrompt(t)) prompt = t; }
    if (r.type === "queue-operation" && r.operation === "enqueue") { const t = typeof r.content === "string" ? r.content : userText(r.content); if (isPrompt(t)) prompt = t; }
  }
  return prompt;
}

const parseLines = (lines) => {
  const recs = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { recs.push(JSON.parse(line)); } catch {}
  }
  return recs;
};

/**
 * One transcript's tail → what that session is doing now. `prev` is the last
 * result for this file: screenshots can push the newest prompt out of the
 * tail, so a prompt seen before is kept.
 */
export function parseSession(file, { mtimeMs, size }, now = Date.now(), prev = null) {
  const recs = parseLines(readTail(file, size));
  let prompt = promptIn(recs) || prev?.prompt || "";
  // First look at this session and nothing in the tail: search further back once.
  if (!prompt && !prev && size > TAIL_BYTES) prompt = promptIn(parseLines(readTail(file, size, 6 * 1024 * 1024)));
  let lastPrompt = "";
  let title = "", cwd = "", entrypoint = "", sessionId = "", branch = "";
  // The folder a session started in names it (commands may cd elsewhere).
  // Claude Code names the projects folder after it: every non-alphanumeric becomes "-".
  const dirName = base(path.dirname(file));
  const cwdCount = new Map();
  let launchCwd = prev?.cwd && encodeDir(prev.cwd) === dirName ? prev.cwd : "";
  const steps = [];
  let last = null; // the last user or assistant message
  let turn = ""; // the message that started the latest turn: a new one means a new turn, even one too quick to see
  for (const r of recs) {
    if (r.cwd) {
      cwd = r.cwd;
      cwdCount.set(r.cwd, (cwdCount.get(r.cwd) ?? 0) + 1);
      if (!launchCwd && encodeDir(r.cwd) === dirName) launchCwd = r.cwd;
    }
    if (r.entrypoint) entrypoint = r.entrypoint;
    if (r.sessionId) sessionId = r.sessionId;
    if (r.gitBranch) branch = r.gitBranch;
    if (r.type === "custom-title" && r.customTitle) title = r.customTitle;
    // "last-prompt" lags behind (it misses messages sent mid-answer): fallback only.
    if (r.type === "last-prompt" && r.lastPrompt) lastPrompt = r.lastPrompt;
    if (r.isSidechain) continue;
    if (r.type === "assistant" && Array.isArray(r.message?.content)) {
      for (const c of r.message.content) if (c?.type === "tool_use") steps.push({ id: c.id, label: describeTool(c.name, c.input), tool: c.name, open: true });
      last = r;
    } else if (r.type === "user" && r.message) {
      const content = r.message.content;
      if (Array.isArray(content)) for (const c of content) if (c?.type === "tool_result") { const s = steps.find((x) => x.id === c.tool_use_id); if (s) { s.open = false; s.failed = !!c.is_error; } }
      if (!r.isMeta && userText(content)) turn = r.uuid || r.timestamp || turn;
      last = r;
    }
  }
  if (!last || !cwd) return null;
  cwd = launchCwd || decodeDir(dirName) || [...cwdCount].sort((a, b) => b[1] - a[1])[0][0];
  if (!prompt) prompt = lastPrompt;

  const age = now - mtimeMs;
  let status = "working";
  let doing = "Thinking…";
  let final = "";
  let waitReason = ""; // "ask": a question or plan for you; "slow": a tool open a long time
  let step = "";
  if (last.type === "assistant") {
    const blocks = last.message.content;
    const tail = blocks[blocks.length - 1];
    if (tail?.type === "tool_use") {
      step = describeTool(tail.name, tail.input);
      if (["AskUserQuestion", "ExitPlanMode"].includes(tail.name)) { status = "waiting"; doing = step; waitReason = "ask"; }
      else if (age > TOOL_SLOW_MS) { status = "waiting"; doing = `Waiting · ${step}`; waitReason = "slow"; }
      else doing = step;
    } else if (last.message.stop_reason !== "tool_use") { // text before a tool call isn't the end: the call's record comes next
      const text = blocks.filter((b) => b?.type === "text").map((b) => b.text).join(" ");
      if (!last.message.stop_reason && age < 5000) doing = "Writing…";
      else { status = "done"; final = short(text.replace(/[#*_`>]/g, ""), 160) || "Finished."; doing = final; }
    }
  } else {
    const t = userText(last.message.content);
    if (/^\[Request interrupted/.test(t)) { status = "done"; doing = final = "Stopped."; }
    else if (age > TOOL_SLOW_MS * 2) { status = "waiting"; doing = "Waiting"; waitReason = "slow"; }
  }
  if (age > SHOW_FOR_MS || (status === "done" && age > DONE_FOR_MS)) return null;

  const folder = base(cwd);
  const scratch = /[\\/]scratch-workspaces[\\/]/.test(cwd) && /^scratch-/.test(folder);
  const project = scratch ? (title || "Claude chat") : folder;
  const recent = steps.slice(-6).map(({ label, tool, open, failed }) => ({ label, tool, state: open ? "running" : failed ? "failed" : "done" }));
  return {
    id: sessionId || base(file).replace(/\.jsonl$/, ""),
    file,
    project,
    title: scratch ? "" : title,
    cwd,
    branch,
    entrypoint,
    app: APP_LABEL[entrypoint] ?? "Claude Code",
    color: COLORS[hash(project) % COLORS.length],
    status, // working | waiting | done
    waitReason,
    step,
    doing,
    prompt: short(prompt, 120),
    final,
    steps: recent,
    updated: mtimeMs,
    turn: turn || prev?.turn || "",
  };
}

const RANK = { waiting: 0, working: 1, done: 2 };

/**
 * From one list to the next: turns that just ended ("done") and sessions that
 * just asked you something ("waiting"). `seen` (id → last state) is updated in
 * place. A session seen for the first time is only remembered, so what was
 * already going on when Halo started isn't announced.
 */
export function sessionTurns(seen, list) {
  const events = [];
  const ids = new Set();
  for (const s of list) {
    ids.add(s.id);
    const state = s.status === "working" ? s.status : `${s.status}:${s.status === "done" ? s.turn : s.waitReason}`;
    const was = seen.get(s.id);
    seen.set(s.id, state);
    if (!was || was === state) continue;
    if (s.status === "done" && s.final !== "Stopped.") events.push({ kind: "done", session: s }); // you stopped it yourself: nothing to say
    // A question or a plan for you. Permission requests have their own bubble, and a slow tool is usually just slow.
    else if (state === "waiting:ask") events.push({ kind: "waiting", session: s });
  }
  for (const id of seen.keys()) if (!ids.has(id)) seen.delete(id);
  return events;
}

export class SessionWatcher extends EventEmitter {
  /** @param {{ exclude: () => string[] }} opts  folders whose sessions are Halo's own */
  constructor(opts) {
    super();
    this.opts = opts;
    this.cache = new Map(); // file -> { mtimeMs, size, session }
    this.list = [];
    this.sent = "";
    this.timer = null;
    this.running = false;
    // With "Approve my sessions from Halo" on, hooks say exactly when a turn
    // starts and stops and what waits for permission; these win over guesses.
    this.hooks = new Map(); // session id → { status: "working" | "done" | "ended", at, prompt, last }
    this.permissions = []; // open permission requests (cc-permissions.js)
  }

  start() {
    if (this.running) return;
    this.running = true;
    const gen = (this.gen = (this.gen ?? 0) + 1); // a stop and start mid-poll keeps one loop
    const tick = () => this.poll().catch(() => {}).finally(() => { if (this.running && this.gen === gen) this.timer = setTimeout(tick, POLL_MS); });
    tick();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** UserPromptSubmit, Stop or SessionEnd from the hook. */
  hookEvent({ event, sessionId, prompt, last, at = Date.now() }) {
    if (!sessionId) return;
    const status = { UserPromptSubmit: "working", Stop: "done", SessionEnd: "ended" }[event];
    if (!status) return;
    this.hooks.set(sessionId, { status, at, prompt: prompt ?? this.hooks.get(sessionId)?.prompt ?? "", last: last ?? "" });
    for (const [id, h] of this.hooks) if (at - h.at > 24 * 3600_000) this.hooks.delete(id);
    this.publish(at);
  }

  setPermissions(list) {
    this.permissions = list;
    this.publish();
  }

  /** One session as the hooks know it; null once it has ended. */
  withHooks(s) {
    const perm = this.permissions.find((p) => p.sessionId === s.id);
    if (perm) return { ...s, status: "waiting", waitReason: "permission", doing: `Needs permission · ${perm.title}`, permission: perm.id };
    const h = this.hooks.get(s.id);
    if (!h) return s;
    if (h.status === "ended") return s.updated > h.at + 5000 ? s : null; // resumed since
    if (h.status === "working") {
      // The prompt is in, but the transcript hasn't caught up yet.
      if (s.status === "done" && h.at >= s.updated - 1500) return { ...s, status: "working", doing: "Thinking…", prompt: short(h.prompt, 120) || s.prompt, final: "" };
      // A long tool is just a long tool: a permission prompt would have come through the hook.
      if (s.waitReason === "slow") return { ...s, status: "working", waitReason: "", doing: s.step || "Working…" };
      return s;
    }
    if (h.status === "done" && s.status !== "done" && s.waitReason !== "ask" && s.updated <= h.at + 3000) {
      const final = short(String(h.last || "").replace(/[#*_`>]/g, ""), 160) || s.final || "Finished.";
      return { ...s, status: "done", waitReason: "", doing: final, final };
    }
    return s;
  }

  async poll() {
    const root = projectsDir();
    const now = Date.now();
    const seen = new Set();
    let dirs = [];
    try { dirs = await fs.promises.readdir(root, { withFileTypes: true }); } catch { dirs = []; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(root, d.name);
      let files = [];
      try { files = await fs.promises.readdir(dir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const file = path.join(dir, f);
        let st;
        try { st = await fs.promises.stat(file); } catch { continue; }
        if (now - st.mtimeMs > SHOW_FOR_MS) continue;
        seen.add(file);
        const hit = this.cache.get(file);
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && now - st.mtimeMs < 5000 === hit.fresh) continue;
        let session = null;
        try { session = parseSession(file, st, now, hit?.session); } catch {}
        this.cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, fresh: now - st.mtimeMs < 5000, session });
      }
    }
    for (const f of this.cache.keys()) if (!seen.has(f)) this.cache.delete(f);
    this.publish(now);
  }

  /** Builds the list from what's been read, with the hooks' news on top, and sends it if it changed. */
  publish(now = Date.now()) {
    if (!this.running) return;
    const exclude = new Set(this.opts.exclude().map((p) => path.resolve(p).toLowerCase()));
    // Re-check the age rules on cached entries (a tool that's been open a while is now "waiting").
    const list = [];
    for (const [file, c] of this.cache) {
      if (!c.session) continue;
      const s = now - c.mtimeMs > TOOL_SLOW_MS && c.session.status === "working" ? parseSession(file, { mtimeMs: c.mtimeMs, size: c.size }, now, c.session) : c.session;
      if (!s) continue;
      if (exclude.has(path.resolve(s.cwd).toLowerCase())) continue; // Halo's own chats
      if (/^sdk-/.test(s.entrypoint)) continue; // headless runs by other tools
      const shown = this.withHooks(s);
      if (shown) list.push(shown);
    }
    list.sort((a, b) => RANK[a.status] - RANK[b.status] || b.updated - a.updated);
    this.list = list;
    const key = JSON.stringify(list.map(({ id, status, doing, prompt, steps, permission, turn }) => [id, status, doing, prompt, steps.length, permission, turn]));
    if (key !== this.sent) {
      this.sent = key;
      this.emit("changed", list);
    }
  }

  /** Bring the app the session runs in to the front. `fallback`: { cwd, entrypoint } for one not in the list. */
  async open(id, fallback = null) {
    const s = this.list.find((x) => x.id === id) ?? fallback;
    if (!s?.cwd) return false;
    if (isMac) {
      const host = await hostApp(s.cwd);
      if (host) return (await run("open", ["-a", host])).ok;
      if (s.entrypoint === "claude-desktop") return (await run("open", ["-b", "com.anthropic.claudefordesktop"])).ok;
      if (s.entrypoint === "claude-vscode") return (await run("open", ["-a", "Visual Studio Code", s.cwd])).ok;
      return (await run("open", ["-a", "Terminal"])).ok;
    }
    if (s.entrypoint === "claude-vscode") return (await run("code", [s.cwd])).ok;
    return false;
  }
}

/** macOS: the .app that owns a `claude` process working in this folder. */
async function hostApp(cwd) {
  const res = await run("lsof", ["-a", "-c", "claude", "-d", "cwd", "-Fpn"], { timeout: 4000 });
  if (!res.ok && !res.stdout) return "";
  let pid = 0;
  const pids = [];
  for (const line of res.stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && path.resolve(line.slice(1)) === path.resolve(cwd)) pids.push(pid);
  }
  for (let p of pids) {
    for (let i = 0; i < 16 && p > 1; i++) {
      const ps = await run("ps", ["-o", "ppid=,comm=", "-p", String(p)], { timeout: 3000 });
      const m = /^\s*(\d+)\s+(.*)$/.exec(ps.stdout.trim());
      if (!m) break;
      const app = /^(.*?\.app)\/Contents\/MacOS\//.exec(m[2]);
      // Claude Code ships inside its own helper .app; keep walking past it.
      if (app && !/\/claude-code\/|ClaudeCode\.app|\/\.local\//.test(app[1])) return app[1];
      p = Number(m[1]);
    }
  }
  return "";
}

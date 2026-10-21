// Permission requests from your own Claude Code sessions (terminal, the
// Claude app, VS Code), answered in Halo. The hook (src/hook/halo-cc-hook.cjs)
// is in ~/.claude/settings.json only while "Approve my sessions from Halo" is
// on. It also reports when a prompt starts, a turn stops and a session ends,
// so the session cards show exactly what each one is doing.
//
// Hook and app share a key kept in Halo's data folder, and each proves it
// knows it, so nothing else on this computer can answer in Halo's place.
// Halo never decides on its own: no answer means Claude Code asks you itself.

import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe } from "./approvals.js";
import { APP_LABEL, describeTool } from "./sessions.js";

const ANSWER_WITHIN_MS = 125_000; // the hook gives up at 130 s, Claude Code at 135 s
const MAX_INPUT_TEXT = 4000;

export function ccSocketPath() {
  if (process.platform === "win32") return `\\\\.\\pipe\\halo-cc-${os.userInfo().username}`;
  return path.join(os.tmpdir(), `halo-cc-${process.getuid?.() ?? "u"}.sock`);
}

const hmac = (key, s) => crypto.createHmac("sha256", key).update(s).digest("hex");
function same(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const base = (p) => String(p ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";

/** Long strings (a whole file for Write) shortened for the card's Details. */
function trimInput(v, depth = 0) {
  if (typeof v === "string") return v.length > MAX_INPUT_TEXT ? `${v.slice(0, MAX_INPUT_TEXT)}… (${v.length - MAX_INPUT_TEXT} more characters)` : v;
  if (Array.isArray(v)) return depth > 6 ? "…" : v.slice(0, 50).map((x) => trimInput(x, depth + 1));
  if (v && typeof v === "object") return depth > 6 ? "…" : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trimInput(x, depth + 1)]));
  return v;
}

/** What the session wants to do, for the card: a headline, the command or file, a note. */
export function describeRequest(tool, input = {}) {
  if (tool === "Bash" || tool === "PowerShell") return { title: "Run a shell command", text: String(input.command ?? ""), note: String(input.description ?? "") };
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const file = input.file_path || input.notebook_path || "";
    return { title: `${tool === "Write" ? "Write" : "Edit"} ${base(file) || "a file"}`, text: String(file), note: "" };
  }
  if (["Read", "Glob", "Grep", "LS"].includes(tool)) return { title: describeTool(tool, input), text: String(input.file_path || input.path || ""), note: "" };
  if (tool === "WebFetch" || tool.startsWith("mcp__")) {
    const d = describe(tool, input);
    return { title: tool.startsWith("mcp__") ? describeTool(tool, input) : d.title, text: d.text, note: d.note };
  }
  return { title: describeTool(tool, input), text: "", note: "" };
}

/** "Always" in words: what Claude Code would remember, and where. */
export function alwaysHint(suggestions = []) {
  const parts = [];
  for (const s of suggestions) {
    if (s?.type === "addRules" || s?.type === "replaceRules") {
      for (const r of s.rules ?? []) parts.push(`${s.behavior === "deny" ? "deny" : s.behavior === "ask" ? "ask for" : "allow"} ${r.toolName}${r.ruleContent ? `(${r.ruleContent})` : ""}`);
    } else if (s?.type === "setMode") parts.push(`switch to ${s.mode} mode`);
    else if (s?.type === "addDirectories") parts.push(`allow the ${(s.directories ?? []).map(base).join(", ")} folder`);
  }
  const where = { session: "for this session", localSettings: "in this project, for you", projectSettings: "in this project", userSettings: "everywhere" }[suggestions[0]?.destination] ?? "";
  return parts.length ? `Allow, and ${parts.join(", ")} ${where}`.trim() : "";
}

export class CcPermissionServer extends EventEmitter {
  /**
   * @param {{ infoFile: string, skip?: (msg: object) => boolean, sockPath?: string }} opts
   *   infoFile: where the hook finds the socket and key; skip: Halo's own sessions
   */
  constructor({ infoFile, skip = () => false, sockPath = ccSocketPath() }) {
    super();
    this.infoFile = infoFile;
    this.skip = skip;
    this.path = sockPath;
    this.pending = new Map(); // id → { request, sock, nonce, timer }
    this.server = null;
    this.key = "";
  }

  async start() {
    this.key = this.loadKey();
    if (process.platform !== "win32") {
      try { fs.unlinkSync(this.path); } catch {}
    }
    this.server = net.createServer((sock) => this.handle(sock));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.path, () => resolve());
    });
    if (process.platform !== "win32") fs.chmodSync(this.path, 0o600);
    this.writeInfo();
  }

  /** The key stays the same across restarts, so a hook that's already running still matches. */
  loadKey() {
    try {
      const k = JSON.parse(fs.readFileSync(this.infoFile, "utf8")).key;
      if (/^[0-9a-f]{64}$/.test(k)) return k;
    } catch {}
    return crypto.randomBytes(32).toString("hex");
  }

  writeInfo() {
    fs.mkdirSync(path.dirname(this.infoFile), { recursive: true });
    const tmp = `${this.infoFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ sock: this.path, key: this.key }), { mode: 0o600 });
    fs.renameSync(tmp, this.infoFile);
  }

  /** On quit every open request goes back to Claude Code, which then asks you itself. */
  stop() {
    for (const id of [...this.pending.keys()]) this.release(id, null, "quit");
    this.server?.close();
  }

  handle(sock) {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    sock.on("data", (d) => {
      buf += d;
      if (buf.length > 2_000_000) return sock.destroy();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = "";
      sock.removeAllListeners("data");
      let msg;
      try { msg = JSON.parse(line); } catch { return sock.destroy(); }
      if (msg?.v !== 1 || typeof msg.nonce !== "string" || !same(msg.proof, hmac(this.key, `req:${msg.nonce}`))) return sock.destroy();
      if (msg.event === "PermissionRequest") this.request(msg, sock);
      else this.event(msg, sock);
    });
  }

  /** UserPromptSubmit, Stop, SessionEnd: a later event means an open card is out of date. */
  event(msg, sock) {
    sock.end("{}\n");
    if (this.skip(msg)) return;
    const sessionId = String(msg.session_id ?? "");
    for (const [id, p] of this.pending) if (p.request.sessionId === sessionId) this.release(id, null, "moved on");
    this.emit("event", { event: String(msg.event ?? ""), sessionId, cwd: msg.cwd, prompt: msg.prompt, last: msg.last, reason: msg.reason, at: Date.now() });
  }

  request(msg, sock) {
    const entrypoint = String(msg.entrypoint ?? "");
    // Halo's own sessions, and other tools' headless runs, are left to whoever runs them.
    if (this.skip(msg) || /^sdk-/.test(entrypoint)) return this.reply(sock, msg.nonce, null);
    const sessionId = String(msg.session_id ?? "");
    for (const [id, p] of this.pending) if (p.request.sessionId === sessionId) this.release(id, null, "moved on");

    const tool = String(msg.tool_name ?? "");
    const input = msg.tool_input && typeof msg.tool_input === "object" ? msg.tool_input : {};
    const suggestions = Array.isArray(msg.permission_suggestions) ? msg.permission_suggestions : [];
    const id = crypto.randomUUID();
    const request = {
      id,
      sessionId,
      cwd: String(msg.cwd ?? ""),
      project: base(msg.cwd) || "Claude Code",
      app: APP_LABEL[entrypoint] ?? "Claude Code",
      entrypoint,
      tool,
      input: trimInput(input),
      ...describeRequest(tool, input),
      canAlways: suggestions.length > 0,
      alwaysHint: alwaysHint(suggestions),
      createdAt: Date.now(),
    };
    const entry = {
      request,
      sock,
      nonce: msg.nonce,
      suggestions,
      timer: setTimeout(() => this.release(id, null, "timeout"), ANSWER_WITHIN_MS),
    };
    this.pending.set(id, entry);
    // The hook went away: Claude Code cancelled it, or you answered in Claude Code.
    sock.on("close", () => this.release(id, null, "gone"));
    this.emit("request", request);
    this.emit("changed", this.list());
  }

  /**
   * Your answer from the card. "pass" hands it back to Claude Code, which asks you there.
   * @param {"allow"|"always"|"deny"|"pass"} choice
   */
  answer(id, choice) {
    const p = this.pending.get(id);
    if (!p) return false;
    let decision = null;
    if (choice === "allow") decision = { behavior: "allow" };
    if (choice === "always") decision = p.suggestions.length ? { behavior: "allow", updatedPermissions: p.suggestions } : { behavior: "allow" };
    if (choice === "deny") decision = { behavior: "deny", message: "Denied in Halo." };
    this.release(id, decision, choice);
    return true;
  }

  release(id, decision, why) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    this.reply(p.sock, p.nonce, decision);
    this.emit("resolved", { id, sessionId: p.request.sessionId, decision: decision?.behavior ?? "passed", why });
    this.emit("changed", this.list());
  }

  reply(sock, nonce, decision) {
    if (sock.destroyed) return;
    const text = decision ? JSON.stringify(decision) : null;
    sock.end(`${JSON.stringify(text ? { decision: text, mac: hmac(this.key, `res:${nonce}:${text}`) } : {})}\n`);
  }

  list() { return [...this.pending.values()].map((p) => p.request); }
}

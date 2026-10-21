// The approval server. The PreToolUse hook (src/hook/approval-hook.cjs) connects
// here for every tool call in Halo's own Claude Code sessions. Reads are
// answered at once; anything that changes something waits for an Allow/Deny
// click in the panel.

import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const DECISION_TIMEOUT_MS = 110_000;

export function socketPath() {
  if (process.platform === "win32") return `\\\\.\\pipe\\halo-${os.userInfo().username}`;
  return path.join(os.tmpdir(), `halo-${process.getuid?.() ?? "u"}.sock`);
}

// ── policy ────────────────────────────────────────────────────────────────────

// WebFetch is not here on purpose: together with reading files it could send
// what it read to any address, so fetching a page asks first.
const READ_BUILTINS = new Set([
  "Read", "Glob", "Grep", "LS", "WebSearch", "ToolSearch", "TodoWrite", "Task", "Agent", "Skill",
  "ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool", "StructuredOutput",
]);
const FILE_READS = new Set(["Read", "Glob", "Grep", "LS"]);
// "Always" never covers these: one Allow must not open up every command or file.
const NEVER_REMEMBER = new Set(["Bash", "PowerShell", "Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch"]);
// A connector tool whose name says it changes something is never a read, whatever it starts with.
const MCP_WRITE_WORD = /(^|_)(send|post|create|update|delete|remove|add|set|write|edit|move|archive|reply|forward|schedule|invite|assign|transition|comment|upload|share|draft|mark|label|trash|respond|complete|close|merge|approve|publish|rename|cancel)(_|$)/i;

// Secrets Halo never reads without asking: keys, tokens, keychains, browser profiles.
const SECRET_PATH = new RegExp([
  String.raw`[\/]\.(ssh|aws|gnupg|kube|docker|azure|gcloud|config[\/]gcloud|config[\/]gh)([\/]|$)`,
  String.raw`[\/]Library[\/](Keychains|Cookies)([\/]|$)`,
  String.raw`[\/](Google[\/]Chrome|BraveSoftware|Microsoft[\/]Edge|Firefox|Mozilla|Safari|Arc)[\/]`,
  String.raw`[\/]AppData[\/](Roaming|Local)[\/]Microsoft[\/](Credentials|Protect|Vault)([\/]|$)`,
  String.raw`[\/]\.claude[\/]\.credentials\.json$`,
  String.raw`(^|[\/])\.(env|env\..+|netrc|npmrc|pypirc|git-credentials)$`,
  String.raw`(^|[\/])(id_rsa|id_ed25519|id_ecdsa|id_dsa)(\.pub)?$`,
  String.raw`\.(pem|key|p12|pfx|keychain|keychain-db|kdbx)$`,
  String.raw`(^|[\/])(credentials|secrets?)(\.json|\.ya?ml|\.toml)?$`,
].join("|"), "i");

/** True when a file tool would touch a secret (for Glob/Grep the folder or the pattern). */
export function touchesSecrets(tool, input = {}) {
  const home = os.homedir();
  const expand = (p) => String(p || "").replace(/^~(?=$|[\\/])/, home);
  const paths = [input.file_path, input.path, input.notebook_path, tool === "Glob" ? input.pattern : null, input.glob].filter(Boolean).map(expand);
  return paths.some((p) => SECRET_PATH.test(p) || SECRET_PATH.test(path.resolve(home, p)));
}
const WRITE_BUILTINS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const MCP_READ = /^(get|list|read|search|fetch|lookup|find|query|describe|view|my_|atlassianuserinfo|getaccessible|slack_read|slack_search)/i;

const GH_READ = [
  /^gh (pr|issue) (list|view|status|checks|diff)\b/,
  /^gh search (prs|issues|repos|code|commits)\b/,
  /^gh run (list|view)\b/,
  /^gh repo (view|list)\b/,
  /^gh (status|auth status)\b/,
  /^gh release (list|view)\b/,
];
const ACLI_READ = [/^acli jira (workitem|project|board|sprint|filter|dashboard) (search|view|list|get)\b/, /^acli jira auth status\b/];
const PIPE_OK = /^(jq|head|tail|grep|wc|sort|uniq|cut|tr|column)\b/;

/** True for a shell command that only reads GitHub or Jira. */
export function isSafeReadCommand(cmd) {
  const c = String(cmd || "").trim();
  if (!c || /[;&<>`\n\r]|\$\(/.test(c)) return false;
  const [first, ...rest] = c.split("|").map((s) => s.trim());
  if (!rest.every((s) => PIPE_OK.test(s))) return false;
  if (GH_READ.some((re) => re.test(first)) || ACLI_READ.some((re) => re.test(first))) return true;
  if (/^gh api\b/.test(first)) {
    if (/\s(-X|--method)\s+(?!GET\b)/i.test(first)) return false;
    if (/\bmutation\b/i.test(first)) return false;
    // -f/-F turn `gh api` into a POST; only GraphQL queries are allowed that way.
    if (/\s(-f|-F|--field|--raw-field|--input)\b/.test(first) && !/^gh api graphql\b/.test(first)) return false;
    return true;
  }
  return false;
}

function inside(dir, file) {
  if (!dir || !file) return false;
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** @returns {"allow" | "ask"} */
export function classify(tool, input, { safeDirs = [] } = {}) {
  if (FILE_READS.has(tool) && touchesSecrets(tool, input)) return "ask";
  if (READ_BUILTINS.has(tool)) return "allow";
  if (WRITE_BUILTINS.has(tool)) {
    const file = input?.file_path || input?.notebook_path;
    return safeDirs.some((d) => inside(d, file)) ? "allow" : "ask";
  }
  if (tool === "Bash" || tool === "PowerShell") return isSafeReadCommand(input?.command) ? "allow" : "ask";
  if (tool.startsWith("mcp__")) {
    const name = tool.split("__").at(-1);
    return MCP_READ.test(name) && !MCP_WRITE_WORD.test(name) ? "allow" : "ask";
  }
  return "ask";
}

// ── describing a request for the approval card ────────────────────────────────

function service(tool) {
  if (/Slack/i.test(tool)) return "slack";
  if (/Ninety/i.test(tool)) return "ninety";
  if (/Atlassian|jira/i.test(tool)) return "jira";
  if (/gmail/i.test(tool)) return "gmail";
  if (/calendar/i.test(tool)) return "calendar";
  return "other";
}

function words(name) {
  return name.replace(/_v\d+$/, "").replace(/^slack_/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
}

export function describe(tool, input = {}) {
  if (tool === "WebFetch") return { service: "other", title: "Open a web page", text: input.url || "", note: input.prompt ? `To find: ${String(input.prompt).slice(0, 160)}` : "" };
  if (FILE_READS.has(tool)) return { service: "file", title: "Read something private", text: input.file_path || input.path || input.pattern || "", note: "This looks like keys, passwords or a browser profile." };
  if (tool === "Bash" || tool === "PowerShell") {
    const isGh = /^\s*gh\b/.test(input.command || "");
    return { service: isGh ? "github" : "shell", title: isGh ? "Run a GitHub command" : "Run a shell command", text: input.command, note: input.description || "" };
  }
  if (WRITE_BUILTINS.has(tool)) {
    return { service: "file", title: `${tool === "Write" ? "Write" : "Edit"} a file`, text: input.file_path || "", note: "" };
  }
  if (tool.startsWith("mcp__")) {
    const parts = tool.split("__");
    const server = parts[1].replace(/^claude_ai_/, "").replace(/_/g, " ");
    const name = parts.at(-1);
    const svc = service(tool);
    const text =
      input.text || input.message || input.body || input.commentBody || input.comment ||
      input.summary || input.title || input.description || "";
    const target = input.channel_id || input.channel || input.issueIdOrKey || input.issue_key || input.projectKey || input.team_id || "";
    return {
      service: svc,
      title: `${server}: ${words(name)}`,
      text: typeof text === "string" ? text : JSON.stringify(text),
      note: target ? `→ ${target}` : "",
    };
  }
  return { service: "other", title: words(tool), text: "", note: "" };
}

// ── server ────────────────────────────────────────────────────────────────────

export class ApprovalServer extends EventEmitter {
  constructor({ safeDirs = () => [] } = {}) {
    super();
    this.token = crypto.randomBytes(24).toString("hex");
    this.path = socketPath();
    this.pending = new Map(); // id → { resolve, timer, request }
    this.sessionAllow = new Map(); // session_id → Set(tool names)
    this.safeDirs = safeDirs;
    this.server = null;
  }

  async start() {
    if (process.platform !== "win32") {
      try { fs.unlinkSync(this.path); } catch {}
    }
    this.server = net.createServer((sock) => this.handle(sock));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.path, () => resolve());
    });
    if (process.platform !== "win32") fs.chmodSync(this.path, 0o600);
  }

  stop() {
    for (const p of this.pending.values()) p.resolve({ decision: "deny", reason: "Halo is closing." });
    this.server?.close();
  }

  /** Environment the hook needs; passed to every Claude Code process Halo starts. */
  env() { return { HALO_SOCK: this.path, HALO_TOKEN: this.token }; }

  handle(sock) {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", async (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = "";
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return sock.end(JSON.stringify({ decision: "deny", reason: "Bad request" }) + "\n");
      }
      if (msg.token !== this.token) return sock.end(JSON.stringify({ decision: "deny", reason: "Unknown caller" }) + "\n");
      const res = await this.decide(msg, sock);
      if (!sock.destroyed) sock.end(JSON.stringify(res) + "\n");
    });
    sock.on("error", () => {});
  }

  async decide(msg, sock) {
    const tool = String(msg.tool_name || "");
    const input = msg.tool_input || {};
    this.emit("tool", { sessionId: msg.session_id, tool, input });
    if (classify(tool, input, { safeDirs: this.safeDirs() }) === "allow") return { decision: "allow" };
    if (this.sessionAllow.get(msg.session_id)?.has(tool)) return { decision: "allow", reason: "Allowed for this chat" };
    // Scheduled and dashboard runs have nobody watching: they only read.
    if (msg.background) return { decision: "deny", reason: "This is a background check, so Halo only reads. Leave this out and finish with what you have." };

    const id = crypto.randomUUID();
    const request = { id, sessionId: msg.session_id, tool, input, ...describe(tool, input), canRemember: !NEVER_REMEMBER.has(tool) && !FILE_READS.has(tool), createdAt: Date.now() };
    return new Promise((resolve) => {
      const finish = (res) => {
        if (!this.pending.has(id)) return;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        this.emit("resolved", { id, ...res });
        resolve(res);
      };
      const entry = {
        request,
        resolve: finish,
        timer: setTimeout(() => finish({ decision: "deny", reason: "No answer in time, so Halo denied it." }), DECISION_TIMEOUT_MS),
      };
      this.pending.set(id, entry);
      sock.on("close", () => finish({ decision: "deny", reason: "Request cancelled" }));
      this.emit("request", request);
    });
  }

  /** Called from the panel's Allow / Deny buttons. */
  answer(id, { allow, remember }) {
    const p = this.pending.get(id);
    if (!p) return false;
    if (allow && remember && p.request.canRemember) {
      const set = this.sessionAllow.get(p.request.sessionId) ?? new Set();
      set.add(p.request.tool);
      this.sessionAllow.set(p.request.sessionId, set);
    }
    p.resolve(allow ? { decision: "allow" } : { decision: "deny", reason: "The user denied this in Halo." });
    return true;
  }

  list() { return [...this.pending.values()].map((p) => p.request); }
}

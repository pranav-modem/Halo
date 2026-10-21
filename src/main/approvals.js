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

// ── shell commands that run without asking ─────────────────────────────────────
// Only GitHub and Jira reads, optionally piped through a few filters. Anything
// the parser doesn't fully understand asks.

/**
 * Splits a command into pipeline stages of words, honouring quotes. Returns
 * null for anything beyond running and piping: redirection, chaining,
 * expansion, globs, or substitution (even inside double quotes).
 */
export function parsePipeline(cmd) {
  const stages = [[]];
  let word = null;
  let quote = "";
  const end = () => {
    if (word !== null) stages.at(-1).push(word);
    word = null;
  };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) quote = "";
      else if (quote === '"' && /[$`\\!]/.test(ch)) return null;
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      word ??= "";
    } else if (ch === " " || ch === "\t") end();
    else if (ch === "|") {
      end();
      if (!stages.at(-1).length) return null;
      stages.push([]);
    } else if (/[\w@%+=:,./-]/.test(ch)) word = (word ?? "") + ch;
    else return null; // ; & < > ` $ ( ) { } * ? [ ] ~ ! # \ newline …
  }
  end();
  return !quote && stages.every((st) => st.length) ? stages : null;
}

/** True when every word is an allowed flag (values checked) and there are at most `positional` other words. */
function onlyFlags(args, isFlag, { values = {}, positional = 0 } = {}) {
  let count = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const joined = Object.keys(values).find((f) => a.startsWith(f) && a.length > f.length);
    if (a in values) {
      if (!values[a](args[++i] ?? "")) return false;
    } else if (joined) {
      if (!values[joined](a.slice(joined.length))) return false;
    } else if (a.startsWith("-")) {
      if (!isFlag(a)) return false;
    } else if (++count > positional) return false;
  }
  return true;
}

const NUM = (v) => /^\d+$/.test(v);
// Filters that read only the pipe: no file arguments, nothing that writes.
const PIPES = {
  jq: (a) => onlyFlags(a, (f) => /^-[rcsejMS]+$/.test(f) || ["--raw-output", "--compact-output", "--slurp", "--join-output", "--sort-keys"].includes(f), { positional: 1 }),
  head: (a) => onlyFlags(a, (f) => /^-\d+$/.test(f), { values: { "-n": NUM, "-c": NUM } }),
  tail: (a) => onlyFlags(a, (f) => /^-\d+$/.test(f), { values: { "-n": NUM, "-c": NUM } }),
  wc: (a) => onlyFlags(a, (f) => /^-[lwcm]+$/.test(f)),
  grep: (a) => onlyFlags(a, (f) => /^-[ivcEFwxnoh]+$/.test(f), { values: { "-m": NUM }, positional: 1 }),
  sort: (a) => onlyFlags(a, (f) => /^-[rnuf]+$/.test(f), { values: { "-k": (v) => /^[\d.,a-z]+$/.test(v), "-t": (v) => v.length === 1 } }),
  uniq: (a) => onlyFlags(a, (f) => /^-[cdu]+$/.test(f)),
};

const GH_READ = {
  pr: ["list", "view", "status", "checks", "diff"],
  issue: ["list", "view", "status"],
  search: ["prs", "issues", "repos", "code", "commits"],
  run: ["list", "view"],
  repo: ["list", "view"],
  release: ["list", "view"],
};

/** `gh api` that can only read: GET, no request body, no files, and GraphQL queries only. */
function ghApiRead(args) {
  let endpoint = null;
  const fields = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const [flag, inline] = eq > 0 ? [a.slice(0, eq), a.slice(eq + 1)] : /^-[XfFqt]./.test(a) ? [a.slice(0, 2), a.slice(2)] : [a, undefined];
    const value = () => inline ?? args[++i] ?? "";
    if (flag === "-X" || flag === "--method") {
      if (value().toUpperCase() !== "GET") return false;
    } else if (flag === "-f" || flag === "--raw-field") fields.push(value());
    else if (flag === "-F" || flag === "--field") {
      const field = value();
      if (/^[^=]*=@/.test(field)) return false; // "@file" reads a file into the request
      fields.push(field);
    } else if (["-q", "--jq", "-t", "--template", "--cache"].includes(flag)) value();
    else if (["--paginate", "--slurp", "-i", "--include", "--silent"].includes(flag)) continue;
    else if (flag.startsWith("-") || endpoint) return false; // --input, -H, unknown flags, a second endpoint
    else endpoint = flag;
  }
  if (!endpoint) return false;
  if (endpoint !== "graphql") return fields.length === 0; // fields would turn the call into a POST
  const query = fields.find((f) => f.startsWith("query="));
  return !!query && !fields.some((f) => /\b(mutation|subscription)\b/i.test(f));
}

function acliRead([product, area, verb, ...rest]) {
  if (product !== "jira") return false;
  if (area === "auth") return verb === "status" && rest.length === 0;
  return ["workitem", "project", "board", "sprint", "filter", "dashboard"].includes(area)
    && ["search", "view", "list", "get"].includes(verb)
    && !rest.some((a) => /file|output/i.test(a));
}

/** True for a shell command that only reads GitHub or Jira. */
export function isSafeReadCommand(cmd) {
  const stages = parsePipeline(String(cmd || "").trim());
  if (!stages) return false;
  const [[bin, ...args], ...pipes] = stages;
  if (!pipes.every(([name, ...a]) => Object.hasOwn(PIPES, name) && PIPES[name](a))) return false;
  if (bin === "acli") return acliRead(args);
  if (bin !== "gh") return false;
  const [sub, verb] = args;
  if (sub === "api") return ghApiRead(args.slice(1));
  if (sub === "status") return args.length === 1;
  if (sub === "auth") return verb === "status" && args.length === 2;
  return !!GH_READ[sub]?.includes(verb) && !args.some((a) => /^--show-token|^--hostname/.test(a));
}

// ── files written without asking ──────────────────────────────────────────────

/** Where `p` really points, following symlinks in whatever part of it exists. */
function realPath(p) {
  let dir = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) {
    rest.unshift(path.basename(dir));
    dir = path.dirname(dir);
  }
  try { dir = fs.realpathSync(dir); } catch {}
  return path.join(dir, ...rest);
}

// Claude Code loads settings, hooks and instructions from files like these.
const CONFIG_NAME = /^(\.|claude\.md$|agents\.md$)/i;

/** Notes (.md / .txt) in the notes folder, and the memory file. Never config, never through a symlink. */
export function isSafeWrite(file, { notesDir, memoryFile } = {}) {
  if (!file) return false;
  if (memoryFile && path.resolve(file) === path.resolve(memoryFile)) {
    try { return !fs.lstatSync(memoryFile).isSymbolicLink(); } catch { return true; }
  }
  if (!notesDir || !/\.(md|txt)$/i.test(file)) return false;
  const rel = path.relative(realPath(notesDir), realPath(file));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  return !rel.split(path.sep).some((seg) => CONFIG_NAME.test(seg));
}

/** @returns {"allow" | "ask"} */
export function classify(tool, input, { writable = {}, background = false } = {}) {
  if (FILE_READS.has(tool) && touchesSecrets(tool, input)) return "ask";
  if (READ_BUILTINS.has(tool)) return "allow";
  // Background runs have nobody watching: they never write.
  if (WRITE_BUILTINS.has(tool)) return !background && isSafeWrite(input?.file_path || input?.notebook_path, writable) ? "allow" : "ask";
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
  constructor({ writable = () => ({}) } = {}) {
    super();
    this.token = crypto.randomBytes(24).toString("hex");
    this.path = socketPath();
    this.pending = new Map(); // id → { resolve, timer, request }
    this.sessionAllow = new Map(); // session_id → Set(tool names)
    this.writable = writable;
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
    if (classify(tool, input, { writable: this.writable(), background: !!msg.background }) === "allow") return { decision: "allow" };
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

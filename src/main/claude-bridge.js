// Talks to the user's own Claude Code (`claude -p`, stream-json in and out),
// so Halo runs on their Claude Code login and connectors, not the API.
//
// One ClaudeSession = one chat. The process stays alive between messages so
// follow-ups are quick; it's restarted with --resume after a stop or idling.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { childEnv, run, which } from "./env.js";

const isWin = process.platform === "win32";
const IDLE_KILL_MS = 15 * 60 * 1000;

// Claude Code tools a desktop work companion never needs.
const DISALLOWED = [
  "Artifact", "ArtifactComments", "ArtifactData", "CronCreate", "CronDelete", "CronList", "DesignSync",
  "EnterWorktree", "ExitWorktree", "ListAgents", "Monitor", "NotebookEdit", "PublishPlugin", "PushNotification",
  "RemoteTrigger", "ReportFindings", "ScheduleWakeup", "SendMessage", "ShareOnboardingGuide", "TaskStop",
];

export function resolveClaude(override) {
  if (override && fs.existsSync(override)) return override;
  return which("claude");
}

/**
 * Env for one of Halo's Claude Code processes. API credentials are removed unless the
 * user chose to use their own key, so Claude Code uses their login.
 */
export function claudeEnv({ apiKey, extra = {} }) {
  const env = childEnv(extra);
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ELECTRON_RUN_AS_NODE;
  // Started from inside another Claude Code session (e.g. while developing
  // Halo there): drop that session's variables so Halo's Claude Code is a
  // normal one on your own login, not a child of that session.
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) {
    for (const k of Object.keys(env)) {
      if (/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_PREVIEW_|AI_AGENT$|MCP_SERVER_CONNECTION_BATCH_SIZE$|MCP_CONNECTION_NONBLOCKING$|ANTHROPIC_BASE_URL$)/.test(k)) delete env[k];
    }
  }
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
  return env;
}

/** How Claude Code runs one of Halo's hook scripts: Halo's own binary, as Node. */
export function hookCommand(hookScript) {
  const fwd = (p) => (isWin ? p.replace(/\\/g, "/") : p);
  const exe = fwd(process.execPath);
  const script = fwd(hookScript.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`));
  return `ELECTRON_RUN_AS_NODE=1 "${exe}" "${script}"`;
}

/** Writes the --settings file that installs the approval hook for Halo's own sessions only. */
export function writeHookSettings(file, hookScript) {
  const command = hookCommand(hookScript);
  const settings = {
    hooks: {
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command, timeout: 120 }] }],
    },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  return file;
}

export function baseArgs({ settingsFile, systemPrompt, model, effort, addDirs = [] }) {
  const args = [
    "-p",
    "--verbose",
    "--permission-prompts", "none",
    "--settings", settingsFile,
    "--disallowedTools", DISALLOWED.join(","),
  ];
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  for (const d of addDirs) args.push("--add-dir", d);
  return args;
}

function spawnClaude(bin, args, { cwd, env }) {
  // npm installs on Windows are .cmd shims, which need a shell.
  const shell = isWin && /\.(cmd|bat)$/i.test(bin);
  return spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell });
}

export class ClaudeSession extends EventEmitter {
  /**
   * @param {{bin:string, cwd:string, env:object, args:string[], resumeId?:string}} opts
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.proc = null;
    this.sessionId = opts.resumeId || null;
    this.resumeNext = !!opts.resumeId;
    this.busy = false;
    this.stderr = "";
    this.idleTimer = null;
    this.streamedMessages = new Set();
  }

  ensure() {
    if (this.proc) return;
    const args = [...this.opts.args, "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages"];
    if (this.resumeNext && this.sessionId) args.push("--resume", this.sessionId);
    this.resumeNext = false;
    this.stderr = "";
    const proc = spawnClaude(this.opts.bin, args, { cwd: this.opts.cwd, env: this.opts.env });
    this.proc = proc;
    let buf = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this.handleLine(line);
      }
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    proc.on("error", (err) => {
      this.emit("fatal", { message: `Couldn't start Claude Code: ${err.message}` });
    });
    proc.on("exit", (code, signal) => {
      if (this.proc === proc) this.proc = null;
      if (this.sessionId) this.resumeNext = true;
      if (this.busy) {
        this.busy = false;
        if (!this.stopping) this.emit("fatal", { message: this.explainExit(code) });
      }
      this.stopping = false;
      this.emit("exit", { code, signal });
    });
  }

  explainExit(code) {
    const s = this.stderr;
    if (/not logged in|please run.*login|\/login/i.test(s)) return "Claude Code isn't logged in. Open a terminal, run `claude`, and sign in.";
    if (/rate.?limit|usage limit/i.test(s)) return "You've hit your Claude usage limit for now.";
    return `Claude Code stopped unexpectedly (exit ${code ?? "?"}).${s ? `\n${s.trim().split("\n").slice(-3).join("\n")}` : ""}`;
  }

  handleLine(line) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    switch (m.type) {
      case "system":
        if (m.subtype === "init") {
          this.sessionId = m.session_id;
          this.emit("init", {
            sessionId: m.session_id,
            model: m.model,
            apiKeySource: m.apiKeySource,
            mcpServers: m.mcp_servers ?? [],
          });
        }
        break;
      case "stream_event": {
        const e = m.event;
        if (e?.type === "message_start") this.currentMessage = e.message?.id;
        if (e?.type === "content_block_start" && e.content_block?.type === "tool_use") {
          this.emit("toolStart", { id: e.content_block.id, name: e.content_block.name });
        }
        if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") {
          if (this.currentMessage) this.streamedMessages.add(this.currentMessage);
          this.emit("text", e.delta.text);
        }
        if (e?.type === "content_block_start" && e.content_block?.type === "text") this.emit("textBlock");
        break;
      }
      case "assistant": {
        const msg = m.message ?? {};
        for (const b of msg.content ?? []) {
          if (b.type === "tool_use") this.emit("toolUse", { id: b.id, name: b.name, input: b.input });
          if (b.type === "text" && !this.streamedMessages.has(msg.id)) this.emit("text", b.text);
        }
        break;
      }
      case "user": {
        const content = m.message?.content;
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b.type === "tool_result") this.emit("toolResult", { id: b.tool_use_id, isError: !!b.is_error });
          }
        }
        break;
      }
      case "rate_limit_event":
        this.emit("rateLimit", m.rate_limit_info);
        break;
      case "result":
        this.busy = false;
        this.streamedMessages.clear();
        this.emit("result", {
          ok: !m.is_error,
          text: m.result,
          sessionId: m.session_id,
          costUsd: m.total_cost_usd,
          durationMs: m.duration_ms,
          stopReason: m.stop_reason,
          denials: m.permission_denials ?? [],
        });
        this.armIdle();
        break;
      default:
        break;
    }
  }

  /** @param {Array<object>} content Anthropic content blocks (text / image). */
  send(content) {
    this.ensure();
    clearTimeout(this.idleTimer);
    this.busy = true;
    const line = JSON.stringify({ type: "user", message: { role: "user", content } });
    this.proc.stdin.write(line + "\n");
  }

  /** Stops the current answer. The next message resumes the same conversation. */
  stop() {
    if (!this.proc) return;
    this.stopping = true;
    this.busy = false;
    this.proc.kill();
    this.emit("stopped");
  }

  armIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.proc && !this.busy) {
        this.stopping = true;
        this.proc.kill();
      }
    }, IDLE_KILL_MS);
  }

  dispose() {
    clearTimeout(this.idleTimer);
    this.removeAllListeners();
    if (this.proc) {
      this.stopping = true;
      this.proc.kill();
    }
  }
}

/**
 * One-shot structured run (`--output-format json --json-schema`). Used by the
 * Today dashboard for Rocks and Slack. Returns the parsed object.
 */
export async function runStructured({ bin, cwd, env, args, prompt, schema, timeoutMs = 240_000 }) {
  const full = [...args, "--output-format", "json", "--json-schema", JSON.stringify(schema), "--no-session-persistence", prompt];
  return new Promise((resolve, reject) => {
    const proc = spawnClaude(bin, full, { cwd, env });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { proc.kill(); reject(new Error("Claude Code took too long.")); }, timeoutMs);
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    proc.stdin.end();
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      try {
        let res = JSON.parse(out);
        // With --verbose, Claude Code prints every message as an array; the result comes last.
        if (Array.isArray(res)) res = res.findLast((m) => m?.type === "result") ?? {};
        if (res.is_error) return reject(new Error(res.result || "Claude Code returned an error."));
        resolve({ data: res.structured_output ?? null, costUsd: res.total_cost_usd, sessionId: res.session_id });
      } catch {
        reject(new Error(err.trim().split("\n").slice(-2).join(" ") || `Claude Code exited with ${code}`));
      }
    });
  });
}

/** Quick health check for Settings: version and whether `claude` runs at all. */
export async function claudeVersion(bin) {
  if (!bin) return null;
  const r = await run(bin, ["--version"], { timeout: 15000 });
  return r.ok ? r.stdout.trim() : null;
}

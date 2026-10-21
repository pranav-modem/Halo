// Hook for your own Claude Code sessions (terminal, the Claude app, VS Code).
// It is in ~/.claude/settings.json only while "Approve my sessions from Halo"
// is on. Claude Code runs it for PermissionRequest (so you can answer in
// Halo) and for UserPromptSubmit, Stop and SessionEnd (so Halo knows exactly
// what each session is doing).
//
// It never blocks Claude Code: if Halo isn't running, doesn't answer in time,
// or anything at all goes wrong, it prints {} and exits 0, and Claude Code
// asks you itself as usual.

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const PERMISSION_WAIT_MS = 130_000; // Claude Code gives this hook 135 s
const EVENT_WAIT_MS = 2_500; // status events get 5 s

let finished = false;
function finish(out = {}) {
  if (finished) return;
  finished = true;
  process.stdout.write(`${JSON.stringify(out)}\n`, () => process.exit(0));
}
process.on("uncaughtException", () => finish());
setTimeout(() => finish(), PERMISSION_WAIT_MS + 1500);

/** Where Halo leaves its socket address and key: Electron's data folder for "Halo". */
function infoFile() {
  if (process.env.HALO_CC_INFO) return process.env.HALO_CC_INFO;
  const home = os.homedir();
  const base =
    process.platform === "darwin" ? path.join(home, "Library", "Application Support")
    : process.platform === "win32" ? process.env.APPDATA || path.join(home, "AppData", "Roaming")
    : process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(base, "Halo", "cc-hook.json");
}

const hmac = (key, s) => crypto.createHmac("sha256", key).update(s).digest("hex");
function same(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("error", () => finish());
process.stdin.on("end", () => {
  try {
    main();
  } catch {
    finish();
  }
});

function main() {
  // Halo's own chats have their own PreToolUse hook, and its background runs only read.
  if (process.env.HALO_TOKEN || process.env.HALO_BACKGROUND === "1") return finish();
  const p = JSON.parse(input.replace(/^﻿/, ""));
  const info = JSON.parse(fs.readFileSync(infoFile(), "utf8"));
  if (!info?.sock || !info?.key) return finish();

  const event = p.hook_event_name;
  const permission = event === "PermissionRequest";
  const nonce = crypto.randomBytes(16).toString("hex");
  // Only what Halo shows; never the transcript.
  const msg = {
    v: 1,
    nonce,
    proof: hmac(info.key, `req:${nonce}`),
    event,
    session_id: p.session_id,
    cwd: p.cwd,
    entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT || "",
  };
  if (permission) {
    msg.tool_name = p.tool_name;
    msg.tool_input = p.tool_input;
    msg.permission_suggestions = Array.isArray(p.permission_suggestions) ? p.permission_suggestions : [];
    msg.permission_mode = p.permission_mode;
  }
  if (event === "UserPromptSubmit") msg.prompt = String(p.prompt ?? "").slice(0, 500);
  if (event === "Stop") msg.last = String(p.last_assistant_message ?? "").slice(0, 500);
  if (event === "SessionEnd") msg.reason = p.reason;

  setTimeout(() => finish(), permission ? PERMISSION_WAIT_MS : EVENT_WAIT_MS);
  const sock = net.createConnection(info.sock);
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("connect", () => sock.write(`${JSON.stringify(msg)}\n`));
  sock.on("data", (d) => {
    buf += d;
    const nl = buf.indexOf("\n");
    if (nl < 0) return;
    sock.destroy();
    const res = JSON.parse(buf.slice(0, nl));
    // An answer only counts if it proves it came from Halo (it knows the key).
    if (!permission || typeof res?.decision !== "string" || !same(res.mac, hmac(info.key, `res:${nonce}:${res.decision}`))) return finish();
    const decision = JSON.parse(res.decision);
    if (decision?.behavior !== "allow" && decision?.behavior !== "deny") return finish();
    finish({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
  });
  sock.on("error", () => finish());
  sock.on("close", () => finish());
}

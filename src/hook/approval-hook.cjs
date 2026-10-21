// PreToolUse hook for Halo's own Claude Code sessions. Claude Code runs
// it before every tool call; it asks the Halo app (over a Unix socket
// on macOS or a named pipe on Windows) and prints the decision.
//
// Fails closed: if the app can't be reached or doesn't answer in time, the
// tool call is denied. These are Halo's sessions, never the user's
// terminal ones, so nothing is lost by denying.

const net = require("node:net");

const SOCK = process.env.HALO_SOCK;
const TOKEN = process.env.HALO_TOKEN;
const DECISION_TIMEOUT_MS = 115_000;

function reply(decision, reason) {
  const out = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision === "allow" ? "allow" : "deny",
      permissionDecisionReason: reason || (decision === "allow" ? "Allowed in Halo" : "Denied in Halo"),
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  if (!SOCK || !TOKEN) return reply("deny", "Halo isn't running.");
  let payload;
  try {
    payload = JSON.parse(input.replace(/^\uFEFF/, ""));
  } catch {
    return reply("deny", "Halo couldn't read the tool request.");
  }
  // Only what the app needs to decide; never the transcript.
  const msg = {
    token: TOKEN,
    session_id: payload.session_id,
    tool_name: payload.tool_name,
    tool_input: payload.tool_input,
    cwd: payload.cwd,
    background: process.env.HALO_BACKGROUND === "1",
  };

  const timer = setTimeout(() => reply("deny", "No answer from Halo in time."), DECISION_TIMEOUT_MS);
  const sock = net.createConnection(SOCK);
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("connect", () => sock.write(JSON.stringify(msg) + "\n"));
  sock.on("data", (d) => {
    buf += d;
    const nl = buf.indexOf("\n");
    if (nl < 0) return;
    clearTimeout(timer);
    try {
      const res = JSON.parse(buf.slice(0, nl));
      reply(res.decision, res.reason);
    } catch {
      reply("deny", "Halo sent an unreadable answer.");
    }
  });
  sock.on("error", () => {
    clearTimeout(timer);
    reply("deny", "Halo isn't reachable.");
  });
});

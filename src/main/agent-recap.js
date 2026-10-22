// Your time with your agents: hours, sessions, lines changed, files, commands,
// busiest day and top project, worked out on this computer from the
// transcripts Claude Code keeps. Scripted runs (`claude -p`, the SDKs),
// Halo's own among them, are left out.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchFolder, projectName } from "./sessions.js";

const IDLE_MS = 5 * 60_000; // a longer pause between steps isn't time spent together
const EDITS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const projectsDir = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");

function transcripts(since) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(projectsDir(), { withFileTypes: true }); } catch {}
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(projectsDir(), d.name);
    let names = [];
    try { names = fs.readdirSync(dir); } catch {}
    for (const n of names) {
      const file = path.join(dir, n);
      try { if (n.endsWith(".jsonl") && fs.statSync(file).mtimeMs >= since) out.push(file); } catch {}
    }
  }
  return out;
}

/** Lines added and removed by one edit's result. */
function lineCounts(result) {
  let add = 0, del = 0;
  for (const hunk of result?.structuredPatch ?? []) {
    for (const l of hunk.lines ?? []) {
      if (l.startsWith("+")) add++;
      else if (l.startsWith("-")) del++;
    }
  }
  if (!add && !del && result?.type === "create" && typeof result.content === "string") add = result.content.split("\n").length;
  return { add, del };
}

/** @param {{ start: number, end: number, exclude?: string[] }} range */
export function agentStats({ start, end, exclude = [] }) {
  const skip = new Set(exclude.map((p) => path.resolve(p)));
  const byDay = new Map();
  const byProject = new Map();
  const files = new Set();
  let ms = 0, sessions = 0, commands = 0, added = 0, removed = 0;

  for (const file of transcripts(start)) {
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    let title = "", cwd = "", scripted = false, last = 0, mine = 0;
    const stamps = [];
    const counted = new Set();
    const f = { commands: 0, added: 0, removed: 0, files: new Set() };
    for (const line of text.split("\n")) {
      if (!line) continue;
      // Parsing is the slow part: skip lines from outside the period once the session is known.
      const ts = line.indexOf('"timestamp":"');
      const at0 = ts < 0 ? NaN : Date.parse(line.slice(ts + 13, ts + 37));
      if (cwd && !(at0 >= start && at0 < end) && !line.includes('"custom-title"') && !line.includes('"sdk-')) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (r.type === "custom-title" && r.customTitle) title = r.customTitle;
      if (/^sdk-/.test(r.entrypoint ?? "")) scripted = true;
      if (r.cwd && !cwd) cwd = r.cwd;
      const at = Date.parse(r.timestamp ?? "");
      if (!(at >= start && at < end)) continue;
      stamps.push(at);
      if (r.type === "assistant" && Array.isArray(r.message?.content)) {
        for (const c of r.message.content) {
          if (c?.type !== "tool_use") continue;
          if (c.name === "Bash" || c.name === "PowerShell") f.commands++;
          if (EDITS.has(c.name) && (c.input?.file_path || c.input?.notebook_path)) f.files.add(c.input.file_path || c.input.notebook_path);
        }
      }
      // Each edit's result carries its diff; count it once.
      if (r.type === "user" && r.toolUseResult?.filePath && r.uuid && !counted.has(r.uuid)) {
        counted.add(r.uuid);
        const { add, del } = lineCounts(r.toolUseResult);
        f.added += add;
        f.removed += del;
      }
    }
    const folder = launchFolder(file) || cwd;
    if (scripted || !stamps.length || skip.has(path.resolve(folder || "/"))) continue;
    stamps.sort((a, b) => a - b);
    for (const at of stamps) {
      const gap = last ? at - last : 0;
      if (gap > 0 && gap <= IDLE_MS) {
        mine += gap;
        const day = new Date(at).toDateString();
        byDay.set(day, (byDay.get(day) ?? 0) + gap);
      }
      last = at;
    }
    if (!mine) continue;
    sessions++;
    ms += mine;
    commands += f.commands;
    added += f.added;
    removed += f.removed;
    for (const x of f.files) files.add(x);
    const name = projectName(folder, title);
    byProject.set(name, (byProject.get(name) ?? 0) + mine);
  }

  const top = (m) => [...m].sort((a, b) => b[1] - a[1])[0] ?? null;
  const busiest = top(byDay);
  const project = top(byProject);
  return {
    start, end, ms, sessions, commands,
    files: files.size,
    lines: { added, removed },
    busiestDay: busiest ? { name: DAYS[new Date(busiest[0]).getDay()], ms: busiest[1] } : null,
    topProject: project ? { name: project[0], ms: project[1] } : null,
  };
}

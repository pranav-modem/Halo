// Halo's memory, the skills Claude Code can use, and chat history.
//
// Memory is a Markdown file in Halo's workspace folder. Every new chat reads
// it (it's added to the system prompt), and Claude can add to it when the user
// says "remember…". Skills and history are read from Claude Code's own
// folders; Halo never deletes anything there.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLAUDE_DIR = path.join(os.homedir(), ".claude");

// ── memory ────────────────────────────────────────────────────────────────────

const MEMORY_HEADER = "# What Halo remembers\n\nOne fact per line. Halo reads this at the start of every chat.\n\n";

export class Memory {
  constructor(store) { this.store = store; }

  get file() {
    const dir = this.store.get("workspaceDir");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, "memory.md");
  }

  text() {
    try {
      return fs.readFileSync(this.file, "utf8");
    } catch {
      return "";
    }
  }

  items() {
    return this.text().split("\n").filter((l) => /^\s*[-*]\s+\S/.test(l)).map((l) => l.replace(/^\s*[-*]\s+/, "").trim());
  }

  write(items) {
    fs.writeFileSync(this.file, MEMORY_HEADER + items.map((i) => `- ${i.replace(/\s+/g, " ").trim()}`).join("\n") + "\n");
  }

  add(text) {
    const t = String(text || "").trim();
    if (!t) return this.items();
    const items = this.items();
    if (!items.includes(t)) items.push(t);
    this.write(items);
    return items;
  }

  remove(index) {
    const items = this.items();
    items.splice(index, 1);
    this.write(items);
    return items;
  }

  /** The part of the system prompt that carries the memory. */
  prompt() {
    const items = this.items();
    return [
      `Your memory file is ${this.file}. ${items.length ? "What you remember about the user:" : "It's empty so far."}`,
      ...items.map((i) => `- ${i}`),
      'When the user says "remember…", or tells you a lasting fact or preference about themselves or their work (their team, manager, projects, how they like answers), add it as one "- " line to that file with the Edit tool, and say you\'ll remember it. When they ask you to forget something, remove the line.',
    ].join("\n");
  }
}

// ── skills ────────────────────────────────────────────────────────────────────

function frontmatter(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    const m = /^---\s*\n([\s\S]*?)\n---/.exec(text);
    if (!m) return {};
    const out = {};
    let key = null;
    for (const line of m[1].split("\n")) {
      const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
      if (kv) {
        key = kv[1];
        out[key] = kv[2].replace(/^["']|["']$/g, "");
      } else if (key && /^\s+\S/.test(line)) {
        out[key] = `${out[key]} ${line.trim()}`.trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

function scanSkillDir(dir, source) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const file = path.join(dir, e.name, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const fm = frontmatter(file);
    out.push({ name: fm.name || e.name, description: (fm.description || "").replace(/\s+/g, " ").trim(), source, path: path.join(dir, e.name) });
  }
  return out;
}

/**
 * Every skill Claude Code can use. `init` is the last Claude Code start-up
 * message (its `skills` names and `plugins` folders).
 */
function installedPlugins() {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, "plugins", "installed_plugins.json"), "utf8"));
    return Object.entries(d.plugins ?? {}).flatMap(([key, installs]) => (installs ?? []).slice(0, 1).map((i) => ({ name: key.split("@")[0], path: i.installPath })));
  } catch {
    return [];
  }
}

export function listSkills(init) {
  const found = [...scanSkillDir(path.join(CLAUDE_DIR, "skills"), "Your skills")];
  for (const p of init?.plugins?.length ? init.plugins : installedPlugins()) {
    for (const s of scanSkillDir(path.join(p.path, "skills"), `Plugin: ${p.name}`)) found.push({ ...s, name: s.name.includes(":") ? s.name : `${p.name}:${s.name}` });
  }
  const byName = new Map(found.map((s) => [s.name, s]));
  for (const name of init?.skills ?? []) {
    if (!byName.has(name) && !found.some((s) => s.name.endsWith(`:${name}`) || s.name === name.split(":").at(-1))) {
      byName.set(name, { name, description: "", source: "Built in or from claude.ai", path: "" });
    }
  }
  return [...byName.values()].sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
}

export function skillsHelp() {
  return {
    folder: path.join(CLAUDE_DIR, "skills"),
    steps: [
      "Paste a link to a skill below, or in the chat: a GitHub folder or repository, or a raw SKILL.md. Halo fetches it, tells you what it does and which files it adds, and installs it after you allow it.",
      `Or add it yourself: make a folder in ${path.join(CLAUDE_DIR, "skills")} named after the skill, with a SKILL.md inside that starts with a name and a description.`,
      "New skills work in new chats.",
    ],
  };
}

// ── history ───────────────────────────────────────────────────────────────────

/** Claude Code's project folder name for a working directory. */
function projectDir(cwd) {
  return path.join(CLAUDE_DIR, "projects", path.resolve(cwd).replace(/[^A-Za-z0-9]/g, "-"));
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

const stripContext = (s) => s.replace(/<context>[\s\S]*?<\/context>\s*/g, "").trim();

export function listHistory(store) {
  const dir = projectDir(store.get("workspaceDir"));
  const titles = new Map((store.get("recentChats") ?? []).map((c) => [c.id, c]));
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  return files
    .map((f) => {
      const id = f.replace(/\.jsonl$/, "");
      const file = path.join(dir, f);
      const stat = fs.statSync(file);
      let title = titles.get(id)?.title ?? "";
      let turns = 0;
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const m = JSON.parse(line);
          if (m.type === "user" && m.message?.role === "user") {
            const t = stripContext(textOf(m.message.content));
            if (t) {
              turns++;
              if (!title) title = t.replace(/\s+/g, " ").slice(0, 80);
            }
          }
        } catch {}
      }
      return { id, title: title || "Chat", character: titles.get(id)?.character ?? null, updatedAt: stat.mtimeMs, turns };
    })
    .filter((c) => c.turns > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function readHistory(store, id) {
  const file = path.join(projectDir(store.get("workspaceDir")), `${path.basename(id)}.jsonl`);
  const out = [];
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      if (m.type === "user" && m.message?.role === "user") {
        const t = stripContext(textOf(m.message.content));
        const images = Array.isArray(m.message.content) ? m.message.content.filter((b) => b.type === "image").length : 0;
        if (t || images) out.push({ role: "user", text: t || "(screenshot)", images, at: m.timestamp });
      } else if (m.type === "assistant") {
        const t = textOf(m.message?.content);
        if (t.trim()) {
          const last = out.at(-1);
          if (last?.role === "assistant") last.text += `\n\n${t}`;
          else out.push({ role: "assistant", text: t, at: m.timestamp });
        }
      }
    } catch {}
  }
  return out;
}

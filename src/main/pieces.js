// Pieces: small scheduled jobs. Each one is a plain-English
// instruction that runs through Claude Code on a schedule ("every 2h", or "at
// 09:00 on mon-fri"), only reads, and comes back as a speech bubble plus items
// on the "needs you" board.

import crypto from "node:crypto";
import { EventEmitter } from "node:events";

export const DEFAULT_PIECES = [
  {
    id: "morning-brief",
    name: "Morning brief",
    when: { at: "09:00", days: "mon-fri" },
    prompt: "Write my morning brief: the three to five things I should handle first today, across Ninety Rocks, Jira, GitHub, Slack, Gmail and my calendar, most time-sensitive first.",
    enabled: true,
  },
  {
    id: "pending-items",
    name: "Pending items",
    when: { every: "2h" },
    prompt: "Check for things waiting on me: Slack messages and emails I haven't answered, pull requests waiting for my review, and Jira issues assigned to me that changed. Only list what still needs me.",
    enabled: false,
  },
  {
    id: "stale-prs",
    name: "Stale PRs",
    when: { at: "14:00", days: "mon-fri" },
    prompt: "Find my open pull requests with no activity for 3 or more days, and reviews I was asked for over a day ago.",
    enabled: false,
  },
];

const DAY = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const ORDER = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function parseEvery(s) {
  const m = /^(\d+)\s*(m|h)$/i.exec(String(s || "").trim());
  if (!m) return null;
  const ms = Number(m[1]) * (m[2].toLowerCase() === "h" ? 3600_000 : 60_000);
  return Math.max(5 * 60_000, ms);
}

export function parseDays(s) {
  const set = new Set();
  for (const part of String(s || "mon-sun").toLowerCase().split(",").map((p) => p.trim()).filter(Boolean)) {
    const [a, b] = part.split("-");
    if (b && a in DAY && b in DAY) {
      for (let i = DAY[a]; ; i = (i + 1) % 7) {
        set.add(i);
        if (i === DAY[b]) break;
      }
    } else if (a in DAY) set.add(DAY[a]);
  }
  return set.size ? set : new Set([0, 1, 2, 3, 4, 5, 6]);
}

export function describeWhen(when) {
  if (when?.every) return `Every ${when.every}`;
  const days = parseDays(when?.days);
  const label = days.size === 7 ? "Every day" : days.size === 5 && [1, 2, 3, 4, 5].every((d) => days.has(d)) ? "Weekdays" : [...days].map((d) => ORDER[d][0].toUpperCase() + ORDER[d].slice(1)).join(", ");
  return `${label} at ${when?.at ?? "09:00"}`;
}

function dueAt(piece, now = new Date()) {
  if (piece.when?.every) {
    const iv = parseEvery(piece.when.every);
    if (!iv) return false;
    return !piece.lastRun || now - piece.lastRun >= iv;
  }
  const m = /^(\d{1,2}):(\d{2})$/.exec(piece.when?.at || "");
  if (!m) return false;
  if (!parseDays(piece.when?.days).has(now.getDay())) return false;
  const at = new Date(now);
  at.setHours(Number(m[1]), Number(m[2]), 0, 0);
  // Only within an hour of the time, so a laptop opened at 5 PM doesn't send the 9 AM brief.
  return now >= at && now - at < 3600_000 && (!piece.lastRun || piece.lastRun < at.getTime());
}

const SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string", description: "One or two short sentences for a speech bubble." },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          url: { type: "string" },
          urgency: { type: "string", enum: ["high", "normal", "low"] },
          source: { type: "string", enum: ["ninety", "jira", "github", "slack", "gmail", "calendar", "halo"] },
        },
        required: ["text", "urgency", "source"],
      },
    },
  },
  required: ["title", "summary", "items"],
};

export class Pieces extends EventEmitter {
  constructor({ store, chat }) {
    super();
    this.store = store;
    this.chat = chat;
    this.running = new Set();
    if (!Array.isArray(store.get("pieces"))) store.set("pieces", DEFAULT_PIECES.map((p) => ({ ...p })));
  }

  list() {
    return this.store.get("pieces").map((p) => ({ ...p, label: describeWhen(p.when), running: this.running.has(p.id) }));
  }

  save(piece) {
    const list = this.store.get("pieces").slice();
    const clean = {
      id: piece.id || crypto.randomUUID(),
      name: String(piece.name || "Piece").slice(0, 60),
      when: piece.when?.every ? { every: String(piece.when.every) } : { at: String(piece.when?.at || "09:00"), days: String(piece.when?.days || "mon-fri") },
      prompt: String(piece.prompt || "").slice(0, 2000),
      enabled: piece.enabled !== false,
      lastRun: piece.lastRun ?? null,
    };
    if (clean.when.every && !parseEvery(clean.when.every)) throw new Error("Use a schedule like every 30m or every 2h.");
    if (clean.when.at && !/^\d{1,2}:\d{2}$/.test(clean.when.at)) throw new Error("Use a time like 09:00.");
    const i = list.findIndex((p) => p.id === clean.id);
    if (i >= 0) list[i] = { ...list[i], ...clean };
    else list.push(clean);
    this.store.set("pieces", list);
    return this.list();
  }

  remove(id) {
    this.store.set("pieces", this.store.get("pieces").filter((p) => p.id !== id));
    return this.list();
  }

  start() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 60_000);
    setTimeout(() => this.tick(), 20_000);
  }

  stop() { clearInterval(this.timer); }

  tick() {
    const now = new Date();
    for (const p of this.store.get("pieces")) {
      if (p.enabled && !this.running.has(p.id) && dueAt(p, now)) this.run(p.id);
    }
  }

  async run(id) {
    const p = this.store.get("pieces").find((x) => x.id === id);
    if (!p || this.running.has(id)) return;
    this.running.add(id);
    this.emit("changed", this.list());
    this.mark(id, { lastRun: Date.now() });
    try {
      const prompt = `${p.prompt}\n\nThis is a scheduled run called "${p.name}" and nobody is watching: only read, never send or change anything. Return a short title, a one- or two-sentence summary for a speech bubble, and the items that need the user (with links), most urgent first. If nothing needs them, return no items.`;
      const { data } = await this.chat.structured(prompt, SCHEMA);
      this.emit("result", { piece: p, data: data ?? { title: p.name, summary: "Nothing came back.", items: [] } });
    } catch (e) {
      this.emit("result", { piece: p, error: e.message });
    } finally {
      this.running.delete(id);
      this.emit("changed", this.list());
    }
  }

  mark(id, patch) {
    this.store.set("pieces", this.store.get("pieces").map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }
}

// Call tracking: notices when a Zoom, Teams, Meet, Webex, Slack huddle or
// FaceTime call is on screen (from window names, the same list Halo uses for
// drag-onto-window), offers to take notes, and logs every call it saw.

import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { listWindows } from "./winlist.js";

const BROWSERS = /chrome|arc|safari|edge|firefox|brave|opera|vivaldi/i;

/** Returns { app, title } when a window looks like a live call, else null. */
export function callFromWindow(w) {
  const owner = w.owner || "";
  const name = w.name || "";
  if (/zoom/i.test(owner) && /zoom (meeting|webinar)|meeting/i.test(name)) return { app: "Zoom", title: name.replace(/^Zoom\s*/i, "") || "Zoom meeting" };
  if (/teams/i.test(owner) && /meeting|call|\(meeting\)/i.test(name)) return { app: "Teams", title: name.replace(/\s*\|\s*Microsoft Teams.*$/i, "") || "Teams call" };
  if (BROWSERS.test(owner) && /(^|\s)meet\s*[–-]|google meet|meet\.google\.com/i.test(name)) return { app: "Google Meet", title: name.replace(/^Meet\s*[–-]\s*/i, "").replace(/\s*[–-]\s*(Google Chrome|Arc|Safari|Microsoft Edge|Firefox).*$/i, "") || "Google Meet" };
  if (/webex/i.test(owner) && /meeting|webex/i.test(name)) return { app: "Webex", title: name || "Webex meeting" };
  if (/slack/i.test(owner) && /huddle/i.test(name)) return { app: "Slack huddle", title: name.replace(/\s*[-|]\s*Slack.*$/i, "") || "Huddle" };
  if (/facetime/i.test(owner) && name) return { app: "FaceTime", title: name };
  return null;
}

export class CallWatcher extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.active = null; // { id, app, title, startedAt, misses }
    this.timer = null;
  }

  start() {
    this.stop();
    if (!this.store.get("calls.detect")) return;
    this.timer = setInterval(() => this.poll().catch(() => {}), 15_000);
    setTimeout(() => this.poll().catch(() => {}), 4_000);
  }

  stop() { clearInterval(this.timer); }

  async poll() {
    const windows = await listWindows();
    let found = null;
    for (const w of windows) {
      found = callFromWindow(w);
      if (found) break;
    }
    if (found && !this.active) {
      this.active = { id: crypto.randomUUID(), ...found, startedAt: Date.now(), misses: 0, recorded: false };
      this.log({ ...this.active, endedAt: null });
      this.emit("started", this.active);
    } else if (found && this.active) {
      this.active.misses = 0;
    } else if (!found && this.active) {
      // Two misses in a row (30 s) before calling it over, so a moved window doesn't end it.
      if (++this.active.misses >= 2) {
        const ended = { ...this.active, endedAt: Date.now() - 15_000 };
        this.active = null;
        this.log(ended);
        this.emit("ended", ended);
      }
    }
  }

  /** Marks the current call as recorded and links its note once it's saved. */
  attach(patch) {
    if (this.active) Object.assign(this.active, patch);
    const id = this.active?.id ?? this.lastEnded;
    if (id) this.update(id, patch);
  }

  log(entry) {
    const calls = (this.store.get("calls.log") ?? []).filter((c) => c.id !== entry.id);
    const clean = { ...entry };
    delete clean.misses;
    calls.unshift(clean);
    this.store.set("calls.log", calls.slice(0, 300));
    if (entry.endedAt) this.lastEnded = entry.id;
  }

  update(id, patch) {
    this.store.set("calls.log", (this.store.get("calls.log") ?? []).map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  /** Adds a call that Halo didn't detect, when the user records one by hand. */
  manual(title) {
    if (this.active) return this.active;
    const entry = { id: crypto.randomUUID(), app: "Meeting", title: title || "Meeting", startedAt: Date.now(), endedAt: null, recorded: true, manual: true };
    this.log(entry);
    this.manualId = entry.id;
    return entry;
  }

  endManual() {
    if (!this.manualId) return;
    this.update(this.manualId, { endedAt: Date.now() });
    this.lastEnded = this.manualId;
    this.manualId = null;
  }

  list() { return this.store.get("calls.log") ?? []; }
}

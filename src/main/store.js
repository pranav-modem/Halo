// Settings (plain JSON in userData) and secrets (encrypted with safeStorage:
// macOS Keychain, Windows DPAPI). Secrets never reach a renderer; the
// settings UI only learns whether one is set.

import { app, safeStorage } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULTS = {
  character: "nova",
  size: "medium", // small | medium | large
  companionPos: null, // { x, y, displayId }
  panelPinned: false,
  showDock: false,
  launchAtLogin: false,
  sounds: true,

  claudePath: "", // empty = find `claude` on PATH
  model: "", // empty = your Claude Code default
  effort: "", // empty = default; low | medium | high | xhigh | max
  useApiKey: false, // only when the user enables it AND stores a key

  githubUser: "", // empty = the active gh account
  ghSsoHidden: 0, // the single sign-on notice was hidden while this many pull requests were held back
  jiraSite: "",
  notesDir: path.join(os.homedir(), "Documents", "Halo Notes"),
  workspaceDir: path.join(os.homedir(), "Documents", "Halo"),

  alerts: {
    enabled: true,
    localEveryMin: 5, // gh + acli, no Claude usage
    claudeEveryMin: 60, // Slack + Ninety via Claude Code; 0 = only on demand
    notifications: true,
  },

  shortcuts: {
    toggle: "CommandOrControl+Shift+B",
    screen: "CommandOrControl+Shift+Space",
    snip: "CommandOrControl+Shift+X",
    record: "CommandOrControl+Shift+R",
    dictate: "CommandOrControl+Shift+D",
  },

  // base.en hears "Hey Halo" far more reliably than tiny.en (which hears "Hey, hello").
  wakeWord: { enabled: true, model: "onnx-community/whisper-base.en", speakReplies: true },

  transcription: {
    engine: "local", // local | openai-compatible
    localModel: "onnx-community/whisper-base.en", // ships with Halo; other languages download
    baseUrl: "https://api.openai.com/v1",
    model: "whisper-1",
  },

  recentChats: [], // { id, title, character, updatedAt }
  theme: "light", // light (day, the default) | dark (night) | system
  themeChosen: false, // true once you pick one in Settings
  calls: { detect: true, offerNotes: true, autoStop: true, log: [] },
  handledLog: [], // when board items were marked Done (for Recap)
  dismissed: [], // ids of board items marked Done
  docked: false, // resting in the island at the top of the screen
  watchSessions: true, // show your Claude Code sessions (read from ~/.claude/projects)
  followPointer: true, // Halo walks after your pointer, across windows and screens
  accountTimeZone: null, // { zone, source, checkedAt } from the Google Calendar connector
};

function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== "object" || base === null) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = typeof v === "object" && v !== null && !Array.isArray(v) && typeof base[k] === "object" && base[k] !== null
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

export class Store {
  constructor() {
    const dir = app.getPath("userData");
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "settings.json");
    this.secretsFile = path.join(dir, "secrets.json");
    this.data = deepMerge(DEFAULTS, readJson(this.file));
    // Day is Halo's default look; earlier builds saved "system" before you'd chosen anything.
    if (!this.data.themeChosen && this.data.theme === "system") this.data.theme = "light";
    // Earlier builds defaulted to the multilingual model, which had to download first.
    if (this.data.transcription?.localModel === "onnx-community/whisper-base" && !this.data.transcription.modelChosen) this.data.transcription.localModel = DEFAULTS.transcription.localModel;
    // Earlier builds saved the tiny wake model, which mishears "Halo".
    if (this.data.wakeWord?.model === "onnx-community/whisper-tiny.en" && !this.data.wakeWord.modelChosen) this.data.wakeWord.model = DEFAULTS.wakeWord.model;
    this.secrets = readJson(this.secretsFile) ?? {};
    this.listeners = new Set();
    this.saveTimer = null;
  }

  get(key) { return key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), this.data); }

  all() { return structuredClone(this.data); }

  set(key, value) {
    const parts = key.split(".");
    let o = this.data;
    for (const p of parts.slice(0, -1)) o = o[p] ??= {};
    o[parts.at(-1)] = value;
    this.scheduleSave();
    for (const fn of this.listeners) fn(key, value);
  }

  /** Merge a partial settings object (from the settings UI). */
  patch(partial) {
    for (const [k, v] of Object.entries(partial)) {
      if (!(k in DEFAULTS)) continue;
      this.set(k, typeof v === "object" && v !== null && !Array.isArray(v) ? deepMerge(this.data[k], v) : v);
    }
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    clearTimeout(this.saveTimer);
    writeJsonAtomic(this.file, this.data);
  }

  // ── secrets ─────────────────────────────────────────────────────────────────

  hasSecret(name) { return typeof this.secrets[name] === "string" && this.secrets[name].length > 0; }

  getSecret(name) {
    const enc = this.secrets[name];
    if (!enc) return "";
    try {
      return safeStorage.decryptString(Buffer.from(enc, "base64"));
    } catch {
      return "";
    }
  }

  setSecret(name, value) {
    if (!value) delete this.secrets[name];
    else {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure storage isn't available on this system.");
      this.secrets[name] = safeStorage.encryptString(value).toString("base64");
    }
    writeJsonAtomic(this.secretsFile, this.secrets);
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

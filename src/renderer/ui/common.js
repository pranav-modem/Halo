// Shared helpers for Halo's island and room pages.

import { logo } from "./logos.js";

export const api = window.halo;
document.documentElement.dataset.platform = api.platform;
export const isMac = api.platform === "darwin";

export const $ = (id) => document.getElementById(id);

/** Tiny DOM builder: h("div", {class: "x", onclick}, "text", child). Strings become text nodes. */
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v; // only ever renderMarkdown() output or the fixed icons below
    else if (k === "style" && typeof v === "object") {
      // Custom properties ("--c") only work through setProperty.
      for (const [sk, sv] of Object.entries(v)) sk.startsWith("--") ? el.style.setProperty(sk, sv) : (el.style[sk] = sv);
    }
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

export function ago(ms) {
  if (!ms) return "";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

export function openUrl(url) { if (url) api.send("panel:openExternal", url); }

// Links inside rendered Markdown open in the browser.
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-href]");
  if (a) {
    e.preventDefault();
    openUrl(a.dataset.href);
  }
});

/** Service colours (as on the island's pills). */
export const SERVICE = {
  github: { name: "GitHub", color: "#F5F6F8", mark: "GH" },
  jira: { name: "Jira", color: "#38BDF8", mark: "J" },
  slack: { name: "Slack", color: "#C084FC", mark: "S" },
  ninety: { name: "Ninety", color: "#34D399", mark: "90" },
  gmail: { name: "Gmail", color: "#F4505E", mark: "M" },
  calendar: { name: "Calendar", color: "#60A5FA", mark: "C" },
  halo: { name: "Halo", color: "#818CF8", mark: "H" },
  shell: { name: "Command", color: "#A3A3A3", mark: ">" },
  file: { name: "File", color: "#A3A3A3", mark: "F" },
  other: { name: "Action", color: "#A3A3A3", mark: "•" },
};

/** A small round service mark, coloured like the service. */
export function mark(svc, size = 18) {
  const lg = logo(svc, size);
  if (lg) return lg;
  const s = SERVICE[svc] ?? SERVICE.other;
  return h("span", { class: "mark", title: s.name, style: { width: `${size}px`, height: `${size}px`, "--c": s.color, fontSize: `${Math.round(size * 0.45)}px` } }, s.mark);
}

/** Outline icons (fixed SVG strings). */
export const ICON = {
  home: '<svg viewBox="0 0 24 24"><path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-4 3v-3H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/></svg>',
  board: '<svg viewBox="0 0 24 24"><path d="M5 7h14M5 12h14M5 17h9"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
  screen: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  snip: '<svg viewBox="0 0 24 24"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/></svg>',
  window: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/></svg>',
  list: '<svg viewBox="0 0 24 24"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  today: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>',
  notes: '<svg viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  pulse: '<svg viewBox="0 0 24 24"><path d="M3 12h4l3-7 4 14 3-7h4"/></svg>',
  look: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M9 10h.01M15 10h.01M9 15c1.5 1.3 4.5 1.3 6 0"/></svg>',
  plug: '<svg viewBox="0 0 24 24"><path d="M9 3v5M15 3v5M7 8h10v4a5 5 0 0 1-10 0zM12 17v4"/></svg>',
  key: '<svg viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 11h.01M11 11h.01M15 11h.01M8 14h8"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/></svg>',
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/></svg>',
  jump: '<svg viewBox="0 0 24 24"><path d="M7 17 17 7M9 7h8v8"/></svg>',
  expand: '<svg viewBox="0 0 24 24"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>',
  shrink: '<svg viewBox="0 0 24 24"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
};

export function icon(name) { return h("span", { class: "ico", html: ICON[name] ?? "" }); }

/** Human labels for Claude Code tool calls, shown as chips while Halo works. */
export function toolLabel(name, input) {
  if (name === "Bash") {
    const c = String(input?.command || "");
    if (/^\s*gh\b/.test(c)) return "Checking GitHub";
    if (/^\s*acli\b/.test(c)) return "Checking Jira";
    return "Running a command";
  }
  const builtin = {
    Read: "Reading a file", Write: "Writing a note", Edit: "Editing a note", WebSearch: "Searching the web", WebFetch: "Reading a web page",
    ToolSearch: "Finding the right tool", Skill: "Using a skill", Task: "Asking a helper", Agent: "Asking a helper", Glob: "Looking for files", Grep: "Searching files",
  };
  if (builtin[name]) return builtin[name];
  if (name.startsWith("mcp__")) {
    const [, server, tool] = name.split("__");
    const srv = server.replace(/^claude_ai_/, "").replace(/_/g, " ");
    const t = tool.replace(/_v\d+$/, "").replace(/^slack_/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
    if (/rocks/.test(t)) return `${srv}: reading Rocks`;
    return `${srv}: ${t}`;
  }
  return name;
}

export function toolService(name, input) {
  if (name === "Bash") return /^\s*gh\b/.test(input?.command || "") ? "github" : /^\s*acli\b/.test(input?.command || "") ? "jira" : "shell";
  if (/Ninety/i.test(name)) return "ninety";
  if (/Slack/i.test(name)) return "slack";
  if (/Atlassian/i.test(name)) return "jira";
  if (/Gmail/i.test(name)) return "gmail";
  if (/Calendar/i.test(name)) return "calendar";
  return "other";
}

/** Prompts behind the quick actions. */
export const QUICK = {
  brief:
    "Brief me on my day. Check my Ninety Rocks (flag anything off track), my open Jira issues, pull requests waiting for my review and my open PRs' checks, Slack mentions or DMs from the last 24 hours that need a reply, and today's calendar. Keep it short and end with the 3 things I should do first.",
  rocks: "What are my Ninety Rocks this quarter? Show status and due date, off-track ones first, with links.",
  prs: "Which pull requests are waiting for my review? Include repo, author, how long each has waited, and size of the change.",
  jira: "List my open Jira issues grouped by status, highest priority first, with links.",
  slack: "Find Slack messages from the last 24 hours that mention me or DM me and still need a reply. One line each, with a link.",
};

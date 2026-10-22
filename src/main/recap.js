// Recap: what you got done today or this week. Local numbers come from
// Halo's own logs (chats, calls, notes, things marked done); the written
// recap is one read-only Claude Code run across GitHub, Jira, Ninety, Slack,
// your calendar and your meeting notes. Recaps are saved as Markdown.

import fs from "node:fs";
import path from "node:path";

/** day = today, week = this week so far, lastweek = Monday to Sunday before it. */
export function periodRange(period, now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (period === "week" || period === "lastweek") start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // Monday
  if (period !== "lastweek") return { start: start.getTime(), end: now.getTime() };
  const end = start.getTime();
  start.setDate(start.getDate() - 7);
  return { start: start.getTime(), end };
}

export function recapStats({ store, notesList, historyList, period }) {
  const { start } = periodRange(period);
  const calls = (store.get("calls.log") ?? []).filter((c) => c.startedAt >= start);
  const minutes = calls.reduce((m, c) => m + Math.max(0, ((c.endedAt ?? Date.now()) - c.startedAt) / 60000), 0);
  return {
    chats: historyList.filter((c) => c.updatedAt >= start).length,
    calls: calls.length,
    callMinutes: Math.round(minutes),
    recorded: calls.filter((c) => c.recorded).length,
    notes: notesList.filter((n) => n.mtime >= start).length,
    handled: (store.get("handledLog") ?? []).filter((t) => t >= start).length,
  };
}

const SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string", description: "One sentence: how the period went." },
    highlights: { type: "array", items: { type: "string" } },
    shipped: { type: "array", items: { type: "object", properties: { text: { type: "string" }, url: { type: "string" }, source: { type: "string" } }, required: ["text"] } },
    meetings: { type: "array", items: { type: "object", properties: { title: { type: "string" }, outcome: { type: "string" } }, required: ["title"] } },
    followUps: { type: "array", items: { type: "string" } },
    stats: {
      type: "object",
      properties: { prsMerged: { type: "number" }, prsReviewed: { type: "number" }, issuesDone: { type: "number" }, meetings: { type: "number" } },
    },
  },
  required: ["headline", "highlights", "shipped", "meetings", "followUps"],
};

function recapDir(store) {
  const dir = path.join(store.get("workspaceDir"), "Recaps");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function render(data, period, range) {
  const fmt = (t) => new Date(t).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const title = period === "week" ? `Week of ${fmt(range.start)}` : fmt(range.start);
  const list = (items) => items.map((i) => `- ${i}`).join("\n");
  const out = [`# ${title}`, "", `*${period === "week" ? "Weekly" : "Daily"} recap by Halo*`, "", data.headline || "", ""];
  if (data.highlights?.length) out.push("## Highlights", list(data.highlights), "");
  if (data.shipped?.length) out.push("## Shipped", data.shipped.map((s) => `- ${s.url ? `[${s.text}](${s.url})` : s.text}`).join("\n"), "");
  if (data.meetings?.length) out.push("## Meetings", data.meetings.map((m) => `- **${m.title}**${m.outcome ? `: ${m.outcome}` : ""}`).join("\n"), "");
  if (data.followUps?.length) out.push("## Next up", list(data.followUps), "");
  return out.join("\n");
}

export async function writeRecap({ chat, store, period }) {
  const range = periodRange(period);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const from = new Date(range.start).toISOString().slice(0, 10);
  const prompt = `Write my ${period === "week" ? "weekly" : "daily"} work recap for ${period === "week" ? `the week starting ${from}` : `today, ${from}`} (time zone ${zone}). Only read; never send or change anything.

Look at:
- GitHub: pull requests I merged or opened, and reviews I did, in that range (gh search prs --author=@me / --reviewed-by=@me with --updated ">=${from}" and --json).
- Jira: issues assigned to me that moved or were resolved since ${from} (acli jira workitem search with JQL "assignee = currentUser() AND updated >= '${from}'" --json).
- Ninety: changes to my Rocks and To-Dos I completed.
- Google Calendar: meetings I had in that range.
- Slack: the threads I took part in that mattered.
- My meeting notes in ${store.get("notesDir")} written since ${from}.

Return a one-sentence headline, 3-6 highlights, what shipped (with links), meetings with a one-line outcome each, and follow-ups for next time. Leave a list empty if there's nothing for it.`;
  const { data } = await chat.structured(prompt, SCHEMA);
  const markdown = render(data ?? {}, period, range);
  const file = path.join(recapDir(store), `${from} ${period}.md`);
  fs.writeFileSync(file, markdown);
  return { file, data, markdown, period, at: Date.now() };
}

export function latestRecap(store, period) {
  const dir = recapDir(store);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(`${period}.md`)).sort().reverse();
  if (!files.length) return null;
  const file = path.join(dir, files[0]);
  return { file, markdown: fs.readFileSync(file, "utf8"), at: fs.statSync(file).mtimeMs, period };
}

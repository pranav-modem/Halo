// Keeps the Today data fresh and turns changes into alerts. Local checks
// (gh, acli) run often; the Claude Code check (Slack, Ninety) runs rarely
// because it uses a little of the user's plan. The first result of each
// source only sets the baseline, so launching the app never spams alerts.

import { EventEmitter } from "node:events";
import { fetchConnectors, fetchGithub, fetchJira } from "./dashboard.js";

const MAX_ALERTS = 50;

export class Watcher extends EventEmitter {
  constructor({ store, chat, githubToken, jiraSite }) {
    super();
    this.store = store;
    this.chat = chat;
    this.githubToken = githubToken; // () => string
    this.jiraSite = jiraSite; // () => string
    this.data = { github: null, jira: null, connectors: null, updated: {} };
    this.loading = { local: false, claude: false };
    this.alerts = [];
    this.timers = [];
    this.seen = { reviews: null, prs: null, jira: null, slack: null, rocks: null };
  }

  start() {
    this.stop();
    const a = this.store.get("alerts");
    this.pollLocal();
    if (a.enabled && a.localEveryMin > 0) this.timers.push(setInterval(() => this.pollLocal(), a.localEveryMin * 60_000));
    if (a.enabled && a.claudeEveryMin > 0) this.timers.push(setInterval(() => this.pollClaude(), a.claudeEveryMin * 60_000));
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  snapshot() {
    return { ...this.data, loading: { ...this.loading }, alerts: this.alerts, dismissed: this.store.get("dismissed") ?? [] };
  }

  /** "Done" on the board: hide that item from now on. */
  dismiss(id) {
    const list = (this.store.get("dismissed") ?? []).filter((x) => x !== id);
    list.push(id);
    this.store.set("dismissed", list.slice(-400));
    this.store.set("handledLog", [...(this.store.get("handledLog") ?? []), Date.now()].slice(-2000));
    const alertId = id.startsWith("alert:") ? id.slice(6) : null;
    if (alertId) for (const a of this.alerts) if (a.id === alertId) a.read = true;
    this.emit("data", this.snapshot());
  }

  async pollLocal() {
    if (this.loading.local) return;
    this.loading.local = true;
    this.emit("data", this.snapshot());
    try {
      const [github, jira] = await Promise.all([
        fetchGithub(this.githubToken()).catch((e) => ({ error: e.message })),
        fetchJira(this.jiraSite()).catch((e) => ({ error: e.message })),
      ]);
      if (!github.error) this.diffGithub(github);
      if (!jira.error) this.diffJira(jira);
      this.data.github = github;
      this.data.jira = jira;
      this.data.updated.local = Date.now();
    } finally {
      this.loading.local = false;
      this.emit("data", this.snapshot());
    }
  }

  async pollClaude() {
    if (this.loading.claude) return;
    this.loading.claude = true;
    this.emit("data", this.snapshot());
    try {
      const c = await fetchConnectors(this.chat);
      this.diffConnectors(c);
      this.data.connectors = c;
    } catch (e) {
      this.data.connectors = { ...(this.data.connectors ?? { rocks: [], slack: [] }), error: e.message };
    } finally {
      this.data.updated.claude = Date.now();
      this.loading.claude = false;
      this.emit("data", this.snapshot());
    }
  }

  // ── diffs → alerts ──────────────────────────────────────────────────────────

  alert(a) {
    const item = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: Date.now(), read: false, ...a };
    this.alerts.unshift(item);
    this.alerts = this.alerts.slice(0, MAX_ALERTS);
    this.emit("alert", item);
  }

  diffGithub(g) {
    const reviews = new Map(g.reviewRequests.map((p) => [p.id, p]));
    if (this.seen.reviews) {
      const fresh = [...reviews.values()].filter((p) => !this.seen.reviews.has(p.id));
      if (fresh.length) {
        const p = fresh[0];
        this.alert({
          source: "github",
          title: fresh.length === 1 ? "A PR needs your review" : `${fresh.length} PRs need your review`,
          body: `${p.repo}#${p.number} ${p.title}`,
          url: p.url,
        });
      }
    }
    this.seen.reviews = new Set(reviews.keys());

    const prev = this.seen.prs;
    const now = new Map(g.myPrs.map((p) => [p.id, p]));
    if (prev) {
      for (const p of now.values()) {
        const before = prev.get(p.id);
        if (!before) continue;
        const sameCommit = before.sha === p.sha;
        if (p.checks === "FAILURE" || p.checks === "ERROR") {
          if (!sameCommit || (before.checks !== "FAILURE" && before.checks !== "ERROR")) {
            this.alert({ source: "github", title: "Checks failed", body: `${p.repo}#${p.number} ${p.title}`, url: p.url, tone: "bad" });
          }
        } else if (p.checks === "SUCCESS" && before.checks === "PENDING" && sameCommit) {
          this.alert({ source: "github", title: "Checks passed", body: `${p.repo}#${p.number} ${p.title}`, url: p.url, tone: "good" });
        }
        if (p.review && p.review !== before.review && (p.review === "APPROVED" || p.review === "CHANGES_REQUESTED")) {
          this.alert({
            source: "github",
            title: p.review === "APPROVED" ? "Your PR was approved" : "Changes requested on your PR",
            body: `${p.repo}#${p.number} ${p.title}`,
            url: p.url,
            tone: p.review === "APPROVED" ? "good" : "bad",
          });
        }
      }
    }
    this.seen.prs = now;
  }

  diffJira(j) {
    const keys = new Map(j.issues.map((i) => [i.key, i]));
    if (this.seen.jira) {
      const fresh = [...keys.values()].filter((i) => !this.seen.jira.has(i.key));
      for (const i of fresh.slice(0, 3)) {
        this.alert({ source: "jira", title: "New Jira issue for you", body: `${i.key} ${i.title}`, url: i.url });
      }
    }
    this.seen.jira = new Set(keys.keys());
  }

  diffConnectors(c) {
    const slack = new Map((c.slack ?? []).map((m) => [m.id, m]));
    if (this.seen.slack) {
      const fresh = [...slack.values()].filter((m) => !this.seen.slack.has(m.id));
      for (const m of fresh.slice(0, 3)) {
        this.alert({ source: "slack", title: `${m.from}${m.channel ? ` in ${m.channel}` : ""}`, body: m.text, url: m.url });
      }
    }
    this.seen.slack = new Set(slack.keys());

    const rocks = new Map((c.rocks ?? []).map((r) => [r.id, r]));
    if (this.seen.rocks) {
      for (const r of rocks.values()) {
        const before = this.seen.rocks.get(r.id);
        if (before && before.status !== "OFF_TRACK" && r.status === "OFF_TRACK") {
          this.alert({ source: "ninety", title: "A Rock is off track", body: r.title, url: r.url, tone: "bad" });
        }
      }
    }
    this.seen.rocks = rocks;
  }

  markRead() {
    for (const a of this.alerts) a.read = true;
    this.emit("data", this.snapshot());
  }
}

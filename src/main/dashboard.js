// The Today dashboard's data. GitHub and Jira come straight from the user's
// signed-in `gh` and `acli` (no Claude usage). Rocks and Slack mentions come
// from one structured Claude Code run through the Ninety and Slack connectors.

import { childEnv, run, which } from "./env.js";

const GH_QUERY = `query {
  viewer {
    login
    pullRequests(first: 20, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { number title url isDraft updatedAt reviewDecision repository { nameWithOwner }
        commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } } }
    }
  }
  reviews: search(query: "is:pr is:open review-requested:@me archived:false", type: ISSUE, first: 20) {
    issueCount
    nodes { ... on PullRequest { number title url updatedAt isDraft author { login } repository { nameWithOwner } } }
  }
  assigned: search(query: "is:issue is:open assignee:@me archived:false", type: ISSUE, first: 20) {
    issueCount
    nodes { ... on Issue { number title url updatedAt repository { nameWithOwner } } }
  }
}`;

/** Where you grant the GitHub CLI access to an organization that uses SAML single sign-on. */
const GH_SSO_URL = "https://github.com/settings/connections/applications/178c6fc778ccc68e1d6a";

export async function githubToken(user) {
  const gh = which("gh");
  if (!gh) return "";
  const args = ["auth", "token"];
  if (user) args.push("--user", user);
  const r = await run(gh, args, { timeout: 10000 });
  return r.ok ? r.stdout.trim() : "";
}

export async function fetchGithub(token) {
  const gh = which("gh");
  if (!gh) return { error: "The GitHub CLI (gh) isn't installed." };
  const r = await run(gh, ["api", "graphql", "-f", `query=${GH_QUERY}`], {
    timeout: 30000,
    env: token ? childEnv({ GH_TOKEN: token }) : undefined,
  });
  // GraphQL can return data and errors together (for example when one org needs
  // single sign-on approval), so use whatever came back before giving up.
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {}
  const raw = `${r.stderr}\n${r.stdout}`;
  const saml = /SAML enforcement|grant your OAuth token access/i.test(raw);
  // How many items GitHub held back for single sign-on (each one is a separate error).
  const ssoBlocked = (parsed?.errors ?? []).filter((e) => e?.extensions?.saml_failure).length || (saml ? 1 : 0);
  const login = parsed?.data?.viewer?.login;
  const warning = saml
    ? `${ssoBlocked === 1 ? "1 pull request is" : `${ssoBlocked} pull requests are`} in your company's GitHub, which uses single sign-on. The GitHub CLI isn't approved there yet for ${login || "this account"}, so Halo can't see ${ssoBlocked === 1 ? "it" : "them"}.`
    : null;
  if (!parsed?.data?.viewer) {
    return { error: warning || (r.stderr || r.stdout || "gh failed").trim().split("\n")[0], ssoUrl: saml ? GH_SSO_URL : null };
  }
  const d = parsed.data;
  d.reviews ??= { nodes: [] };
  d.assigned ??= { nodes: [] };
  return {
    warning,
    ssoBlocked: saml ? ssoBlocked : 0,
    ssoUrl: saml ? GH_SSO_URL : null,
    login: d.viewer.login,
    myPrs: (d.viewer.pullRequests?.nodes ?? []).filter(Boolean).map((p) => ({
      id: p.url,
      title: p.title,
      url: p.url,
      repo: p.repository.nameWithOwner,
      number: p.number,
      draft: p.isDraft,
      review: p.reviewDecision,
      checks: p.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
      sha: p.commits.nodes[0]?.commit.oid ?? null,
      updatedAt: p.updatedAt,
    })),
    reviewRequests: d.reviews.nodes.filter((p) => p?.url).map((p) => ({
      id: p.url,
      title: p.title,
      url: p.url,
      repo: p.repository.nameWithOwner,
      number: p.number,
      author: p.author?.login,
      draft: p.isDraft,
      updatedAt: p.updatedAt,
    })),
    assignedIssues: d.assigned.nodes.filter((i) => i?.url).map((i) => ({
      id: i.url,
      title: i.title,
      url: i.url,
      repo: i.repository.nameWithOwner,
      number: i.number,
      updatedAt: i.updatedAt,
    })),
  };
}

export async function jiraSite() {
  const acli = which("acli");
  if (!acli) return "";
  const r = await run(acli, ["jira", "auth", "status"], { timeout: 15000 });
  const m = /Site:\s*(\S+)/.exec(r.stdout);
  return m ? m[1] : "";
}

export async function fetchJira(site) {
  const acli = which("acli");
  if (!acli) return { error: "The Atlassian CLI (acli) isn't installed." };
  const jql = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";
  const r = await run(acli, ["jira", "workitem", "search", "--jql", jql, "--fields", "key,summary,status,priority,issuetype", "--limit", "30", "--json"], { timeout: 40000 });
  if (!r.ok) return { error: (r.stderr || r.stdout || "acli failed").trim().split("\n")[0] };
  let items;
  try {
    items = JSON.parse(r.stdout);
  } catch {
    return { error: "acli returned something unexpected." };
  }
  const host = site ? `https://${site.replace(/^https?:\/\//, "")}` : "";
  return {
    issues: (Array.isArray(items) ? items : items.issues ?? []).map((it) => ({
      id: it.key,
      key: it.key,
      title: it.fields?.summary ?? "",
      status: it.fields?.status?.name ?? "",
      statusColor: it.fields?.status?.statusCategory?.colorName ?? "",
      priority: it.fields?.priority?.name ?? "",
      type: it.fields?.issuetype?.name ?? "",
      url: host ? `${host}/browse/${it.key}` : "",
    })),
  };
}

// ── Ninety + Slack through Claude Code ────────────────────────────────────────

export const CONNECTOR_SCHEMA = {
  type: "object",
  properties: {
    rocks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          status: { type: "string", enum: ["ON_TRACK", "OFF_TRACK", "DONE", "CANCELED", "DRAFT", "UNKNOWN"] },
          dueDate: { type: "string" },
          team: { type: "string" },
          url: { type: "string" },
        },
        required: ["id", "title", "status"],
      },
    },
    rocksError: { type: "string" },
    slack: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          from: { type: "string" },
          channel: { type: "string" },
          text: { type: "string" },
          url: { type: "string" },
          when: { type: "string" },
        },
        required: ["id", "from", "text"],
      },
    },
    slackError: { type: "string" },
  },
  required: ["rocks", "slack"],
};

export const CONNECTOR_PROMPT = `Collect two lists for my work dashboard. Only read; don't change anything.

1. My Ninety Rocks for the current quarter: use the Ninety connector (read_rocks_v1, filtered to Rocks I own, current quarter). For each give id, title, status (ON_TRACK, OFF_TRACK, DONE, CANCELED or DRAFT), dueDate (YYYY-MM-DD), team name, and a link if the tool gives one. If Ninety isn't available, leave rocks empty and explain in rocksError.

2. Slack messages from the last 24 hours that mention me or are direct messages to me, newest first, at most 10: use the Slack connector's search. For each give a stable id (the message permalink or channel+timestamp), from (person's name), channel (name, or "DM"), text (one line, under 160 characters), url (permalink) and when (relative, like "2h ago"). If Slack isn't available, leave slack empty and explain in slackError.

Return only the structured result.`;

export async function fetchConnectors(chat) {
  const { data } = await chat.structured(CONNECTOR_PROMPT, CONNECTOR_SCHEMA);
  return data ?? { rocks: [], slack: [], rocksError: "No data came back." };
}

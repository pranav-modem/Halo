// "Approve my sessions from Halo": adds or removes Halo's hook groups in
// ~/.claude/settings.json.
//
// - Nothing is written until you've seen the exact diff and confirmed it.
// - A timestamped backup goes next to the file first.
// - If the file changed after Halo read it, Halo refuses and shows a new diff.
// - Only Halo's own groups are touched (found by the hook script's name in
//   the command), so other tools' hooks stay as they are.
// - Halo edits the few lines it owns and leaves the rest of the text alone,
//   so the diff shows only Halo's change.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MARKER = "halo-cc-hook.cjs";
/** The hook groups Halo installs, in this order. */
export const EVENTS = {
  PermissionRequest: { matcher: "*", timeout: 135 },
  UserPromptSubmit: { timeout: 5 },
  Stop: { timeout: 5 },
  SessionEnd: { timeout: 5 },
};

export function settingsFile() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json");
}

const isHaloGroup = (g) => Array.isArray(g?.hooks) && g.hooks.some((h) => String(h?.command ?? "").includes(MARKER));
const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

function group(event, command) {
  const { matcher, timeout } = EVENTS[event];
  return { ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command, timeout }] };
}

function read(file) {
  try {
    return { exists: true, text: fs.readFileSync(file, "utf8") };
  } catch (e) {
    if (e.code === "ENOENT") return { exists: false, text: "" };
    throw new Error(`Halo couldn't read ${file}: ${e.message}`);
  }
}

function parse(text, file) {
  if (!text.trim()) return {};
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} isn't valid JSON (${e.message}), so Halo won't change it.`);
  }
  if (!isObject(data)) throw new Error(`${file} isn't a settings object, so Halo won't change it.`);
  if (data.hooks !== undefined && !isObject(data.hooks)) throw new Error(`"hooks" in ${file} isn't an object, so Halo won't change it.`);
  for (const ev of Object.keys(EVENTS)) {
    if (data.hooks?.[ev] !== undefined && !Array.isArray(data.hooks[ev])) throw new Error(`"hooks.${ev}" in ${file} isn't a list, so Halo won't change it.`);
  }
  return data;
}

/** Is Halo's hook in settings.json, and does it point at this copy of Halo? */
export function hookStatus(command) {
  const file = settingsFile();
  try {
    const { exists, text } = read(file);
    const data = parse(text, file);
    const events = Object.keys(data.hooks ?? {}).filter((ev) => (data.hooks[ev] ?? []).some(isHaloGroup));
    const current = Object.keys(EVENTS).every((ev) => {
      const mine = (data.hooks?.[ev] ?? []).filter(isHaloGroup);
      return mine.length === 1 && JSON.stringify(mine[0]) === JSON.stringify(group(ev, command));
    }) && events.length === Object.keys(EVENTS).length;
    return { file, exists, installed: events.length > 0, current, events };
  } catch (e) {
    return { file, exists: true, installed: false, current: false, events: [], error: e.message };
  }
}

// ── the change, as data ───────────────────────────────────────────────────────

/** settings.json without Halo's groups, then (when enabling) with this copy's groups. */
export function desired(data, command, enable) {
  const out = structuredClone(data);
  if (isObject(out.hooks)) {
    let removed = false;
    for (const ev of Object.keys(out.hooks)) {
      if (!Array.isArray(out.hooks[ev]) || !out.hooks[ev].some(isHaloGroup)) continue;
      out.hooks[ev] = out.hooks[ev].filter((g) => !isHaloGroup(g));
      removed = true;
      if (!out.hooks[ev].length) delete out.hooks[ev];
    }
    if (removed && !Object.keys(out.hooks).length) delete out.hooks;
  }
  if (enable) {
    out.hooks ??= {};
    for (const ev of Object.keys(EVENTS)) (out.hooks[ev] ??= []).push(group(ev, command));
  }
  return out;
}

// ── the change, as text (keeps the file's own layout) ─────────────────────────

/** Where each value sits in the text: objects keep their entries, arrays their items. */
function spans(text) {
  let i = 0;
  const fail = () => { throw new Error(`Unexpected JSON at ${i}`); };
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const str = () => {
    if (text[i] !== '"') fail();
    const start = i++;
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i));
  };
  const value = () => {
    ws();
    const start = i;
    if (text[i] === "{") {
      i++;
      const entries = [];
      ws();
      if (text[i] === "}") return { type: "object", start, end: ++i, entries };
      for (;;) {
        ws();
        const keyStart = i;
        const key = str();
        ws();
        if (text[i++] !== ":") fail();
        entries.push({ key, keyStart, value: value() });
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") return { type: "object", start, end: ++i, entries };
        fail();
      }
    }
    if (text[i] === "[") {
      i++;
      const items = [];
      ws();
      if (text[i] === "]") return { type: "array", start, end: ++i, items };
      for (;;) {
        items.push(value());
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "]") return { type: "array", start, end: ++i, items };
        fail();
      }
    }
    if (text[i] === '"') { str(); return { type: "string", start, end: i }; }
    const m = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
    if (!m) fail();
    i += m[0].length;
    return { type: "literal", start, end: i };
  };
  const root = value();
  ws();
  if (i !== text.length) fail();
  return root;
}

/** The text's own style: indent unit, `"key" : value` or `"key": value`, line endings. */
function styleOf(text) {
  const ind = /\n([ \t]+)"/.exec(text)?.[1] ?? "  ";
  return {
    unit: ind.startsWith("\t") ? "\t" : ind,
    sep: /"\s+:\s/.test(text) ? " : " : ": ",
    nl: text.includes("\r\n") ? "\r\n" : "\n",
  };
}

function serialize(v, ind, st) {
  const inner = ind + st.unit;
  if (Array.isArray(v)) return v.length ? `[${st.nl}${v.map((x) => inner + serialize(x, inner, st)).join(`,${st.nl}`)}${st.nl}${ind}]` : "[]";
  if (isObject(v)) {
    const keys = Object.keys(v);
    return keys.length ? `{${st.nl}${keys.map((k) => `${inner}${JSON.stringify(k)}${st.sep}${serialize(v[k], inner, st)}`).join(`,${st.nl}`)}${st.nl}${ind}}` : "{}";
  }
  return JSON.stringify(v);
}

const lineIndent = (text, pos) => /^[ \t]*/.exec(text.slice(text.lastIndexOf("\n", pos - 1) + 1))[0];
const splice = (text, a, b, s = "") => text.slice(0, a) + s + text.slice(b);
const entryOf = (obj, key) => obj?.entries?.find((e) => e.key === key);

/** Removes item k of an array (or entry k of an object) with its comma. */
function cut(text, list, k, startOf, endOf, node) {
  if (k > 0) return splice(text, endOf(list[k - 1]), endOf(list[k]));
  if (list.length > 1) return splice(text, startOf(list[0]), startOf(list[1]));
  return splice(text, node.start + 1, node.end - 1);
}
const cutItem = (text, arr, k) => cut(text, arr.items, k, (x) => x.start, (x) => x.end, arr);
const cutEntry = (text, obj, k) => cut(text, obj.entries, k, (e) => e.keyStart, (e) => e.value.end, obj);

/** Adds `piece` (already serialized for `indent`) at the end of an array or object. */
function append(text, node, list, startOf, endOf, makePiece, st) {
  if (list.length) {
    const indent = lineIndent(text, startOf(list[0]));
    return splice(text, endOf(list.at(-1)), endOf(list.at(-1)), `,${st.nl}${indent}${makePiece(indent)}`);
  }
  const outer = lineIndent(text, node.start);
  const indent = outer + st.unit;
  return splice(text, node.start + 1, node.end - 1, `${st.nl}${indent}${makePiece(indent)}${st.nl}${outer}`);
}

/** The new text of settings.json: Halo's groups removed, then (when enabling) added. */
export function editText(text, command, enable) {
  const st = styleOf(text);
  let t = text.trim() ? text : `{}${st.nl}`;
  // One group at a time, reading the positions again after each cut.
  let removed = false;
  for (let again = true; again;) {
    again = false;
    const hooks = entryOf(spans(t), "hooks")?.value;
    if (hooks?.type !== "object") break;
    for (const [k, e] of hooks.entries.entries()) {
      if (e.value.type !== "array") continue;
      const idx = e.value.items.findIndex((it) => isHaloGroup(JSON.parse(t.slice(it.start, it.end))));
      if (idx < 0) continue;
      t = e.value.items.length === 1 ? cutEntry(t, hooks, k) : cutItem(t, e.value, idx);
      removed = again = true;
      break;
    }
  }
  if (removed) {
    const root = spans(t);
    const k = root.entries.findIndex((e) => e.key === "hooks");
    if (k >= 0 && root.entries[k].value.type === "object" && !root.entries[k].value.entries.length) t = cutEntry(t, root, k);
  }
  if (!enable) return t;

  let root = spans(t);
  if (!entryOf(root, "hooks")) {
    const all = Object.fromEntries(Object.keys(EVENTS).map((ev) => [ev, [group(ev, command)]]));
    return append(t, root, root.entries, (e) => e.keyStart, (e) => e.value.end, (ind) => `"hooks"${st.sep}${serialize(all, ind, st)}`, st);
  }
  for (const ev of Object.keys(EVENTS)) {
    root = spans(t);
    const hooks = entryOf(root, "hooks").value;
    const arr = entryOf(hooks, ev)?.value;
    t = arr
      ? append(t, arr, arr.items, (x) => x.start, (x) => x.end, (ind) => serialize(group(ev, command), ind, st), st)
      : append(t, hooks, hooks.entries, (e) => e.keyStart, (e) => e.value.end, (ind) => `${JSON.stringify(ev)}${st.sep}${serialize([group(ev, command)], ind, st)}`, st);
  }
  return t;
}

// ── diff ──────────────────────────────────────────────────────────────────────

/**
 * A unified diff of two texts, as lines for the room to colour.
 * @returns {{ lines: {kind: "hunk"|"ctx"|"add"|"del", text: string}[], added: number, removed: number }}
 */
export function diffLines(a, b, context = 3) {
  const A = a.replace(/\r\n/g, "\n").split("\n");
  const B = b.replace(/\r\n/g, "\n").split("\n");
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf);
  const b2 = B.slice(pre, B.length - suf);
  const n = a2.length, m = b2.length;
  const mid = [];
  if (n * m <= 4_000_000) {
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i * w + j] = a2[i] === b2[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a2[i] === b2[j]) { mid.push([" ", a2[i]]); i++; j++; }
      else if (j < m && (i === n || dp[i * w + j + 1] >= dp[(i + 1) * w + j])) { mid.push(["+", b2[j]]); j++; }
      else { mid.push(["-", a2[i]]); i++; }
    }
  } else {
    for (const l of a2) mid.push(["-", l]);
    for (const l of b2) mid.push(["+", l]);
  }
  const ops = [...A.slice(0, pre).map((l) => [" ", l]), ...mid, ...A.slice(A.length - suf).map((l) => [" ", l])];
  // Line numbers for each op, then hunks with `context` lines around each change.
  let ai = 1, bi = 1;
  const numbered = ops.map(([k, l]) => {
    const r = { k, l, a: ai, b: bi };
    if (k !== "+") ai++;
    if (k !== "-") bi++;
    return r;
  });
  const lines = [];
  let added = 0, removed = 0;
  for (let i = 0; i < numbered.length;) {
    if (numbered[i].k === " ") { i++; continue; }
    const start = Math.max(0, i - context);
    let end = i;
    while (end < numbered.length) {
      if (numbered[end].k !== " ") { end++; continue; }
      let run = end;
      while (run < numbered.length && numbered[run].k === " ") run++;
      if (run - end > context * 2 || run === numbered.length) { end = Math.min(numbered.length, end + context); break; }
      end = run;
    }
    const hunk = numbered.slice(start, end);
    const aLen = hunk.filter((x) => x.k !== "+").length;
    const bLen = hunk.filter((x) => x.k !== "-").length;
    lines.push({ kind: "hunk", text: `@@ -${hunk[0].a},${aLen} +${hunk[0].b},${bLen} @@` });
    for (const x of hunk) {
      lines.push({ kind: x.k === "+" ? "add" : x.k === "-" ? "del" : "ctx", text: `${x.k}${x.l}` });
      if (x.k === "+") added++;
      if (x.k === "-") removed++;
    }
    i = end;
  }
  return { lines, added, removed };
}

// ── plan, then apply ──────────────────────────────────────────────────────────

const plans = new Map(); // id → { file, exists, hash, after, enable }

const stamp = (d = new Date()) => {
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** Reads settings.json and works out the change. Nothing is written. */
export function planHooks(command, enable) {
  const file = settingsFile();
  const { exists, text } = read(file);
  const data = parse(text, file);
  const want = desired(data, command, enable);
  let after;
  try {
    after = editText(text, command, enable);
    // The text edit must mean exactly the intended change, or Halo writes the whole file in its style instead.
    if (JSON.stringify(JSON.parse(after)) !== JSON.stringify(want)) after = null;
  } catch {
    after = null;
  }
  if (after === null) {
    const st = styleOf(text);
    after = serialize(want, "", st) + st.nl;
  }
  const id = crypto.randomUUID();
  if (after === text) return { id: null, file, enable, noChange: true };
  plans.clear();
  plans.set(id, { file, exists, hash: sha(text), after, enable });
  const diff = diffLines(text, after);
  return { id, file, exists, enable, backup: exists ? `${path.basename(file)}.halo-backup-${stamp()}` : null, diff, noChange: false };
}

export function cancelPlan(id) { plans.delete(id); }

/** Writes a planned change, after a backup, and only if the file is still what Halo read. */
export function applyPlan(id) {
  const p = plans.get(id);
  if (!p) return { ok: false, error: "This review is out of date. Turn the setting on or off again to see the change." };
  const now = read(p.file);
  if (now.exists !== p.exists || sha(now.text) !== p.hash) {
    plans.delete(id);
    return { ok: false, changed: true, error: `${p.file} changed after Halo read it, so Halo didn't write anything. Review the new change first.` };
  }
  let backup = null;
  try {
    fs.mkdirSync(path.dirname(p.file), { recursive: true });
    let mode = 0o644;
    if (p.exists) {
      const name = `${p.file}.halo-backup-${stamp()}`;
      for (let n = 1; !backup; n++) {
        const dest = n === 1 ? name : `${name}-${n}`;
        try {
          fs.copyFileSync(p.file, dest, fs.constants.COPYFILE_EXCL);
          backup = dest;
        } catch (e) {
          if (e.code !== "EEXIST" || n > 50) throw e;
        }
      }
      mode = fs.statSync(p.file).mode & 0o777;
    }
    const tmp = `${p.file}.halo-${process.pid}.tmp`;
    fs.writeFileSync(tmp, p.after, { mode });
    fs.renameSync(tmp, p.file);
    JSON.parse(fs.readFileSync(p.file, "utf8"));
  } catch (e) {
    return { ok: false, error: `Halo couldn't write ${p.file}: ${e.message}${backup ? ` Your backup is ${backup}.` : ""}` };
  }
  plans.delete(id);
  return { ok: true, file: p.file, backup, enable: p.enable };
}

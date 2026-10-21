// A small, safe Markdown renderer for chat answers and notes. Everything is
// HTML-escaped first; only a fixed set of tags is produced, and links keep
// their URL in data-href (the panel opens http/https links in the browser).

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function safeHref(url) {
  const u = url.trim().replace(/&amp;/g, "&");
  return /^(https?:|mailto:)/i.test(u) ? esc(u) : null;
}

function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
    const h = safeHref(url);
    return h ? `<a data-href="${h}" title="${h}">${text}</a>` : text;
  });
  s = s.replace(/(^|[\s(])((https?:\/\/)[^\s<)]+[^\s<).,;:!?'"])/g, (m, pre, url) => {
    const h = safeHref(url);
    return h ? `${pre}<a data-href="${h}" title="${h}">${url}</a>` : m;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  return s;
}

function table(lines) {
  const row = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
  const head = row(lines[0]);
  const body = lines.slice(2).map(row);
  return `<div class="md-table"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${body
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

export function renderMarkdown(src) {
  const lines = esc(String(src ?? "")).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push(`<pre><code>${code.join("\n")}</code></pre>`);
      continue;
    }

    if (/^\s*$/.test(line)) {
      flush();
      i++;
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const level = Math.min(6, h[1].length + 2);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      out.push("<hr>");
      i++;
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush();
      const t = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) t.push(lines[i++]);
      out.push(table(t));
      continue;
    }

    if (/^\s*&gt;\s?/.test(line)) {
      flush();
      const q = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) q.push(lines[i++].replace(/^\s*&gt;\s?/, ""));
      out.push(`<blockquote>${renderMarkdownEscaped(q.join("\n"))}</blockquote>`);
      continue;
    }

    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const ordered = /\d/.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m) {
          items.push({ indent: m[1].length, text: m[3] });
          i++;
        } else if (/^\s{2,}\S/.test(lines[i]) && items.length) {
          items[items.length - 1].text += " " + lines[i].trim();
          i++;
        } else break;
      }
      const base = items[0].indent;
      let html = `<${ordered ? "ol" : "ul"}>`;
      let nested = false;
      for (const it of items) {
        let text = it.text;
        let cls = "";
        const task = /^\[( |x|X)\]\s+(.*)$/.exec(text);
        if (task) {
          cls = ` class="task${task[1] !== " " ? " done" : ""}"`;
          text = task[2];
        }
        if (it.indent > base && !nested) {
          html += "<ul>";
          nested = true;
        } else if (it.indent <= base && nested) {
          html += "</ul>";
          nested = false;
        }
        html += `<li${cls}>${inline(text)}</li>`;
      }
      if (nested) html += "</ul>";
      html += `</${ordered ? "ol" : "ul"}>`;
      out.push(html);
      continue;
    }

    para.push(line.trim());
    i++;
  }
  flush();
  return out.join("");
}

// Blockquote bodies are already escaped; render them without escaping twice.
function renderMarkdownEscaped(s) {
  return renderMarkdown(s.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
}

// The shareable picture of your time with your agents: 1080 × 1920, story-sized.

import { stillCharacter } from "./characters/still.js";

const W = 1080;
const H = 1920;
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", system-ui, sans-serif';

/** 4 h 12 min · 35 min */
export function hm(ms) {
  const m = Math.round(ms / 60000);
  const h = Math.floor(m / 60);
  return h ? `${h} h${m % 60 ? ` ${m % 60} min` : ""}` : `${m} min`;
}

export const num = (n) => n.toLocaleString();

/** The picture's title and dates for a period ("day", "week" or "lastweek"). */
export function recapTitle(period, { start, end }) {
  const date = (t, o) => new Date(t).toLocaleDateString(undefined, o);
  if (period === "day") return { title: "My day with my agents", range: date(start, { weekday: "long", month: "short", day: "numeric" }) };
  const last = period === "lastweek" ? end - 86_400_000 : end;
  return { title: "My week with my agents", range: `${date(start, { month: "short", day: "numeric" })} – ${date(last, { month: "short", day: "numeric" })}` };
}

function text(c, s, x, y, { size, weight = 400, color = "#fff", align = "left", max = Infinity, spacing = "0px" }) {
  let px = size;
  do c.font = `${weight} ${px}px ${FONT}`;
  while (c.measureText(s).width > max && (px -= 2) > 18);
  c.fillStyle = color;
  c.textAlign = align;
  c.letterSpacing = spacing;
  c.fillText(s, x, y);
  c.letterSpacing = "0px";
}

/** @returns {string} a PNG data URL */
export function recapImage(stats, { kind, title, range, platform }) {
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const c = cv.getContext("2d");

  const bg = c.createLinearGradient(0, 0, W * 0.45, H);
  bg.addColorStop(0, "#1A1E8C");
  bg.addColorStop(0.5, "#3B2BD4");
  bg.addColorStop(1, "#8B3FE0");
  c.fillStyle = bg;
  c.fillRect(0, 0, W, H);
  const glow = c.createRadialGradient(540, 640, 40, 540, 640, 560);
  glow.addColorStop(0, "rgba(255,255,255,0.24)");
  glow.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = glow;
  c.fillRect(0, 0, W, H);
  c.strokeStyle = "rgba(255,255,255,0.35)";
  c.lineWidth = 3;
  c.beginPath();
  c.moveTo(-40, 900);
  c.quadraticCurveTo(560, 700, 1120, 720);
  c.stroke();

  const soft = "rgba(255,255,255,0.78)";
  text(c, "MY RECAP", 90, 150, { size: 32, weight: 600, color: "rgba(255,255,255,0.7)", spacing: "3px" });
  text(c, title, 90, 234, { size: 68, weight: 750, max: 900 });
  text(c, range, 90, 294, { size: 40, color: soft });

  c.drawImage(stillCharacter(kind, 700, { R: 220, center: { x: 350, y: 340 } }), 540 - 350, 640 - 340);

  text(c, hm(stats.ms), 540, 1010, { size: 128, weight: 800, align: "center", max: 920 });
  text(c, "with Claude Code", 540, 1076, { size: 42, color: "rgba(255,255,255,0.86)", align: "center" });

  const cards = [
    ["Sessions", num(stats.sessions)],
    ["Lines changed", num(stats.lines.added + stats.lines.removed), `+${num(stats.lines.added)}  −${num(stats.lines.removed)}`],
    ["Files edited", num(stats.files)],
    ["Commands", num(stats.commands)],
    ["Busiest day", stats.busiestDay?.name ?? "–", stats.busiestDay ? hm(stats.busiestDay.ms) : ""],
    ["Top project", stats.topProject?.name ?? "–", stats.topProject ? hm(stats.topProject.ms) : ""],
  ];
  cards.forEach(([label, value, sub], i) => {
    const x = i % 2 ? 555 : 90;
    const y = 1136 + Math.floor(i / 2) * 212;
    c.fillStyle = "rgba(255,255,255,0.13)";
    c.beginPath();
    c.roundRect(x, y, 435, 190, 30);
    c.fill();
    text(c, label, x + 36, y + 58, { size: 31, weight: 500, color: "rgba(255,255,255,0.82)" });
    text(c, value, x + 36, y + 130, { size: 64, weight: 800, max: 363 });
    if (sub) text(c, sub, x + 36, y + 170, { size: 28, color: "rgba(255,255,255,0.75)", max: 363 });
  });

  text(c, `Made with Halo, on my ${platform === "darwin" ? "Mac" : "PC"}`, 540, 1850, { size: 32, color: "rgba(255,255,255,0.72)", align: "center" });
  return cv.toDataURL("image/png");
}

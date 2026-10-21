// Renders a still frame of a character to PNG data URLs for the app and tray
// icons (used by scripts/make-icons.mjs). Same drawing code as the desktop character.

import { Character } from "./characters/engine.js";

const canvas = document.getElementById("c");

function still(kind, px, { background = false } = {}) {
  canvas.style.width = `${px}px`;
  canvas.style.height = `${px}px`;
  canvas.width = px;
  canvas.height = px;
  const b = new Character(canvas, { kind, R: px * (background ? 0.25 : 0.3), center: { x: px / 2, y: px * (background ? 0.47 : 0.45) } });
  b.observer.disconnect();
  b.dpr = 1;
  canvas.width = px;
  canvas.height = px;
  b.w = px;
  b.h = px;
  b.blink = 1;
  b.lookAt(0.15, 0.25);
  b.lx = 0.15;
  b.ly = 0.25;
  b.frame(1.2, 0);
  b.particles = [];
  b.frame(1.2, 0);
  if (!background) return canvas.toDataURL("image/png");

  // App icon: the character on a soft rounded square.
  const out = document.createElement("canvas");
  out.width = px;
  out.height = px;
  const c = out.getContext("2d");
  const m = px * 0.09;
  const r = px * 0.2;
  const g = c.createLinearGradient(0, m, 0, px - m);
  g.addColorStop(0, "#2B2160");
  g.addColorStop(1, "#140F33");
  c.fillStyle = g;
  c.beginPath();
  c.roundRect(m, m, px - 2 * m, px - 2 * m, r);
  c.fill();
  c.drawImage(canvas, 0, 0);
  return out.toDataURL("image/png");
}

/** Monochrome star silhouette for the macOS menu bar ("Template" image). */
function template(px) {
  canvas.width = px;
  canvas.height = px;
  const c = canvas.getContext("2d");
  c.clearRect(0, 0, px, px);
  c.translate(px / 2, px / 2 + px * 0.03);
  c.scale(px * 0.46, px * 0.46);
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? 0.5 : 1;
    pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
  }
  c.beginPath();
  pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
  c.closePath();
  c.lineJoin = "round";
  c.lineWidth = 0.16;
  c.strokeStyle = "#000";
  c.fillStyle = "#000";
  c.stroke();
  c.fill();
  // Two eyes cut out so it reads as a face at 16 px.
  c.globalCompositeOperation = "destination-out";
  for (const s of [-1, 1]) {
    c.beginPath();
    c.ellipse(s * 0.2, 0.08, 0.075, 0.13, 0, 0, Math.PI * 2);
    c.fill();
  }
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalCompositeOperation = "source-over";
  return canvas.toDataURL("image/png");
}

window.renderIcons = () => ({
  "icon.png": still("nova", 1024, { background: true }),
  "tray.png": still("nova", 32),
  "tray@2x.png": still("nova", 64),
  "trayTemplate.png": template(18),
  "trayTemplate@2x.png": template(36),
  ...Object.fromEntries(["nova", "sunny", "luna", "orbit", "mimi"].map((k) => [`characters/${k}.png`, still(k, 256)])),
});
window.iconsReady = true;

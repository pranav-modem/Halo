// The five characters. Each one draws its body in unit space (1 = R), then
// asks the engine to draw the face (`b.face`). Signature idle motion follows
// the character sheet: Nova rotates/pulses/twinkles, Sunny glows/pulses/beams,
// Luna rocks/glows/sleeps, Orbit orbits/spins/sparkles, Mimi floats/fades/reappears.

import { gloss, halo, spark4, vgrad } from "./paint.js";

const TAU = Math.PI * 2;

/** 1 normally, slower and smaller while asleep. */
const calm = (b) => (b.state === "sleeping" ? 0.35 : 1);

/** Fires `fn` at most every `min`–`max` seconds (per character, per key). */
function every(b, key, t, min, max, fn) {
  b.memo ??= {};
  const next = b.memo[key] ?? 0;
  if (t >= next) {
    b.memo[key] = t + min + Math.random() * (max - min);
    if (next !== 0) fn();
  }
}

function starPath(c, ro, ri, rr) {
  const p = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 ? ri : ro;
    p.push([Math.cos(a) * r, Math.sin(a) * r + 0.06]);
  }
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const s = mid(p[9], p[0]);
  c.beginPath();
  c.moveTo(s[0], s[1]);
  for (let i = 0; i < 10; i++) {
    const q = p[i];
    const n = mid(q, p[(i + 1) % 10]);
    c.arcTo(q[0], q[1], n[0], n[1], i % 2 ? rr * 0.55 : rr);
  }
  c.closePath();
}

/** Crescent = unit circle minus a circle at (x2, y2) of radius r2. */
function crescentPath(c, x2, y2, r2) {
  const d = Math.hypot(x2, y2);
  const a = (1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, 1 - a * a));
  const ux = x2 / d, uy = y2 / d, px = a * ux, py = a * uy;
  const P1 = [px - h * uy, py + h * ux];
  const P2 = [px + h * uy, py - h * ux];
  const a1 = Math.atan2(P1[1], P1[0]), a2 = Math.atan2(P2[1], P2[0]);
  const b1 = Math.atan2(P1[1] - y2, P1[0] - x2), b2 = Math.atan2(P2[1] - y2, P2[0] - x2);
  const mid = (s, e) => s + ((e - s + Math.PI * 4) % TAU) / 2;
  const ma = mid(a1, a2);
  const outerCCW = Math.hypot(Math.cos(ma) - x2, Math.sin(ma) - y2) < r2;
  const mb = mid(b2, b1);
  const innerCCW = Math.hypot(x2 + Math.cos(mb) * r2, y2 + Math.sin(mb) * r2) > 1;
  c.beginPath();
  c.arc(0, 0, 1, a1, a2, outerCCW);
  c.arc(x2, y2, r2, b2, b1, innerCCW);
  c.closePath();
}

function ghostPath(c, t) {
  c.beginPath();
  c.moveTo(-0.78, -0.12);
  c.arc(0, -0.12, 0.78, Math.PI, 0);
  c.bezierCurveTo(0.8, 0.15, 0.95, 0.2, 1.02, 0.32);
  c.bezierCurveTo(1.07, 0.43, 0.9, 0.5, 0.8, 0.47);
  c.lineTo(0.8, 0.64);
  for (let i = 0; i < 3; i++) {
    const x0 = 0.8 - i * 0.5333, x1 = x0 - 0.5333;
    c.quadraticCurveTo((x0 + x1) / 2, 0.95 + 0.07 * Math.sin(t * 3 + i * 1.4), x1, 0.64);
  }
  c.lineTo(-0.8, 0.47);
  c.bezierCurveTo(-0.9, 0.5, -1.07, 0.43, -1.02, 0.32);
  c.bezierCurveTo(-0.95, 0.2, -0.8, 0.15, -0.78, -0.12);
  c.closePath();
}

export const CAST = {
  nova: {
    shadow: "rgba(255,170,0,.22)",
    draw(c, t, b) {
      const k = calm(b);
      c.save();
      c.rotate(Math.sin(t * 1.3) * 0.1 * k + b.v.spin);
      const p = 1 + Math.sin(t * 2.6) * 0.03 * k;
      c.scale(p, p);
      starPath(c, 1.08, 0.6, 0.24);
      c.fillStyle = vgrad(c, -1, 1, ["#FFF7AE", "#FFDB2E", "#FFB000"]);
      c.fill();
      c.lineJoin = "round";
      c.lineWidth = 0.085;
      c.strokeStyle = "#F08A00";
      c.stroke();
      gloss(c, -0.22, -0.45, 0.08, 0.18, -0.55);
      b.face(c, { x: 0, y: 0.12, dx: 0.27, w: 0.12, h: 0.2, bx: 0.48, by: 0.17, my: 0.25, mouth: "smile" });
      c.restore();
      if (b.state !== "sleeping") every(b, "twinkle", t, 0.5, 1.4, () => b.spawn("twinkle"));
    },
  },

  sunny: {
    shadow: "rgba(255,180,0,.22)",
    draw(c, t, b) {
      const k = calm(b);
      const loud = b.state === "alert" || b.state === "listening" ? 0.12 : 0;
      halo(c, "255,196,40", (0.24 + 0.1 * Math.sin(t * 2.2) + loud) * (0.5 + 0.5 * k), 1.5);
      const p = 1 + Math.sin(t * 2) * 0.025 * k;
      c.save();
      c.scale(p, p);
      const g = vgrad(c, -1, 1, ["#FFF08A", "#FFD21F", "#FFB400"]);
      c.save();
      c.rotate(t * 0.3 * k + b.v.spin);
      const burst = b.state === "done" ? 0.12 : 0;
      for (let i = 0; i < 8; i++) {
        c.save();
        c.rotate((i * Math.PI) / 4);
        const L = 1.12 + burst + 0.08 * Math.sin(t * 3 + i * 1.3) * k;
        c.beginPath();
        c.moveTo(-0.17, -0.8);
        c.lineTo(0, -L);
        c.lineTo(0.17, -0.8);
        c.closePath();
        c.lineJoin = "round";
        c.lineWidth = 0.08;
        c.strokeStyle = "#F29A00";
        c.stroke();
        c.fillStyle = g;
        c.fill();
        c.restore();
      }
      c.restore();
      c.beginPath();
      c.arc(0, 0, 0.75, 0, TAU);
      c.fillStyle = g;
      c.fill();
      c.lineWidth = 0.085;
      c.strokeStyle = "#F29A00";
      c.stroke();
      gloss(c, -0.3, -0.4, 0.12, 0.08, -0.6);
      b.face(c, { x: 0, y: 0, dx: 0.24, w: 0.13, h: 0.21, bx: 0.43, by: 0.2, my: 0.2, mouth: "open" });
      c.restore();
    },
  },

  luna: {
    shadow: "rgba(110,100,240,.2)",
    draw(c, t, b) {
      const k = calm(b);
      halo(c, "150,140,255", 0.2 + 0.08 * Math.sin(t * 1.8), 1.45);
      c.save();
      c.rotate(Math.sin(t * 1.1) * 0.14 * k + b.v.spin * 0.15);
      crescentPath(c, 0.52, -0.3, 0.8);
      const g = c.createLinearGradient(-0.6, -0.9, 0.5, 1);
      g.addColorStop(0, "#E6E3FF");
      g.addColorStop(0.55, "#BDB6F8");
      g.addColorStop(1, "#A096EF");
      c.fillStyle = g;
      c.fill();
      c.lineJoin = "round";
      c.lineWidth = 0.09;
      c.strokeStyle = "#5A55E6";
      c.stroke();
      gloss(c, -0.62, -0.36, 0.06, 0.18, 0.35);
      b.face(c, { x: -0.4, y: 0.2, dx: 0.17, w: 0.1, h: 0.17, bx: 0.27, by: 0.13, my: 0.17, mouth: "none", sleepy: true });
      c.restore();
      // Luna dozes even when idle: the occasional z.
      if (b.state === "idle" && !b.hover) every(b, "z", t, 3.5, 7, () => b.spawn("z"));
    },
  },

  orbit: {
    shadow: "rgba(90,60,220,.22)",
    draw(c, t, b) {
      const k = calm(b);
      const tilt = -0.35 + Math.sin(t * 0.7) * 0.1 * k;
      const rx = 1.34, ry = 0.34;
      const m = t * 1.4 * k;
      const back = Math.sin(m) < 0;
      const rg = c.createLinearGradient(-rx, 0, rx, 0);
      ["#7DD3FC", "#C4B5FD", "#F9A8D4", "#93C5FD"].forEach((s, i) => rg.addColorStop(i / 3, s));
      const ring = (a0, a1) => {
        c.save();
        c.rotate(tilt);
        c.beginPath();
        c.ellipse(0, 0, rx, ry, 0, a0, a1);
        c.strokeStyle = rg;
        c.lineWidth = 0.15;
        c.lineCap = "round";
        c.stroke();
        c.restore();
      };
      const moon = () => {
        c.save();
        c.rotate(tilt);
        c.fillStyle = "#FDE68A";
        c.beginPath();
        c.arc(Math.cos(m) * rx, Math.sin(m) * ry, 0.1, 0, TAU);
        c.fill();
        c.restore();
      };
      ring(Math.PI, TAU);
      if (back) moon();
      c.save();
      c.rotate(b.v.spin);
      const bg = c.createRadialGradient(-0.3, -0.35, 0.05, 0, 0, 0.95);
      bg.addColorStop(0, "#7B5CFF");
      bg.addColorStop(0.45, "#3D25AE");
      bg.addColorStop(1, "#1A0F55");
      c.fillStyle = bg;
      c.beginPath();
      c.arc(0, 0, 0.82, 0, TAU);
      c.fill();
      c.lineWidth = 0.07;
      c.strokeStyle = "#120A3D";
      c.stroke();
      gloss(c, -0.32, -0.46, 0.16, 0.09, -0.6);
      b.face(c, { x: 0, y: -0.06, dx: 0.26, w: 0.14, h: 0.21, bx: 0.45, by: 0.14, my: 0.2, mouth: "smile", light: true });
      c.restore();
      ring(0, Math.PI);
      if (!back) moon();
      const spots = [[-1.3, -0.9], [1.2, -1.05], [1.32, 0.75], [-1.12, 1.0]];
      spots.forEach((p, i) => spark4(c, p[0], p[1], 0.13 * k * (0.55 + 0.45 * Math.sin(t * 3 + i * 1.7)), "#FFD84D"));
    },
  },

  mimi: {
    shadow: "rgba(139,92,246,.2)",
    draw(c, t, b) {
      const k = calm(b);
      // Fades and reappears every ~9 s, but never while you're pointing at
      // her or while she has something to tell you.
      let a = 1;
      if (b.state === "idle" && !b.hover) {
        const p = t % 9;
        if (p > 6.8) a = 1 - 0.72 * Math.sin(((p - 6.8) / 2.2) * Math.PI);
      }
      c.save();
      c.globalAlpha *= a;
      c.translate(0, Math.sin(t * 1.7) * 0.07 * k - 0.05);
      c.rotate(Math.sin(t * 0.9) * 0.05 * k + b.v.spin);
      ghostPath(c, t * k);
      c.fillStyle = vgrad(c, -0.9, 0.95, ["#FFFFFF", "#F5F0FF", "#D8CAFF"]);
      c.fill();
      c.lineJoin = "round";
      c.lineWidth = 0.075;
      c.strokeStyle = "#8B5CF6";
      c.stroke();
      gloss(c, -0.36, -0.55, 0.12, 0.07, -0.5);
      b.face(c, { x: 0, y: -0.08, dx: 0.22, w: 0.12, h: 0.19, bx: 0.42, by: 0.14, my: 0.14, mouth: "smile" });
      c.restore();
    },
  },
};

// Character engine: the shared state machine, tweens, face, badges and
// particles for all five characters. Everything is drawn in code on a 2D
// canvas, in a unit space where 1 = the body radius R.

import { CAST } from "./cast.js";
import { spark4, heartPath } from "./paint.js";

const now = () => performance.now() / 1000;
const INK = "#1A1426";
const LIGHT_INK = "#F7F5FF";
const TAU = Math.PI * 2;

export const Ease = {
  lin: (p) => p,
  out: (p) => 1 - Math.pow(1 - p, 3),
  inOut: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  back: (p) => {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
  },
};

const STATE_BADGE = {
  thinking: { kind: "dots", color: "#8B5CF6" },
  working: { kind: "gear", color: "#3B82F6" },
  listening: { kind: "mic", color: "#EF4444" },
  alert: { kind: "bang", color: "#F59E0B" },
  done: { kind: "check", color: "#22C55E" },
  error: { kind: "cross", color: "#EF4444" },
};

// ── Shared ticker: one requestAnimationFrame for every character on the page ──────

const live = new Set();
let rafId = 0;
let lastTick = 0;

function tick() {
  rafId = 0;
  const t = now();
  let next = Infinity;
  for (const b of live) {
    const interval = 1 / b.targetFps();
    if (t - b.lastDraw >= interval - 0.004) {
      const dt = Math.min(0.1, t - (b.lastDraw || t));
      b.lastDraw = t;
      b.frame(t, dt);
    }
    next = Math.min(next, b.lastDraw + 1 / b.targetFps());
  }
  lastTick = t;
  if (!live.size) return;
  const wait = Math.max(0, next - now());
  // Below ~30 ms the frame callback is the cheapest wait; longer waits use a
  // timer so a sleeping character wakes the page only a few times a second.
  if (wait < 0.03) rafId = requestAnimationFrame(tick);
  else setTimeout(() => { if (!rafId) rafId = requestAnimationFrame(tick); }, wait * 1000);
}

function ensureTicking() {
  if (!rafId && live.size) rafId = requestAnimationFrame(tick);
}

// ── The engine ────────────────────────────────────────────────────────────────

export class Character {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{kind?: string, R?: number, center?: {x:number,y:number}, fps?: number, interactive?: boolean}} opts
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.kind = CAST[opts.kind] ? opts.kind : "nova";
    this.R = opts.R ?? 34;
    this.center = opts.center ?? null;
    this.fps = opts.fps ?? 30;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);

    this.state = "idle";
    this.stateT = now();
    this.prevState = "idle";

    // Animated values (tweens write these; idle drift is added in frame()).
    this.v = { oy: 0, ox: 0, sx: 1, sy: 1, rot: 0, spin: 0, alpha: 1, blush: 0, es: 1, badgeS: 0, pop: 1 };
    this.tweens = new Map();

    this.lx = 0; this.ly = 0; // smoothed look, -1…1
    this.tx = 0; this.ty = 0; // look target
    this.hover = false;
    this.blink = 1;
    this.nextBlink = now() + 1 + Math.random() * 2.5;
    this.blinkStart = -9;
    this.talkUntil = 0;
    this.talkPhase = 0;
    this.emoteName = null;
    this.emoteUntil = 0;
    this.particles = [];
    this.lastAmbient = 0;
    this.lastDraw = 0;
    this.badge = null;
    this.t0 = now() - Math.random() * 5;

    this.resize();
    // Canvases are often created before they are laid out; follow their size.
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
  }

  // ── public API ──────────────────────────────────────────────────────────────

  start() { live.add(this); ensureTicking(); return this; }
  stop() { live.delete(this); this.observer?.disconnect(); }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, r.width || this.canvas.width);
    const h = Math.max(1, r.height || this.canvas.height);
    this.w = w; this.h = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
  }

  setKind(kind) {
    if (!CAST[kind] || kind === this.kind) return;
    this.anim("pop", [[0.6, 120, Ease.inOut]], () => {
      this.kind = kind;
      this.anim("pop", [[1, 320, Ease.back]]);
      this.burst("twinkle", 5);
    });
  }

  setState(next) {
    if (next === this.state) return;
    this.prevState = this.state;
    this.state = next;
    this.stateT = now();
    this.setBadge(STATE_BADGE[next] ?? null);
    switch (next) {
      case "done":
        this.anim("oy", [[-0.32, 180, Ease.out], [0, 420, Ease.back]]);
        this.anim("spin", [[TAU, 900, Ease.inOut]], () => { this.v.spin = 0; });
        this.burst("spark", 7);
        break;
      case "error":
        this.anim("ox", [[0.12, 50, Ease.out], [-0.12, 70, Ease.inOut], [0.08, 70, Ease.inOut], [0, 90, Ease.out]]);
        break;
      case "alert":
        this.anim("oy", [[-0.25, 140, Ease.out], [0, 320, Ease.back]]);
        break;
      case "listening":
        this.anim("es", [[1.15, 160, Ease.out], [1, 300, Ease.inOut]]);
        break;
      case "thinking":
      case "working":
        this.doBlink();
        break;
      default:
        break;
    }
  }

  /** Cursor direction, already normalised to -1…1. */
  lookAt(x, y) { this.tx = x; this.ty = y; }

  /** Call on every streamed text delta: the mouth flaps while text arrives. */
  talk() { this.talkUntil = now() + 0.28; }

  setHover(h) {
    if (h === this.hover) return;
    this.hover = h;
    if (h) this.anim("blush", [[0.8, 220, Ease.out]]);
    else this.anim("blush", [[0, 400, Ease.inOut]]);
  }

  poke() {
    this.anim("sy", [[0.8, 70, Ease.out], [1.1, 130, Ease.out], [1, 170, Ease.inOut]]);
    this.anim("sx", [[1.16, 70, Ease.out], [0.94, 130, Ease.out], [1, 170, Ease.inOut]]);
  }

  /** love | surprised | dizzy | happy */
  emote(name, duration = 1.8) {
    this.emoteName = name;
    this.emoteUntil = now() + duration;
    if (name === "love") { this.burst("heart", 4); this.anim("blush", [[1, 200, Ease.out], [1, duration * 1000 - 500, Ease.lin], [this.hover ? 0.8 : 0, 300, Ease.inOut]]); }
    if (name === "surprised") this.anim("oy", [[-0.3, 140, Ease.out], [0, 380, Ease.back]]);
    if (name === "dizzy") this.anim("rot", [[TAU, 1200, Ease.inOut]], () => { this.v.rot = 0; });
    if (name === "happy") this.burst("twinkle", 4);
  }

  // ── internals ───────────────────────────────────────────────────────────────

  targetFps() { return this.state === "sleeping" ? 4 : this.fps; }

  anim(prop, keys, onDone) {
    this.tweens.set(prop, { prop, keys, i: 0, from: this.v[prop], start: performance.now(), onDone });
  }

  setBadge(b) {
    const same = (b?.kind ?? null) === (this.badge?.kind ?? null);
    if (same) return;
    this.anim("badgeS", [[0, 90, Ease.inOut]], () => {
      this.badge = b;
      if (b) this.anim("badgeS", [[1, 280, Ease.back]]);
    });
  }

  doBlink() { this.blinkStart = now(); }

  burst(type, n) { for (let i = 0; i < n; i++) this.spawn(type, i * 0.08); }

  spawn(type, delay = 0) {
    const a = Math.random() * TAU;
    const z = type === "z";
    this.particles.push({
      type,
      x: z ? 0.5 : Math.cos(a) * (1.15 + Math.random() * 0.3),
      y: z ? -0.75 : Math.sin(a) * (1.0 + Math.random() * 0.3),
      vx: z ? 0.22 : (Math.random() - 0.5) * 0.35,
      vy: z ? -0.42 : -0.25 - Math.random() * 0.2,
      age: -delay,
      life: z ? 2.2 : 1.1 + Math.random() * 0.4,
    });
  }

  update(t, dt) {
    const nowMs = performance.now();
    for (const tw of [...this.tweens.values()]) {
      const k = tw.keys[tw.i];
      const p = Math.min(1, Math.max(0, (nowMs - tw.start) / k[1]));
      this.v[tw.prop] = tw.from + (k[0] - tw.from) * k[2](p);
      if (p >= 1) {
        tw.from = k[0];
        tw.i += 1;
        tw.start = nowMs;
        if (tw.i >= tw.keys.length) {
          this.tweens.delete(tw.prop);
          tw.onDone?.();
        }
      }
    }

    // Where the eyes look: the cursor, unless the state overrides it.
    let tx = this.tx, ty = this.ty;
    if (this.state === "thinking") { tx = 0.6 + Math.sin(t * 0.8) * 0.15; ty = -0.7; }
    if (this.state === "working") { tx = -0.35 + Math.sin(t * 2.2) * 0.25; ty = 0.35; }
    if (this.state === "sleeping") { tx = 0; ty = 0.3; }
    if (this.emoteName === "dizzy") { tx = Math.sin(t * 9) * 0.5; }
    const k = 1 - Math.pow(0.002, dt);
    this.lx += (tx - this.lx) * k;
    this.ly += (ty - this.ly) * k;

    // Blinks.
    if (t > this.nextBlink) {
      if (this.state !== "sleeping") {
        this.doBlink();
        if (Math.random() < 0.2) setTimeout(() => this.doBlink(), 230);
      }
      this.nextBlink = t + 2.2 + Math.random() * 3.2;
    }
    const bp = (t - this.blinkStart) / 0.16;
    this.blink = bp >= 0 && bp < 1 ? Math.abs(1 - 2 * bp) * 0.92 + 0.08 : 1;

    if (this.emoteName && t > this.emoteUntil) this.emoteName = null;

    // Mouth flaps while text streams.
    const talking = t < this.talkUntil;
    this.talkPhase = talking ? 0.5 + 0.5 * Math.sin(t * 22) : Math.max(0, this.talkPhase - dt * 6);

    // Ambient particles.
    if (t - this.lastAmbient > 0.25) {
      this.lastAmbient = t;
      if (this.state === "sleeping" && Math.random() < 0.18) this.spawn("z");
      if (this.state === "done" && t - this.stateT < 1.6 && Math.random() < 0.5) this.spawn("spark");
    }
    for (const p of this.particles) {
      p.age += dt;
      if (p.age > 0) { p.x += p.vx * dt; p.y += p.vy * dt; }
    }
    this.particles = this.particles.filter((p) => p.age < p.life);
  }

  frame(t, dt) {
    this.update(t, dt);
    const c = this.ctx;
    const { w, h, dpr } = this;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);

    const cx = this.center ? this.center.x : w / 2;
    const cy = this.center ? this.center.y : h / 2;
    const R = this.R;
    const st = this.state;
    const lt = t - this.t0;

    // State-driven motion layered on top of the tweens.
    let oy = this.v.oy, sx = this.v.sx, sy = this.v.sy, rot = this.v.rot;
    if (st === "alert") oy += -Math.abs(Math.sin(lt * 6)) * 0.12;
    if (st === "thinking") oy += Math.sin(lt * 2) * 0.03;
    if (st === "listening") { const b = Math.sin(lt * 3.2) * 0.025; sx += b; sy -= b; }
    if (st === "sleeping") { const b = Math.sin(lt * 1.6) * 0.035; sy += b; sx -= b * 0.6; }
    if (this.hover) { sx *= 1.04; sy *= 1.04; }
    const pop = this.v.pop;

    c.save();
    c.translate(cx, cy);
    c.scale(R, R);

    // Soft coloured shadow under the character.
    const cast = CAST[this.kind];
    c.fillStyle = cast.shadow;
    c.beginPath();
    c.ellipse(0, 1.32, 0.72 * (1 + oy * 0.9) * pop, 0.1 * pop, 0, 0, TAU);
    c.fill();

    c.save();
    c.translate(this.v.ox, oy);
    c.rotate(rot);
    c.scale(sx * pop, sy * pop);
    c.globalAlpha = this.v.alpha * (st === "sleeping" ? 0.92 : 1);
    cast.draw(c, lt, this);
    c.restore();

    if (this.badge && this.v.badgeS > 0.01) this.drawBadge(c, lt);
    this.drawParticles(c, R);
    c.restore();
  }

  // ── face ────────────────────────────────────────────────────────────────────

  /**
   * Draws blush, eyes and mouth at the face position.
   * o: {x, y, dx, w, h, bx, by, my, mouth, light, sleepy}
   */
  face(c, o) {
    const x = o.x + this.lx * 0.09;
    const y = o.y + this.ly * 0.07;
    const st = this.state;
    const awake = this.hover || (st !== "idle" && st !== "sleeping");

    let eye = o.sleepy && !awake ? "closed" : "open";
    if (st === "working") eye = "focus";
    if (st === "alert" || st === "listening") eye = "wide";
    if (st === "done") eye = "happy";
    if (st === "error") eye = "flat";
    if (st === "sleeping") eye = "closed";
    if (this.emoteName === "love") eye = "heart";
    if (this.emoteName === "dizzy") eye = "spiral";
    if (this.emoteName === "surprised") eye = "dot";
    if (this.emoteName === "happy") eye = "happy";

    const blush = Math.max(0.45, this.v.blush);
    c.fillStyle = `rgba(255,120,160,${0.45 + 0.35 * (blush - 0.45)})`;
    for (const s of [-1, 1]) {
      c.beginPath();
      c.ellipse(x + s * o.bx, y + o.by, 0.13, 0.075, 0, 0, TAU);
      c.fill();
    }

    for (const s of [-1, 1]) this.eye(c, x + s * o.dx, y, o.w * this.v.es, o.h * this.v.es, eye, o.light, s);

    let mouth = o.mouth;
    if (st === "thinking") mouth = "o";
    if (st === "alert") mouth = "o";
    if (st === "error") mouth = "flat";
    if (st === "done") mouth = o.mouth === "none" ? "smile" : "open";
    if (st === "sleeping") mouth = o.mouth === "open" ? "smile" : o.mouth;
    if (mouth === "none" && awake) mouth = "smile";
    if (this.talkPhase > 0.02) mouth = "talk";
    this.mouth(c, x, y + o.my, mouth, o.light);
  }

  eye(c, x, y, w, h, shape, light, side) {
    const ink = light ? LIGHT_INK : INK;
    c.save();
    c.translate(x, y);
    c.strokeStyle = ink;
    c.fillStyle = ink;
    c.lineCap = "round";
    c.lineWidth = 0.055;
    switch (shape) {
      case "closed":
        c.beginPath();
        c.arc(0, -h * 0.2, w * 0.85, 0.15 * Math.PI, 0.85 * Math.PI);
        c.stroke();
        break;
      case "happy":
        c.beginPath();
        c.arc(0, h * 0.3, w * 0.85, 1.15 * Math.PI, 1.85 * Math.PI);
        c.stroke();
        break;
      case "flat":
        c.beginPath();
        c.moveTo(-w * 0.55, side * -0.02);
        c.lineTo(w * 0.55, side * 0.02);
        c.stroke();
        break;
      case "dot":
        c.beginPath();
        c.arc(0, 0, w * 0.32, 0, TAU);
        c.fill();
        break;
      case "heart":
        c.fillStyle = "#FF4D7E";
        c.scale(1, 1);
        heartPath(c, w * 0.95);
        c.fill();
        break;
      case "spiral": {
        c.lineWidth = 0.035;
        c.beginPath();
        const turns = 2.2;
        const rot = now() * 6 * side;
        for (let i = 0; i <= 40; i++) {
          const a = (i / 40) * turns * TAU + rot;
          const r = (i / 40) * w * 0.6;
          const px = Math.cos(a) * r, py = Math.sin(a) * r;
          if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
        }
        c.stroke();
        break;
      }
      default: {
        const s = shape === "wide" ? 1.18 : 1;
        const squint = shape === "focus" ? 0.7 : 1;
        const hh = Math.max(0.025, h * s * squint * this.blink);
        c.beginPath();
        c.ellipse(0, 0, (w * s) / 2, hh / 2, 0, 0, TAU);
        c.fill();
        if (!light && this.blink > 0.5) {
          c.fillStyle = "#fff";
          c.beginPath();
          c.arc(-w * 0.13, -hh * 0.2, w * 0.17, 0, TAU);
          c.fill();
          c.beginPath();
          c.arc(w * 0.12, hh * 0.17, w * 0.08, 0, TAU);
          c.fill();
        }
      }
    }
    c.restore();
  }

  mouth(c, x, y, shape, light) {
    const ink = light ? LIGHT_INK : INK;
    c.strokeStyle = ink;
    c.fillStyle = ink;
    c.lineWidth = 0.045;
    c.lineCap = "round";
    switch (shape) {
      case "o":
        c.beginPath();
        c.arc(x + 0.02, y, 0.038, 0, TAU);
        c.fill();
        break;
      case "flat":
        c.beginPath();
        c.moveTo(x - 0.07, y);
        c.lineTo(x + 0.07, y);
        c.stroke();
        break;
      case "talk": {
        const open = 0.03 + 0.09 * this.talkPhase;
        c.fillStyle = light ? LIGHT_INK : "#7A1F2B";
        c.beginPath();
        c.ellipse(x, y + 0.02, 0.085, open, 0, 0, TAU);
        c.fill();
        break;
      }
      case "open":
        c.fillStyle = "#7A1F2B";
        c.beginPath();
        c.moveTo(x - 0.12, y - 0.03);
        c.quadraticCurveTo(x, y + 0.22, x + 0.12, y - 0.03);
        c.closePath();
        c.fill();
        c.fillStyle = "#FF8FA3";
        c.beginPath();
        c.ellipse(x, y + 0.07, 0.055, 0.03, 0, 0, TAU);
        c.fill();
        break;
      case "none":
        break;
      default:
        c.beginPath();
        c.arc(x, y - 0.05, 0.07, 0.2 * Math.PI, 0.8 * Math.PI);
        c.stroke();
    }
  }

  // ── badge and particles ─────────────────────────────────────────────────────

  drawBadge(c, t) {
    const b = this.badge;
    const s = this.v.badgeS;
    c.save();
    c.translate(1.02, -1.04);
    c.scale(s, s);
    if (b.kind === "mic") {
      const ring = (t * 1.2) % 1;
      c.strokeStyle = `rgba(239,68,68,${0.5 * (1 - ring)})`;
      c.lineWidth = 0.05;
      c.beginPath();
      c.arc(0, 0, 0.27 + ring * 0.25, 0, TAU);
      c.stroke();
    }
    c.fillStyle = b.color;
    c.beginPath();
    c.arc(0, 0, 0.27, 0, TAU);
    c.fill();
    c.lineWidth = 0.05;
    c.strokeStyle = "#fff";
    c.stroke();
    c.fillStyle = "#fff";
    c.strokeStyle = "#fff";
    c.lineCap = "round";
    c.lineJoin = "round";
    switch (b.kind) {
      case "dots":
        for (let i = 0; i < 3; i++) {
          c.beginPath();
          c.arc((i - 1) * 0.1, -0.05 * Math.max(0, Math.sin(t * 6 - i * 0.8)), 0.04, 0, TAU);
          c.fill();
        }
        break;
      case "gear":
        c.save();
        c.rotate(t * 2.5);
        for (let i = 0; i < 6; i++) {
          c.rotate(TAU / 6);
          c.fillRect(-0.03, -0.17, 0.06, 0.07);
        }
        c.beginPath();
        c.arc(0, 0, 0.11, 0, TAU);
        c.fill();
        c.fillStyle = b.color;
        c.beginPath();
        c.arc(0, 0, 0.045, 0, TAU);
        c.fill();
        c.restore();
        break;
      case "mic":
        c.beginPath();
        c.ellipse(0, -0.04, 0.055, 0.09, 0, 0, TAU);
        c.fill();
        c.lineWidth = 0.035;
        c.beginPath();
        c.arc(0, -0.02, 0.1, 0.1 * Math.PI, 0.9 * Math.PI);
        c.stroke();
        c.beginPath();
        c.moveTo(0, 0.08);
        c.lineTo(0, 0.14);
        c.stroke();
        break;
      case "bang":
        c.fillRect(-0.03, -0.16, 0.06, 0.17);
        c.beginPath();
        c.arc(0, 0.1, 0.035, 0, TAU);
        c.fill();
        break;
      case "check":
        c.lineWidth = 0.06;
        c.beginPath();
        c.moveTo(-0.1, 0);
        c.lineTo(-0.02, 0.08);
        c.lineTo(0.11, -0.08);
        c.stroke();
        break;
      case "cross":
        c.lineWidth = 0.06;
        c.beginPath();
        c.moveTo(-0.08, -0.08);
        c.lineTo(0.08, 0.08);
        c.moveTo(0.08, -0.08);
        c.lineTo(-0.08, 0.08);
        c.stroke();
        break;
    }
    c.restore();
  }

  drawParticles(c, R) {
    for (const p of this.particles) {
      if (p.age < 0) continue;
      const k = p.age / p.life;
      const a = Math.sin(k * Math.PI);
      c.save();
      c.globalAlpha = a;
      if (p.type === "z") {
        c.translate(p.x, p.y);
        c.scale(1 / R, 1 / R);
        c.fillStyle = "#8C8FD6";
        c.font = `600 ${Math.round(R * 0.36)}px system-ui, sans-serif`;
        c.fillText("z", 0, 0);
      } else if (p.type === "heart") {
        c.translate(p.x, p.y);
        c.fillStyle = "#FF5C8A";
        heartPath(c, 0.16);
        c.fill();
      } else {
        const col = p.type === "spark" ? "#34D399" : "#FFD84D";
        spark4(c, p.x, p.y, 0.16 * a + 0.04, col);
      }
      c.restore();
    }
  }
}

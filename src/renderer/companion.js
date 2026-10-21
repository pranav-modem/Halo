// The desktop character. Main tells us where the cursor is (for the eyes),
// whether it's over the body (hover), and what Halo is doing (state).
// We handle clicks, drags, the speech bubble, and dozing off when ignored.

import { Character } from "./characters/engine.js";

const api = window.halo;
const canvas = document.getElementById("stage");
const bubble = document.getElementById("bubble");
const CHAR = { x: 130, y: 180 };
const SIZES = { small: 26, medium: 32, large: 40 };
const SLEEP_AFTER_MS = 10 * 60 * 1000;

const init = await api.invoke("app:state");
const pal = new Character(canvas, { kind: init.character, R: SIZES[init.size] ?? 32, center: CHAR }).start();
let baseState = "idle"; // what main says; "sleeping" is layered on locally
let lastActivity = Date.now();
let asleep = false;

function placeBubble() {
  bubble.style.bottom = `${Math.round(window.innerHeight - (CHAR.y - pal.R * 1.55))}px`;
}
placeBubble();

function wake() {
  lastActivity = Date.now();
  if (asleep) {
    asleep = false;
    pal.setState(baseState);
    api.send("companion:asleep", false);
  }
}

setInterval(() => {
  if (!asleep && baseState === "idle" && Date.now() - lastActivity > SLEEP_AFTER_MS) {
    asleep = true;
    pal.setState("sleeping");
    api.send("companion:asleep", true);
  }
}, 5000);

// ── messages from main ────────────────────────────────────────────────────────

api.on("companion:cursor", ({ dx, dy, dist }) => {
  pal.lookAt(Math.tanh(dx / 260), Math.tanh(dy / 200));
  if (dist < 150) wake();
});
api.on("companion:hover", (over) => {
  pal.setHover(over);
  if (over) wake();
});
api.on("companion:state", (s) => {
  baseState = s;
  if (s !== "idle") wake();
  if (!asleep) pal.setState(s);
});
api.on("companion:talk", () => pal.talk());
api.on("companion:emote", (e) => { wake(); pal.emote(e); });
api.on("companion:kind", (k) => { wake(); pal.setKind(k); });
api.on("companion:size", (s) => { pal.R = SIZES[s] ?? 32; placeBubble(); });
api.on("companion:bubble", (b) => showBubble(b));
api.on("companion:dropTarget", (t) => {
  if (t) {
    showBubble({ title: "Let go to show me this window", body: t.name, timeoutMs: 0 });
    pal.emote("surprised", 0.6);
  } else hideBubble();
});
api.on("companion:hideBubble", () => hideBubble());
// Walking after the pointer: lean into the step (up to 10°).
api.on("companion:walk", (lean) => {
  if (lean) wake();
  canvas.style.transform = lean ? `rotate(${(lean * 10).toFixed(1)}deg)` : "";
});

// ── speech bubble ─────────────────────────────────────────────────────────────

let bubbleTimer = 0;
let bubbleAction = null;

function showBubble({ title = "", body = "", kind = "info", timeoutMs = 9000, action = null }) {
  wake();
  bubble.querySelector(".title").textContent = title;
  bubble.querySelector(".body").textContent = body;
  bubble.querySelector(".title").hidden = !title;
  bubble.classList.toggle("alert", kind === "alert");
  bubble.classList.toggle("good", kind === "good");
  bubble.classList.toggle("bad", kind === "bad");
  bubble.querySelector(".act").textContent = action?.tab === "today" ? "Open Today" : action?.tab === "chat" ? "Open chat" : action?.tab === "notes" ? "Open notes" : action?.url ? "Open" : "";
  fitBubble();
  bubble.classList.add("show");
  bubbleAction = action;
  clearTimeout(bubbleTimer);
  if (timeoutMs) bubbleTimer = setTimeout(hideBubble, timeoutMs);
  requestAnimationFrame(() => {
    const r = bubble.getBoundingClientRect();
    api.send("companion:bubbleRect", { x: r.left, y: r.top, w: r.width, h: r.height + 8 });
  });
}

/** The window is a fixed size: drop lines of the body until the bubble fits above the character. */
function fitBubble() {
  const room = CHAR.y - pal.R * 1.55 - 4;
  const body = bubble.querySelector(".body");
  for (let lines = 4; lines >= 1; lines--) {
    body.style.webkitLineClamp = String(lines);
    if (bubble.offsetHeight <= room) break;
  }
}

function hideBubble() {
  bubble.classList.remove("show");
  clearTimeout(bubbleTimer);
  api.send("companion:bubbleRect", null);
}

bubble.addEventListener("click", (e) => {
  if (e.target.classList.contains("close")) {
    hideBubble();
    return;
  }
  api.send("companion:bubbleClick", bubbleAction);
  hideBubble();
});

// ── pointer: click, drag, shake ───────────────────────────────────────────────

let press = null;

function overBody(e) {
  return Math.hypot(e.clientX - CHAR.x, e.clientY - CHAR.y) <= pal.R * 1.3;
}

canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || !overBody(e)) return;
  canvas.setPointerCapture(e.pointerId);
  press = { sx: e.screenX, sy: e.screenY, t: performance.now(), dragging: false, lastX: e.screenX, dir: 0, flips: [] };
  wake();
});

canvas.addEventListener("pointermove", (e) => {
  if (!press) return;
  const dx = e.screenX - press.sx;
  const dy = e.screenY - press.sy;
  if (!press.dragging && Math.hypot(dx, dy) > 3) {
    press.dragging = true;
    canvas.classList.add("dragging");
    api.send("companion:dragStart", { screenX: press.sx, screenY: press.sy });
  }
  if (press.dragging) {
    api.send("companion:dragMove", { screenX: e.screenX, screenY: e.screenY });
    // Shake detection: several fast direction changes in about a second.
    const vx = e.screenX - press.lastX;
    if (Math.abs(vx) > 6) {
      const dir = Math.sign(vx);
      if (press.dir && dir !== press.dir) {
        const now = performance.now();
        press.flips = press.flips.filter((t) => now - t < 1200);
        press.flips.push(now);
        if (press.flips.length >= 5) {
          pal.emote("dizzy", 2.2);
          press.flips = [];
        }
      }
      press.dir = dir;
    }
    press.lastX = e.screenX;
  }
});

canvas.addEventListener("pointerup", (e) => {
  if (!press) return;
  const p = press;
  press = null;
  canvas.classList.remove("dragging");
  try { canvas.releasePointerCapture(e.pointerId); } catch {}
  if (p.dragging) {
    api.send("companion:dragEnd");
    return;
  }
  pal.poke();
  // Wait a moment to tell a click (open the chat) from a double-click (rest in the island).
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = 0;
    pal.emote("happy", 0.8);
    api.send("companion:dock", true);
    return;
  }
  clickTimer = setTimeout(() => {
    clickTimer = 0;
    api.send("companion:click");
  }, 260);
});
let clickTimer = 0;

canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (overBody(e)) api.send("companion:menu");
});

// The island: Halo resting at the top centre of the screen, as a black
// extension of the notch (or a small black tab on screens without one).
// Hover widens it, click opens the chat, drag down puts Halo back on the desktop.

import { Character } from "./characters/engine.js";

const api = window.halo;
const island = document.getElementById("island");
const init = await api.invoke("island:init");

// Fit the notch: the black tab spans the notch plus an "ear" on each side.
island.style.setProperty("--h", `${init.height}px`);
// On a notched Mac the middle is hidden by the notch, so Nova sits in the left ear.
island.style.setProperty("--w", `${init.notch ? init.notchWidth + 2 * 54 : 140}px`);
island.style.setProperty("--wide", `${init.notch ? init.notchWidth + 2 * 120 : 260}px`);

const pal = new Character(document.getElementById("pal"), { kind: init.character, R: 9.5, center: { x: 17, y: 16 } }).start();

const LIGHT = { idle: "#6B7079", thinking: "#A78BFA", working: "#3B9EFF", talking: "#818CF8", listening: "#A78BFA", alert: "#F5A524", done: "#34D399", error: "#F4505E", sleeping: "#3A3D44" };
const TEXT = { idle: "Ready", thinking: "Thinking…", working: "Working…", talking: "Answering…", listening: "Taking notes", alert: "Needs you", done: "Done", error: "Problem", sleeping: "Napping" };
let state = "idle";
let badge = 0;

function paint() {
  document.getElementById("light").style.setProperty("--c", LIGHT[state] ?? LIGHT.idle);
  document.getElementById("status").textContent = badge ? `${badge} need${badge === 1 ? "s" : ""} you` : TEXT[state] ?? "";
  const b = document.getElementById("badge");
  b.hidden = !badge;
  b.textContent = String(badge);
  // Rest a little wider while something is going on.
  island.classList.toggle("wide", hover || badge > 0 || ["thinking", "working", "talking", "listening", "alert"].includes(state));
}

api.on("companion:state", (s) => { state = s; pal.setState(s); paint(); });
api.on("island:badge", (n) => { badge = n; paint(); });
api.on("companion:kind", (k) => pal.setKind(k));
api.on("companion:talk", () => pal.talk());
api.on("companion:emote", (e) => pal.emote(e));

// Hover: the window ignores the mouse except over the tab (forwarded moves tell us).
let hover = false;
let press = null; // a click or drag in progress
let carrying = false; // pulled out of the island and still being dragged
let clickTimer = 0;

function setHover(h) {
  if (h === hover || carrying) return; // keep the drag's events while Halo is carried out
  hover = h;
  api.send("island:mouse", h);
  pal.setHover(h);
  paint();
}
addEventListener("mousemove", (e) => {
  const r = island.getBoundingClientRect();
  setHover(e.clientX >= r.left - 4 && e.clientX <= r.right + 4 && e.clientY <= r.bottom + 4);
  const cx = r.left + 17;
  pal.lookAt(Math.tanh((e.clientX - cx) / 200), Math.tanh((e.clientY - 16) / 120));
});
addEventListener("mouseleave", () => setHover(false));
api.on("companion:cursor", ({ dx, dy }) => pal.lookAt(Math.tanh(dx / 260), Math.tanh(dy / 200)));

// Click opens the chat; double-click puts Halo back on the desktop. Dragging
// down pulls Halo out and keeps carrying it: drop it on a window to show it
// that window, or anywhere else to leave it on the desktop.
island.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  press = { x: e.screenX, y: e.screenY };
  island.setPointerCapture(e.pointerId);
});
island.addEventListener("pointermove", (e) => {
  if (carrying) return api.send("companion:dragMove", { screenX: e.screenX, screenY: e.screenY });
  if (!press) return;
  if (e.screenY - press.y > 22 || Math.abs(e.screenX - press.x) > 60) {
    press = null;
    carrying = true;
    api.send("island:undock", { screenX: e.screenX, screenY: e.screenY, carry: true });
  }
});
const endCarry = () => {
  if (!carrying) return false;
  carrying = false;
  api.send("island:dragEnd");
  return true;
};
island.addEventListener("pointerup", () => {
  if (endCarry() || !press) return;
  press = null;
  pal.poke();
  // Wait a moment: opening the chat right away would swallow a double-click.
  clearTimeout(clickTimer);
  clickTimer = setTimeout(() => api.send("island:click"), 260);
});
island.addEventListener("lostpointercapture", endCarry);
island.addEventListener("dblclick", () => {
  clearTimeout(clickTimer);
  api.send("island:undock", null);
});
island.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  api.send("companion:menu");
});
pal.setState(init.state ?? "idle");
state = init.state ?? "idle";
badge = init.badge ?? 0;
paint();

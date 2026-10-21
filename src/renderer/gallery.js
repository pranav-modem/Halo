import { Character } from "./characters/engine.js";
import { CHARACTERS, STATES } from "../shared/characters-meta.js";

const hero = document.getElementById("hero");
const heroBuddies = [];
for (const ch of CHARACTERS) {
  const fig = document.createElement("figure");
  const cv = document.createElement("canvas");
  fig.append(cv);
  const cap = document.createElement("figcaption");
  cap.innerHTML = `${ch.name}<small>${ch.motion}</small>`;
  fig.append(cap);
  hero.append(fig);
  heroBuddies.push({ el: cv, b: new Character(cv, { kind: ch.id, R: 36 }).start() });
}

addEventListener("mousemove", (e) => {
  for (const { el, b } of heroBuddies) {
    const r = el.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    b.lookAt(Math.tanh(dx / 260), Math.tanh(dy / 200));
    b.setHover(Math.hypot(dx, dy) < 40);
  }
});
for (const { el, b } of heroBuddies) el.addEventListener("click", () => { b.poke(); b.emote("love"); });

const grid = document.getElementById("grid");
const head = document.createElement("tr");
head.innerHTML = "<th></th>" + STATES.map((s) => `<th>${s}</th>`).join("");
grid.append(head);
for (const ch of CHARACTERS) {
  const tr = document.createElement("tr");
  tr.innerHTML = `<th class="row">${ch.name}</th>`;
  for (const s of STATES) {
    const td = document.createElement("td");
    const cv = document.createElement("canvas");
    td.append(cv);
    tr.append(td);
    const b = new Character(cv, { kind: ch.id, R: 26, fps: 30 }).start();
    // Let the idle frame settle first so one-shot effects (done hop) play.
    setTimeout(() => b.setState(s), 400);
    if (s === "talking") setInterval(() => b.talk(), 120);
    if (s === "done") setInterval(() => { b.setState("idle"); setTimeout(() => b.setState("done"), 60); }, 3000);
  }
  grid.append(tr);
}

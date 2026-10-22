// A still frame of a character on its own canvas, for icons and shareable pictures.

import { Character } from "./engine.js";

export function stillCharacter(kind, px, { R = px * 0.3, center = { x: px / 2, y: px * 0.45 } } = {}) {
  const canvas = document.createElement("canvas");
  const b = new Character(canvas, { kind, R, center });
  b.observer?.disconnect();
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
  b.particles = []; // no sparkles mid-flight in a still
  b.frame(1.2, 0);
  return canvas;
}

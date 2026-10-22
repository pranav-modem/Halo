// Small canvas helpers shared by the engine and the characters. Coordinates
// are in unit space (1 = body radius).

const TAU = Math.PI * 2;

export function spark4(c, x, y, s, color) {
  c.save();
  c.translate(x, y);
  c.fillStyle = color;
  c.beginPath();
  c.moveTo(0, -s);
  c.quadraticCurveTo(s * 0.18, -s * 0.18, s, 0);
  c.quadraticCurveTo(s * 0.18, s * 0.18, 0, s);
  c.quadraticCurveTo(-s * 0.18, s * 0.18, -s, 0);
  c.quadraticCurveTo(-s * 0.18, -s * 0.18, 0, -s);
  c.fill();
  c.restore();
}

/** The white shine at the top-left of every body. */
export function gloss(c, x, y, rx, ry, rot, alpha = 0.78) {
  c.fillStyle = `rgba(255,255,255,${alpha})`;
  c.beginPath();
  c.ellipse(x, y, rx, ry, rot, 0, TAU);
  c.fill();
  c.beginPath();
  c.arc(x + rx * 1.6, y + ry * 1.9, Math.min(rx, ry) * 0.45, 0, TAU);
  c.fill();
}

export function halo(c, rgb, alpha, r) {
  const g = c.createRadialGradient(0, 0, r * 0.3, 0, 0, r);
  g.addColorStop(0, `rgba(${rgb},${alpha})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  c.fillStyle = g;
  c.beginPath();
  c.arc(0, 0, r, 0, TAU);
  c.fill();
}

export function vgrad(c, y0, y1, stops) {
  const g = c.createLinearGradient(0, y0, 0, y1);
  stops.forEach((s, i) => g.addColorStop(i / (stops.length - 1), s));
  return g;
}

export function heartPath(c, s) {
  c.beginPath();
  c.moveTo(0, s * 0.38);
  c.bezierCurveTo(-s * 1.05, -s * 0.15, -s * 0.5, -s * 0.95, 0, -s * 0.38);
  c.bezierCurveTo(s * 0.5, -s * 0.95, s * 1.05, -s * 0.15, 0, s * 0.38);
  c.closePath();
}

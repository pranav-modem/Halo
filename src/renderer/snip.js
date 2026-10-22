const api = window.halo;
const shot = document.getElementById("shot");
const shade = document.getElementById("shade");
const box = document.getElementById("box");
const size = document.getElementById("size");

shot.src = await api.invoke("snip:image");

let start = null;

function rectFrom(e) {
  const x = Math.min(start.x, e.clientX);
  const y = Math.min(start.y, e.clientY);
  return { x, y, w: Math.abs(e.clientX - start.x), h: Math.abs(e.clientY - start.y) };
}

addEventListener("pointerdown", (e) => {
  start = { x: e.clientX, y: e.clientY };
  shade.style.display = "none";
  box.style.display = "block";
  size.style.display = "block";
  document.documentElement.setPointerCapture?.(e.pointerId);
});

addEventListener("pointermove", (e) => {
  if (!start) return;
  const r = rectFrom(e);
  Object.assign(box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  size.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
  Object.assign(size.style, { left: `${r.x}px`, top: `${Math.max(0, r.y - 22)}px` });
});

addEventListener("pointerup", (e) => {
  if (!start) return;
  const r = rectFrom(e);
  start = null;
  if (r.w < 4 || r.h < 4) {
    shade.style.display = "block";
    box.style.display = "none";
    size.style.display = "none";
    return;
  }
  api.send("snip:done", r);
});

addEventListener("keydown", (e) => {
  if (e.key === "Escape") api.send("snip:cancel");
});

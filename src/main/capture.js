// Screen capture for "ask about my screen" and region snips. Captures only
// when the user asks; Halo and the panel are hidden for the shot.

import { BrowserWindow, desktopCapturer, ipcMain, screen, shell, systemPreferences } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_EDGE = 1568; // larger images are downscaled by the model anyway

export function screenPermission() {
  if (process.platform !== "darwin") return "granted";
  return systemPreferences.getMediaAccessStatus("screen");
}

export function openScreenSettings() {
  if (process.platform === "darwin") shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
}

/** Full-resolution image of one display. */
async function grabDisplay(display) {
  const size = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) };
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
  const all = screen.getAllDisplays();
  const match = sources.find((s) => s.display_id === String(display.id)) ?? sources[all.findIndex((d) => d.id === display.id)] ?? sources[0];
  if (!match || match.thumbnail.isEmpty()) throw new Error("The screen couldn't be captured.");
  return match.thumbnail;
}

function forModel(img) {
  const { width, height } = img.getSize();
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const out = scale < 1 ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: "good" }) : img;
  return { mediaType: "image/jpeg", data: out.toJPEG(82).toString("base64"), width: out.getSize().width, height: out.getSize().height };
}

export class Capturer {
  /** @param {{ hideAll: () => Promise<void>, showAll: () => void }} hooks */
  constructor(hooks) {
    this.hooks = hooks;
    this.snipWin = null;
    ipcMain.on("snip:done", (_e, rect) => this.finishSnip(rect));
    ipcMain.on("snip:cancel", () => this.finishSnip(null));
    ipcMain.handle("snip:image", () => this.snipState?.dataUrl ?? null);
  }

  displayUnderCursor() {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }

  async captureScreen() {
    const display = this.displayUnderCursor();
    await this.hooks.hideAll();
    try {
      const img = await grabDisplay(display);
      return forModel(img);
    } finally {
      this.hooks.showAll();
    }
  }

  /**
   * One window, by the id from winlist.js (CGWindowID on macOS, HWND on
   * Windows). Falls back to cropping the screen if the window can't be
   * captured on its own.
   */
  async captureWindow(w) {
    const display = screen.getDisplayMatching({ x: Math.round(w.x), y: Math.round(w.y), width: Math.round(w.w), height: Math.round(w.h) });
    const sf = display.scaleFactor;
    try {
      const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: Math.round(w.w * sf), height: Math.round(w.h * sf) } });
      const src = sources.find((s) => s.id.startsWith(`window:${w.id}:`));
      if (src && !src.thumbnail.isEmpty()) return { ...forModel(src.thumbnail), label: w.name || w.owner };
    } catch {}
    await this.hooks.hideAll();
    try {
      const img = await grabDisplay(display);
      const k = img.getSize().width / display.bounds.width;
      const crop = img.crop({
        x: Math.max(0, Math.round((w.x - display.bounds.x) * k)),
        y: Math.max(0, Math.round((w.y - display.bounds.y) * k)),
        width: Math.round(w.w * k),
        height: Math.round(w.h * k),
      });
      return { ...forModel(crop), label: w.name || w.owner };
    } finally {
      this.hooks.showAll();
    }
  }

  /** Shows a dimmed still of the screen and lets the user drag a box. */
  async snip() {
    if (this.snipWin) return null;
    const display = this.displayUnderCursor();
    await this.hooks.hideAll();
    let img;
    try {
      img = await grabDisplay(display);
    } catch (e) {
      this.hooks.showAll();
      throw e;
    }
    const b = display.bounds;
    this.snipState = { img, display, dataUrl: img.toDataURL() };
    const win = new BrowserWindow({
      x: b.x, y: b.y, width: b.width, height: b.height,
      frame: false, show: false, resizable: false, movable: false, fullscreenable: false,
      alwaysOnTop: true, skipTaskbar: true, hasShadow: false, enableLargerThanScreen: true,
      backgroundColor: "#000000",
      webPreferences: { preload: path.join(here, "..", "preload", "preload.cjs"), contextIsolation: true, sandbox: true },
    });
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.snipWin = win;
    await win.loadFile(path.join(here, "..", "renderer", "snip.html"));
    win.setBounds(b);
    win.show();
    win.focus();
    return new Promise((resolve) => {
      this.snipResolve = resolve;
      win.on("closed", () => {
        this.snipWin = null;
        if (this.snipResolve) {
          this.snipResolve(null);
          this.snipResolve = null;
        }
      });
    });
  }

  finishSnip(rect) {
    const st = this.snipState;
    const resolve = this.snipResolve;
    this.snipResolve = null;
    this.snipWin?.close();
    this.hooks.showAll();
    if (!resolve) return;
    if (!rect || !st || rect.w < 4 || rect.h < 4) return resolve(null);
    const k = st.img.getSize().width / st.display.bounds.width;
    const crop = st.img.crop({ x: Math.round(rect.x * k), y: Math.round(rect.y * k), width: Math.round(rect.w * k), height: Math.round(rect.h * k) });
    this.snipState = null;
    resolve(forModel(crop));
  }
}

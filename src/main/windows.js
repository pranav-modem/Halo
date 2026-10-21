// Halo's windows: the companion (transparent, always on top, click-through
// except over the character), the chat panel, the room and the island.
// Click-through polls the cursor, hit-tests the body, and flips "ignore mouse
// events" only when that changes.

import { BrowserWindow, nativeTheme, screen } from "electron";
import { listWindows, windowAt } from "./winlist.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const RENDERER = path.join(here, "..", "renderer");
const PRELOAD = path.join(here, "..", "preload", "preload.cjs");
const isMac = process.platform === "darwin";

export const COMPANION_W = 260;
export const COMPANION_H = 250;
/** Character centre inside the companion window; the speech bubble sits above it. */
export const CHAR = { x: COMPANION_W / 2, y: 180 };
export const SIZES = { small: 26, medium: 32, large: 40 };
const EDGE = 24;
/** How long Halo has to hover still over a window before it lights up (first time, then after moving off one). */
const DWELL_MS = 1500;
const REARM_MS = 1000;

const webPreferences = {
  preload: PRELOAD,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  spellcheck: false,
};

const FOLLOW_GAP = 90; // px between Halo and your pointer when it catches up

export class CompanionWindow {
  constructor(store, { onDrop, onDropOnWindow, holdStill } = {}) {
    this.store = store;
    this.onDrop = onDrop;
    this.onDropOnWindow = onDropOnWindow;
    this.holdStill = holdStill ?? (() => false);
    this.walking = false;
    this.walkSaveTimer = null;
    this.animating = false;
    this.win = null;
    this.over = null;
    this.dragging = null;
    this.asleep = false;
    this.bubbleRect = null;
    this.lastCursor = { x: NaN, y: NaN };
    this.poll = null;
  }

  get R() { return SIZES[this.store.get("size")] ?? SIZES.medium; }

  create() {
    const pos = this.restorePosition();
    this.win = new BrowserWindow({
      width: COMPANION_W,
      height: COMPANION_H,
      x: pos.x,
      y: pos.y,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      show: false,
      ...(isMac ? { type: "panel" } : {}),
      webPreferences: { ...webPreferences, backgroundThrottling: false },
    });
    this.win.setAlwaysOnTop(true, isMac ? "floating" : "screen-saver");
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    this.win.setIgnoreMouseEvents(true);
    this.over = false;
    this.win.loadFile(path.join(RENDERER, "companion.html"));
    this.win.once("ready-to-show", () => this.win.showInactive());
    this.win.on("closed", () => { this.win = null; this.stopPolling(); });
    this.startPolling();
    return this.win;
  }

  send(channel, data) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, data);
  }

  // ── cursor polling: click-through + eye tracking ────────────────────────────

  startPolling() {
    this.stopPolling();
    const interval = this.asleep ? 250 : 33;
    this.poll = setInterval(() => this.tick(), interval);
  }

  stopPolling() {
    clearInterval(this.poll);
    this.poll = null;
  }

  setAsleep(asleep) {
    if (asleep === this.asleep) return;
    this.asleep = asleep;
    this.startPolling();
  }

  tick() {
    const win = this.win;
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const lx = p.x - b.x;
    const ly = p.y - b.y;

    if (this.dragging) return; // the drag keeps mouse events on

    const r = this.R * 1.25;
    let over = Math.hypot(lx - CHAR.x, ly - CHAR.y) <= r;
    const br = this.bubbleRect;
    if (!over && br) over = lx >= br.x && lx <= br.x + br.w && ly >= br.y && ly <= br.y + br.h;
    if (over !== this.over) {
      this.over = over;
      win.setIgnoreMouseEvents(!over);
      this.send("companion:hover", over);
    }

    if (p.x !== this.lastCursor.x || p.y !== this.lastCursor.y) {
      this.lastCursor = p;
      // Asleep, only wake for a cursor that comes close.
      const dist = Math.hypot(lx - CHAR.x, ly - CHAR.y);
      if (!this.asleep || dist < 150) this.send("companion:cursor", { dx: lx - CHAR.x, dy: ly - CHAR.y, dist });
    }

    this.follow(p, b);
  }

  /**
   * Follow my pointer: Halo walks after the cursor, across
   * windows and screens, and stops a little short of it. It holds still while
   * you drag it, while the chat is open next to it, and while it sleeps.
   */
  follow(p, b) {
    const stop = () => {
      if (!this.walking) return;
      this.walking = false;
      this.send("companion:walk", 0);
      clearTimeout(this.walkSaveTimer);
      this.walkSaveTimer = setTimeout(() => this.savePosition(), 800);
    };
    if (!this.store.get("followPointer") || this.asleep || this.animating || this.over || this.holdStill()) return stop();
    const cx = b.x + CHAR.x;
    const cy = b.y + CHAR.y;
    const dx = p.x - cx;
    const dy = p.y - cy;
    const d = Math.hypot(dx, dy);
    if (d <= FOLLOW_GAP) return stop();
    const step = Math.min((d - FOLLOW_GAP) * 0.08, 14);
    if (step < 0.6) return stop();
    const next = this.clamp(b.x + (dx / d) * step, b.y + (dy / d) * step);
    if (Math.abs(next.x - b.x) < 1 && Math.abs(next.y - b.y) < 1) return stop(); // pinned against an edge
    this.win.setBounds({ x: next.x, y: next.y, width: COMPANION_W, height: COMPANION_H });
    this.walking = true;
    this.send("companion:walk", Math.max(-1, Math.min(1, (next.x - b.x) / 14)));
  }

  setBubbleRect(rect) { this.bubbleRect = rect; }

  // ── drag (and drop onto a window to show it to Halo) ────────────────────────

  dragStart({ screenX, screenY }) {
    if (!this.win) return;
    const b = this.win.getBounds();
    this.dragging = { x0: b.x, y0: b.y, px: screenX, py: screenY, windows: null, armed: null, still: null };
    this.win.setIgnoreMouseEvents(false);
    this.over = true;
    // The list of windows arrives a moment later; until then the drag just moves.
    const d = this.dragging;
    listWindows().then((ws) => { if (this.dragging === d) d.windows = ws; }).catch(() => {});
    // Dragging only moves Halo. Holding still over a window for a moment
    // "arms" it: the window lights up, and letting go shows it to Halo.
    d.dwell = setInterval(() => this.checkDwell(d), 100);
  }

  dragMove({ screenX, screenY }) {
    const d = this.dragging;
    if (!d || !this.win) return;
    const x = Math.round(d.x0 + screenX - d.px);
    const y = Math.round(d.y0 + screenY - d.py);
    this.win.setBounds({ x, y, width: COMPANION_W, height: COMPANION_H });
    const p = { x: x + CHAR.x, y: y + CHAR.y };
    if (!d.still || Math.hypot(p.x - d.still.x, p.y - d.still.y) > 10) d.still = { ...p, t: Date.now() };
    if (d.armed && Math.hypot(p.x - d.armed.x, p.y - d.armed.y) > 40) this.disarm(d);
  }

  checkDwell(d) {
    if (this.dragging !== d || !d.windows || !d.still || d.armed) return;
    if (Date.now() - d.still.t < (d.disarmedOnce ? REARM_MS : DWELL_MS)) return;
    const target = windowAt(d.windows, d.still.x, d.still.y);
    if (!target) return;
    d.armed = { x: d.still.x, y: d.still.y, target };
    this.highlight(target);
    this.send("companion:dropTarget", { name: target.name || target.owner, owner: target.owner });
  }

  disarm(d) {
    d.armed = null;
    d.disarmedOnce = true;
    this.highlight(null);
    this.send("companion:dropTarget", null);
  }

  dragEnd() {
    const d = this.dragging;
    if (!d || !this.win) return;
    clearInterval(d.dwell);
    this.dragging = null;
    this.highlight(null);
    if (d.armed) {
      // Dropped on a lit-up window: show it to Halo, then fly back home.
      this.send("companion:dropTarget", null);
      this.animateTo(d.x0, d.y0);
      this.onDropOnWindow?.(d.armed.target);
      return;
    }
    const b = this.win.getBounds();
    const target = this.clamp(b.x, b.y);
    this.animateTo(target.x, target.y, () => this.savePosition());
    this.onDrop?.();
  }

  /** A purple ring over the window the companion is hovering, or none. */
  highlight(target) {
    if (!target) {
      this.hl?.hide();
      return;
    }
    if (!this.hl || this.hl.isDestroyed()) {
      this.hl = new BrowserWindow({
        frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false, resizable: false, focusable: false,
        skipTaskbar: true, alwaysOnTop: true, show: false, ...(isMac ? { type: "panel" } : {}),
        webPreferences: { sandbox: true, contextIsolation: true },
      });
      this.hl.setIgnoreMouseEvents(true);
      this.hl.setAlwaysOnTop(true, isMac ? "floating" : "screen-saver");
      this.hl.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      this.hl.loadFile(path.join(RENDERER, "highlight.html"));
    }
    this.hl.setBounds({ x: Math.round(target.x), y: Math.round(target.y), width: Math.round(target.w), height: Math.round(target.h) });
    this.hl.showInactive();
    this.win.moveTop();
  }

  /** Keeps the character (not the empty bubble area) inside the work area. */
  clamp(x, y) {
    const cx = x + CHAR.x;
    const cy = y + CHAR.y;
    const d = screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(cy) });
    const wa = d.workArea;
    const R = this.R * 1.4;
    const ncx = Math.min(Math.max(cx, wa.x + EDGE + R), wa.x + wa.width - EDGE - R);
    // The bubble needs room above the character, so the top limit uses the window top.
    const ncy = Math.min(Math.max(cy, wa.y + CHAR.y), wa.y + wa.height - EDGE - R);
    return { x: Math.round(ncx - CHAR.x), y: Math.round(ncy - CHAR.y), displayId: d.id };
  }

  animateTo(x, y, done) {
    const win = this.win;
    this.animating = true;
    const from = win.getBounds();
    const t0 = Date.now();
    const dur = 250;
    const backOut = (p) => 1 + 2.70158 * Math.pow(p - 1, 3) + 1.70158 * Math.pow(p - 1, 2);
    const step = () => {
      if (!win || win.isDestroyed()) return;
      const p = Math.min(1, (Date.now() - t0) / dur);
      const e = backOut(p);
      win.setBounds({ x: Math.round(from.x + (x - from.x) * e), y: Math.round(from.y + (y - from.y) * e), width: COMPANION_W, height: COMPANION_H });
      if (p < 1) setTimeout(step, 16);
      else {
        this.animating = false;
        done?.();
      }
    };
    step();
  }

  savePosition() {
    if (!this.win) return;
    const b = this.win.getBounds();
    const d = screen.getDisplayNearestPoint({ x: b.x + CHAR.x, y: b.y + CHAR.y });
    this.store.set("companionPos", { x: b.x, y: b.y, displayId: d.id });
  }

  restorePosition() {
    const saved = this.store.get("companionPos");
    const displays = screen.getAllDisplays();
    if (saved && displays.some((d) => d.id === saved.displayId)) {
      return this.clamp(saved.x, saved.y);
    }
    const wa = screen.getPrimaryDisplay().workArea;
    const R = this.R * 1.4;
    return {
      x: Math.round(wa.x + wa.width - EDGE - R - CHAR.x - 8),
      y: Math.round(wa.y + wa.height - EDGE - R - CHAR.y - 8),
    };
  }

  /** Screen-space centre of the character, for placing the panel next to it. */
  charScreenPoint() {
    const b = this.win?.getBounds() ?? { x: 0, y: 0 };
    return { x: b.x + CHAR.x, y: b.y + CHAR.y };
  }

  hideFor(ms) {
    if (!this.win) return Promise.resolve();
    this.win.setOpacity(0);
    return new Promise((r) => setTimeout(r, ms));
  }

  reveal() { this.win?.setOpacity(1); }
}

const ALL_SPACES = { visibleOnFullScreen: true, skipTransformProcessType: true };

/**
 * macOS: brings a window to the desktop (Space) you're on, instead of
 * switching you back to the one it was opened on.
 */
function showOnThisSpace(win) {
  if (isMac && !win.isFullScreen()) {
    win.setVisibleOnAllWorkspaces(true, { skipTransformProcessType: true });
    win.show();
    win.focus();
    setTimeout(() => { if (!win.isDestroyed()) win.setVisibleOnAllWorkspaces(false, { skipTransformProcessType: true }); }, 250);
    return;
  }
  win.show();
  win.focus();
}

export class PanelWindow {
  constructor(store) {
    this.store = store;
    this.win = null;
  }

  create() {
    this.win = new BrowserWindow({
      width: 420,
      height: 640,
      minWidth: 360,
      minHeight: 460,
      frame: false,
      show: false,
      resizable: true,
      maximizable: true,
      skipTaskbar: false,
      title: "Halo",
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#121317" : "#F3F3F6",
      fullscreenable: true,
      alwaysOnTop: !!this.store.get("panelPinned"),
      // The notetaker records from this page, so it must keep running while hidden.
      webPreferences: { ...webPreferences, backgroundThrottling: false },
    });
    this.win.loadFile(path.join(RENDERER, "panel.html"));
    // Like Halo itself, the chat follows you to every desktop (Space) and over
    // full-screen apps. Full screen gets its own Space, so it stops following there.
    if (isMac) {
      this.win.setVisibleOnAllWorkspaces(true, ALL_SPACES);
      this.win.on("enter-full-screen", () => this.win.setVisibleOnAllWorkspaces(false, { skipTransformProcessType: true }));
      this.win.on("leave-full-screen", () => this.win.setVisibleOnAllWorkspaces(true, ALL_SPACES));
    }
    this.win.on("close", (e) => {
      if (!this.quitting) {
        e.preventDefault();
        this.win.hide();
      }
    });
    return this.win;
  }

  send(channel, data) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, data);
  }

  isVisible() { return !!this.win?.isVisible(); }

  /** Shows the panel beside the companion, kept inside that screen's work area. */
  showNear(point, tab) {
    if (!this.win) this.create();
    const { width, height } = this.win.getBounds();
    const d = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) });
    const wa = d.workArea;
    const gap = 70;
    let x = point.x - width - gap;
    if (x < wa.x + 8) x = point.x + gap;
    let y = point.y - height + 60;
    x = Math.min(Math.max(x, wa.x + 8), wa.x + wa.width - width - 8);
    y = Math.min(Math.max(y, wa.y + 8), wa.y + wa.height - height - 8);
    if (!this.win.isVisible()) this.win.setBounds({ x: Math.round(x), y: Math.round(y), width, height });
    this.win.show();
    this.win.focus();
    if (tab) this.send("panel:tab", tab);
  }

  /** Shows the panel hanging under the island at the top centre of the screen. */
  showDocked(display, top) {
    if (!this.win) this.create();
    if (this.win.isFullScreen()) return this.win.show();
    const { width, height } = this.win.getBounds();
    const wa = display.workArea;
    const x = Math.round(display.bounds.x + display.bounds.width / 2 - width / 2);
    const y = Math.round(Math.max(wa.y, top) + 6);
    this.win.setBounds({ x, y, width, height: Math.min(height, wa.y + wa.height - y - 8) });
    this.win.show();
    this.win.focus();
  }

  toggleFullScreen() {
    if (!this.win) return;
    if (isMac) this.win.setFullScreen(!this.win.isFullScreen());
    else if (this.win.isMaximized()) this.win.unmaximize();
    else this.win.maximize();
  }

  hide() {
    if (this.win?.isFullScreen()) {
      this.win.once("leave-full-screen", () => this.win.hide());
      this.win.setFullScreen(false);
    } else this.win?.hide();
  }

  setPinned(pinned) {
    this.store.set("panelPinned", pinned);
    this.win?.setAlwaysOnTop(pinned, isMac ? "floating" : "normal");
  }
}

/** The big window: Home, Memory, Pieces, Skills, History, Notes, Activity, Settings. */
export class RoomWindow {
  constructor() { this.win = null; }

  open(page = "home") {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send("room:page", page);
      showOnThisSpace(this.win);
      return;
    }
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = Math.min(1200, d.width - 80);
    const height = Math.min(800, d.height - 60);
    this.win = new BrowserWindow({
      width, height, minWidth: 860, minHeight: 560,
      x: Math.round(d.x + (d.width - width) / 2), y: Math.round(d.y + (d.height - height) / 2),
      title: "Halo", backgroundColor: nativeTheme.shouldUseDarkColors ? "#171A23" : "#F6F6F8", show: false, fullscreenable: true,
      ...(isMac ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 22, y: 18 } } : { titleBarStyle: "hidden", titleBarOverlay: { color: "#08090C", symbolColor: "#A3A8B8", height: 52 } }),
      webPreferences,
    });
    this.win.loadFile(path.join(RENDERER, "room.html"), { query: { page } });
    this.win.once("ready-to-show", () => this.win.show());
    this.win.on("close", (e) => {
      if (!this.quitting) {
        e.preventDefault();
        this.win.hide();
      }
    });
  }

  send(channel, data) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, data);
  }
}

/**
 * Halo resting at the top centre of the screen: a black tab that extends the
 * notch (or a small black tab where there is none).
 */
export class IslandWindow {
  constructor(store) {
    this.store = store;
    this.win = null;
  }

  /** The display Halo docks on, its menu-bar height and whether it has a notch. */
  geometry() {
    const d = screen.getPrimaryDisplay();
    const menubar = Math.max(0, d.workArea.y - d.bounds.y);
    const notch = isMac && menubar >= 30; // notched MacBooks have a ~37 pt menu bar
    return { display: d, notch, height: notch ? menubar : 30, notchWidth: 200 };
  }

  show() {
    const g = this.geometry();
    const W = 520, H = 70;
    const b = g.display.bounds;
    const bounds = { x: Math.round(b.x + b.width / 2 - W / 2), y: b.y, width: W, height: H };
    if (!this.win || this.win.isDestroyed()) {
      this.win = new BrowserWindow({
        ...bounds, frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false, resizable: false, movable: false,
        minimizable: false, maximizable: false, fullscreenable: false, alwaysOnTop: true, skipTaskbar: true, focusable: false, show: false,
        enableLargerThanScreen: true, ...(isMac ? { type: "panel" } : {}),
        webPreferences: { ...webPreferences, backgroundThrottling: false },
      });
      this.win.setAlwaysOnTop(true, "screen-saver");
      this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      this.win.setIgnoreMouseEvents(true, { forward: true });
      this.win.loadFile(path.join(RENDERER, "island.html"));
      this.win.once("ready-to-show", () => { this.win.setBounds(bounds); this.win.showInactive(); });
    } else {
      this.win.setBounds(bounds);
      this.win.showInactive();
    }
    this.geo = g;
  }

  hide() { this.win?.hide(); }

  isVisible() { return !!this.win && !this.win.isDestroyed() && this.win.isVisible(); }

  setMouse(over) { this.win?.setIgnoreMouseEvents(!over, { forward: true }); }

  /** Screen point just under the island, where the docked panel hangs. */
  bottom() {
    const g = this.geo ?? this.geometry();
    return { display: g.display, top: g.display.bounds.y + g.height + 4 };
  }

  send(channel, data) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, data);
  }
}

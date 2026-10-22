// Renders the app icon, tray icons and character stills into assets/.
// Run with: npx electron scripts/make-icons.mjs

import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "assets");

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 1100, webPreferences: { offscreen: true, sandbox: true } });
  await win.loadFile(path.join(root, "src", "renderer", "icon-render.html"));
  for (let i = 0; i < 50; i++) {
    if (await win.webContents.executeJavaScript("window.iconsReady === true")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const files = await win.webContents.executeJavaScript("window.renderIcons()");
  for (const [name, dataUrl] of Object.entries(files)) {
    const file = path.join(out, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(dataUrl.split(",")[1], "base64"));
    console.log("wrote", path.relative(root, file));
  }
  app.quit();
});

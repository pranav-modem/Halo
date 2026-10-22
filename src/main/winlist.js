// Lists the app windows on screen, front to back, with their bounds, so Halo
// can be dropped on one to be shown that window.
// macOS: CGWindowListCopyWindowInfo through JXA. Windows: EnumWindows through
// PowerShell. No native modules.

import { screen } from "electron";
import { run } from "./env.js";

const JXA = `ObjC.import('CoreGraphics');
function run() {
  var arr = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0));
  var out = [];
  for (var i = 0; i < arr.count; i++) {
    var d = arr.objectAtIndex(i);
    if (d.objectForKey('kCGWindowLayer').js !== 0) continue;
    var b = d.objectForKey('kCGWindowBounds');
    var name = d.objectForKey('kCGWindowName');
    out.push({ id: d.objectForKey('kCGWindowNumber').js, pid: d.objectForKey('kCGWindowOwnerPID').js,
      owner: ObjC.unwrap(d.objectForKey('kCGWindowOwnerName')), name: name.isNil() ? '' : ObjC.unwrap(name),
      x: b.objectForKey('X').js, y: b.objectForKey('Y').js, w: b.objectForKey('Width').js, h: b.objectForKey('Height').js });
  }
  return JSON.stringify(out);
}`;

const PS = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public class HaloWin {
  public delegate bool Proc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(Proc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT v, int s);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  public struct RECT { public int L, T, R, B; }
  public static List<string> List() {
    var o = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      int cloaked; DwmGetWindowAttribute(h, 14, out cloaked, 4); if (cloaked != 0) return true;
      var sb = new StringBuilder(256); GetWindowText(h, sb, 256); if (sb.Length == 0) return true;
      RECT r; DwmGetWindowAttribute(h, 9, out r, 16); if (r.R - r.L < 40 || r.B - r.T < 40) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      var p = System.Diagnostics.Process.GetProcessById((int)pid);
      o.Add(h.ToInt64() + "\\t" + pid + "\\t" + p.ProcessName + "\\t" + sb.ToString().Replace("\\t"," ") + "\\t" + r.L + "\\t" + r.T + "\\t" + (r.R - r.L) + "\\t" + (r.B - r.T));
      return true;
    }, IntPtr.Zero);
    return o;
  }
}
"@
[HaloWin]::List() | ForEach-Object { $_ }
`;

/** @returns {Promise<Array<{id:number,pid:number,owner:string,name:string,x:number,y:number,w:number,h:number}>>} */
export async function listWindows() {
  if (process.platform === "darwin") {
    const r = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", JXA], { timeout: 4000 });
    if (!r.ok) return [];
    try {
      return JSON.parse(r.stdout).filter((w) => w.pid !== process.pid && w.w > 40 && w.h > 40);
    } catch {
      return [];
    }
  }
  if (process.platform === "win32") {
    const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"], { timeout: 8000, input: PS });
    if (!r.ok && !r.stdout) return [];
    return r.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [id, pid, owner, name, x, y, w, h] = line.split("\t");
        // Physical pixels → Electron's DIP coordinates.
        const dip = screen.screenToDipRect(null, { x: +x, y: +y, width: +w, height: +h });
        return { id: +id, pid: +pid, owner, name, x: dip.x, y: dip.y, w: dip.width, h: dip.height };
      })
      .filter((w) => w.pid !== process.pid);
  }
  return [];
}

/** Front-most window containing the point. */
export function windowAt(windows, x, y) {
  return windows.find((w) => x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) ?? null;
}

// Finding the user's tools. Apps launched from Finder or the Start menu don't
// get the user's shell PATH, so we ask the login shell once and add the usual
// install locations of `claude`, `gh` and `acli`.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const isWin = process.platform === "win32";
const SEP = isWin ? ";" : ":";
let userPath = process.env.PATH || "";

export async function loadUserPath() {
  const home = os.homedir();
  const extra = isWin
    ? [
        path.join(home, ".local", "bin"),
        path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "npm"),
        path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Programs", "claude"),
        "C:\\Program Files\\GitHub CLI",
        "C:\\Program Files\\Git\\cmd",
        "C:\\Program Files\\Git\\bin",
      ]
    : [path.join(home, ".local", "bin"), path.join(home, ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

  let fromShell = "";
  if (!isWin) {
    const shell = process.env.SHELL || "/bin/zsh";
    fromShell = await new Promise((resolve) => {
      execFile(shell, ["-ilc", 'printf "__HALO__%s__HALO__" "$PATH"'], { timeout: 5000 }, (err, stdout) => {
        const m = /__HALO__(.*)__HALO__/s.exec(stdout || "");
        resolve(err && !m ? "" : m ? m[1] : "");
      });
    });
  }
  const parts = [...fromShell.split(SEP), ...(process.env.PATH || "").split(SEP), ...extra].filter(Boolean);
  userPath = [...new Set(parts)].join(SEP);
  return userPath;
}

/** Environment for child processes, with the user's PATH. */
export function childEnv(extra = {}) {
  return { ...process.env, PATH: userPath, ...extra };
}

/** Absolute path of an executable on the user's PATH, or "" if not found. */
export function which(name) {
  const exts = isWin ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of userPath.split(SEP)) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return "";
}

export function run(cmd, args, { env, timeout = 30000, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { env: env ?? childEnv(), timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true, shell: isWin && /\.(cmd|bat)$/i.test(cmd) },
      (err, stdout, stderr) => resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr), error: err }),
    );
    if (input != null) {
      child.stdin.on("error", () => {}); // the command may exit before reading it all
      child.stdin.end(input);
    }
  });
}

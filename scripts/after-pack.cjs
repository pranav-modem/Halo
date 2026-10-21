// electron-builder afterPack hook: code-sign the macOS app with a stable
// identity, so macOS keeps Halo's Screen Recording and Microphone permissions
// when you install a new build. macOS ties those permissions to the app's
// designated requirement. An ad-hoc signature's requirement is its own hash,
// so every ad-hoc build looks like a new app and the permissions reset.
//
// Identity, first match wins:
//   1. $HALO_SIGN_IDENTITY: a name or SHA-1 from `security find-identity`,
//      or "-" for ad-hoc
//   2. "Developer ID Application: …"
//   3. "Apple Development: …"
//   4. "Halo Local Signing", made by scripts/make-signing-cert.sh
//   5. ad-hoc, with a warning
// CSC_IDENTITY_AUTO_DISCOVERY=false (set in CI) skips 2 to 4.
//
// electron-builder's own signing stays off (build.mac.identity is null).
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// Keep in sync with build.appId in package.json.
const IDENTIFIER = "app.halo.desktop";
const LOCAL_CERT = "Halo Local Signing";
const PREFERRED = ["Developer ID Application:", "Apple Development:", LOCAL_CERT];

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  const identity = pickIdentity();
  if (identity.hash === "-") warnAdHoc(identity.reason);
  else console.log(`  • signing        identity="${identity.name}" identifier=${IDENTIFIER}`);

  // Finder info and other extended attributes make codesign refuse to sign.
  execFileSync("xattr", ["-cr", app]);
  try {
    // Inside-out instead of --deep: each bundle is sealed after the code in it.
    for (const code of nestedCode(app)) sign(code, identity.hash);
    sign(app, identity.hash, ["--identifier", IDENTIFIER]);
  } catch (err) {
    throw new Error(
      `codesign failed with "${identity.name}". If macOS asked to use the key, ` +
        `choose Always Allow and build again. To build ad-hoc instead, set HALO_SIGN_IDENTITY=-.\n${err.message}`
    );
  }

  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  const requirement = execFileSync("codesign", ["-d", "-r-", app], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  console.log(`  • signed         ${requirement.trim().replace(/^#\s*/, "")}`);
};

function pickIdentity() {
  const forced = process.env.HALO_SIGN_IDENTITY;
  if (forced === "-") return { hash: "-", name: "ad-hoc", reason: "HALO_SIGN_IDENTITY is set to -." };
  if (forced) return { hash: forced, name: forced };
  if (process.env.CSC_IDENTITY_AUTO_DISCOVERY === "false") {
    return { hash: "-", name: "ad-hoc", reason: "Identity lookup is off (CSC_IDENTITY_AUTO_DISCOVERY=false)." };
  }

  const valid = identities(true);
  for (const prefix of PREFERRED) {
    const found = valid.find((id) => id.name.startsWith(prefix));
    if (found) return found;
  }
  const untrusted = identities(false).some((id) => id.name === LOCAL_CERT);
  return {
    hash: "-",
    name: "ad-hoc",
    reason: untrusted
      ? `"${LOCAL_CERT}" is in your keychain but isn't trusted for code signing yet.`
      : "No code-signing identity was found in your keychain.",
  };
}

// Code-signing identities from `security find-identity`: [{ hash, name }].
function identities(validOnly) {
  const args = ["find-identity", ...(validOnly ? ["-v"] : []), "-p", "codesigning"];
  let out;
  try {
    out = execFileSync("security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return [];
  }
  return [...out.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/gm)].map((m) => ({ hash: m[1], name: m[2] }));
}

function warnAdHoc(reason) {
  console.warn(
    [
      "",
      "  ⚠ Halo is ad-hoc signed. " + reason,
      "    macOS will forget Halo's Screen Recording and Microphone permissions",
      "    every time you install a new build, and call detection can't read window titles",
      "    until you allow Screen Recording again.",
      "    To keep them, run this once and rebuild:  bash scripts/make-signing-cert.sh",
      "    (An Apple Development or Developer ID certificate works too.)",
      "",
    ].join("\n")
  );
}

// Quiet on success; on failure codesign's stderr ends up in the error message.
function sign(target, identity, extra = []) {
  execFileSync("codesign", ["--force", "--sign", identity, ...extra, target], { stdio: ["ignore", "ignore", "pipe"] });
}

// Every nested bundle and Mach-O file inside the app. The walk is post-order,
// so anything inside a bundle comes before the bundle itself.
function nestedCode(app) {
  const found = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        if (/\.(app|framework)$/.test(entry.name)) found.push(p);
      } else if (entry.isFile() && !isBundleExecutable(p) && isMachO(p)) {
        found.push(p);
      }
    }
  })(app);
  return found;
}

// A bundle's main executable is signed together with its bundle:
// X.app/Contents/MacOS/X and X.framework/Versions/A/X.
function isBundleExecutable(file) {
  const name = path.basename(file);
  const dir = path.dirname(file);
  const bundle = path.basename(path.dirname(path.dirname(dir)));
  return (
    (path.basename(dir) === "MacOS" && bundle === `${name}.app`) ||
    (path.basename(path.dirname(dir)) === "Versions" && bundle === `${name}.framework`)
  );
}

function isMachO(file) {
  const buf = Buffer.alloc(8);
  const fd = fs.openSync(file, "r");
  try {
    if (fs.readSync(fd, buf, 0, 8, 0) < 8) return false;
  } finally {
    fs.closeSync(fd);
  }
  const magic = buf.readUInt32BE(0);
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) return true;
  // Universal binary. Java class files share 0xcafebabe but have a large second word.
  return (magic === 0xcafebabe || magic === 0xcafebabf) && buf.readUInt32BE(4) < 32;
}

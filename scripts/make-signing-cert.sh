#!/usr/bin/env bash
# Make a self-signed code-signing certificate, "Halo Local Signing", in your
# login keychain. scripts/after-pack.cjs signs Halo with it when you have no
# Apple Development or Developer ID certificate. The signature then stays the
# same from build to build, so macOS keeps Halo's Screen Recording and
# Microphone permissions when you install a new build.
#
# Opt-in. Run it once per Mac:  bash scripts/make-signing-cert.sh
# Safe to run again: it only adds what is missing.
set -euo pipefail

NAME="Halo Local Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if [[ "$(uname)" != Darwin ]]; then
  echo "This script is for macOS." >&2
  exit 1
fi

has_identity() { security find-identity "$@" -p codesigning "$KEYCHAIN" 2>/dev/null | grep "\"$NAME\"" >/dev/null; }

apple=$(security find-identity -v -p codesigning 2>/dev/null | grep -Eo '"(Developer ID Application|Apple Development): [^"]+"' | head -1 || true)
if [[ -n "$apple" ]] && ! has_identity; then
  echo "You already have $apple."
  echo "Halo builds are signed with it, so you don't need a local certificate. Nothing changed."
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# 1. Certificate and private key.
if has_identity; then
  echo "• \"$NAME\" is already in your login keychain."
else
  echo "• Creating \"$NAME\" (RSA 2048, valid for 10 years)…"
  cat >"$tmp/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
EOF
  # /usr/bin/openssl (LibreSSL) writes a .p12 that `security import` can read.
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$tmp/cert.cnf" \
    -keyout "$tmp/key.pem" -out "$tmp/cert.pem" 2>/dev/null
  pass="$(/usr/bin/openssl rand -hex 16)"
  /usr/bin/openssl pkcs12 -export -name "$NAME" -inkey "$tmp/key.pem" -in "$tmp/cert.pem" \
    -out "$tmp/cert.p12" -passout "pass:$pass"
  # -x: the private key can't be exported. -T: codesign may use it.
  security import "$tmp/cert.p12" -k "$KEYCHAIN" -P "$pass" -x -T /usr/bin/codesign >/dev/null
  echo "  Added to your login keychain."

  echo "• Letting codesign use the key without asking on every build."
  echo "  Type your Mac login password, or press Return to skip."
  if ! security set-key-partition-list -S apple-tool:,apple: -s -l "$NAME" "$KEYCHAIN" >/dev/null 2>&1; then
    echo "  Skipped. On your next build macOS asks once: choose Always Allow."
  fi
fi

# 2. Trust it for code signing only, so `security find-identity -v` lists it.
if has_identity -v; then
  echo "• \"$NAME\" is trusted for code signing."
else
  echo "• Trusting \"$NAME\" for code signing only. macOS asks for your password."
  security find-certificate -c "$NAME" -p "$KEYCHAIN" >"$tmp/trust.pem"
  security add-trusted-cert -r trustRoot -p codeSign "$tmp/trust.pem"
fi

if ! has_identity -v; then
  echo "\"$NAME\" still isn't a valid code-signing identity. Check it in Keychain Access." >&2
  exit 1
fi

echo
security find-identity -v -p codesigning "$KEYCHAIN" | grep "\"$NAME\""
echo
echo "Done. Build with: npm run dist:mac"
echo "Allow Screen Recording and Microphone once more after you install that build."
echo "Builds after that keep them."

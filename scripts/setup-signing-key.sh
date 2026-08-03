#!/usr/bin/env bash
#
# Create the release signing key. Run once, ever.
#
# Why this is a separate script you run by hand rather than part of the release
# flow: generating a private key is the one step that must not be repeatable by
# accident. A second key would produce releases signed with something other than
# the fingerprint already published — which is worse than no signature at all,
# because it looks exactly like the compromise a signature exists to reveal.
#
# Everything after this is automatic. `npm run release:sign` signs, verifies and
# publishes; `npm run check:signing` fails the build if a published release is
# missing its signature. Neither needs you.
#
# Storage follows the pattern the Android signing key already uses: key material
# in ~/.aevistle, outside the repository, passphrase in a properties file beside
# it. There is no reason for this project to have two models for the same thing.
#
# Nothing written here is reachable by git — this directory is not in the
# working tree. `.gitignore` also lists these names, which is belt and braces
# for the case where somebody copies a key into the repository by hand.
#
# The uid uses the GitHub noreply address deliberately. A GPG uid is published
# to everyone who ever verifies a download, and the real address is a stated
# privacy red line for this repository.
set -euo pipefail

HOME_DIR="$HOME/.aevistle"
PROPS="$HOME_DIR/gpg.properties"
NAME="Aevistle Release Signing"
EMAIL="199806313+Fusheng201@users.noreply.github.com"

mkdir -p "$HOME_DIR"

if [ -f "$PROPS" ]; then
  echo "A signing key already exists:"
  grep '^fingerprint=' "$PROPS"
  echo
  echo "Refusing to generate a second one. If you genuinely need to replace it,"
  echo "delete $PROPS and re-run — and remember that every release signed with"
  echo "the old key becomes unverifiable against the new fingerprint."
  exit 0
fi

command -v gpg >/dev/null 2>&1 || {
  echo "gpg is not installed. On Windows it ships with Git for Windows;"
  echo "on Debian/Ubuntu: sudo apt install gnupg"
  exit 1
}

echo "Generating a 4096-bit RSA signing key. This takes a minute or two."

PASS="$(head -c 32 /dev/urandom | base64 | tr -d '\n=')"
PARAMS="$(mktemp)"
trap 'rm -f "$PARAMS"' EXIT

cat > "$PARAMS" <<PARAMSEOF
%echo Generating Aevistle release signing key
Key-Type: RSA
Key-Length: 4096
Key-Usage: sign
Name-Real: $NAME
Name-Email: $EMAIL
Expire-Date: 5y
Passphrase: $PASS
%commit
PARAMSEOF

gpg --batch --gen-key "$PARAMS"

FPR="$(gpg --list-keys --with-colons "$EMAIL" | awk -F: '/^fpr:/ {print $10; exit}')"
[ -n "$FPR" ] || { echo "Could not read the fingerprint back — key generation failed."; exit 1; }

umask 077
cat > "$PROPS" <<PROPSEOF
# Aevistle release signing key.
#
# Never commit this file. It lives here rather than in the repository for the
# same reason aevistle-release.jks does — this directory is outside the working
# tree, so git cannot see it at all.
fingerprint=$FPR
passphrase=$PASS
uid=$NAME <$EMAIL>
PROPSEOF

# An armoured backup of the secret key, so losing the GnuPG home does not mean
# losing the ability to sign — the same reason the .jks lives here rather than
# only inside a build tool's cache.
gpg --batch --yes --pinentry-mode loopback --passphrase "$PASS" \
    --export-secret-keys --armor "$FPR" > "$HOME_DIR/aevistle-signing-key.asc"
gpg --armor --export "$FPR" > "$HOME_DIR/aevistle-public-key.asc"

echo
echo "Done. Fingerprint:"
echo "  $FPR"
echo
echo "Written to $HOME_DIR:"
echo "  gpg.properties            fingerprint + passphrase"
echo "  aevistle-signing-key.asc  encrypted backup of the private key"
echo "  aevistle-public-key.asc   the public half, published with each release"
echo
echo "Nothing else needs doing. The next release signs itself."

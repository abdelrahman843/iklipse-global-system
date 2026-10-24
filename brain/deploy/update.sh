#!/usr/bin/env bash
# Updates the iklipse brain to a commit of main, as root (the path unit runs
# it when the brain writes deploy/request.json, only after the owner's OK):
# a new release built and tested next to the one running, switched to,
# restarted, health-checked; if it isn't healthy in 60 seconds, back to the
# one before. What came of it is left in deploy/result.json, which the brain
# reads (and tells) when it starts.
#
# Only a commit on origin/main is ever deployed (merged: a PR, its checks and
# the owner's OK to merge), whatever the request says.

set -euo pipefail

APP=/srv/iklipse-brain/app
DEPLOY=/var/lib/iklipse-brain/deploy
REQ="$DEPLOY/request.json"
SECRETS=/etc/iklipse-brain/brain.env
REPO="${GITHUB_REPO:-abdelrahman843/iklipse-global-system}"

[ -s "$REQ" ] || exit 0
SHA=$(sed -n 's/.*"sha":"\([0-9a-f]\{40\}\)".*/\1/p' "$REQ")
APPROVAL=$(sed -n 's/.*"approval_id":"\([0-9a-f-]\{36\}\)".*/\1/p' "$REQ")
rm -f "$REQ"

result() {
  printf '{"approval_id":"%s","ok":%s,"message":"%s"}\n' "$APPROVAL" "$1" "$2" > "$DEPLOY/result.json"
  chown brain:brain "$DEPLOY/result.json"
}

if [ -z "$SHA" ] || [ -z "$APPROVAL" ]; then
  echo "update: not a valid request" >&2
  exit 1
fi

# The token only in this script's git calls (a header for github.com), never on the command line.
TOKEN=$(sed -n 's/^GITHUB_TOKEN=["'"'"']\{0,1\}\([^"'"'"']*\)["'"'"']\{0,1\}$/\1/p' "$SECRETS")
AUTH=$(printf 'x-access-token:%s' "$TOKEN" | base64 -w0)
export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="http.https://github.com/.extraheader" GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $AUTH"

mkdir -p "$APP/releases"
if [ ! -d "$APP/repo" ]; then git clone --quiet --bare "https://github.com/$REPO.git" "$APP/repo"; fi
git -C "$APP/repo" fetch --quiet origin '+refs/heads/main:refs/remotes/origin/main'
if ! git -C "$APP/repo" merge-base --is-ancestor "$SHA" origin/main; then
  result false "${SHA:0:7} isn't on main, so nothing changed."
  systemctl restart iklipse-brain
  exit 1
fi

NEW="$APP/releases/$SHA"
OLD=$(readlink -f "$APP/current" || true)
if [ ! -d "$NEW/brain/dist" ]; then
  rm -rf "$NEW"
  mkdir -p "$NEW"
  git -C "$APP/repo" archive "$SHA" brain | tar -x -C "$NEW"
  if ! (cd "$NEW/brain" && npm ci --ignore-scripts --no-audit --no-fund && npm run build && npm test && npm prune --omit=dev --ignore-scripts); then
    rm -rf "$NEW"
    result false "${SHA:0:7} didn't build or its tests failed, so nothing changed."
    systemctl restart iklipse-brain
    exit 1
  fi
fi

ln -sfn "$NEW" "$APP/current.new" && mv -T "$APP/current.new" "$APP/current"
echo "$SHA" > "$DEPLOY/current"
# Read (and told) by the new release as it starts; if it doesn't come up, replaced below before the old one starts.
result true "The brain runs ${SHA:0:7} now."
systemctl restart iklipse-brain

for _ in $(seq 1 30); do
  sleep 2
  if curl -fsS http://127.0.0.1:8787/health > /dev/null; then exit 0; fi
done

# Not healthy: back to the one before.
if [ -n "$OLD" ] && [ -d "$OLD" ]; then
  ln -sfn "$OLD" "$APP/current.new" && mv -T "$APP/current.new" "$APP/current"
  basename "$OLD" > "$DEPLOY/current"
fi
result false "${SHA:0:7} didn't come up healthy, so it went back to ${OLD##*/}."
systemctl restart iklipse-brain
exit 1

#!/usr/bin/env bash
# Deploys the app to the server over SSH. Used by .github/workflows/deploy.yml; safe to run by hand.
# Dependencies are installed here (they're pure JavaScript) and uploaded, so the server needs no npm.
# See DEPLOY.md.
#
# Required env: DEPLOY_HOST, DEPLOY_USER, DEPLOY_PATH (app directory on the server), DEPLOY_URL (public https URL)
# Optional env: DEPLOY_KEY (path to an ssh private key)
set -euo pipefail

: "${DEPLOY_HOST:?set DEPLOY_HOST}" "${DEPLOY_USER:?set DEPLOY_USER}" "${DEPLOY_PATH:?set DEPLOY_PATH}" "${DEPLOY_URL:?set DEPLOY_URL}"
SSH_OPTS=(-o BatchMode=yes -o IdentitiesOnly=yes)
[ -n "${DEPLOY_KEY:-}" ] && SSH_OPTS+=(-i "$DEPLOY_KEY")
SSH="ssh ${SSH_OPTS[*]}"
TARGET="$DEPLOY_USER@$DEPLOY_HOST"

npm ci --omit=dev --silent

# --omit-dir-times / no -p: the deploy user can't set owners or times on files the site user owns.
# .env (secrets) and data/ (search cache) live on the server and are never touched.
echo "==> Uploading"
rsync -rl --omit-dir-times --delete -e "$SSH" \
  --exclude '.env' --exclude 'data/' --exclude 'RELEASE' \
  server public package.json package-lock.json node_modules "$TARGET:$DEPLOY_PATH/"

echo "==> Restarting"
# A systemd path unit (karaoke4phun-restart.path) restarts the app when RELEASE changes.
$SSH "$TARGET" "date -u +%FT%TZ > $DEPLOY_PATH/RELEASE.new && mv -f $DEPLOY_PATH/RELEASE.new $DEPLOY_PATH/RELEASE"

echo "==> Verifying"
code=000
for i in 1 2 3 4 5 6; do
  sleep 3
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$DEPLOY_URL/api/config" || true)
  [ "$code" = "200" ] && { echo "App is up (HTTP 200)."; exit 0; }
done
echo "App did not come back (last HTTP $code)" >&2
exit 1

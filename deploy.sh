#!/bin/bash
# Runs on the VPS. The GitHub Actions deploy key is locked to this script in
# authorized_keys (command="..."), so CI can run this and nothing else.
set -euo pipefail

# All in one function, so bash has read the whole file before the reset can change it.
main() {
  source ~/.nvm/nvm.sh
  cd ~/github/semantic-cms

  # Preserve the live, AI-generated theme (untracked) across the reset.
  [ -f public/site/site.css ] && cp public/site/site.css /tmp/scms-site.css.bak || true

  PREVIOUS=$(git rev-parse HEAD)
  git fetch origin main
  git reset --hard origin/main

  # Restore the live theme if the reset removed it (first transition only).
  if [ ! -f public/site/site.css ] && [ -f /tmp/scms-site.css.bak ]; then
    cp /tmp/scms-site.css.bak public/site/site.css
  fi

  # Reinstall dependencies only when the package files changed: the native
  # modules (better-sqlite3, sharp) are slow to rebuild.
  if [ ! -d node_modules ] || ! git diff --quiet "$PREVIOUS" HEAD -- package.json package-lock.json; then
    npm ci
  fi

  pm2 restart semantic-cms --update-env
  pm2 save
  echo "Deploy complete: $(git rev-parse --short HEAD)"
}
main "$@"

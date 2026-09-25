#!/usr/bin/env bash
# Pin the printshop-discord-bot commit this app installs. The bot lives in
# its own public repo (github.com/imeckler/printshop-discord-bot) so the
# Discord server's admins can review it; this app depends on it as a git
# URL pinned to a commit, so what runs in production is always a specific,
# reviewable commit. Push the bot repo first, then run this and commit the
# package.json / package-lock.json change.
#
# npm saves the dependency as "github:...#sha" and records a git+ssh URL in
# the lockfile regardless of the spec given here; the Dockerfile rewrites
# that to https with a git insteadOf rule, since the repo is public.
#
#   scripts/bump-discord-bot.sh [ref]     # default: main
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
ref="${1:-main}"
repo="imeckler/printshop-discord-bot"

sha="$(gh api "repos/$repo/commits/$ref" --jq .sha)"
spec="git+https://github.com/$repo.git#$sha"
old="$(node -p "require('$here/package.json').dependencies['printshop-discord-bot'] || ''")"
case "$old" in
  *"#$sha") echo "printshop-discord-bot already pinned at $sha"; exit 0 ;;
esac
cd "$here"
npm install --no-audit --no-fund "printshop-discord-bot@$spec"
echo "printshop-discord-bot: ${old:-<none>} -> $sha ($ref)"

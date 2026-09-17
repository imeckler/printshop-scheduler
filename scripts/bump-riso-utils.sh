#!/usr/bin/env bash
# Pin the riso-utils commit that the Docker build compiles (RISO_UTILS_REV in
# the Dockerfile). The build clones github.com/imeckler/riso-utils directly, so
# push riso-utils first, then run this and commit the Dockerfile change.
#
#   scripts/bump-riso-utils.sh [ref]     # default: main
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
ref="${1:-main}"
repo="imeckler/riso-utils"

sha="$(gh api "repos/$repo/commits/$ref" --jq .sha)"
old="$(sed -nE 's/^ARG RISO_UTILS_REV=(.*)$/\1/p' "$here/Dockerfile")"
if [ -z "$old" ]; then
  echo "ARG RISO_UTILS_REV not found in Dockerfile" >&2
  exit 1
fi
if [ "$old" = "$sha" ]; then
  echo "riso-utils already pinned at $sha"
  exit 0
fi
perl -pi -e "s/^ARG RISO_UTILS_REV=.*/ARG RISO_UTILS_REV=$sha/" "$here/Dockerfile"
echo "riso-utils: $old -> $sha ($ref)"

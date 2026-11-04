#!/usr/bin/env bash
# Publishes a result of ./run.sh --json on GitHub Pages, called by the workflow benchmark.yml:
#   bench/publish.sh BRANCH RESULT.json
# The branch gh-pages keeps the latest JSON of every benchmarked branch in benchmark-data/ and the page index.html
# that bench/pages.mjs renders from all of them. Needs GITHUB_TOKEN and GITHUB_REPOSITORY, as in GitHub Actions.
set -euo pipefail
branch=$1
result=$(realpath "$2")
bench=$(cd "$(dirname "$0")" && pwd)
site=$(mktemp -d)
trap 'rm -rf "$site"' EXIT

cd "$site"
git init -q
git remote add origin "https://x-access-token:$GITHUB_TOKEN@github.com/$GITHUB_REPOSITORY.git"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
# Other branches may publish at the same time: if the push is rejected, retry on their version.
for attempt in 1 2 3 4 5; do
  if git fetch -q --depth=1 origin gh-pages 2>/dev/null; then
    git checkout -q -B gh-pages FETCH_HEAD
  else
    git checkout -q --orphan gh-pages # first run: the branch doesn't exist yet
  fi
  mkdir -p benchmark-data
  cp "$result" "benchmark-data/${branch//\//-}.json"
  touch .nojekyll # serve the files as they are
  node "$bench/pages.mjs" benchmark-data/*.json > index.html
  git add -A
  git diff --cached --quiet || git commit -q -m "Benchmark $branch at ${GITHUB_SHA::7}"
  git push -q origin gh-pages && exit 0
  sleep $((attempt * 5))
done
exit 1

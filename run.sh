#!/usr/bin/env bash
# Benchmarks the service-atlas implementations on different branches of this repository, see README.md.
#   ./run.sh [--runs N] [--startup-runs N] [--phases LIST] [REF...] > results.md
# Needs only bash, git and Docker: everything else runs in a tools container that drives Docker via its socket.
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash on Windows must not rewrite the container paths

cd "$(dirname "$0")"
# The common git dir also works in worktrees. Git Bash needs the Windows form of the path.
git_dir=$(cd "$(git rev-parse --git-common-dir)" && { pwd -W 2>/dev/null || pwd; })

cleanup() {
  docker rm -f service-atlas-bench sa-bench-app sa-bench-probe sa-bench-mock sa-bench-size >/dev/null 2>&1 || true
  docker network rm sa-bench >/dev/null 2>&1 || true
  docker volume rm sa-bench-certs >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build -q -t service-atlas-bench . >/dev/null
docker run --rm --name service-atlas-bench \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$git_dir:/repo.git:ro" \
  -v sa-bench-certs:/certs \
  service-atlas-bench "$@"

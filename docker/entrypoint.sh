#!/usr/bin/env bash
# Dispatch entrypoint: one image, three roles.
#   (default)                       -> web dashboard + REST + SSE + GitHub webhook
#   worker [--once]                 -> drain the job queue (scale horizontally)
#   new|resume|status|list|doctor|estimate|sprint|fix|serve  -> factory CLI
#   <anything else>                 -> exec it verbatim (e.g. `bash`)
set -euo pipefail

DATA_DIR="${FACTORY_DATA_DIR:-/var/lib/factory/.factory}"
WORK_DIR="${FACTORY_WORKSPACES_DIR:-/var/lib/factory/workspaces}"
mkdir -p "$DATA_DIR" "$WORK_DIR" 2>/dev/null || true

# --- Auth preflight: warn loudly if neither a token nor a mounted gh login exists.
gh_cfg="${GH_CONFIG_DIR:-${HOME:-/root}/.config/gh}"
if [ -z "${GITHUB_TOKEN:-}" ] && [ -z "${GH_TOKEN:-}" ] && [ ! -f "${gh_cfg}/hosts.yml" ]; then
  echo "WARN: no GitHub/Copilot auth detected." >&2
  echo "      Provide ONE of:" >&2
  echo "        - GITHUB_TOKEN with the 'copilot' scope (e.g. from: gh auth refresh --scopes copilot)" >&2
  echo "        - a mounted gh login dir at ${gh_cfg} (-v \$HOME/.config/gh:${gh_cfg}:ro)" >&2
  echo "      Copilot model calls (and any GitHub push) will fail without it." >&2
fi

# --- Docker daemon reachability (the factory drives verify/deploy/ZAP via Docker).
if ! docker info >/dev/null 2>&1; then
  echo "WARN: no reachable Docker daemon. Mount the host socket" >&2
  echo "      (-v /var/run/docker.sock:/var/run/docker.sock) or set DOCKER_HOST to a dind sidecar." >&2
  echo "      The verify/delivery stages and Trivy/ZAP scans need it." >&2
fi

CLI=/app/packages/cli/dist/index.js
WEB=/app/packages/web/dist/server.js

cmd="${1:-serve}"
case "$cmd" in
  serve)
    exec node "$WEB"
    ;;
  worker)
    shift
    exec node "$CLI" worker "$@"
    ;;
  new|resume|status|list|doctor|estimate|sprint|fix)
    exec node "$CLI" "$@"
    ;;
  factory)
    shift
    exec node "$CLI" "$@"
    ;;
  *)
    exec "$@"
    ;;
esac

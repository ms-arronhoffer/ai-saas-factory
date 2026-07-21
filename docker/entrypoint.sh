#!/usr/bin/env bash
# Dispatch entrypoint: one image, several roles.
#   (default)                       -> web dashboard + REST + SSE + GitHub webhook
#   login                           -> HTTPS device-flow GitHub/Copilot login (persist to gh volume)
#   worker [--once]                 -> drain the job queue (scale horizontally)
#   new|resume|status|list|doctor|estimate|sprint|fix|serve  -> factory CLI
#   <anything else>                 -> exec it verbatim (e.g. `bash`)
set -euo pipefail

DATA_DIR="${FACTORY_DATA_DIR:-/var/lib/factory/.factory}"
WORK_DIR="${FACTORY_WORKSPACES_DIR:-/var/lib/factory/workspaces}"
mkdir -p "$DATA_DIR" "$WORK_DIR" 2>/dev/null || true

gh_cfg="${GH_CONFIG_DIR:-${HOME:-/root}/.config/gh}"

# --- `login`: authenticate over HTTPS *inside* the container via GitHub's device
# flow, requesting the 'copilot' scope, and persist the token to the gh config
# volume. Use this when the host's `gh` login can't be reused (e.g. Windows/macOS
# store gh creds in the OS keyring, so mounting ~/.config/gh carries no token).
#   docker compose run --rm factory login
if [ "${1:-}" = "login" ]; then
  shift
  echo "GitHub device-flow login over HTTPS (requesting the 'copilot' scope)…" >&2
  echo "Open the printed URL, enter the one-time code, and approve access." >&2
  gh auth login --hostname github.com --git-protocol https --web --scopes "copilot" "$@"
  echo "--- gh auth status ---" >&2
  gh auth status || true
  echo "Token persisted to ${gh_cfg}. Start the server with:  docker compose up -d" >&2
  exit 0
fi

# --- Bridge a container-side `gh` login into the token the SDK actually uses.
# If no token env is set but `gh` is logged in (via the `login` command above,
# persisted on the gh-config volume), mint GITHUB_TOKEN from it for this process.
if [ -z "${GITHUB_TOKEN:-}" ] && [ -z "${GH_TOKEN:-}" ]; then
  if tok="$(gh auth token 2>/dev/null)" && [ -n "$tok" ]; then
    export GITHUB_TOKEN="$tok"
    echo "auth: using token from the container's gh login (scopes via gh auth status)." >&2
  fi
fi

# --- Auth preflight: warn loudly if we still have no usable credential.
if [ -z "${GITHUB_TOKEN:-}" ] && [ -z "${GH_TOKEN:-}" ]; then
  echo "WARN: no GitHub/Copilot auth detected. Fix it one of these ways:" >&2
  echo "        - run:  docker compose run --rm factory login   (HTTPS device-flow login → gh volume)" >&2
  echo "        - or set GITHUB_TOKEN with the 'copilot' scope, e.g. on the host:" >&2
  echo "            PowerShell:  \$env:GITHUB_TOKEN = (gh auth token); docker compose up -d" >&2
  echo "            bash:        GITHUB_TOKEN=\$(gh auth token) docker compose up -d" >&2
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

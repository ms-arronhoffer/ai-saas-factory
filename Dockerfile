# syntax=docker/dockerfile:1
#
# AI SaaS Factory — self-contained image that runs the factory as a standalone
# server (web dashboard + REST + webhook + queue worker) OR as a one-shot CLI.
#
# It bakes in EVERY security scanner the pipeline uses so nothing is skipped:
#   pip:  semgrep, bandit, pip-audit, checkov     go-binaries: gitleaks, trivy, syft
#   node: npm-audit (built in)                    docker:      ZAP DAST (pulled at run time)
#
# The factory itself drives Docker (verify/deploy/ZAP), so the container needs a
# Docker daemon — provide one via the mounted host socket (see docker-compose.yml)
# or a dind sidecar. This image ships only the Docker *client*, not a daemon.

########################  build stage  ########################
FROM node:26-bookworm-slim AS build
WORKDIR /app

# Install deps first (better layer caching), then compile the TypeScript monorepo.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/web/package.json packages/web/package.json
RUN npm ci

COPY . .
RUN npx tsc -b --force

########################  runtime stage  ######################
FROM node:26-bookworm-slim AS runtime
ENV DEBIAN_FRONTEND=noninteractive

# --- OS packages + CLIs: git, Docker client + compose, GitHub CLI, Python venv ---
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg git jq python3 python3-venv python3-pip tar; \
    install -m 0755 -d /etc/apt/keyrings; \
    # Docker apt repo (CLI + compose plugin only — no daemon)
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc; \
    chmod a+r /etc/apt/keyrings/docker.asc; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
        > /etc/apt/sources.list.d/docker.list; \
    # GitHub CLI apt repo
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg; \
    chmod a+r /etc/apt/keyrings/githubcli.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin gh; \
    rm -rf /var/lib/apt/lists/*

# --- Python-based scanners in an isolated venv, put on PATH (latest at build time) ---
ENV SCANNER_VENV=/opt/scanners
RUN python3 -m venv "$SCANNER_VENV" \
 && "$SCANNER_VENV/bin/pip" install --no-cache-dir --upgrade pip \
 && "$SCANNER_VENV/bin/pip" install --no-cache-dir semgrep bandit pip-audit checkov
ENV PATH="/opt/scanners/bin:${PATH}"

# --- Go-binary scanners → /usr/local/bin (official installers fetch latest) ---
RUN set -eux; \
    curl -sSfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin; \
    curl -sSfL https://raw.githubusercontent.com/anchore/syft/main/install.sh          | sh -s -- -b /usr/local/bin; \
    # gitleaks has no install script — fetch the latest release asset for this arch
    arch="$(dpkg --print-architecture)"; case "$arch" in amd64) gl=x64 ;; arm64) gl=arm64 ;; *) gl="$arch" ;; esac; \
    ver="$(curl -sSfL https://api.github.com/repos/gitleaks/gitleaks/releases/latest | jq -r .tag_name | sed 's/^v//')"; \
    curl -sSfL "https://github.com/gitleaks/gitleaks/releases/download/v${ver}/gitleaks_${ver}_linux_${gl}.tar.gz" \
        | tar -xz -C /usr/local/bin gitleaks; \
    gitleaks version; trivy --version; syft version

# --- Copilot CLI up front so the SDK never blocks on a first-run download ---
RUN npm install -g @github/copilot || echo "copilot CLI global install skipped; SDK will provide it"

WORKDIR /app
# Built app + prod-resolvable node_modules (hoisted at the monorepo root).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/config ./config
COPY --from=build /app/templates ./templates
COPY --from=build /app/package.json ./package.json
COPY docker/entrypoint.sh /usr/local/bin/factory-entrypoint
RUN sed -i 's/\r$//' /usr/local/bin/factory-entrypoint && chmod +x /usr/local/bin/factory-entrypoint

# Server binds all interfaces; state + generated apps live under /var/lib/factory
# (mount the SAME host path so the Docker daemon can read each build context).
ENV NODE_ENV=production \
    FACTORY_WEB_HOST=0.0.0.0 \
    FACTORY_WEB_PORT=7788 \
    FACTORY_DATA_DIR=/var/lib/factory/.factory \
    FACTORY_WORKSPACES_DIR=/var/lib/factory/workspaces
VOLUME ["/var/lib/factory"]
EXPOSE 7788

ENTRYPOINT ["factory-entrypoint"]
CMD ["serve"]

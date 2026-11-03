# Pin the base image to the same Bun version as packageManager in package.json.
# (`latest` would silently change the runtime under us between builds.)
ARG BUN_IMAGE=oven/bun:1.4.2

# ---------------------------------------------------------------------------
# vault: fetch the HashiCorp vault CLI. gpg/wget/lsb-release are only needed
# to add the HashiCorp apt repo, so they stay in this stage; the final image
# only receives the (static) vault binary.
# ---------------------------------------------------------------------------
FROM ${BUN_IMAGE} AS vault
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates gpg wget lsb-release && \
    wget -O- https://apt.releases.hashicorp.com/gpg | gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" > /etc/apt/sources.list.d/hashicorp.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends vault && \
    /usr/bin/vault version

# ---------------------------------------------------------------------------
# typecheck: full install (incl. devDependencies) and `tsc --noEmit`. The
# container runs raw TS, so this is the only type gate before production.
# The final stage COPYs a marker from here so BuildKit cannot skip it.
# ---------------------------------------------------------------------------
FROM ${BUN_IMAGE} AS typecheck
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src/ src/
RUN bun run typecheck && touch /typecheck.ok

# ---------------------------------------------------------------------------
# prod-deps: production-only node_modules (lockfile must still match).
# --omit=peer: Bun auto-installs peers, which drags `typescript` in via the
# @solana/codecs-* peerDependencies; no runtime code imports it (or the other
# omitted peer, fastestsmallesttextencoderdecoder).
# ---------------------------------------------------------------------------
FROM ${BUN_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile --omit=peer

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM ${BUN_IMAGE}
WORKDIR /app

# jq is needed at runtime by vault-entrypoint.sh.
RUN apt-get update && \
    apt-get install -y --no-install-recommends jq && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

COPY --from=vault /usr/bin/vault /usr/bin/vault

COPY vault-entrypoint.sh /usr/local/bin/vault-entrypoint.sh
RUN chmod +x /usr/local/bin/vault-entrypoint.sh

COPY --from=prod-deps /app/node_modules node_modules
COPY package.json bun.lock tsconfig.json ./

# Depend on the typecheck stage: the build fails if types don't check.
COPY --from=typecheck /typecheck.ok /tmp/typecheck.ok

COPY src/ src/

# Run as the unprivileged user the bun image ships with.
USER bun

EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/vault-entrypoint.sh"]
CMD ["bun", "src/main.ts"]

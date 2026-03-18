FROM oven/bun:latest
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Install vault CLI and jq
RUN apt-get update && \
    apt-get install -y gpg wget lsb-release jq && \
    wget -O- https://apt.releases.hashicorp.com/gpg | gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" > /etc/apt/sources.list.d/hashicorp.list && \
    apt-get update && \
    apt-get install -y vault && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

COPY vault-entrypoint.sh /usr/local/bin/vault-entrypoint.sh
RUN chmod +x /usr/local/bin/vault-entrypoint.sh

COPY src/ src/
COPY tsconfig.json ./

EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/vault-entrypoint.sh"]
CMD ["bun", "src/main.ts"]

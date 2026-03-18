#!/bin/sh
set -e

# Require Vault env vars
if [ -z "$VAULT_ADDR" ] || [ -z "$VAULT_ROLE_ID" ] || [ -z "$VAULT_SECRET_ID" ]; then
  echo "[vault-entrypoint] Missing VAULT_ADDR, VAULT_ROLE_ID, or VAULT_SECRET_ID"
  exit 1
fi

VAULT_ENV="${VAULT_ENV:-prod}"

# Authenticate via AppRole
echo "[vault-entrypoint] Authenticating to Vault..."
VAULT_TOKEN=$(vault write -field=token auth/approle/login \
  role_id="$VAULT_ROLE_ID" \
  secret_id="$VAULT_SECRET_ID") || {
  echo "[vault-entrypoint] Failed to authenticate to Vault"
  exit 1
}
export VAULT_TOKEN

# Fetch secrets from all paths and export as env vars
VAULT_PATHS="${VAULT_PATHS:-$VAULT_ENV/app}"
for path in $(echo "$VAULT_PATHS" | tr ',' ' '); do
  echo "[vault-entrypoint] Fetching secrets from secret/$path"
  secrets=$(vault kv get -format=json "secret/$path") || {
    echo "[vault-entrypoint] Failed to fetch secrets from secret/$path"
    exit 1
  }
  # Export each key-value pair safely without eval
  for key in $(echo "$secrets" | jq -r '.data.data | keys[]'); do
    value=$(echo "$secrets" | jq -r --arg k "$key" '.data.data[$k]')
    export "$key=$value"
  done
done

# Clean up Vault creds from env
unset VAULT_TOKEN VAULT_ADDR VAULT_ROLE_ID VAULT_SECRET_ID VAULT_ENV VAULT_PATHS

# Run the actual command
echo "[vault-entrypoint] Starting application..."
exec "$@"

import { Connection } from '@solana/web3.js';
import { config } from '../config.js';

/**
 * Solana RPC connection whose every HTTP request is aborted after
 * `config.solana.rpcTimeoutMs`. web3.js applies no timeout by default, so a
 * single hung RPC call would otherwise stall a shared refresh (and every
 * request waiting on it) until the server's own request timeout.
 */
export function createSolanaConnection(): Connection {
  return new Connection(config.solana.rpcUrl, {
    commitment: 'confirmed',
    fetch: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      fetch(input, { ...init, signal: AbortSignal.timeout(config.solana.rpcTimeoutMs) })) as typeof fetch,
  });
}

import { TokenAccountNotFoundError, TokenInvalidAccountOwnerError } from '@solana/spl-token';

/**
 * True ONLY when an SPL token account is genuinely absent on-chain — i.e. a 0
 * balance is the correct answer. Every other error from getAccount (RPC error,
 * timeout, rate limit, transport failure) is an INFRASTRUCTURE failure and must
 * propagate: a financial endpoint must never read an outage as a 0 balance
 * (which would, for circulating-supply math, undercount locked tokens and
 * OVERSTATE circulating supply / market cap).
 *
 * Usage:
 *   try { const acct = await getAccount(conn, ata); ... }
 *   catch (e) { if (!isTokenAccountAbsent(e)) throw e;  // RPC failure → propagate
 *               amount = new BN(0);  // genuinely absent → 0 is correct }
 */
export function isTokenAccountAbsent(error: unknown): boolean {
  return (
    error instanceof TokenAccountNotFoundError ||
    error instanceof TokenInvalidAccountOwnerError
  );
}

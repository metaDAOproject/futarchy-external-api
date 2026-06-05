/**
 * Meteora Service
 * 
 * Provides mapping from Meteora pool owner addresses to token (baseMint) addresses.
 * This mapping is used to normalize Meteora pool data to match existing table structures.
 *
 * DAMM v2 pool addresses for base/USDC use the v0.6 Meteora config (same as existing
 * tracked launches in the Dune query); v0.7 config yields a different pool PDA.
 */

/**
 * Mapping from Meteora pool owner addresses to token (baseMint) addresses
 * 
 * The owner addresses correspond to the DAOs that have Meteora LP positions:
 * - Umbra, Ranger, Paystream, Loyal, Avici, ZKFG, Solomon, Superclaw, Futardio cult, Omnipair
 * 
 */
export const METEORA_OWNER_TO_TOKEN_MAP: Map<string, string> = new Map([
  // Umbra
  ['6vsc8pukkxm5xo54c2vbraasfqipkpghqnuktxxfysx6', 'PRVT6TB7uss3FrUd2D9xs2zqDBsa3GbMJMwCQsgmeta'],
  // Ranger
  ['55h1q1yrhjq93uhg4jqrbbhx3a8h7tcm8kvf2um2g5q3', 'RNGRtJMbCveqCp7AC6U95KmrdKecFckaJZiWbPGmeta'],
  // Paystream
  ['bpxtb2asf2tft97ewtd8payxcqfq6wqod33qrwwfk9vz', 'PAYZP1W3UmdEsNLJwmH61TNqACYJTvhXy8SCN4Tmeta'],
  // Loyal
  ['aqyytwckemeemu8zpzfxrxmbvwaytsbbhi1w4pbrhvye', 'LYLikzBQtpa9ZgVrJsqYGQpR3cC1WMJrBHaXGrQmeta'],
  // Avici
  ['dggyoucu1adzt4gel5nqiducwhrgbkmwsuzsxh2j622g', 'BANKJmvhT8tiJRsBSS1n2HryMBPvT5Ze4HU95DUAmeta'],
  // ZKFG
  ['bnvdfxyg2faybdyd71xr9ghke18mbmhtjslkscuxho6z', 'ZKFHiLAfAFMTcDAuCtjNW54VzpERvoe7PBF9mYgmeta'],
  // Solomon
  ['98spcyuz2rqm2dgjcqqsxs4gjrntlsnuaavcf38xyj9u', 'SoLo9oxzLDpcq1dpqAgMwgce5WqkRDtNXK7EPnbmeta'],
  // Omnipair
  ['8s6Jdoh7tgUqmU3D2EmpNJHSvuN5U4NybpLAdsiMitwB', 'omfgRBnxHsNJh6YeGbGAmWenNkenzsXyBXm3WDhmeta'],
  // Superclaw
  ['5ZPnwQDU7dEKdMGqaY5oCQkiuQpwjtYSJNMNpiStTNvU', '5TbDn1dFEcUTJp69Fxnu5wbwNec6LmoK42Sr5mmNmeta'],
  // Futardio cult
  ['FeMyhpB3LJuuuA1oLzXFDuZ48EJz46gyyk3w2xuQA8uw', 'Cbjr1Nvcay3QWDriyRKtokJ7V4PMknesGxeK8z7Zmeta'],
  // P2P Protocol
  ['9Rykf7i9fxUaXD8iD6GSGpRaoWQQP51Uiq1oxSE9oDzx', 'P2PXup1ZvMpCDkJn3PQxtBYgxeCSfH39SFeurGSmeta'],
]);

/** Distinct base mints we attribute Meteora fee rows to (one per tracked LP owner). */
export function getAllMappedTokens(): string[] {
  return [...new Set(METEORA_OWNER_TO_TOKEN_MAP.values())];
}

/**
 * Get token address (baseMint) for a given Meteora owner address
 * @param ownerAddress The Meteora pool owner address
 * @returns The token (baseMint) address, or null if not found
 */
export function getTokenForOwner(ownerAddress: string): string | null {
  const normalizedOwner = ownerAddress.toLowerCase();
  const token = Array.from(METEORA_OWNER_TO_TOKEN_MAP.entries()).find(([owner, _]) => owner.toLowerCase() === normalizedOwner)?.[1];
  return token || null;
}

/**
 * Get all known owner addresses
 * @returns Array of owner addresses
 */
export function getAllOwners(): string[] {
  return Array.from(METEORA_OWNER_TO_TOKEN_MAP.keys()).map(owner => owner.toLowerCase());
}

/**
 * Check if an owner address is known
 * @param ownerAddress The owner address to check
 * @returns True if the owner is in the mapping
 */
export function isKnownOwner(ownerAddress: string): boolean {
  return Array.from(METEORA_OWNER_TO_TOKEN_MAP.entries()).find(([owner, _]) => owner.toLowerCase() === ownerAddress.toLowerCase()) !== undefined;
}

import { describe, it, expect } from 'bun:test';
import { parseExcludedHolders } from '../src/config.js';

// Two real, distinct base58 pubkeys used across the cases.
const MINT = 'RNGRtJMbCveqCp7AC6U95KmrdKecFckaJZiWbPGmeta';
const WALLET = 'SoLo9oxzLDpcq1dpqAgMwgce5WqkRDtNXK7EPnbmeta';
const WALLET2 = 'So11111111111111111111111111111111111111112';

describe('parseExcludedHolders', () => {
  it('returns [] for empty / whitespace input', () => {
    expect(parseExcludedHolders('')).toEqual([]);
    expect(parseExcludedHolders('   ')).toEqual([]);
  });

  it('parses a mint:wallet entry without a label', () => {
    const holders = parseExcludedHolders(`${MINT}:${WALLET}`);
    expect(holders).toHaveLength(1);
    expect(holders[0]!.mint).toBe(MINT);
    expect(holders[0]!.wallet.toString()).toBe(WALLET);
    expect(holders[0]!.label).toBeUndefined();
  });

  it('parses a mint:wallet:label entry', () => {
    const holders = parseExcludedHolders(`${MINT}:${WALLET}:Laso external wallet`);
    expect(holders).toHaveLength(1);
    expect(holders[0]!.label).toBe('Laso external wallet');
  });

  it('parses multiple comma-separated entries', () => {
    const holders = parseExcludedHolders(`${MINT}:${WALLET}:a, ${MINT}:${WALLET2}:b`);
    expect(holders).toHaveLength(2);
    expect(holders[0]!.wallet.toString()).toBe(WALLET);
    expect(holders[1]!.wallet.toString()).toBe(WALLET2);
    expect(holders[1]!.label).toBe('b');
  });

  it('trims surrounding whitespace on mint, wallet, and label', () => {
    const holders = parseExcludedHolders(`  ${MINT} : ${WALLET} : spaced label  `);
    expect(holders).toHaveLength(1);
    expect(holders[0]!.mint).toBe(MINT);
    expect(holders[0]!.wallet.toString()).toBe(WALLET);
    expect(holders[0]!.label).toBe('spaced label');
  });

  it('skips malformed and invalid-pubkey entries without throwing', () => {
    const holders = parseExcludedHolders(
      [
        'no-colon-here',           // no delimiter
        `${MINT}:`,                // missing wallet
        `:${WALLET}`,              // missing mint
        `not-a-pubkey:${WALLET}`,  // invalid mint
        `${MINT}:not-a-pubkey`,    // invalid wallet
        `${MINT}:${WALLET}:good`,  // the only valid one
      ].join(','),
    );
    expect(holders).toHaveLength(1);
    expect(holders[0]!.label).toBe('good');
  });

  it('treats an empty label after the second colon as undefined', () => {
    const holders = parseExcludedHolders(`${MINT}:${WALLET}:`);
    expect(holders).toHaveLength(1);
    expect(holders[0]!.label).toBeUndefined();
  });
});

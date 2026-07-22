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

  it('ignores blank entries from a trailing/leading comma', () => {
    const holders = parseExcludedHolders(`,${MINT}:${WALLET}, ,`);
    expect(holders).toHaveLength(1);
    expect(holders[0]!.wallet.toString()).toBe(WALLET);
  });

  it('throws on malformed entries so a typo cannot silently overstate circulating supply', () => {
    expect(() => parseExcludedHolders('no-colon-here')).toThrow('Invalid EXCLUDED_CIRCULATING_WALLETS');
    expect(() => parseExcludedHolders(`${MINT}:`)).toThrow('Invalid EXCLUDED_CIRCULATING_WALLETS');
    expect(() => parseExcludedHolders(`:${WALLET}`)).toThrow('Invalid EXCLUDED_CIRCULATING_WALLETS');
    expect(() => parseExcludedHolders(`not-a-pubkey:${WALLET}`)).toThrow('valid base58 pubkeys');
    expect(() => parseExcludedHolders(`${MINT}:not-a-pubkey`)).toThrow('valid base58 pubkeys');
  });

  it('aborts the whole list if any entry is malformed', () => {
    // The one valid entry must NOT be returned — fail fast, don't partially apply.
    expect(() => parseExcludedHolders(`${MINT}:${WALLET}:good, garbage`)).toThrow();
  });

  it('treats an empty label after the second colon as undefined', () => {
    const holders = parseExcludedHolders(`${MINT}:${WALLET}:`);
    expect(holders).toHaveLength(1);
    expect(holders[0]!.label).toBeUndefined();
  });
});

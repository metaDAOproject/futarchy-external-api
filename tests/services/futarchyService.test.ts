import { describe, it, expect, afterEach, setSystemTime } from 'bun:test';
import BN from 'bn.js';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  ACCOUNT_SIZE,
  AccountLayout,
  MINT_SIZE,
  MintLayout,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { FutarchyService, type DaoTickerData } from '../../src/services/futarchyService.js';
import { config } from '../../src/config.js';

const DAO = new PublicKey('5FPGRzY9ArJFwY2Hp2y2eqMzVewyWCBox7esmpuZfCvE');
const BASE = new PublicKey('SoLo9oxzLDpcq1dpqAgMwgce5WqkRDtNXK7EPnbmeta');
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

afterEach(() => setSystemTime());

describe('FutarchyService.getAllDaos', () => {
  it('serves DAOs whose pool reserves exceed 2^53', async () => {
    const svc = new FutarchyService();
    (svc as any).client = {
      futarchy: {
        account: {
          dao: {
            all: async () => [{
              publicKey: DAO,
              account: {
                baseMint: BASE,
                quoteMint: USDC,
                amm: { state: { futarchy: { spot: { pool: {
                  baseReserves: new BN('20000000000000000'), // > 2^53
                  quoteReserves: new BN('1000000000000'),
                } } } } },
              },
            }],
          },
        },
      },
    };
    (svc as any).connection = { getMultipleAccountsInfo: async (keys: unknown[]) => keys.map(() => null) };
    (svc as any).getTokenDecimals = async (mint: PublicKey) => (mint.equals(USDC) ? 6 : 9);
    (svc as any).getTokenMetadata = async () => null;

    const daos = await svc.getAllDaos();

    expect(daos.map((d) => d.daoAddress.toBase58())).toEqual([DAO.toBase58()]);
    expect(daos[0]!.poolData.baseReserves.toString()).toBe('20000000000000000');
  });

  it('serves the previous snapshot while refreshing, up to the max-stale cap', async () => {
    const now = Date.now();
    setSystemTime(new Date(now));
    const svc = new FutarchyService();
    let scans = 0;
    let fail = false;
    (svc as any).fetchAllDaos = async () => {
      scans++;
      if (fail) throw new Error('RPC down');
      return { data: [{ daoAddress: DAO, scan: scans } as unknown as DaoTickerData], readAt: Date.now() };
    };
    const scanOf = (daos: DaoTickerData[]) => (daos[0] as any).scan;

    expect(scanOf(await svc.getAllDaos())).toBe(1);

    // Past the TTL: the old snapshot is returned immediately; a refresh runs behind it.
    setSystemTime(new Date(now + config.cache.tickersTTL + 1));
    expect(scanOf(await svc.getAllDaos())).toBe(1);
    await Bun.sleep(0);
    expect(scans).toBe(2);
    expect(scanOf(await svc.getAllDaos())).toBe(2);

    // RPC down: keep serving the last good snapshot while it's within the cap...
    fail = true;
    const refreshedAt = now + config.cache.tickersTTL + 1;
    setSystemTime(new Date(refreshedAt + config.cache.tickersTTL + 1));
    expect(scanOf(await svc.getAllDaos())).toBe(2);

    // ...and fail once it's older than the cap, rather than serve stale prices.
    setSystemTime(new Date(refreshedAt + config.cache.tickersMaxStale + 1));
    await expect(svc.getAllDaos()).rejects.toThrow('RPC down');
  });

  it('discards a refresh whose reserves are already past the max-stale cap', async () => {
    const svc = new FutarchyService();
    (svc as any).fetchAllDaos = async () => ({
      data: [{ daoAddress: DAO } as unknown as DaoTickerData],
      readAt: Date.now() - config.cache.tickersMaxStale - 1,
    });

    await expect(svc.getAllDaos()).rejects.toThrow('max-stale');
  });

  it('honors a max-stale cap configured below the TTL', async () => {
    const original = config.cache.tickersMaxStale;
    config.cache.tickersMaxStale = 1_000; // below the 55s TTL
    try {
      const now = Date.now();
      setSystemTime(new Date(now));
      const svc = new FutarchyService();
      let scans = 0;
      (svc as any).fetchAllDaos = async () => ({ data: [{ scan: ++scans } as unknown as DaoTickerData], readAt: Date.now() });

      await svc.getAllDaos();
      setSystemTime(new Date(now + 1_500)); // within the TTL, past the cap
      expect(((await svc.getAllDaos())[0] as any).scan).toBe(2);
    } finally {
      config.cache.tickersMaxStale = original;
    }
  });
});

describe('FutarchyService batched lookups', () => {
  const metadataPda = (mint: PublicKey) => PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s').toBuffer(), mint.toBuffer()],
    new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'),
  )[0];
  const mintAccount = (decimals: number) => {
    const data = Buffer.alloc(MINT_SIZE);
    MintLayout.encode({
      mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 0n, decimals,
      isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default,
    }, data);
    return { data, owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false };
  };
  const metadataAccount = (mint: PublicKey, name: string, symbol: string) => {
    const str = (v: string) => { const b = Buffer.from(v); const len = Buffer.alloc(4); len.writeUInt32LE(b.length); return Buffer.concat([len, b]); };
    const data = Buffer.concat([Buffer.alloc(1), Buffer.alloc(32), mint.toBuffer(), str(name), str(symbol)]);
    return { data, owner: PublicKey.default, lamports: 1, executable: false };
  };
  const tokenAccount = (mint: PublicKey, owner: PublicKey, amount: bigint) => {
    const data = Buffer.alloc(ACCOUNT_SIZE);
    AccountLayout.encode({
      mint, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: 1,
      isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default,
    }, data);
    return { data, owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false };
  };

  it('decodes batched mints, metadata and treasury balances across >100 keys, then reuses the caches', async () => {
    const daos = Array.from({ length: 60 }, (_, i) => ({
      address: Keypair.generate().publicKey,
      mint: Keypair.generate().publicKey,
      vault: Keypair.generate().publicKey,
      decimals: i % 10,
      hasMetadata: i % 2 === 0,
      usdc: i % 2 === 0 ? BigInt(i + 1) * 1_000_000n : null,
    }));
    const accounts = new Map<string, unknown>([[USDC.toBase58(), mintAccount(6)]]);
    accounts.set(metadataPda(USDC).toBase58(), metadataAccount(USDC, 'USD Coin', 'USDC'));
    for (const d of daos) {
      accounts.set(d.mint.toBase58(), mintAccount(d.decimals));
      if (d.hasMetadata) accounts.set(metadataPda(d.mint).toBase58(), metadataAccount(d.mint, `Token ${d.decimals}`, `T${d.decimals}`));
      if (d.usdc !== null) {
        const ata = getAssociatedTokenAddressSync(USDC, d.vault, true);
        accounts.set(ata.toBase58(), tokenAccount(USDC, d.vault, d.usdc));
      }
    }

    const batches: string[][] = [];
    let singleLookups = 0;
    const svc = new FutarchyService();
    (svc as any).connection = {
      getMultipleAccountsInfo: async (keys: PublicKey[]) => {
        batches.push(keys.map((k) => k.toBase58()));
        return keys.map((k) => accounts.get(k.toBase58()) ?? null);
      },
      getAccountInfo: async () => { singleLookups++; return null; },
    };
    (svc as any).client = {
      futarchy: { account: { dao: { all: async () => daos.map((d) => ({
        publicKey: d.address,
        account: {
          baseMint: d.mint, quoteMint: USDC, squadsMultisigVault: d.vault,
          amm: { state: { futarchy: { spot: { pool: { baseReserves: new BN(1000), quoteReserves: new BN(2000) } } } } },
        },
      })) } } },
    };

    const served = await svc.getAllDaos();

    expect(batches.every((b) => b.length <= 100)).toBe(true);
    expect(batches.flat().length).toBeGreaterThan(100 + 60); // 61 mints + 61 metadata + 60 treasury ATAs
    expect(singleLookups).toBe(0); // absent metadata is not re-fetched one by one
    for (const d of daos) {
      const row = served.find((r) => r.daoAddress.equals(d.address))!;
      expect(row.baseDecimals).toBe(d.decimals);
      expect(row.quoteDecimals).toBe(6);
      expect(row.quoteSymbol).toBe('USDC');
      expect(row.baseSymbol).toBe(d.hasMetadata ? `T${d.decimals}` : undefined);
      expect(row.treasuryUsdcAum).toBe(d.usdc === null ? undefined : (Number(d.usdc) / 1e6).toFixed(6));
    }

    // Next refresh: decimals, metadata and confirmed-absent metadata come from cache;
    // only the treasury balances are read again.
    batches.length = 0;
    await (svc as any).refreshAllDaos();
    expect(batches.flat().length).toBe(60);
    expect(singleLookups).toBe(0);
  });
});

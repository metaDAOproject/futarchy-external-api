/**
 * Regression tests for the allocation snapshot error contract.
 *
 * Mint supply and every live non-circulating balance must come from one
 * contextual RPC batch. Infrastructure failures must reject rather than
 * silently returning zero allocations.
 */

import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import {
  ACCOUNT_SIZE,
  AccountLayout,
  getAssociatedTokenAddressSync,
  AccountState,
  getAssociatedTokenAddress,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Keypair, PublicKey, type AccountInfo } from '@solana/web3.js';
import BN from 'bn.js';
import { config } from '../../src/config.js';
import { LaunchpadService } from '../../src/services/launchpadService.js';
import { SolanaService } from '../../src/services/solanaService.js';
import { getSupplyInfoWithLaunchpadAllocation } from '../../src/services/supplyWithLaunchpadAllocation.js';

const MINT = new PublicKey('SoLo9oxzLDpcq1dpqAgMwgce5WqkRDtNXK7EPnbmeta');
const HOLDER = new PublicKey('DMB74TZgN7Rqfwtqqm3VQBgKBb2WYPdBqVtHbvB4LLeV');
const HOLDER_2 = new PublicKey('5FPGRzY9ArJFwY2Hp2y2eqMzVewyWCBox7esmpuZfCvE');
const ACCOUNT_A = new PublicKey('So11111111111111111111111111111111111111112');
const ACCOUNT_B = new PublicKey('11111111111111111111111111111111');
const OTHER_MINT = 'So11111111111111111111111111111111111111112';
const ZERO_KEY = new PublicKey(new Uint8Array(32));

function accountInfo(
  data: Buffer,
  tokenProgramId = TOKEN_PROGRAM_ID,
): AccountInfo<Buffer> {
  return {
    data,
    executable: false,
    lamports: 1,
    owner: tokenProgramId,
    rentEpoch: 0,
  };
}

function mintAccountInfo(
  supply = 1_000_000n,
  decimals = 6,
  tokenProgramId = TOKEN_PROGRAM_ID,
): AccountInfo<Buffer> {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode({
    mintAuthorityOption: 0,
    mintAuthority: ZERO_KEY,
    supply,
    decimals,
    isInitialized: true,
    freezeAuthorityOption: 0,
    freezeAuthority: ZERO_KEY,
  }, data);
  return accountInfo(data, tokenProgramId);
}

function tokenAccountInfo(
  owner: PublicKey,
  amount: bigint,
  mint = MINT,
  tokenProgramId = TOKEN_PROGRAM_ID,
): AccountInfo<Buffer> {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({
    mint,
    owner,
    amount,
    delegateOption: 0,
    delegate: ZERO_KEY,
    state: AccountState.Initialized,
    isNativeOption: 0,
    isNative: 0n,
    delegatedAmount: 0n,
    closeAuthorityOption: 0,
    closeAuthority: ZERO_KEY,
  }, data);
  return accountInfo(data, tokenProgramId);
}

function discovery(
  accounts: Array<{ pubkey: PublicKey; info: AccountInfo<Buffer> }>,
  slot = 100,
) {
  return {
    context: { apiVersion: 'test', slot },
    value: accounts.map(({ pubkey, info }) => ({ pubkey, account: info })),
  };
}

function snapshotStub() {
  return {
    excludedHolders: [],
    performancePackageAmount: new BN(0),
    daoTreasuryAmount: new BN(0),
    mintSupply: { amount: new BN(1_000_000), decimals: 6 },
    tokenProgramId: TOKEN_PROGRAM_ID,
    slot: 100,
    futarchyAmmAmount: new BN(0),
    meteoraLpAmount: new BN(0),
    additionalTokensClaimed: false,
  };
}

beforeEach(() => {
  config.circulating.excludedHolders.length = 0;
});

afterEach(() => {
  config.circulating.excludedHolders.length = 0;
});

describe('LaunchpadService.getTokenAllocationBreakdown', () => {
  it('propagates infrastructure failures instead of returning an empty breakdown', async () => {
    const svc = new LaunchpadService();
    (svc as any).getLaunchByBaseMint = async () => {
      throw new Error('RPC connection refused');
    };

    await expect(svc.getTokenAllocationBreakdown(MINT)).rejects.toThrow('RPC connection refused');
  });

  it('returns an empty allocation with a live mint snapshot when no launch exists', async () => {
    const svc = new LaunchpadService();
    (svc as any).getLaunchByBaseMint = async () => null;
    (svc as any).getLiveBalanceSnapshot = async () => snapshotStub();

    const breakdown = await svc.getTokenAllocationBreakdown(MINT);

    expect(breakdown.teamPerformancePackage.amount.isZero()).toBe(true);
    expect(breakdown.totalNonCirculating.isZero()).toBe(true);
    expect(breakdown.balanceSnapshotSlot).toBe(100);
    expect(breakdown.mintSupplySnapshot.amount.toString()).toBe('1000000');
  });

  it('returns an empty allocation with launch metadata for an incomplete launch', async () => {
    const svc = new LaunchpadService();
    const launchAddress = HOLDER_2;
    (svc as any).getLaunchByBaseMint = async () => ({
      launchAddress,
      baseMint: MINT,
      version: 'v0.7',
      dao: undefined,
    });
    (svc as any).getLiveBalanceSnapshot = async () => snapshotStub();

    const breakdown = await svc.getTokenAllocationBreakdown(MINT);

    expect(breakdown.version).toBe('v0.7');
    expect(breakdown.launchAddress?.equals(launchAddress)).toBe(true);
    expect(breakdown.totalNonCirculating.isZero()).toBe(true);
    expect(breakdown.excludedHolders).toEqual([]);
    expect(breakdown.mintSupplySnapshot.decimals).toBe(6);
  });

  it('derives the additional-recipient ATA from the snapshotted token program', async () => {
    const svc = new LaunchpadService();
    const recipient = HOLDER;
    const expectedAta = await getAssociatedTokenAddress(
      MINT,
      recipient,
      true,
      TOKEN_2022_PROGRAM_ID,
    );
    (svc as any).getLaunchByBaseMint = async () => ({
      launchAddress: HOLDER_2,
      baseMint: MINT,
      performancePackageGrantee: HOLDER,
      performancePackageTokenAmount: new BN(0),
      state: { completed: {} },
      dao: ACCOUNT_A,
      version: 'v0.7',
      additionalTokensAmount: new BN(100),
      additionalTokensRecipient: recipient,
      additionalTokensClaimed: false,
    });
    (svc as any).futarchyClient = {
      fetchDao: async () => ({ quoteMint: undefined }),
    };
    (svc as any).getPerformancePackageAddress = () => ACCOUNT_B;
    (svc as any).getLiveBalanceSnapshot = async () => ({
      ...snapshotStub(),
      tokenProgramId: TOKEN_2022_PROGRAM_ID,
    });

    const breakdown = await svc.getTokenAllocationBreakdown(MINT);

    expect(
      breakdown.additionalTokenAllocation?.tokenAccountAddress?.equals(expectedAta),
    ).toBe(true);
  });
});

describe('LaunchpadService allocation snapshots', () => {
  for (const accountCount of [99, 100, 205]) {
    it(`serves a holder with ${accountCount} token accounts through the allocation path`, async () => {
      config.circulating.excludedHolders.push({ mint: MINT.toString(), wallet: HOLDER });
      const accounts = Array.from({ length: accountCount }, (_, index) => ({
        pubkey: new PublicKey(new BN(index + 1).toArrayLike(Buffer, 'le', 32)),
        info: tokenAccountInfo(HOLDER, BigInt(index + 1)),
      }));
      const accountMap = new Map([
        [MINT.toString(), mintAccountInfo()],
        ...accounts.map(({ pubkey, info }) => [pubkey.toString(), info] as const),
      ]);
      const svc = new LaunchpadService();
      (svc as any).getLaunchByBaseMint = async () => null;
      const batches: number[] = [];
      (svc as any).connection = {
        getTokenAccountsByOwner: async () => discovery(accounts),
        getMultipleAccountsInfoAndContext: async (addresses: PublicKey[]) => {
          batches.push(addresses.length);
          expect(addresses.length).toBeLessThanOrEqual(100);
          return {
            context: { slot: 321 },
            value: addresses.map(address => accountMap.get(address.toString()) ?? null),
          };
        },
      };

      const breakdown = await svc.getTokenAllocationBreakdown(MINT);

      expect(batches.length).toBe(Math.ceil((accountCount + 1) / 100));
      expect(batches.reduce((sum, count) => sum + count, 0)).toBe(accountCount + 1);
      expect(breakdown.excludedHolders[0]?.amount.toString()).toBe(String(accountCount * (accountCount + 1) / 2));
      expect(breakdown.totalNonCirculating.toString()).toBe(String(accountCount * (accountCount + 1) / 2));
      expect(breakdown.balanceSnapshotSlot).toBe(321);
    });
  }

  for (const outcome of ['retry', 'mismatch', 'RPC failure']) {
    it(`handles multi-batch ${outcome} without mixing slots or caching partial balances`, async () => {
      config.circulating.excludedHolders.push({ mint: MINT.toString(), wallet: HOLDER });
      const accounts = Array.from({ length: 100 }, (_, index) => ({
        pubkey: new PublicKey(new BN(index + 1).toArrayLike(Buffer, 'le', 32)),
        info: tokenAccountInfo(HOLDER, 1n),
      }));
      const svc = new LaunchpadService();
      (svc as any).getLaunchByBaseMint = async () => null;
      let calls = 0;
      (svc as any).connection = {
        getTokenAccountsByOwner: async () => discovery(accounts),
        getMultipleAccountsInfoAndContext: async (addresses: PublicKey[], options: { minContextSlot: number }) => {
          const call = calls++;
          expect(options.minContextSlot).toBe(100);
          if (outcome === 'RPC failure' && call === 1) throw new Error('batch RPC failed');
          const slot = outcome === 'retry' && call >= 2 ? 400 : 200 + call;
          return {
            context: { slot },
            value: addresses.map(address => address.equals(MINT)
              ? mintAccountInfo()
              : tokenAccountInfo(HOLDER, slot === 400 ? 2n : 1n)),
          };
        },
      };

      if (outcome === 'retry') {
        const breakdown = await svc.getTokenAllocationBreakdown(MINT);
        expect(calls).toBe(4);
        expect(breakdown.balanceSnapshotSlot).toBe(400);
        expect(breakdown.excludedHolders[0]?.amount.toString()).toBe('200');
      } else {
        await expect(svc.getTokenAllocationBreakdown(MINT)).rejects.toThrow(
          outcome === 'mismatch' ? 'Balance snapshot slots differed' : 'batch RPC failed',
        );
        expect(calls).toBe(outcome === 'mismatch' ? 6 : 2);
        expect((svc as any).cache.size).toBe(0);
      }
    });
  }

  it('reads mint supply without holder discovery when no holders are configured', async () => {
    const svc = new LaunchpadService();
    (svc as any).getLaunchByBaseMint = async () => null;
    let called = false;
    (svc as any).connection = {
      getTokenAccountsByOwner: async () => {
        called = true;
        return discovery([]);
      },
      getMultipleAccountsInfoAndContext: async () => ({
        context: { slot: 321 },
        value: [mintAccountInfo()],
      }),
    };

    const breakdown = await svc.getTokenAllocationBreakdown(MINT);
    expect(breakdown.excludedHolders).toEqual([]);
    expect(breakdown.mintSupplySnapshot.amount.toString()).toBe('1000000');
    expect(called).toBe(false);
  });

  it('reads mint supply and sums every holder account in one contextual batch', async () => {
    config.circulating.excludedHolders.push({
      mint: MINT.toString(),
      wallet: HOLDER,
      label: 'external',
    });
    const accounts = [
      { pubkey: ACCOUNT_A, info: tokenAccountInfo(HOLDER, 100n) },
      { pubkey: ACCOUNT_B, info: tokenAccountInfo(HOLDER, 25n) },
    ];
    const accountMap = new Map([
      [MINT.toString(), mintAccountInfo(2_000_000n, 6)],
      ...accounts.map(({ pubkey, info }) => [pubkey.toString(), info] as const),
    ]);
    const svc = new LaunchpadService();
    let batchCalls = 0;
    (svc as any).connection = {
      getTokenAccountsByOwner: async () => discovery(accounts),
      getMultipleAccountsInfoAndContext: async (addresses: PublicKey[]) => {
        batchCalls++;
        return {
          context: { apiVersion: 'test', slot: 321 },
          value: addresses.map(address => accountMap.get(address.toString()) ?? null),
        };
      },
    };

    const snapshot = await (svc as any).getLiveBalanceSnapshot(MINT);

    expect(batchCalls).toBe(1);
    expect(snapshot.slot).toBe(321);
    expect(snapshot.mintSupply.amount.toString()).toBe('2000000');
    expect(snapshot.mintSupply.decimals).toBe(6);
    expect(snapshot.excludedHolders[0].amount.toString()).toBe('125');
    expect(snapshot.excludedHolders[0].label).toBe('external');
  });

  it('yields zero when a configured holder owns no accounts for the mint', async () => {
    config.circulating.excludedHolders.push({ mint: MINT.toString(), wallet: HOLDER });
    const svc = new LaunchpadService();
    (svc as any).connection = {
      getTokenAccountsByOwner: async () => discovery([]),
      getMultipleAccountsInfoAndContext: async () => ({
        context: { apiVersion: 'test', slot: 100 },
        value: [mintAccountInfo()],
      }),
    };

    const snapshot = await (svc as any).getLiveBalanceSnapshot(MINT);

    expect(snapshot.excludedHolders[0].amount.isZero()).toBe(true);
  });

  it('propagates discovery failures instead of returning a silent zero', async () => {
    config.circulating.excludedHolders.push({ mint: MINT.toString(), wallet: HOLDER });
    const svc = new LaunchpadService();
    (svc as any).connection = {
      getTokenAccountsByOwner: async () => {
        throw new Error('RPC connection refused');
      },
    };

    await expect((svc as any).getLiveBalanceSnapshot(MINT)).rejects.toThrow(
      'RPC connection refused',
    );
  });

  it('fails closed when a discovered token account is absent from the batch', async () => {
    config.circulating.excludedHolders.push({ mint: MINT.toString(), wallet: HOLDER });
    const accounts = [{ pubkey: ACCOUNT_A, info: tokenAccountInfo(HOLDER, 100n) }];
    const svc = new LaunchpadService();
    (svc as any).connection = {
      getTokenAccountsByOwner: async () => discovery(accounts),
      getMultipleAccountsInfoAndContext: async () => ({
        context: { apiVersion: 'test', slot: 100 },
        value: [mintAccountInfo(), null],
      }),
    };

    await expect((svc as any).getLiveBalanceSnapshot(MINT)).rejects.toThrow(
      'was absent from balance snapshot',
    );
  });

  it('ignores holders configured for another mint on the allocation path', async () => {
    config.circulating.excludedHolders.push({ mint: OTHER_MINT, wallet: HOLDER });
    const svc = new LaunchpadService();
    (svc as any).getLaunchByBaseMint = async () => null;
    let called = false;
    (svc as any).connection = {
      getTokenAccountsByOwner: async () => {
        called = true;
        return discovery([]);
      },
      getMultipleAccountsInfoAndContext: async () => ({
        context: { slot: 321 },
        value: [mintAccountInfo()],
      }),
    };

    const breakdown = await svc.getTokenAllocationBreakdown(MINT);
    expect(breakdown.excludedHolders).toEqual([]);
    expect(breakdown.mintSupplySnapshot.amount.toString()).toBe('1000000');
    expect(called).toBe(false);
  });

  it('retries the complete snapshot when account topology changes around it', async () => {
    config.circulating.excludedHolders.push({ mint: MINT.toString(), wallet: HOLDER });
    const accountA = [{ pubkey: ACCOUNT_A, info: tokenAccountInfo(HOLDER, 10n) }];
    const accountB = [{ pubkey: ACCOUNT_B, info: tokenAccountInfo(HOLDER, 20n) }];
    const discoveries = [accountA, accountB, accountB, accountB];
    const svc = new LaunchpadService();
    let discoveryCalls = 0;
    let batchCalls = 0;
    (svc as any).connection = {
      getTokenAccountsByOwner: async () =>
        discovery(discoveries[discoveryCalls++] ?? accountB, 100 + discoveryCalls),
      getMultipleAccountsInfoAndContext: async (addresses: PublicKey[]) => {
        batchCalls++;
        return {
          context: { apiVersion: 'test', slot: 200 + batchCalls },
          value: addresses.map(address => {
            if (address.equals(MINT)) return mintAccountInfo();
            return tokenAccountInfo(HOLDER, address.equals(ACCOUNT_A) ? 10n : 20n);
          }),
        };
      },
    };

    const snapshot = await (svc as any).getLiveBalanceSnapshot(MINT);

    expect(discoveryCalls).toBe(4);
    expect(batchCalls).toBe(2);
    expect(snapshot.excludedHolders[0].amount.toString()).toBe('20');
  });

  it('reads performance-package and treasury balances in the mint-supply batch', async () => {
    const performanceAta = await getAssociatedTokenAddress(
      MINT,
      ACCOUNT_A,
      true,
      TOKEN_PROGRAM_ID,
    );
    const treasuryAta = await getAssociatedTokenAddress(
      MINT,
      ACCOUNT_B,
      true,
      TOKEN_PROGRAM_ID,
    );
    const svc = new LaunchpadService();
    let requested: string[] = [];
    (svc as any).connection = {
      getTokenAccountsByOwner: async () => discovery([]),
      getMultipleAccountsInfoAndContext: async (addresses: PublicKey[]) => {
        requested = addresses.map(address => address.toString());
        return {
          context: { apiVersion: 'test', slot: 444 },
          value: addresses.map(address => {
            if (address.equals(MINT)) return mintAccountInfo(9_000_000n);
            if (address.equals(performanceAta)) return tokenAccountInfo(HOLDER, 75n);
            if (address.equals(treasuryAta)) return tokenAccountInfo(HOLDER, 25n);
            return null;
          }),
        };
      },
    };

    const snapshot = await (svc as any).getLiveBalanceSnapshot(MINT, ACCOUNT_A, ACCOUNT_B);

    expect(requested).toContain(performanceAta.toString());
    expect(requested).toContain(treasuryAta.toString());
    expect(snapshot.slot).toBe(444);
    expect(snapshot.mintSupply.amount.toString()).toBe('9000000');
    expect(snapshot.performancePackageAmount.toString()).toBe('75');
    expect(snapshot.daoTreasuryAmount.toString()).toBe('25');
  });

  it('selects Token-2022 ATAs from the same contextual batch', async () => {
    const performanceAta = await getAssociatedTokenAddress(
      MINT,
      ACCOUNT_A,
      true,
      TOKEN_2022_PROGRAM_ID,
    );
    const treasuryAta = await getAssociatedTokenAddress(
      MINT,
      ACCOUNT_B,
      true,
      TOKEN_2022_PROGRAM_ID,
    );
    const svc = new LaunchpadService();
    (svc as any).connection = {
      getTokenAccountsByOwner: async () => discovery([]),
      getMultipleAccountsInfoAndContext: async (addresses: PublicKey[]) => ({
        context: { apiVersion: 'test', slot: 555 },
        value: addresses.map(address => {
          if (address.equals(MINT)) {
            return mintAccountInfo(8_000_000n, 6, TOKEN_2022_PROGRAM_ID);
          }
          if (address.equals(performanceAta)) {
            return tokenAccountInfo(
              HOLDER,
              80n,
              MINT,
              TOKEN_2022_PROGRAM_ID,
            );
          }
          if (address.equals(treasuryAta)) {
            return tokenAccountInfo(
              HOLDER,
              20n,
              MINT,
              TOKEN_2022_PROGRAM_ID,
            );
          }
          return null;
        }),
      }),
    };

    const snapshot = await (svc as any).getLiveBalanceSnapshot(
      MINT,
      ACCOUNT_A,
      ACCOUNT_B,
    );

    expect(snapshot.slot).toBe(555);
    expect(snapshot.mintSupply.amount.toString()).toBe('8000000');
    expect(snapshot.tokenProgramId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(snapshot.performancePackageAmount.toString()).toBe('80');
    expect(snapshot.daoTreasuryAmount.toString()).toBe('20');
  });

  it('fails closed when account topology keeps changing', async () => {
    config.circulating.excludedHolders.push({ mint: MINT.toString(), wallet: HOLDER });
    const svc = new LaunchpadService();
    let calls = 0;
    (svc as any).connection = {
      getTokenAccountsByOwner: async () => {
        const account = calls++ % 2 === 0 ? ACCOUNT_A : ACCOUNT_B;
        return discovery([{ pubkey: account, info: tokenAccountInfo(HOLDER, 10n) }]);
      },
      getMultipleAccountsInfoAndContext: async (addresses: PublicKey[]) => ({
        context: { apiVersion: 'test', slot: 100 },
        value: addresses.map(address =>
          address.equals(MINT) ? mintAccountInfo() : tokenAccountInfo(HOLDER, 10n)),
      }),
    };

    await expect((svc as any).getLiveBalanceSnapshot(MINT)).rejects.toThrow(
      'Token-account topology changed',
    );
    expect(calls).toBe(6);
  });

});

describe('LaunchpadService.getLiveLaunches', () => {
  const LAUNCH = new PublicKey('5FPGRzY9ArJFwY2Hp2y2eqMzVewyWCBox7esmpuZfCvE');
  const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

  function fakeProgram(launches: any[], fundingRecords: any[] = [], calls = { launch: 0, fundingRecord: 0 }) {
    return {
      account: {
        launch: { all: async () => { calls.launch++; return launches; } },
        fundingRecord: { all: async () => { calls.fundingRecord++; return fundingRecords; } },
      },
    };
  }

  afterEach(() => setSystemTime());

  function serviceWith(programs: { v06?: any; v07?: any; v08?: any }) {
    const svc = new LaunchpadService();
    (svc as any).clientV06 = { launchpad: programs.v06 ?? fakeProgram([]) };
    (svc as any).clientV07 = { launchpad: programs.v07 ?? fakeProgram([]) };
    (svc as any).clientV08 = { launchpad: programs.v08 ?? fakeProgram([]) };
    (svc as any).getMintDecimals = async () => 6;
    return svc;
  }

  const STARTED = Math.floor(Date.now() / 1000) - 60 * 60;
  const DURATION = 4 * 24 * 60 * 60;
  const liveLaunch = {
    publicKey: LAUNCH,
    account: {
      state: { live: {} },
      baseMint: MINT,
      quoteMint: USDC,
      minimumRaiseAmount: new BN('500000000000'),
      unixTimestampStarted: new BN(STARTED),
      secondsForLaunch: DURATION,
    },
  };

  it('aggregates funding records for open live launches only', async () => {
    const completed = { ...liveLaunch, account: { ...liveLaunch.account, state: { complete: {} } } };
    // Still `live` on-chain, but its close time passed and nobody called closeLaunch.
    const pastClose = {
      ...liveLaunch,
      account: { ...liveLaunch.account, unixTimestampStarted: new BN(STARTED - 2 * DURATION) },
    };
    const calls = { launch: 0, fundingRecord: 0 };
    const svc = serviceWith({
      v07: fakeProgram([liveLaunch, completed, pastClose], [
        { account: { committedAmount: new BN('1500000') } },
        { account: { committedAmount: new BN('250000000') } },
        { account: { committedAmount: new BN(0) } },
      ], calls),
    });

    const { launches } = await svc.getLiveLaunches();

    expect(launches).toEqual([{
      launchAddress: LAUNCH.toBase58(),
      version: 'v0.7',
      tokenAddress: MINT.toBase58(),
      quoteMint: USDC.toBase58(),
      quoteDecimals: 6,
      committerCount: 2,
      totalCommitted: '251.5',
      totalCommittedRaw: '251500000',
      minimumRaise: '500000',
      minimumRaiseRaw: '500000000000',
      closeTime: STARTED + DURATION,
    }]);
    // Funding records are read for the open launch only, not the expired one.
    expect(calls.fundingRecord).toBe(1);
  });

  it('shares one scan per TTL window and drops launches the moment they close', async () => {
    const now = Date.now();
    setSystemTime(new Date(now));
    const closingSoon = {
      ...liveLaunch,
      account: {
        ...liveLaunch.account,
        unixTimestampStarted: new BN(Math.floor(now / 1000) - DURATION + 60),
      },
    };
    const calls = { launch: 0, fundingRecord: 0 };
    const svc = serviceWith({ v08: fakeProgram([closingSoon], [], calls) });

    // Concurrent callers share the in-flight scan.
    const [a, b] = await Promise.all([svc.getLiveLaunches(), svc.getLiveLaunches()]);
    expect(a.launches).toHaveLength(1);
    expect(b).toEqual(a);
    expect(calls.launch).toBe(1);

    // Within the TTL but past the close time: served from cache, launch filtered out.
    setSystemTime(new Date(now + 120_000));
    expect((await svc.getLiveLaunches()).launches).toEqual([]);
    expect(calls.launch).toBe(1);

    // After the TTL: rescanned.
    setSystemTime(new Date(now + config.cache.liveLaunchesTTL + 1));
    await svc.getLiveLaunches();
    expect(calls.launch).toBe(2);
  });

  it('propagates RPC failures instead of serving an empty list, and does not cache them', async () => {
    let fail = true;
    const svc = serviceWith({
      v06: {
        account: {
          launch: { all: async () => { if (fail) throw new Error('RPC connection refused'); return []; } },
          fundingRecord: { all: async () => [] },
        },
      },
    });

    await expect(svc.getLiveLaunches()).rejects.toThrow('RPC connection refused');
    fail = false;
    expect((await svc.getLiveLaunches()).launches).toEqual([]);
  });
});

describe('LaunchpadService batched allocation reads', () => {
  const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  const DAO = Keypair.generate().publicKey;
  const AMM_VAULT = Keypair.generate().publicKey;
  const SQUADS_VAULT = Keypair.generate().publicKey;
  const LAUNCH = new PublicKey('5FPGRzY9ArJFwY2Hp2y2eqMzVewyWCBox7esmpuZfCvE');

  const tokenAccount = (owner: PublicKey, amount: bigint) => {
    const data = Buffer.alloc(ACCOUNT_SIZE);
    AccountLayout.encode({
      mint: MINT, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: 1,
      isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default,
    }, data);
    return { data, owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false };
  };

  function completedLaunchService(balances: (keys: PublicKey[]) => Promise<unknown[]>) {
    const svc = new LaunchpadService();
    const calls = { daoFetches: 0, balanceReads: 0 };
    (svc as any).getLaunchByBaseMint = async () => ({
      launchAddress: LAUNCH, baseMint: MINT, version: 'v0.7', dao: DAO,
      performancePackageTokenAmount: new BN(0),
    });
    (svc as any).futarchyClient = {
      fetchDao: async () => { calls.daoFetches++; return { quoteMint: USDC, amm: { ammBaseVault: AMM_VAULT }, squadsMultisigVault: SQUADS_VAULT }; },
    };
    (svc as any).connection = {
      getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => {
        calls.balanceReads++;
        const values = await balances(keys);
        return {
          context: { slot: 321 },
          value: keys.map((key, index) => key.equals(MINT) ? mintAccountInfo() : values[index]),
        };
      },
    };
    return { svc, calls };
  }

  it('reads every balance in one call, fetches the DAO once, and treats absent accounts as 0', async () => {
    const treasuryAta = getAssociatedTokenAddressSync(MINT, SQUADS_VAULT, true);
    const { svc, calls } = completedLaunchService(async (keys) => keys.map((key) => {
      if (key.equals(AMM_VAULT)) return tokenAccount(AMM_VAULT, 5_000n);
      if (key.equals(treasuryAta)) return tokenAccount(SQUADS_VAULT, 7_000n);
      return null; // performance package and Meteora vault absent
    }));

    const breakdown = await svc.getTokenAllocationBreakdown(MINT);

    expect(calls).toEqual({ daoFetches: 1, balanceReads: 1 });
    expect(breakdown.futarchyAmmLiquidity.amount.toString()).toBe('5000');
    expect(breakdown.futarchyAmmLiquidity.vaultAddress?.equals(AMM_VAULT)).toBe(true);
    expect(breakdown.daoTreasuryTokens.amount.toString()).toBe('7000');
    expect(breakdown.daoTreasuryTokens.vaultAddress?.equals(SQUADS_VAULT)).toBe(true);
    // Absent accounts: 0, and (as before) no pool/vault address reported for them.
    expect(breakdown.teamPerformancePackage.amount.isZero()).toBe(true);
    expect(breakdown.teamPerformancePackage.address).toBeDefined();
    expect(breakdown.meteoraLpLiquidity).toEqual({ amount: new BN(0) });
    expect(breakdown.totalNonCirculating.toString()).toBe('7000');
  });

  it('rejects instead of reading zeros when the balance read fails', async () => {
    const { svc } = completedLaunchService(async () => { throw new Error('RPC connection refused'); });

    await expect(svc.getTokenAllocationBreakdown(MINT)).rejects.toThrow('RPC connection refused');
  });

  it('shares one load between concurrent requests for a mint', async () => {
    const { svc, calls } = completedLaunchService(async (keys) => keys.map(() => null));

    await Promise.all([1, 2, 3, 4, 5].map(() => svc.getTokenAllocationBreakdown(MINT)));

    expect(calls).toEqual({ daoFetches: 1, balanceReads: 1 });
  });

  it('reads both launch program versions in one call and caches "no launch"', async () => {
    const svc = new LaunchpadService();
    let reads = 0;
    (svc as any).connection = {
      getMultipleAccountsInfo: async (keys: PublicKey[]) => { reads++; expect(keys).toHaveLength(2); return [null, null]; },
    };

    expect(await svc.getLaunchByBaseMint(MINT)).toBeNull();
    expect(await svc.getLaunchByBaseMint(MINT)).toBeNull();
    expect(reads).toBe(1);
  });

  describe('decoding real launch accounts', () => {
    const GRANTEE = Keypair.generate().publicKey;
    const RECIPIENT = Keypair.generate().publicKey;

    // Default value for every field of an Anchor (0.29 IDL) type.
    const defaultFor = (type: any): unknown => {
      if (typeof type === 'string') {
        if (type === 'publicKey') return PublicKey.default;
        if (type === 'bool') return false;
        if (/^[ui](8|16|32)$/.test(type)) return 0;
        return new BN(0); // u64 / i64 / u128
      }
      if ('option' in type) return null;
      if ('vec' in type) return [];
      if ('array' in type) return Array.from({ length: type.array[1] }, () => defaultFor(type.array[0]));
      return { live: {} }; // the only defined type in Launch is the LaunchState enum
    };

    async function launchAccount(svc: LaunchpadService, version: 'v0.6' | 'v0.7', fields: Record<string, unknown>) {
      const program = (svc as any)[version === 'v0.7' ? 'clientV07' : 'clientV06'].launchpad;
      const idlFields = program.idl.accounts.find((a: any) => a.name === 'launch').type.fields;
      const account = Object.fromEntries(idlFields.map((f: any) => [f.name, defaultFor(f.type)]));
      const data = await program.coder.accounts.encode('launch', { ...account, ...fields });
      return { data, owner: program.programId, lamports: 1, executable: false };
    }

    const lookup = async (svc: LaunchpadService, v07: unknown, v06: unknown) => {
      (svc as any).connection = { getMultipleAccountsInfo: async () => [v07, v06] };
      return svc.getLaunchByBaseMint(MINT);
    };

    for (const claimState of [false, true, 'missing', 'malformed']) {
      it(`uses snapshotted claim state ${claimState} with recipient balances despite cached launch state`, async () => {
        const svc = new LaunchpadService();
        const launchAddress = svc.getLaunchAddressV07(MINT);
        const fields = {
          baseMint: MINT, dao: DAO, performancePackageTokenAmount: new BN(0),
          additionalTokensAmount: new BN(100), additionalTokensRecipient: RECIPIENT,
          additionalTokensClaimed: false, state: { complete: {} },
        };
        const unclaimed = await launchAccount(svc, 'v0.7', fields);
        expect((await lookup(svc, unclaimed, null))?.additionalTokensClaimed).toBeUndefined();
        const currentLaunch = typeof claimState === 'boolean'
          ? await launchAccount(svc, 'v0.7', { ...fields, additionalTokensClaimed: claimState })
          : claimState === 'missing' ? null : { ...unclaimed, data: Buffer.alloc(1) };
        config.circulating.excludedHolders.push({ mint: MINT.toString(), wallet: RECIPIENT });
        const amount = claimState === true ? 225n : 125n;
        const holderAccounts = [{ pubkey: ACCOUNT_A, info: tokenAccountInfo(RECIPIENT, amount) }];
        (svc as any).futarchyClient = { fetchDao: async () => ({ amm: {} }) };
        (svc as any).connection = {
          getTokenAccountsByOwner: async () => discovery(holderAccounts),
          getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => ({
            context: { slot: 321 },
            value: keys.map(key => {
              if (key.equals(MINT)) return mintAccountInfo(1_000n, 0);
              if (key.equals(launchAddress)) return currentLaunch;
              if (key.equals(ACCOUNT_A)) return holderAccounts[0]!.info;
              return null;
            }),
          }),
        };

        const result = getSupplyInfoWithLaunchpadAllocation(MINT.toString(), new SolanaService(), svc);
        if (typeof claimState === 'boolean') {
          const { supplyInfo } = await result;
          expect(supplyInfo.circulatingSupply).toBe('775');
          expect(supplyInfo.allocation?.additionalTokenAllocation?.claimed).toBe(claimState);
          expect(supplyInfo.allocation?.balanceSnapshotSlot).toBe(321);
        } else {
          await expect(result).rejects.toThrow();
          expect((svc as any).cache.get(`allocation_${MINT}`, config.cache.tickersTTL)).toBeUndefined();
        }
      });
    }

    it('decodes a v0.7 launch, including its additional-token fields', async () => {
      const svc = new LaunchpadService();
      const v07 = await launchAccount(svc, 'v0.7', {
        baseMint: MINT, dao: DAO, performancePackageGrantee: GRANTEE,
        performancePackageTokenAmount: new BN(123), additionalTokensAmount: new BN(456),
        additionalTokensRecipient: RECIPIENT, additionalTokensClaimed: true, state: { complete: {} },
      });

      const launch = (await lookup(svc, v07, null))!;

      expect(launch.version).toBe('v0.7');
      expect(launch.launchAddress.equals(svc.getLaunchAddressV07(MINT))).toBe(true);
      expect(launch.baseMint.equals(MINT)).toBe(true);
      expect(launch.dao!.equals(DAO)).toBe(true);
      expect(launch.performancePackageGrantee.equals(GRANTEE)).toBe(true);
      expect(launch.performancePackageTokenAmount.toString()).toBe('123');
      expect(launch.additionalTokensAmount!.toString()).toBe('456');
      expect(launch.additionalTokensRecipient!.equals(RECIPIENT)).toBe(true);
      expect(launch.additionalTokensClaimed).toBe(true);
      expect(launch.state).toEqual({ complete: {} });
    });

    it('decodes a v0.6 launch at the v0.6 address', async () => {
      const svc = new LaunchpadService();
      const v06 = await launchAccount(svc, 'v0.6', {
        baseMint: MINT, dao: DAO, performancePackageTokenAmount: new BN(789),
      });

      const launch = (await lookup(svc, null, v06))!;

      expect(launch.version).toBe('v0.6');
      expect(launch.launchAddress.equals(svc.getLaunchAddressV06(MINT))).toBe(true);
      expect(launch.dao!.equals(DAO)).toBe(true);
      expect(launch.performancePackageTokenAmount.toString()).toBe('789');
      expect(launch.additionalTokensAmount).toBeUndefined();
    });

    it('prefers the v0.7 launch when both versions exist', async () => {
      const svc = new LaunchpadService();
      const v07 = await launchAccount(svc, 'v0.7', { baseMint: MINT, performancePackageTokenAmount: new BN(7) });
      const v06 = await launchAccount(svc, 'v0.6', { baseMint: MINT, performancePackageTokenAmount: new BN(6) });

      const launch = (await lookup(svc, v07, v06))!;

      expect(launch.version).toBe('v0.7');
      expect(launch.performancePackageTokenAmount.toString()).toBe('7');
    });
  });
});

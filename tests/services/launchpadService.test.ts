/**
 * Regression tests for the allocation snapshot error contract.
 *
 * Mint supply and every live non-circulating balance must come from one
 * contextual RPC batch. Infrastructure failures must reject rather than
 * silently returning zero allocations.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  AccountLayout,
  AccountState,
  getAssociatedTokenAddress,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { PublicKey, type AccountInfo } from '@solana/web3.js';
import BN from 'bn.js';
import { config } from '../../src/config.js';
import { LaunchpadService } from '../../src/services/launchpadService.js';

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
    (svc as any).getFutarchyAmmLiquidity = async () => ({ amount: new BN(0) });
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
  it('resolves no configured holders without RPC when only holder balances are requested', async () => {
    const svc = new LaunchpadService();
    let called = false;
    (svc as any).connection = {
      getTokenAccountsByOwner: async () => {
        called = true;
        return discovery([]);
      },
    };

    expect(await (svc as any).getExcludedHolderBalances(MINT)).toEqual([]);
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

  it('ignores holders configured for another mint without RPC', async () => {
    config.circulating.excludedHolders.push({ mint: OTHER_MINT, wallet: HOLDER });
    const svc = new LaunchpadService();
    let called = false;
    (svc as any).connection = {
      getTokenAccountsByOwner: async () => {
        called = true;
        return discovery([]);
      },
    };

    expect(await (svc as any).getExcludedHolderBalances(MINT)).toEqual([]);
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

  it('bounds allocation cache entries and evicts the oldest entry', () => {
    const svc = new LaunchpadService();

    for (let index = 0; index <= 1000; index++) {
      (svc as any).setCache(`allocation-${index}`, index);
    }

    expect((svc as any).cache.size).toBe(1000);
    expect((svc as any).cache.has('allocation-0')).toBe(false);
    expect((svc as any).cache.get('allocation-1000')?.data).toBe(1000);
  });
});

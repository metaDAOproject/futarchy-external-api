export interface DexScreenerBlock {
  blockNumber: number;
  blockTimestamp: number;
}

export interface DexScreenerAsset {
  id: string;
  name: string;
  symbol: string;
  totalSupply: number;
  circulatingSupply: number;
  coinGeckoId?: string;
  coinMarketCapId?: string;
  metadata?: Record<string, string>;
}

export interface DexScreenerPool {
  id: string;
  name: string;
  assetIds: string[];
  pairIds: string[];
  metadata?: Record<string, string>;
}

export interface DexScreenerPair {
  id: string;
  dexKey: string;
  asset0Id: string;
  asset1Id: string;
  createdAtBlockNumber?: number;
  createdAtBlockTimestamp?: number;
  createdAtTxnId?: string;
  creator?: string;
  feeBps?: number;
  pool?: DexScreenerPool;
  metadata?: Record<string, string>;
}

export interface DexScreenerSwapEvent {
  block: DexScreenerBlock;
  eventType: 'swap';
  txnId: string;
  txnIndex: number;
  eventIndex: number;
  maker: string;
  pairId: string;
  asset0In?: number;
  asset1In?: number;
  asset0Out?: number;
  asset1Out?: number;
  priceNative: number;
  reserves?: {
    asset0: number;
    asset1: number;
  };
  metadata?: Record<string, string>;
}

export interface DexScreenerLatestBlockResponse {
  block: DexScreenerBlock;
}

export interface DexScreenerAssetResponse {
  asset: DexScreenerAsset;
}

export interface DexScreenerPairResponse {
  pair: DexScreenerPair;
}

export interface DexScreenerEventsResponse {
  events: DexScreenerSwapEvent[];
}

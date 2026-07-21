// CoinMarketCap DEX API response types.
//
// Models the endpoints in [Section C] "DEXes" of CoinMarketCap's integration
// requirements. The shapes intentionally mirror our CoinGecko adapter
// (src/routes/coingecko.ts) — CMC's DEX spec is field-for-field close to
// CoinGecko's, so both feeds are built from the same on-chain DAO discovery +
// rolling-24h ETL metrics.
//
// Prices/volumes are numbers here (CMC expects JSON numbers), whereas the
// CoinGecko adapter serves strings. A trading pair is keyed `${baseMint}_${quoteMint}`,
// the same identifier the CoinGecko `ticker_id` uses.

/** One entry in the `/cmc/ticker` object, keyed by the `BASE_QUOTE` trading pair. */
export interface CoinMarketCapTicker {
  base_id: string;
  quote_id: string;
  // Token identity carried INLINE, per CMC's Section C "Uniswap Sample" DEX spec
  // (a DEX has no symbol-keyed listing, so name/symbol travel with the pair). Same
  // values as /cmc/assets keyed by base_id/quote_id — the two feeds stay consistent.
  // Mirrors the sibling CoinGecko /api/tickers adapter, which emits these inline too.
  base_name: string;
  base_symbol: string;
  quote_name: string;
  quote_symbol: string;
  last_price: number;
  base_volume: number;
  quote_volume: number;
  /** 0 = trading, 1 = frozen. Always 0 for an on-chain AMM (never halted). */
  isFrozen: 0 | 1;
}

/** The `/cmc/ticker` response: an object keyed by `BASE_QUOTE`. */
export type CoinMarketCapTickerResponse = Record<string, CoinMarketCapTicker>;

/** One element of the `/cmc/summary` array. */
export interface CoinMarketCapSummaryPair {
  trading_pairs: string;
  base_currency: string;
  quote_currency: string;
  // Market-type discriminator. Always 'spot': getPoolData only ever selects the
  // DAO's spot pool (conditional pass/fail pools are explicitly ignored), so
  // every pair we surface is a spot market.
  type: 'spot';
  last_price: number;
  lowest_ask: number;
  highest_bid: number;
  base_volume: number;
  quote_volume: number;
  // Only reported when a real 24h high/low exists in the ETL window. Omitted
  // (rather than reported as 0) otherwise — a financial feed must not fabricate
  // an extreme. price_change_percent_24h is intentionally absent: we have no
  // reliable 24h-ago open, and reporting a fake 0% would be worse than omitting.
  highest_price_24h?: number;
  lowest_price_24h?: number;
}

/** One entry in the `/cmc/assets` object, keyed by the token's mint address. */
export interface CoinMarketCapAsset {
  name: string;
  symbol: string;
  /** Solana mint address — the token's contract address. */
  contractAddress: string;
  can_withdraw: 'true' | 'false';
  can_deposit: 'true' | 'false';
  maker_fee: number;
  taker_fee: number;
}

/** The `/cmc/assets` response: an object keyed by mint address. */
export type CoinMarketCapAssetsResponse = Record<string, CoinMarketCapAsset>;

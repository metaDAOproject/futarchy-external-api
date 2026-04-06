-- v0.6 OHLCV + Fee Volume Tables
-- Source: external indexer DB (v0_6_spot_swaps, v0_6_conditional_swaps, v0_6_daos, v0_6_proposals)
-- Written to: app DB via hourly reconciliation upserts
--
-- Token key = base_mint_acct from v0_6_daos (same concept as existing daily_volumes.token)
-- All timestamps are TIMESTAMPTZ in UTC
-- All amounts are raw integer units; 6 decimals for human-scale
-- Fee rate: 0.5% (0.005)

-- ============================================
-- 1) Spot OHLCV — 1-minute granularity
-- ============================================
CREATE TABLE IF NOT EXISTS v06_spot_ohlcv_1m (
  id SERIAL PRIMARY KEY,
  token VARCHAR(64) NOT NULL,
  bucket TIMESTAMPTZ NOT NULL,
  open NUMERIC(40, 12) NOT NULL DEFAULT 0,
  high NUMERIC(40, 12) NOT NULL DEFAULT 0,
  low NUMERIC(40, 12) NOT NULL DEFAULT 0,
  close NUMERIC(40, 12) NOT NULL DEFAULT 0,
  average_price NUMERIC(40, 12) NOT NULL DEFAULT 0,
  base_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
  target_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
  buy_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
  sell_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
  trade_count INT NOT NULL DEFAULT 0,
  is_complete BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(token, bucket)
);

CREATE INDEX IF NOT EXISTS idx_v06_spot_ohlcv_1m_token_bucket ON v06_spot_ohlcv_1m(token, bucket DESC);
CREATE INDEX IF NOT EXISTS idx_v06_spot_ohlcv_1m_bucket ON v06_spot_ohlcv_1m(bucket DESC);

-- ============================================
-- 2) Spot OHLCV — daily granularity
-- ============================================
CREATE TABLE IF NOT EXISTS v06_spot_ohlcv_1d (
  id SERIAL PRIMARY KEY,
  token VARCHAR(64) NOT NULL,
  bucket TIMESTAMPTZ NOT NULL,
  open NUMERIC(40, 12) NOT NULL DEFAULT 0,
  high NUMERIC(40, 12) NOT NULL DEFAULT 0,
  low NUMERIC(40, 12) NOT NULL DEFAULT 0,
  close NUMERIC(40, 12) NOT NULL DEFAULT 0,
  average_price NUMERIC(40, 12) NOT NULL DEFAULT 0,
  base_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
  target_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
  buy_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
  sell_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
  trade_count INT NOT NULL DEFAULT 0,
  is_complete BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(token, bucket)
);

CREATE INDEX IF NOT EXISTS idx_v06_spot_ohlcv_1d_token_bucket ON v06_spot_ohlcv_1d(token, bucket DESC);
CREATE INDEX IF NOT EXISTS idx_v06_spot_ohlcv_1d_bucket ON v06_spot_ohlcv_1d(bucket DESC);

-- ============================================
-- 3) Fee breakdown: spot — daily by (token, date)
-- ============================================
CREATE TABLE IF NOT EXISTS v06_fee_volume_daily_spot (
  id SERIAL PRIMARY KEY,
  token VARCHAR(64) NOT NULL,
  date DATE NOT NULL,
  buy_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
  sell_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
  base_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
  target_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
  trade_count INT NOT NULL DEFAULT 0,
  usdc_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
  token_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
  token_fees_usdc NUMERIC(40, 12) NOT NULL DEFAULT 0,
  sell_volume_usdc NUMERIC(40, 12) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(token, date)
);

CREATE INDEX IF NOT EXISTS idx_v06_fee_spot_token_date ON v06_fee_volume_daily_spot(token, date DESC);
CREATE INDEX IF NOT EXISTS idx_v06_fee_spot_date ON v06_fee_volume_daily_spot(date DESC);

-- ============================================
-- 4) Fee breakdown: conditional — daily by (token, date)
--    Fee columns are NULL until the proposal resolves
-- ============================================
CREATE TABLE IF NOT EXISTS v06_fee_volume_daily_conditional (
  id SERIAL PRIMARY KEY,
  token VARCHAR(64) NOT NULL,
  date DATE NOT NULL,
  buy_volume NUMERIC(40, 12),
  sell_volume NUMERIC(40, 12),
  base_volume NUMERIC(40, 12),
  target_volume NUMERIC(40, 12),
  trade_count INT,
  usdc_fees NUMERIC(40, 12),
  token_fees NUMERIC(40, 12),
  token_fees_usdc NUMERIC(40, 12),
  sell_volume_usdc NUMERIC(40, 12),
  conditional_reconciled BOOLEAN NOT NULL DEFAULT false,
  pending_open_proposals INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(token, date)
);

CREATE INDEX IF NOT EXISTS idx_v06_fee_cond_token_date ON v06_fee_volume_daily_conditional(token, date DESC);
CREATE INDEX IF NOT EXISTS idx_v06_fee_cond_date ON v06_fee_volume_daily_conditional(date DESC);

-- ============================================
-- 5) Fee aggregate — primary for accountant
--    Totals = spot + COALESCE(conditional, 0)
-- ============================================
CREATE TABLE IF NOT EXISTS v06_fee_volume_daily_aggregate (
  id SERIAL PRIMARY KEY,
  token VARCHAR(64) NOT NULL,
  date DATE NOT NULL,
  -- Spot breakdown
  spot_buy_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
  spot_sell_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
  spot_base_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
  spot_target_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
  spot_trade_count INT NOT NULL DEFAULT 0,
  spot_usdc_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
  spot_token_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
  spot_token_fees_usdc NUMERIC(40, 12) NOT NULL DEFAULT 0,
  -- Conditional breakdown (nullable until reconciled)
  conditional_buy_volume NUMERIC(40, 12),
  conditional_sell_volume NUMERIC(40, 12),
  conditional_base_volume NUMERIC(40, 12),
  conditional_target_volume NUMERIC(40, 12),
  conditional_trade_count INT,
  conditional_usdc_fees NUMERIC(40, 12),
  conditional_token_fees NUMERIC(40, 12),
  conditional_token_fees_usdc NUMERIC(40, 12),
  -- Totals: spot + COALESCE(conditional, 0)
  total_buy_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
  total_sell_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
  total_base_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
  total_target_volume NUMERIC(40, 12) NOT NULL DEFAULT 0,
  total_trade_count INT NOT NULL DEFAULT 0,
  total_usdc_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
  total_token_fees NUMERIC(40, 12) NOT NULL DEFAULT 0,
  total_token_fees_usdc NUMERIC(40, 12) NOT NULL DEFAULT 0,
  -- Reconciliation status
  conditional_reconciled BOOLEAN NOT NULL DEFAULT false,
  pending_open_proposals INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(token, date)
);

CREATE INDEX IF NOT EXISTS idx_v06_fee_agg_token_date ON v06_fee_volume_daily_aggregate(token, date DESC);
CREATE INDEX IF NOT EXISTS idx_v06_fee_agg_date ON v06_fee_volume_daily_aggregate(date DESC);

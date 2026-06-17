import { describe, it, expect } from 'bun:test';
import BN from 'bn.js';
import { PriceService } from '../../src/services/priceService.js';

describe('PriceService', () => {
  const priceService = new PriceService();

  describe('calculatePrice', () => {
    it('should calculate price correctly for standard reserves', () => {
      const baseReserves = new BN('1000000000000'); // 1000 tokens (9 decimals)
      const quoteReserves = new BN('50000000000');   // 50000 USDC (6 decimals)
      
      const price = priceService.calculatePrice(baseReserves, quoteReserves, 9, 6);
      
      expect(price).not.toBeNull();
      expect(parseFloat(price!)).toBeCloseTo(50, 1); // ~50 USDC per token
    });

    it('should return null for zero base reserves', () => {
      const baseReserves = new BN(0);
      const quoteReserves = new BN('50000000000');
      
      const price = priceService.calculatePrice(baseReserves, quoteReserves, 9, 6);
      
      expect(price).toBeNull();
    });

    it('should return null for zero quote reserves', () => {
      const baseReserves = new BN('1000000000000');
      const quoteReserves = new BN(0);
      
      const price = priceService.calculatePrice(baseReserves, quoteReserves, 9, 6);
      
      expect(price).toBeNull();
    });

    it('should return null for null reserves', () => {
      const price = priceService.calculatePrice(null as any, null as any, 9, 6);
      expect(price).toBeNull();
    });

    it('should handle equal decimals', () => {
      const baseReserves = new BN('1000000000');
      const quoteReserves = new BN('2000000000');
      
      const price = priceService.calculatePrice(baseReserves, quoteReserves, 9, 9);
      
      expect(price).not.toBeNull();
      expect(parseFloat(price!)).toBeCloseTo(2, 5);
    });

    it('should handle different decimal configurations', () => {
      // Use smaller numbers that fit in 53 bits
      // 1000 tokens with 9 decimals, 500 USDC with 6 decimals
      const baseReserves = new BN('1000000000000'); // 1000 * 10^9
      const quoteReserves = new BN('500000000');     // 500 * 10^6
      
      const price = priceService.calculatePrice(baseReserves, quoteReserves, 9, 6);
      
      expect(price).not.toBeNull();
      expect(parseFloat(price!)).toBeCloseTo(0.5, 2);
    });
  });

  describe('calculateSpread', () => {
    it('should calculate bid and ask with default spread', () => {
      const spread = priceService.calculateSpread(100);
      
      expect(spread).not.toBeNull();
      expect(parseFloat(spread!.bid)).toBeCloseTo(99.5, 1); // 0.5% below
      expect(parseFloat(spread!.ask)).toBeCloseTo(100.5, 1); // 0.5% above
    });

    it('should calculate bid and ask with custom spread', () => {
      const spread = priceService.calculateSpread(100, 100); // 1% spread
      
      expect(spread).not.toBeNull();
      expect(parseFloat(spread!.bid)).toBeCloseTo(99, 1);
      expect(parseFloat(spread!.ask)).toBeCloseTo(101, 1);
    });

    it('should return null for zero price', () => {
      const spread = priceService.calculateSpread(0);
      expect(spread).toBeNull();
    });

    it('should return null for negative price', () => {
      const spread = priceService.calculateSpread(-100);
      expect(spread).toBeNull();
    });

    it('should return null for NaN price', () => {
      const spread = priceService.calculateSpread(NaN);
      expect(spread).toBeNull();
    });

    it('should return null for Infinity', () => {
      const spread = priceService.calculateSpread(Infinity);
      expect(spread).toBeNull();
    });
  });

  describe('calculateLiquidityUSD', () => {
    it('should calculate liquidity correctly', () => {
      const quoteReserves = new BN('50000000000'); // 50000 USDC
      
      const liquidity = priceService.calculateLiquidityUSD(quoteReserves, 6);
      
      expect(liquidity).not.toBeNull();
      expect(parseFloat(liquidity!)).toBeCloseTo(100000, 0); // 2x quote reserves
    });

    it('should return null for null reserves', () => {
      const liquidity = priceService.calculateLiquidityUSD(null as any, 6);
      expect(liquidity).toBeNull();
    });

    it('should handle zero reserves', () => {
      const quoteReserves = new BN(0);
      const liquidity = priceService.calculateLiquidityUSD(quoteReserves, 6);
      
      expect(liquidity).not.toBeNull();
      expect(liquidity).toBe('0.00');
    });
  });
});

import BN from 'bn.js';

export class PriceService {
  calculatePrice(
    baseReserves: BN, 
    quoteReserves: BN, 
    baseDecimals: number, 
    quoteDecimals: number
  ): string | null {
    // Validate inputs
    if (!baseReserves || !quoteReserves) {
      return null;
    }

    const baseReservesNum = baseReserves.toNumber();
    const quoteReservesNum = quoteReserves.toNumber();

    // Check for zero or invalid reserves
    if (baseReservesNum === 0 || quoteReservesNum === 0 || 
        !isFinite(baseReservesNum) || !isFinite(quoteReservesNum) ||
        isNaN(baseReservesNum) || isNaN(quoteReservesNum)) {
      return null;
    }

    // Price = quoteReserves / baseReserves, adjusted for decimals
    const decimalAdjustment = Math.pow(
      10,
      baseDecimals - quoteDecimals
    );
    
    const price = (quoteReservesNum / baseReservesNum) * decimalAdjustment;
    
    // Validate calculated price
    if (!isFinite(price) || isNaN(price) || price <= 0) {
      return null;
    }
    
    return price.toFixed(12);
  }

  calculateSpread(price: number, spreadBps: number = 50): { bid: string; ask: string } | null {
    // Validate price
    if (!isFinite(price) || isNaN(price) || price <= 0) {
      return null;
    }

    // spreadBps = 50 means 0.5%
    const spreadPercent = spreadBps / 10000;
    const bid = price * (1 - spreadPercent);
    const ask = price * (1 + spreadPercent);
    
    // Validate results
    if (!isFinite(bid) || !isFinite(ask) || isNaN(bid) || isNaN(ask)) {
      return null;
    }
    
    return {
      bid: bid.toFixed(12),
      ask: ask.toFixed(12),
    };
  }

  calculateLiquidityUSD(quoteReserves: BN, quoteDecimals: number): string | null {
    if (!quoteReserves) {
      return null;
    }

    const quoteReservesNum = quoteReserves.toNumber();
    
    // Validate reserves
    if (!isFinite(quoteReservesNum) || isNaN(quoteReservesNum) || quoteReservesNum < 0) {
      return null;
    }

    // For stablecoin pairs, liquidity = 2 * quoteReserves
    const liquidity = (quoteReservesNum * 2) / Math.pow(10, quoteDecimals);
    
    // Validate result
    if (!isFinite(liquidity) || isNaN(liquidity) || liquidity < 0) {
      return null;
    }
    
    return liquidity.toFixed(2);
  }

}
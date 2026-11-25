import type { MarketInstrument, Timeframe } from '../types/market.ts';

export const PRIMARY_SYMBOL = 'XAU/USD';

export const MARKET_INSTRUMENTS: MarketInstrument[] = [
  {
    symbol: 'XAU/USD',
    name: 'Gold Spot',
    category: 'Metals',
    decimals: 2,
    basePrice: 3527.0,
    volatilityBps: 14,
    description: 'Spot Gold vs US Dollar',
  },
];

export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  '1M': 60,
  '5M': 300,
  '15M': 900,
  '1H': 3600,
  '4H': 14400,
};

export const TIMEFRAMES: Timeframe[] = ['1M', '5M', '15M', '1H', '4H'];

export function getInstrumentBySymbol(symbol: string): MarketInstrument {
  return (
    MARKET_INSTRUMENTS.find((item) => item.symbol === symbol) ?? MARKET_INSTRUMENTS[0]
  );
}

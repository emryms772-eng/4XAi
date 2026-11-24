import type { MarketInstrument, Timeframe } from '../types/market.ts';

export const MARKET_INSTRUMENTS: MarketInstrument[] = [
  {
    symbol: 'XAU/USD',
    name: 'Gold Spot',
    category: 'Metals',
    decimals: 2,
    basePrice: 2664.50,
    volatilityBps: 14,
    description: 'Spot Gold vs US Dollar',
  },
  {
    symbol: 'EUR/USD',
    name: 'Euro / US Dollar',
    category: 'Forex',
    decimals: 5,
    basePrice: 1.08425,
    volatilityBps: 7,
    description: 'Major G10 FX pair',
  },
  {
    symbol: 'GBP/USD',
    name: 'British Pound / US Dollar',
    category: 'Forex',
    decimals: 5,
    basePrice: 1.26780,
    volatilityBps: 9,
    description: 'Cable spot FX pair',
  },
  {
    symbol: 'VOL_75',
    name: 'Volatility 75 Index',
    category: 'Synthetic',
    decimals: 2,
    basePrice: 148920.40,
    volatilityBps: 26,
    description: 'Continuous 75% annualized synthetic volatility index',
  },
  {
    symbol: 'VOL_100',
    name: 'Volatility 100 Index',
    category: 'Synthetic',
    decimals: 2,
    basePrice: 2845.65,
    volatilityBps: 32,
    description: 'Continuous 100% annualized synthetic volatility index',
  },
  {
    symbol: 'BTC/USD',
    name: 'Bitcoin / US Dollar',
    category: 'Digital',
    decimals: 2,
    basePrice: 94280.00,
    volatilityBps: 24,
    description: 'Spot Bitcoin benchmark',
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

export type MarketCategory = 'Metals' | 'Forex' | 'Synthetic' | 'Digital';

export type Timeframe = '1M' | '5M' | '15M' | '1H' | '4H';

export interface MarketInstrument {
  symbol: string;
  name: string;
  category: MarketCategory;
  decimals: number;
  basePrice: number;
  volatilityBps: number;
  description: string;
}

export interface OHLCVCandle {
  time: number; // Unix timestamp in seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type FeedOrigin = 'live-api' | 'simulated-live';

export interface MarketCandlesResponse {
  symbol: string;
  timeframe: Timeframe;
  decimals: number;
  source: FeedOrigin;
  sourceLabel: string;
  candles: OHLCVCandle[];
}

export interface MarketTickEvent {
  symbol: string;
  timeframe: Timeframe;
  price: number;
  bid: number;
  ask: number;
  changePct: number;
  source: FeedOrigin;
  candle: OHLCVCandle;
  timestamp: number;
}

export interface WatchlistQuote {
  symbol: string;
  name: string;
  category: MarketCategory;
  decimals: number;
  price: number;
  changePct: number;
  high24h: number;
  low24h: number;
  structureHint?: string;
  recentPattern?: string;
}

export interface KeyLevel {
  id: string;
  price: number;
  type: 'Support' | 'Resistance';
  strength: 'Major' | 'Minor';
  touches: number;
  distancePct: number;
}

export interface PriceActionZone {
  id: string;
  kind: 'Demand OB' | 'Supply OB' | 'Bullish FVG' | 'Bearish FVG';
  low: number;
  high: number;
  midpoint: number;
  time: number;
  mitigated: boolean;
  distancePct: number;
}

export interface PriceActionMarker {
  time: number;
  position: 'aboveBar' | 'belowBar';
  color: string;
  shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square';
  text: string;
  kind: 'BOS' | 'CHoCH' | 'Sweep' | 'Engulfing' | 'PinBar';
}

export interface CandlePatternEvent {
  time: number;
  name: string;
  bias: 'Bullish' | 'Bearish' | 'Neutral';
  description: string;
}

export interface PriceActionSnapshot {
  trendStructure: 'Bullish (HH / HL)' | 'Bearish (LH / LL)' | 'Ranging / Choppy';
  latestStructureEvent: 'Bullish BOS' | 'Bearish BOS' | 'Bullish CHoCH' | 'Bearish CHoCH' | 'Inside Range';
  dealingRangeHigh: number;
  dealingRangeLow: number;
  equilibriumPrice: number;
  rangePositionPct: number;
  rangeZone: 'Discount' | 'Equilibrium' | 'Premium';
  avgCandleRange: number;
  avgRangePct: number;
  recentSweep: 'Buy-Side Sweep (Bearish)' | 'Sell-Side Sweep (Bullish)' | 'None';
  latestPattern: CandlePatternEvent | null;
  buyerPressurePct: number;
  unmitigatedFvgCount: number;
  activeOrderBlockCount: number;
}

export interface PriceActionAnalysisSummary {
  snapshot: PriceActionSnapshot;
  levels: KeyLevel[];
  zones: PriceActionZone[];
  markers: PriceActionMarker[];
  recentPatterns: CandlePatternEvent[];
}

export interface PriceActionSignalPlan {
  signal: 'BUY' | 'SELL' | 'WAIT';
  signalStrength: 'A+ Setup' | 'Standard' | 'Developing';
  setupType: string;
  triggerPattern: string;
  entryPrice: number;
  entryZone: string;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  riskRewardRatio: string;
  invalidationReason: string;
  confluences: string[];
}

export interface AIPriceActionSignal {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  analyzedAt: string;
  model: string;
  spotPriceAtSignal: number;
  bias: 'Bullish' | 'Bearish' | 'Neutral';
  priceActionNarrative: string;
  keyZonesExplanation: string;
  plan: PriceActionSignalPlan;
}

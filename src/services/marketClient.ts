import type {
  AIPriceActionSignal,
  MarketCandlesResponse,
  MarketTickEvent,
  OHLCVCandle,
  PriceActionAnalysisSummary,
  Timeframe,
  WatchlistQuote,
} from '../types/market';

export interface CandlesPayload extends MarketCandlesResponse {
  priceAction: PriceActionAnalysisSummary;
}

export interface SignalResponse {
  priceAction: PriceActionAnalysisSummary;
  signal: AIPriceActionSignal;
}

export async function fetchWatchlistQuotes(): Promise<WatchlistQuote[]> {
  const res = await fetch('/api/market/watchlist');
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to load watchlist quotes');
  }
  const data = (await res.json()) as { quotes: WatchlistQuote[] };
  return data.quotes;
}

export async function fetchMarketCandles(
  symbol: string,
  timeframe: Timeframe,
  limit = 180
): Promise<CandlesPayload> {
  const params = new URLSearchParams({
    symbol,
    timeframe,
    limit: String(limit),
  });
  const res = await fetch(`/api/market/candles?${params.toString()}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to load market candles');
  }
  return (await res.json()) as CandlesPayload;
}

export function subscribeMarketStream(
  symbol: string,
  timeframe: Timeframe,
  onTick: (tick: MarketTickEvent) => void,
  onConnectionChange: (connected: boolean) => void
): () => void {
  const params = new URLSearchParams({ symbol, timeframe });
  const source = new EventSource(`/api/market/stream?${params.toString()}`);

  source.onopen = () => {
    onConnectionChange(true);
  };

  source.onmessage = (event) => {
    try {
      const tick = JSON.parse(event.data) as MarketTickEvent;
      onConnectionChange(true);
      onTick(tick);
    } catch {
      // Ignore malformed frame
    }
  };

  source.onerror = () => {
    onConnectionChange(false);
  };

  return () => {
    onConnectionChange(false);
    source.close();
  };
}

export async function requestPriceActionSignal(params: {
  symbol: string;
  timeframe: Timeframe;
  candles: OHLCVCandle[];
}): Promise<SignalResponse> {
  const res = await fetch('/api/analysis/signal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Failed to generate AI price-action signal');
  }
  return data as SignalResponse;
}

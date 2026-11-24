import { analyzePriceAction } from '../../src/analysis/priceAction.ts';
import { TIMEFRAMES, getInstrumentBySymbol } from '../../src/config/instruments.ts';
import { generatePriceActionSignal } from '../../src/server/aiAnalysis.ts';
import { getMarketCandles } from '../../src/server/marketData.ts';
import type { OHLCVCandle, Timeframe } from '../../src/types/market.ts';

interface ServerlessRequest {
  method?: string;
  body?: unknown;
}

interface ServerlessResponse {
  status: (code: number) => ServerlessResponse;
  json: (body: unknown) => void;
}

function parseTimeframe(raw: unknown): Timeframe {
  if (typeof raw === 'string' && TIMEFRAMES.includes(raw as Timeframe)) {
    return raw as Timeframe;
  }
  return '5M';
}

export default async function handler(
  req: ServerlessRequest,
  res: ServerlessResponse
) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = (
      typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {}
    ) as {
      symbol?: unknown;
      timeframe?: unknown;
      candles?: unknown;
    };

    const symbol = typeof body.symbol === 'string' ? body.symbol : 'XAU/USD';
    const timeframe = parseTimeframe(body.timeframe);
    const instrument = getInstrumentBySymbol(symbol);

    let candles: OHLCVCandle[] = Array.isArray(body.candles)
      ? (body.candles as OHLCVCandle[])
      : [];

    if (candles.length < 30) {
      const loaded = await getMarketCandles(instrument.symbol, timeframe, 180);
      candles = loaded.candles;
    }

    const priceAction = analyzePriceAction(candles, instrument.decimals);
    const signal = await generatePriceActionSignal({
      symbol: instrument.symbol,
      timeframe,
      candles,
      snapshot: priceAction.snapshot,
      levels: priceAction.levels,
      zones: priceAction.zones,
      recentPatterns: priceAction.recentPatterns,
    });

    res.status(200).json({ priceAction, signal });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unable to generate AI price-action signal.';
    const status = message.includes('GEMINI_API_KEY') ? 400 : 500;
    res.status(status).json({ error: message });
  }
}

import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { TIMEFRAMES, getInstrumentBySymbol } from '../config/instruments.ts';
import type {
  AIPriceActionSignal,
  OHLCVCandle,
  PriceActionAnalysisSummary,
  Timeframe,
  TimeframeAlignmentItem,
} from '../types/market.ts';

const MODEL_NAME = 'gemini-4-hydrogen';

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error(
      'GEMINI_API_KEY is not configured. Add a valid key in Settings > Secrets (or Vercel Environment Variables) to generate AI price-action signals.'
    );
  }

  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export interface TimeframePriceActionInput {
  timeframe: Timeframe;
  candles: OHLCVCandle[];
  analysis: PriceActionAnalysisSummary;
}

function normalizeTimeframe(raw: string, fallback: Timeframe): Timeframe {
  const upper = raw.trim().toUpperCase();
  if (TIMEFRAMES.includes(upper as Timeframe)) {
    return upper as Timeframe;
  }
  return fallback;
}

export async function generatePriceActionSignal(params: {
  symbol: string;
  activeTimeframe: Timeframe;
  timeframesData: TimeframePriceActionInput[];
}): Promise<AIPriceActionSignal> {
  const { symbol, activeTimeframe, timeframesData } = params;
  const instrument = getInstrumentBySymbol(symbol);
  const ai = getGeminiClient();

  const activeEntry =
    timeframesData.find((t) => t.timeframe === activeTimeframe) ??
    timeframesData[0];

  const currentPrice =
    activeEntry.candles[activeEntry.candles.length - 1]?.close ??
    instrument.basePrice;

  // Provide top-down summary for all 5 timeframes + raw OHLC sequences for 4H, 1H, 15M, 5M, 1M
  const multiTimeframeContext = timeframesData.map((tfItem) => ({
    timeframe: tfItem.timeframe,
    structure: tfItem.analysis.snapshot,
    supportResistanceLevels: tfItem.analysis.levels.slice(0, 4),
    imbalancesAndOrderBlocks: tfItem.analysis.zones.slice(0, 4),
    recentCandlestickPatterns: tfItem.analysis.recentPatterns.slice(0, 4),
    recentOHLC: tfItem.candles.slice(tfItem.timeframe === activeTimeframe ? -24 : -12).map((c) => ({
      t: new Date(c.time * 1000).toISOString().slice(11, 16),
      o: c.open,
      h: c.high,
      l: c.low,
      c: c.close,
    })),
  }));

  const payload = {
    instrument: {
      symbol: instrument.symbol,
      name: instrument.name,
      category: instrument.category,
      decimals: instrument.decimals,
    },
    activeChartTimeframe: activeTimeframe,
    currentPrice,
    multiTimeframePriceAction: multiTimeframeContext,
  };

  const systemInstruction = [
    'You are an institutional top-down multi-timeframe pure price-action analyst.',
    'You are given pure OHLC price action across ALL 5 timeframes (1M, 5M, 15M, 1H, 4H) with zero lagging indicators.',
    'Perform a top-down analysis: evaluate higher-timeframe structure and liquidity (4H and 1H), mid-timeframe Order Blocks and FVGs (15M), and lower-timeframe execution triggers like CHoCH, BOS, liquidity sweeps, engulfings, and pin bars (5M and 1M).',
    'CRITICAL RULE: Do NOT use, mention, or rely on lagging indicators such as RSI, MACD, EMA, SMA, Stochastics, or Bollinger Bands.',
    'Select the single best signalTimeframe (one of: 1M, 5M, 15M, 1H, 4H) where the cleanest price-action entry trigger and risk-to-reward setup is currently aligned.',
    'Provide a concise timeframeAlignment array covering all 5 timeframes (4H, 1H, 15M, 5M, 1M).',
    `All price levels must be realistic relative to currentPrice (${currentPrice}) and rounded to ${instrument.decimals} decimal places.`,
    'For a BUY signal: stopLoss < entryPrice < takeProfit1 < takeProfit2.',
    'For a SELL signal: takeProfit2 < takeProfit1 < entryPrice < stopLoss.',
    'If multi-timeframe structure conflicts with no clean risk-reward edge, output signal "WAIT" and explain which timeframe level needs to break or sweep first.',
    'Never promise guaranteed profits.',
  ].join(' ');

  const response = await ai.models.generateContent({
    model: MODEL_NAME,
    contents: `Analyze all 5 timeframes (1M, 5M, 15M, 1H, 4H) of pure OHLC price action and output a multi-timeframe signal:\n${JSON.stringify(
      payload
    )}`,
    config: {
      systemInstruction,
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          bias: {
            type: Type.STRING,
            description: 'Overall multi-timeframe bias: Bullish, Bearish, or Neutral.',
          },
          signalTimeframe: {
            type: Type.STRING,
            description:
              'Best execution timeframe for this signal: 1M, 5M, 15M, 1H, or 4H.',
          },
          priceActionNarrative: {
            type: Type.STRING,
            description:
              '2-3 sentences explaining top-down alignment from 4H/1H structure down to the chosen execution timeframe trigger without lagging indicators.',
          },
          keyZonesExplanation: {
            type: Type.STRING,
            description:
              '2 sentences explaining the key HTF/LTF Order Blocks, Fair Value Gaps, liquidity pools, and S/R zones.',
          },
          timeframeAlignment: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                timeframe: {
                  type: Type.STRING,
                  description: 'Timeframe: 4H, 1H, 15M, 5M, or 1M.',
                },
                bias: {
                  type: Type.STRING,
                  description: 'Bullish, Bearish, or Neutral.',
                },
                structureEvent: {
                  type: Type.STRING,
                  description: 'Latest structure read, e.g. Bullish BOS, Bearish CHoCH, Range.',
                },
                rangeZone: {
                  type: Type.STRING,
                  description: 'Discount, Equilibrium, or Premium.',
                },
                note: {
                  type: Type.STRING,
                  description: 'Brief 4-8 word price-action takeaway for this timeframe.',
                },
              },
              required: ['timeframe', 'bias', 'structureEvent', 'rangeZone', 'note'],
            },
            description: 'All 5 timeframes ordered 4H, 1H, 15M, 5M, 1M.',
          },
          plan: {
            type: Type.OBJECT,
            properties: {
              signal: {
                type: Type.STRING,
                description: 'Actionable signal: BUY, SELL, or WAIT.',
              },
              signalStrength: {
                type: Type.STRING,
                description: 'A+ Setup, Standard, or Developing.',
              },
              setupType: {
                type: Type.STRING,
                description: 'Price action setup archetype.',
              },
              triggerPattern: {
                type: Type.STRING,
                description: 'Candlestick or structural trigger observed.',
              },
              entryPrice: {
                type: Type.NUMBER,
                description: 'Primary signal entry price.',
              },
              entryZone: {
                type: Type.STRING,
                description: 'Formatted entry zone string.',
              },
              stopLoss: {
                type: Type.NUMBER,
                description: 'Structural invalidation stop-loss price.',
              },
              takeProfit1: {
                type: Type.NUMBER,
                description: 'First liquidity/structure target price.',
              },
              takeProfit2: {
                type: Type.NUMBER,
                description: 'Extended swing target price.',
              },
              riskRewardRatio: {
                type: Type.STRING,
                description: 'Risk to reward ratio, e.g. 1 : 2.6',
              },
              invalidationReason: {
                type: Type.STRING,
                description: 'Exact candle close or structural break invalidating the setup.',
              },
              confluences: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: '3 to 4 pure price-action confluences across timeframes.',
              },
            },
            required: [
              'signal',
              'signalStrength',
              'setupType',
              'triggerPattern',
              'entryPrice',
              'entryZone',
              'stopLoss',
              'takeProfit1',
              'takeProfit2',
              'riskRewardRatio',
              'invalidationReason',
              'confluences',
            ],
          },
        },
        required: [
          'bias',
          'signalTimeframe',
          'priceActionNarrative',
          'keyZonesExplanation',
          'timeframeAlignment',
          'plan',
        ],
      },
    },
  });

  const rawText = (response.text ?? '').trim();
  if (!rawText) {
    throw new Error('Gemini returned an empty price-action signal response.');
  }

  const parsed = JSON.parse(rawText) as {
    bias: 'Bullish' | 'Bearish' | 'Neutral';
    signalTimeframe: string;
    priceActionNarrative: string;
    keyZonesExplanation: string;
    timeframeAlignment: TimeframeAlignmentItem[];
    plan: AIPriceActionSignal['plan'];
  };

  const resolvedSignalTf = normalizeTimeframe(
    parsed.signalTimeframe || activeTimeframe,
    activeTimeframe
  );

  return {
    id: `sig-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    symbol: instrument.symbol,
    timeframe: activeTimeframe,
    signalTimeframe: resolvedSignalTf,
    analyzedAt: new Date().toISOString(),
    model: MODEL_NAME,
    spotPriceAtSignal: currentPrice,
    bias: parsed.bias,
    priceActionNarrative: parsed.priceActionNarrative,
    keyZonesExplanation: parsed.keyZonesExplanation,
    timeframeAlignment: (parsed.timeframeAlignment ?? []).map((item) => ({
      ...item,
      timeframe: normalizeTimeframe(item.timeframe, activeTimeframe),
    })),
    plan: parsed.plan,
  };
}

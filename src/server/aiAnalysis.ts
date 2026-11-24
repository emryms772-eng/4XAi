import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { getInstrumentBySymbol } from '../config/instruments.ts';
import type {
  AIPriceActionSignal,
  CandlePatternEvent,
  KeyLevel,
  OHLCVCandle,
  PriceActionSnapshot,
  PriceActionZone,
  Timeframe,
} from '../types/market.ts';

const MODEL_NAME = 'gemini-4-hydrogen';

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error(
      'GEMINI_API_KEY is not configured. Add a valid key in Settings > Secrets to generate AI price-action signals.'
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

export async function generatePriceActionSignal(params: {
  symbol: string;
  timeframe: Timeframe;
  candles: OHLCVCandle[];
  snapshot: PriceActionSnapshot;
  levels: KeyLevel[];
  zones: PriceActionZone[];
  recentPatterns: CandlePatternEvent[];
}): Promise<AIPriceActionSignal> {
  const { symbol, timeframe, candles, snapshot, levels, zones, recentPatterns } =
    params;
  const instrument = getInstrumentBySymbol(symbol);
  const ai = getGeminiClient();

  const recentCandles = candles.slice(-32).map((c) => ({
    t: new Date(c.time * 1000).toISOString().slice(11, 16),
    o: c.open,
    h: c.high,
    l: c.low,
    c: c.close,
  }));

  const currentPrice = candles[candles.length - 1]?.close ?? instrument.basePrice;

  const priceActionContext = {
    instrument: {
      symbol: instrument.symbol,
      name: instrument.name,
      category: instrument.category,
      decimals: instrument.decimals,
    },
    timeframe,
    currentPrice,
    structure: snapshot,
    supportResistanceLevels: levels,
    imbalancesAndOrderBlocks: zones,
    candlestickPatterns: recentPatterns,
    rawOHLCSequence: recentCandles,
  };

  const systemInstruction = [
    'You are an institutional pure price-action trading analyst.',
    'Analyze the market strictly using pure price action: raw OHLC candle sequence, swing structure (HH/HL, LH/LL), Breaks of Structure (BOS), Change of Character (CHoCH), Liquidity Sweeps, Supply/Demand Order Blocks, Fair Value Gaps (FVG), Support/Resistance flips, and Premium vs Discount dealing range equilibrium.',
    'CRITICAL RULE: Do NOT use, mention, or rely on lagging indicators such as RSI, MACD, EMA, SMA, Stochastics, or Bollinger Bands.',
    `All price levels must be realistic relative to currentPrice (${currentPrice}) and rounded to ${instrument.decimals} decimal places.`,
    'For a BUY signal: stopLoss < entryPrice < takeProfit1 < takeProfit2.',
    'For a SELL signal: takeProfit2 < takeProfit1 < entryPrice < stopLoss.',
    'If price is trapped mid-range with conflicting order flow and poor risk-to-reward, output signal "WAIT" and specify the exact breakout or sweep trigger levels to watch.',
    'Never promise guaranteed profits.',
  ].join(' ');

  const response = await ai.models.generateContent({
    model: MODEL_NAME,
    contents: `Study this pure OHLC price-action context and output a structured trading signal:\n${JSON.stringify(
      priceActionContext
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
            description: 'Overall pure price-action bias: Bullish, Bearish, or Neutral.',
          },
          priceActionNarrative: {
            type: Type.STRING,
            description:
              '2-3 sentences analyzing the raw candle sequence, swing structure (BOS/CHoCH), liquidity sweeps, and Premium/Discount positioning without mentioning lagging indicators.',
          },
          keyZonesExplanation: {
            type: Type.STRING,
            description:
              '2 sentences explaining the active Order Blocks, Fair Value Gaps (FVG), and Support/Resistance zones driving this setup.',
          },
          plan: {
            type: Type.OBJECT,
            properties: {
              signal: {
                type: Type.STRING,
                description: 'Actionable signal classification: BUY, SELL, or WAIT.',
              },
              signalStrength: {
                type: Type.STRING,
                description: 'Signal quality grade: A+ Setup, Standard, or Developing.',
              },
              setupType: {
                type: Type.STRING,
                description:
                  'Price action setup archetype, e.g. Liquidity Sweep Reversal, BOS Pullback to Demand, FVG Mitigation, or Range Rejection.',
              },
              triggerPattern: {
                type: Type.STRING,
                description:
                  'Specific candlestick or structural trigger observed, e.g. Sell-Side Sweep + Bullish Engulfing.',
              },
              entryPrice: {
                type: Type.NUMBER,
                description: 'Primary signal entry price.',
              },
              entryZone: {
                type: Type.STRING,
                description: 'Formatted entry zone range string.',
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
                description:
                  'Exact candle close or structural break that invalidates this signal.',
              },
              confluences: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description:
                  '3 to 4 pure price-action confluences (no lagging indicators).',
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
          'priceActionNarrative',
          'keyZonesExplanation',
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
    priceActionNarrative: string;
    keyZonesExplanation: string;
    plan: AIPriceActionSignal['plan'];
  };

  return {
    id: `sig-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    symbol: instrument.symbol,
    timeframe,
    analyzedAt: new Date().toISOString(),
    model: MODEL_NAME,
    spotPriceAtSignal: currentPrice,
    bias: parsed.bias,
    priceActionNarrative: parsed.priceActionNarrative,
    keyZonesExplanation: parsed.keyZonesExplanation,
    plan: parsed.plan,
  };
}

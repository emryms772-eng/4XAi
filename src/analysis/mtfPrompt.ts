import { TIMEFRAMES, getInstrumentBySymbol } from '../config/instruments.ts';
import type {
  AIBacktestReview,
  AIPriceActionSignal,
  BacktestResult,
  MarketDriverAssessment,
  MarketDriverVerdict,
  MarketScoutContext,
  OHLCVCandle,
  PriceActionAnalysisSummary,
  Timeframe,
  TimeframeAlignmentItem,
} from '../types/market.ts';
import { evaluateAllFiveDrivers } from './marketContext.ts';
import {
  extractHistoricalPriceActionTimeline,
  getClosedCandlesForTimeframe,
} from './priceAction.ts';

export interface TimeframePriceActionInput {
  timeframe: Timeframe;
  candles: OHLCVCandle[];
  analysis: PriceActionAnalysisSummary;
}

export interface RawSignalJSON {
  bias: 'Bullish' | 'Bearish' | 'Neutral';
  signalTimeframe: string;
  priceActionNarrative: string;
  keyZonesExplanation: string;
  timeframeAlignment: TimeframeAlignmentItem[];
  marketDrivers?: MarketDriverAssessment[];
  confirmingFactors?: string[];
  conflictingFactors?: string[];
  requiredChecks?: string[];
  plan: AIPriceActionSignal['plan'];
}

export interface RawBacktestReviewJSON {
  verdict: 'Strong Edge' | 'Moderate Edge' | 'Needs Filtering';
  summary: string;
  bestPerformingPattern: string;
  keyWeakness: string;
  recommendations: string[];
}

export function normalizeTimeframe(raw: string, fallback: Timeframe): Timeframe {
  const upper = String(raw ?? '').trim().toUpperCase();
  if (TIMEFRAMES.includes(upper as Timeframe)) {
    return upper as Timeframe;
  }
  return fallback;
}

export function parseJsonFromModelText<T>(raw: string): T {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1)) as T;
    }
    throw new Error('Model response was not valid JSON.');
  }
}

export const SIGNAL_JSON_SCHEMA_HINT = `Return ONLY valid JSON matching this exact shape (no markdown, no extra text):
{
  "bias": "Bullish" | "Bearish" | "Neutral",
  "signalTimeframe": "5M",
  "priceActionNarrative": "string",
  "keyZonesExplanation": "string",
  "timeframeAlignment": [
    { "timeframe": "4H"|"1H"|"15M"|"5M"|"1M", "bias": "Bullish"|"Bearish"|"Neutral", "structureEvent": "string", "rangeZone": "Discount"|"Equilibrium"|"Premium", "note": "string" }
  ],
  "marketDrivers": [
    { "id": 1, "driver": "1. Supply, Demand, Liquidity & Session Flow", "verdict": "Bullish"|"Bearish"|"Neutral"|"Conflicting"|"Missing Data", "summary": "string", "evidence": ["string"] },
    { "id": 2, "driver": "2. Macroeconomic Catalysts & Central Bank Policy", "verdict": "Bullish"|"Bearish"|"Neutral"|"Conflicting"|"Missing Data", "summary": "string", "evidence": ["string"] },
    { "id": 3, "driver": "3. Asset / Instrument Fundamentals", "verdict": "Bullish"|"Bearish"|"Neutral"|"Conflicting"|"Missing Data", "summary": "string", "evidence": ["string"] },
    { "id": 4, "driver": "4. Market Sentiment & Risk Environment", "verdict": "Bullish"|"Bearish"|"Neutral"|"Conflicting"|"Missing Data", "summary": "string", "evidence": ["string"] },
    { "id": 5, "driver": "5. Technical Structure & Market Mechanics", "verdict": "Bullish"|"Bearish"|"Neutral"|"Conflicting"|"Missing Data", "summary": "string", "evidence": ["string"] }
  ],
  "confirmingFactors": ["string"],
  "conflictingFactors": ["string"],
  "requiredChecks": ["string"],
  "plan": {
    "signal": "BUY" | "SELL" | "WAIT",
    "signalStrength": "A+ Setup" | "Standard" | "Developing",
    "setupType": "string",
    "triggerPattern": "string",
    "entryPrice": number,
    "entryZone": "string",
    "stopLoss": number,
    "takeProfit1": number,
    "takeProfit2": number,
    "riskRewardRatio": "string",
    "invalidationReason": "string",
    "confluences": ["string", "string", "string"]
  }
}`;

export const BACKTEST_JSON_SCHEMA_HINT = `Return ONLY valid JSON matching this exact shape (no markdown, no extra text):
{
  "verdict": "Strong Edge" | "Moderate Edge" | "Needs Filtering",
  "summary": "string",
  "bestPerformingPattern": "string",
  "keyWeakness": "string",
  "recommendations": ["string", "string", "string"]
}`;

export function buildMtfSignalPrompt(params: {
  symbol: string;
  activeTimeframe: Timeframe;
  timeframesData: TimeframePriceActionInput[];
  scoutContext?: MarketScoutContext | null;
}) {
  const { symbol, activeTimeframe, timeframesData, scoutContext } = params;
  const instrument = getInstrumentBySymbol(symbol);

  const m5Entry =
    timeframesData.find((t) => t.timeframe === '5M') ??
    timeframesData.find((t) => t.timeframe === activeTimeframe) ??
    timeframesData[0];

  const m5ClosedCandles = getClosedCandlesForTimeframe(m5Entry.candles, '5M');
  const confirmedBarTime = m5ClosedCandles[m5ClosedCandles.length - 1]?.time ?? 0;
  const currentPrice =
    m5ClosedCandles[m5ClosedCandles.length - 1]?.close ??
    m5Entry.candles[m5Entry.candles.length - 1]?.close ??
    instrument.basePrice;

  const multiTimeframeContext = timeframesData.map((tfItem) => {
    const closedCandles = getClosedCandlesForTimeframe(
      tfItem.candles,
      tfItem.timeframe
    );
    const timeline = extractHistoricalPriceActionTimeline(
      tfItem.candles,
      instrument.decimals,
      { timeframe: tfItem.timeframe }
    );
    const recentBarCount =
      tfItem.timeframe === '5M' ? 32 : tfItem.timeframe === '1M' ? 12 : 14;
    const snap = tfItem.analysis.snapshot;

    return {
      tf: tfItem.timeframe,
      role:
        tfItem.timeframe === '5M'
          ? 'EXECUTION_5M'
          : tfItem.timeframe === '1M'
          ? 'MICRO_TIMING'
          : 'HTF_CONTEXT',
      closedBarsOnly: true,
      history: {
        bars: timeline.barsAnalyzed,
        window: `${timeline.windowStartIso} -> ${timeline.windowEndIso}`,
        highLow: [timeline.historicalLow, timeline.historicalHigh],
        macroPosPct: timeline.macroRangePositionPct,
        macroZone: timeline.macroZone,
        sessionShift: timeline.earlierSessionVsRecentShift,
        swings: timeline.swingSequence.map(
          (s) => `${s.time} ${s.label} ${s.price}`
        ),
        events: timeline.historicalStructureAndSweeps.map(
          (e) => `${e.time} ${e.event} @ ${e.price}`
        ),
        equalLiquidityPools: timeline.equalLiquidityPools,
        displacementEvents: timeline.displacementEvents,
      },
      snapshot: {
        trend: snap.trendStructure,
        event: snap.latestStructureEvent,
        sweep: snap.recentSweep,
        rangePct: snap.rangePositionPct,
        zone: snap.rangeZone,
        eq50: snap.equilibriumPrice,
        dealingRange: [snap.dealingRangeLow, snap.dealingRangeHigh],
        buyerPressurePct: snap.buyerPressurePct,
      },
      levels: tfItem.analysis.levels
        .slice(0, 5)
        .map((l) => `${l.type}(${l.strength}) @ ${l.price}`),
      zones: tfItem.analysis.zones
        .slice(0, 5)
        .map((z) => `${z.kind} [${z.low}-${z.high}]`),
      patterns: tfItem.analysis.recentPatterns
        .slice(0, 5)
        .map(
          (p) =>
            `${new Date(p.time * 1000).toISOString().slice(5, 16).replace('T', ' ')} ${p.name} (${p.bias})`
        ),
      ohlcvLegend: 't|o|h|l|c|v',
      recentClosedBars: closedCandles
        .slice(-recentBarCount)
        .map(
          (c) =>
            `${new Date(c.time * 1000).toISOString().slice(5, 16).replace('T', ' ')}|${c.open}|${c.high}|${c.low}|${c.close}|${c.volume}`
        ),
    };
  });

  const payloadJson = JSON.stringify({
    instrument: {
      symbol: instrument.symbol,
      name: instrument.name,
      category: instrument.category,
      decimals: instrument.decimals,
    },
    activeChartTimeframe: activeTimeframe,
    executionTimeframe: '5M',
    nonRepaintingClosedBarsOnly: true,
    lastClosedPrice: currentPrice,
    scoutContext: scoutContext ?? null,
    multiTimeframePriceAction: multiTimeframeContext,
  });

  const systemInstruction = [
    'You are a Smart Money Concept (SMC) price-action analyst operating strictly on CLOSED candles. Follow ONLY the Smart Money top-down and supply/demand rules below:',
    '1. Top-Down Direction & Mitigation Control: Start from higher timeframes (4H/1H) to set directional bias and identify key supply and demand zones. Track control through mitigation: mitigating a demand zone keeps demand in control; mitigating a supply zone keeps supply in control; breaking below a valid demand zone shifts control to supply.',
    '2. Supply & Demand Zone Quality: Prioritize supply and demand zones backed by (a) imbalance/FVG from fast movement, (b) Break of Structure (BoS) confirming momentum, and (c) strong pushed distance away from the zone before pullback. Refine entries using Order Blocks (the origin candle of the impulsive FVG/BoS move).',
    '3. Change of Character (ChoCH) vs. Sweep / FVG Trap: Before treating a break past a swing or zone as a true ChoCH reversal, check historical price action to the left for (a) a liquidity sweep of stops beyond a swing followed by return inside the range, or (b) price moving into an unmitigated FVG acting as a rebalance magnet.',
    '4. Execution & No-Signal Rule: Evaluate setups on closed bars without inventing prices or chart data. Output plan.signal = "WAIT" (NO SIGNAL) with clear requiredChecks when Smart Money structure is unclear, conflicting, or not yet confirmed—do NOT block a valid Smart Money setup merely because external calendar/news feeds are empty.',
    `Round all prices to ${instrument.decimals} decimal places relative to lastClosedPrice (${currentPrice}). For BUY: stopLoss < entryPrice < takeProfit1 < takeProfit2. For SELL: takeProfit2 < takeProfit1 < entryPrice < stopLoss.`,
  ].join(' ');

  const userPrompt = `Analyze this instrument using strictly Smart Money top-down direction, mitigation control, FVG + BoS + pushed distance zone quality, Order Blocks, and ChoCH vs. liquidity sweep / FVG trap checks, and return a decision (BUY, SELL, or WAIT / NO SIGNAL):\n${payloadJson}`;

  return {
    instrument,
    currentPrice,
    confirmedBarTime,
    payloadJson,
    systemInstruction,
    userPrompt,
  };
}

function normalizeDriverVerdict(raw: unknown): MarketDriverVerdict {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'bullish') return 'Bullish';
  if (s === 'bearish') return 'Bearish';
  if (s === 'conflicting' || s === 'conflict') return 'Conflicting';
  if (s.includes('missing')) return 'Missing Data';
  return 'Neutral';
}

export function normalizeSignalResult(params: {
  parsed: RawSignalJSON;
  symbol: string;
  activeTimeframe: Timeframe;
  currentPrice: number;
  confirmedBarTime?: number;
  model: string;
  timeframesData?: TimeframePriceActionInput[];
  scoutContext?: MarketScoutContext | null;
}): AIPriceActionSignal {
  const {
    parsed,
    symbol,
    activeTimeframe,
    currentPrice,
    confirmedBarTime = 0,
    model,
    timeframesData = [],
    scoutContext = null,
  } = params;
  const instrument = getInstrumentBySymbol(symbol);
  const rawPlan = (parsed.plan ?? {}) as Partial<AIPriceActionSignal['plan']>;

  const rawAction = String(rawPlan.signal ?? 'WAIT').toUpperCase();
  let signalAction: 'BUY' | 'SELL' | 'WAIT' =
    rawAction === 'BUY' || rawAction === 'SELL' ? rawAction : 'WAIT';

  const rawBias = String(parsed.bias ?? 'Neutral');
  const bias: AIPriceActionSignal['bias'] =
    rawBias === 'Bullish' || rawBias === 'Bearish' ? rawBias : 'Neutral';

  const rawStrength = String(rawPlan.signalStrength ?? 'Developing');
  let signalStrength: AIPriceActionSignal['plan']['signalStrength'] =
    rawStrength === 'A+ Setup' || rawStrength === 'Standard'
      ? rawStrength
      : 'Developing';

  const toFinite = (val: unknown, fallback = 0): number => {
    const n = Number(val);
    return Number.isFinite(n) ? n : fallback;
  };

  const normalizedAlignment: TimeframeAlignmentItem[] = (
    Array.isArray(parsed.timeframeAlignment) ? parsed.timeframeAlignment : []
  ).map((item) => ({
    ...item,
    timeframe: normalizeTimeframe(item.timeframe, activeTimeframe),
  }));

  const m5Entry =
    timeframesData.find((t) => t.timeframe === '5M') ?? timeframesData[0];
  const rrString = rawPlan.riskRewardRatio || '1 : 2.0';

  const fallbackDrivers = m5Entry
    ? evaluateAllFiveDrivers({
        symbol: instrument.symbol,
        proposedAction: signalAction,
        bias,
        m5Analysis: m5Entry.analysis,
        timeframeAlignment: normalizedAlignment,
        riskRewardRatio: rrString,
        scout: scoutContext,
      })
    : null;

  const rawDrivers = Array.isArray(parsed.marketDrivers)
    ? parsed.marketDrivers
    : [];
  const defaultDriverTitles: Record<1 | 2 | 3 | 4 | 5, string> = {
    1: '1. Supply, Demand & Liquidity Flow',
    2: '2. Higher-Timeframe Mitigation & Control',
    3: '3. Zone Quality (FVG, BoS & Pushed Distance)',
    4: '4. Order Blocks & Liquidity Sweeps',
    5: '5. Technical Structure & ChoCH Validation',
  };

  const marketDrivers: MarketDriverAssessment[] = ([1, 2, 3, 4, 5] as const).map(
    (id) => {
      const fromModel = rawDrivers.find((d) => Number(d?.id) === id);
      const fromEval = fallbackDrivers?.marketDrivers.find((d) => d.id === id);
      if (fromModel && fromModel.summary) {
        return {
          id,
          driver: fromModel.driver || defaultDriverTitles[id],
          verdict: normalizeDriverVerdict(fromModel.verdict),
          summary: fromModel.summary,
          evidence:
            Array.isArray(fromModel.evidence) && fromModel.evidence.length > 0
              ? fromModel.evidence.slice(0, 4)
              : fromEval?.evidence ?? [],
        };
      }
      return (
        fromEval ?? {
          id,
          driver: defaultDriverTitles[id],
          verdict: 'Neutral',
          summary: 'Evaluated from available chart structure.',
          evidence: [],
        }
      );
    }
  );

  let setupType = rawPlan.setupType || 'SMC Top-Down & Supply/Demand Setup';
  let triggerPattern = rawPlan.triggerPattern || 'SMC Structure / OB / FVG Confirmation';
  if (fallbackDrivers?.shouldBlockSignal && signalAction !== 'WAIT') {
    signalAction = 'WAIT';
    signalStrength = 'Developing';
    setupType = fallbackDrivers.blockReason ?? 'NO SIGNAL — Unconfirmed SMC Structure';
    triggerPattern =
      fallbackDrivers.requiredChecks[0] ?? 'Wait for Smart Money confirmation';
  }

  const mergeList = (a?: unknown, b?: string[]) => {
    const first = Array.isArray(a)
      ? a.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      : [];
    return Array.from(new Set([...first, ...(b ?? [])])).slice(0, 6);
  };

  const confirmingFactors = mergeList(
    parsed.confirmingFactors,
    fallbackDrivers?.confirmingFactors
  );
  const conflictingFactors = mergeList(
    parsed.conflictingFactors,
    fallbackDrivers?.conflictingFactors
  );
  const requiredChecks = mergeList(
    parsed.requiredChecks,
    fallbackDrivers?.requiredChecks
  );

  const analystVerdict: AIPriceActionSignal['analystVerdict'] =
    signalAction === 'BUY' ? 'BUY' : signalAction === 'SELL' ? 'SELL' : 'NO SIGNAL';

  return {
    id: `sig-${instrument.symbol.replace('/', '')}-${confirmedBarTime || Date.now()}`,
    symbol: instrument.symbol,
    timeframe: activeTimeframe,
    signalTimeframe: '5M',
    analyzedAt: new Date().toISOString(),
    confirmedBarTime,
    confirmedBarCloseTime: confirmedBarTime > 0 ? confirmedBarTime + 300 : 0,
    isLockedToClosedBar: confirmedBarTime > 0,
    model,
    spotPriceAtSignal: currentPrice,
    bias,
    analystVerdict,
    priceActionNarrative:
      parsed.priceActionNarrative || 'Smart Money multi-timeframe analysis completed.',
    keyZonesExplanation:
      parsed.keyZonesExplanation || 'See active Supply/Demand zones, Order Blocks, and FVGs.',
    timeframeAlignment: normalizedAlignment,
    marketDrivers,
    confirmingFactors,
    conflictingFactors,
    requiredChecks,
    scoutedSources: scoutContext?.sources?.slice(0, 6),
    plan: {
      signal: signalAction,
      signalStrength,
      setupType,
      triggerPattern,
      entryPrice: toFinite(rawPlan.entryPrice, signalAction === 'WAIT' ? 0 : currentPrice),
      entryZone: rawPlan.entryZone || currentPrice.toFixed(instrument.decimals),
      stopLoss: toFinite(rawPlan.stopLoss, 0),
      takeProfit1: toFinite(rawPlan.takeProfit1, 0),
      takeProfit2: toFinite(rawPlan.takeProfit2, 0),
      riskRewardRatio: rrString,
      invalidationReason:
        rawPlan.invalidationReason || 'Candle close beyond structural invalidation.',
      confluences: Array.isArray(rawPlan.confluences)
        ? rawPlan.confluences.slice(0, 5)
        : [],
    },
  };
}

export function buildBacktestReviewPrompt(backtest: BacktestResult) {
  const payloadJson = JSON.stringify({
    symbol: backtest.symbol,
    timeframe: backtest.timeframe,
    barsTested: backtest.barsTested,
    nonRepaintingVerified: backtest.nonRepaintingVerified,
    initialCapital: backtest.initialCapital,
    finalEquity: backtest.finalEquity,
    netReturnUsd: backtest.netReturnUsd,
    netReturnPct: backtest.netReturnPct,
    totalTrades: backtest.totalTrades,
    wins: backtest.wins,
    losses: backtest.losses,
    breakevens: backtest.breakevens,
    winRatePct: backtest.winRatePct,
    profitFactor: backtest.profitFactor,
    expectancyR: backtest.expectancyR,
    maxDrawdownPct: backtest.maxDrawdownPct,
    appliedFilters: backtest.appliedFilters ?? [],
    filterStats: backtest.filterStats ?? null,
    setupBreakdown: backtest.setupBreakdown,
    recentTradesSample: backtest.trades.slice(0, 18).map((t) => ({
      side: t.side,
      setupType: t.setupType,
      trigger: t.trigger,
      exitReason: t.exitReason,
      tp1Hit: t.tp1Hit,
      rMultiple: t.rMultiple,
      pnlUsd: t.pnlUsd,
    })),
  });

  const systemInstruction = [
    'You are a Smart Money Concept (SMC) backtest auditor.',
    'Review the historical backtest results using Smart Money structure rules (top-down bias, supply/demand mitigation control, FVG + BoS + pushed distance zones, Order Blocks, and ChoCH vs. liquidity sweep / FVG trap filtering).',
    'Classify verdict strictly as one of: "Strong Edge", "Moderate Edge", or "Needs Filtering".',
    'Provide 3 specific, actionable Smart Money filtering recommendations.',
  ].join(' ');

  return { payloadJson, systemInstruction };
}

export function normalizeBacktestReviewResult(params: {
  parsed: RawBacktestReviewJSON;
  backtest: BacktestResult;
  model: string;
}): AIBacktestReview {
  const { parsed, backtest, model } = params;
  const normalizedVerdict: AIBacktestReview['verdict'] =
    parsed.verdict === 'Strong Edge' ||
    parsed.verdict === 'Moderate Edge' ||
    parsed.verdict === 'Needs Filtering'
      ? parsed.verdict
      : backtest.profitFactor >= 1.5 && backtest.expectancyR > 0.25
      ? 'Strong Edge'
      : backtest.profitFactor >= 1.1
      ? 'Moderate Edge'
      : 'Needs Filtering';

  return {
    model,
    reviewedAt: new Date().toISOString(),
    verdict: normalizedVerdict,
    summary: parsed.summary || 'Backtest audit completed.',
    bestPerformingPattern: parsed.bestPerformingPattern || 'N/A',
    keyWeakness: parsed.keyWeakness || 'N/A',
    recommendations: Array.isArray(parsed.recommendations)
      ? parsed.recommendations.slice(0, 4)
      : [],
  };
}

export function formatSmsSignalText(signal: AIPriceActionSignal): string {
  const instrument = getInstrumentBySymbol(signal.symbol);
  const d = instrument.decimals;
  const fmt = (val: number) => (val > 0 ? val.toFixed(d) : 'Watch');
  const { plan } = signal;
  const barTime =
    signal.confirmedBarTime > 0
      ? new Date(signal.confirmedBarTime

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
    // Strictly exclude unclosed forming bar so AI signals never repaint mid-candle
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
    fiveDriverScoutContext: scoutContext
      ? {
          utcTimestamp: scoutContext.utcTimestamp,
          sessionName: scoutContext.sessionName,
          sessionLiquidityNote: scoutContext.sessionLiquidityNote,
          sessionBlocked: scoutContext.sessionBlocked,
          crossMarketRiskTone: scoutContext.crossMarketRiskTone,
          crossMarketSummary: scoutContext.crossMarketSummary,
          calendarAvailable: scoutContext.calendarAvailable,
          imminentHighImpactEvent: scoutContext.imminentHighImpactEvent,
          relevantEvents: scoutContext.relevantEvents,
          fngIndex: scoutContext.fngIndex ?? null,
          hasVerifiedExternalNews: scoutContext.hasVerifiedExternalNews,
          macroNewsBrief: scoutContext.macroNewsBrief,
          fundamentalsBrief: scoutContext.fundamentalsBrief,
          sentimentBrief: scoutContext.sentimentBrief,
          newsHeadlines: scoutContext.newsHeadlines.map((h) => ({
            title: h.title,
            source: h.source,
            publishedAt: h.publishedAt,
          })),
          highImpactRiskDetected: scoutContext.highImpactRiskDetected,
          highImpactRiskNote: scoutContext.highImpactRiskNote,
        }
      : null,
    multiTimeframePriceAction: multiTimeframeContext,
  });

  const systemInstruction = [
    'You are a disciplined institutional market analyst operating strictly on CLOSED, NON-REPAINTING candles. NO GUESSING, NO FABRICATION.',
    'FIVE-DRIVER EVALUATION MANDATE: Before issuing any trading signal, scout and evaluate ALL FIVE market drivers from the supplied payload:',
    '(1) Supply, demand, liquidity, and session/order-flow context (UTC session liquidity, dealing-range Premium/Discount, OBs, FVGs, EQH/EQL, closed-bar buyer/seller pressure);',
    '(2) Macroeconomic catalysts and central bank policy (interest rates, inflation, growth, scheduled economic calendar events);',
    '(3) Asset or company/instrument fundamentals (central bank/yield/ETF/supply shifts or major announcements; note truthfully that Synthetic indices have no macro/earnings);',
    '(4) Market sentiment and risk environment (risk-on vs risk-off cross-market tape, geopolitical or breaking news shocks);',
    '(5) Technical structure and market mechanics (key S/R, BOS/CHoCH breakouts, sweeps, liquidity targets across 4H, 1H, 15M, 5M, 1M).',
    'SMART MONEY TOP-DOWN & SUPPLY/DEMAND FRAMEWORK:',
    '- Top-Down Direction & Mitigation Control: Start from higher timeframes (4H/1H) to set dominant direction and key supply/demand zones. Track control via mitigation: mitigating a demand zone keeps demand in control; mitigating a supply zone keeps supply in control; breaking below a valid demand zone shifts control to supply.',
    '- Zone Quality Criteria: Prioritize supply/demand zones backed by (a) inefficiency/FVG imbalance from fast movement, (b) Break of Structure (BoS) confirming momentum, and (c) strong pushed distance away from the zone before retracement. Refine entries with Order Blocks (origin candle of the impulsive FVG move) and check unfilled orders.',
    '- Change of Character (ChoCH) Trap Filtering: Before treating a break past a swing/zone as a true reversal ChoCH, check historical context to the left for (a) a liquidity sweep of stop losses below/above a swing followed by re-entry into the range, or (b) an unmitigated FVG acting as a magnet for normal pullback/rebalance.',
    'RULES FOR CERTAINTY: Do NOT guess, invent prices/timeframes, or fill in missing chart/news/macro data. If fiveDriverScoutContext marks calendarAvailable=false or hasVerifiedExternalNews=false for a non-Synthetic asset, mark those driver verdicts as "Missing Data".',
    'Always populate confirmingFactors (what aligns with the setup), conflictingFactors (what opposes or creates risk), and requiredChecks (exact checks or chart/macro details needed first whenever issuing NO SIGNAL / WAIT).',
    'WHEN TO OUTPUT NO SIGNAL ("WAIT"): Issue plan.signal = "WAIT" (NO SIGNAL) whenever ANY of the following occurs: (a) required macro/news/chart data is missing or contradictory; (b) sessionBlocked=true (weekend/rollover thin liquidity); (c) imminentHighImpactEvent or highImpactRiskDetected=true; (d) HTF structure conflicts or a move looks like a liquidity sweep / FVG rebalance trap rather than a confirmed shift; (e) 5M lacks closed-bar OTE Discount (<=40% BUY) or Premium (>=60% SELL) + sweep/displacement confirmation; or (f) R:R < 1:2.5.',
    'EXECUTION RULE: Execution is ALWAYS strictly on the 5M timeframe (signalTimeframe = "5M") on CLOSED bars only. Only output BUY or SELL as an "A+ Setup" when multiple drivers align and key risks are accounted for.',
    'CRITICAL RULE: Do NOT use, mention, or rely on lagging indicators such as RSI, MACD, EMA, SMA, Stochastics, or Bollinger Bands.',
    'Provide marketDrivers (exactly 5 entries for drivers 1..5) and timeframeAlignment covering all 5 timeframes (4H, 1H, 15M, 5M, 1M).',
    `All price levels must be realistic relative to lastClosedPrice (${currentPrice}) and rounded to ${instrument.decimals} decimal places.`,
    'For a BUY (or bullish WAIT watch plan): stopLoss < entryPrice < takeProfit1 < takeProfit2.',
    'For a SELL (or bearish WAIT watch plan): takeProfit2 < takeProfit1 < entryPrice < stopLoss.',
    'Never promise guaranteed profits.',
  ].join(' ');

  const userPrompt = `Evaluate all 5 market drivers (session/liquidity, macro/central bank, fundamentals, risk sentiment, and closed-bar 4H–1M technical structure) and Smart Money top-down/supply-demand/ChoCH rules strictly without guessing missing data, state confirming vs conflicting factors, and output a 5M decision (BUY, SELL, or WAIT / NO SIGNAL):\n${payloadJson}`;

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
    1: '1. Supply, Demand, Liquidity & Session Flow',
    2: '2. Macroeconomic Catalysts & Central Bank Policy',
    3: '3. Asset / Instrument Fundamentals',
    4: '4. Market Sentiment & Risk Environment',
    5: '5. Technical Structure & Market Mechanics',
  };

  const marketDrivers: MarketDriverAssessment[] = ([1, 2, 3, 4, 5] as const).map(
    (id) => {
      const fromModel = rawDrivers.find((d) => Number(d?.id) === id);
      const fromEval = fallbackDrivers?.marketDrivers.find((d) => d.id === id);
      if (fromModel && fromModel.summary) {
        return {
          id,
          driver: fromModel.driver || defaultDriverTitles[id],
          verdict:
            fromEval?.verdict === 'Missing Data' || fromEval?.verdict === 'Conflicting'
              ? fromEval.verdict
              : normalizeDriverVerdict(fromModel.verdict),
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
          verdict: 'Missing Data',
          summary: 'Insufficient verified data for this driver.',
          evidence: [],
        }
      );
    }
  );

  // Enforce deterministic certainty block if macro/news data missing or high-impact conflict detected
  let setupType = rawPlan.setupType || 'MTF Structure & Liquidity Setup';
  let triggerPattern = rawPlan.triggerPattern || '5M Price Action Confirmation';
  if (fallbackDrivers?.shouldBlockSignal && signalAction !== 'WAIT') {
    signalAction = 'WAIT';
    signalStrength = 'Developing';
    setupType = fallbackDrivers.blockReason ?? 'NO SIGNAL — Unmet Multi-Driver Certainty';
    triggerPattern =
      fallbackDrivers.requiredChecks[0] ?? 'Resolve conflicting or missing checks first';
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
      parsed.priceActionNarrative || 'Multi-timeframe price-action scan completed.',
    keyZonesExplanation:
      parsed.keyZonesExplanation || 'See active 5M Order Blocks, FVGs, and S/R zones.',
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
        rawPlan.invalidationReason || '5M candle close beyond structural invalidation.',
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
    'You are an institutional quantitative price-action auditor.',
    'Review the causal, non-repainting historical backtest results (closed-bar signals, next-bar Open execution, 50% TP1 partial + Breakeven stop, conservative SL-first intrabar simulation).',
    'CRITICAL RULE: Pure price action only — NEVER suggest or mention lagging indicators like RSI, MACD, EMA, SMA, Stochastics, or Bollinger Bands.',
    'Evaluate statistical quality objectively: profit factor, expectancy R, drawdown, and setup breakdown.',
    'Classify verdict strictly as one of: "Strong Edge", "Moderate Edge", or "Needs Filtering".',
    'Provide 3 specific, actionable pure price-action filtering recommendations (e.g., higher-timeframe bias alignment, liquidity sweep confirmation, discount/premium filtering).',
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
      ? new Date(signal.confirmedBarTime * 1000).toISOString().slice(11, 16) + ' UTC'
      : new Date(signal.analyzedAt || Date.now()).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        });

  const verdictLabel =
    plan.signal === 'WAIT' ? 'NO SIGNAL' : `${plan.signal} (${plan.signalStrength})`;
  const actionLine =
    plan.signal === 'WAIT'
      ? `Action: NO SIGNAL — ${signal.requiredChecks?.[0] || 'WAIT FOR 5M CANDLE CLOSE CONFIRMATION'}`
      : `Action: ENTER NOW (${plan.signal} Confirmed on Closed 5M Bar)`;

  const lines = [
    `StrataDesk 5M | ${signal.symbol}`,
    `${verdictLabel} | ${plan.setupType}`,
    actionLine,
    `Entry: ${fmt(plan.entryPrice)} | SL: ${fmt(plan.stopLoss)}`,
    `TP1: ${fmt(plan.takeProfit1)} | TP2: ${fmt(plan.takeProfit2)} (${plan.riskRewardRatio})`,
    `Trigger: ${plan.triggerPattern}`,
    ...(signal.conflictingFactors?.[0] ? [`Risk/Conflict: ${signal.conflictingFactors[0]}`] : []),
    `Invalidation: ${plan.invalidationReason}`,
    `Locked Closed Bar: ${barTime} (Non-Repainting)`,
  ];

  return lines.join('\n');
}

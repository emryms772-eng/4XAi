import { getInstrumentBySymbol } from '../config/instruments.ts';
import type {
  MarketCategory,
  MarketDriverAssessment,
  MarketDriverVerdict,
  MarketScoutContext,
  PriceActionAnalysisSummary,
  TimeframeAlignmentItem,
  WatchlistQuote,
} from '../types/market.ts';

export interface UtcSessionContext {
  sessionName: string;
  liquidityNote: string;
  sessionBlocked: boolean;
}

export function getUtcSessionContext(
  category: MarketCategory,
  nowSec = Math.floor(Date.now() / 1000)
): UtcSessionContext {
  const d = new Date(nowSec * 1000);
  const utcHour = d.getUTCHours();

  if (category === 'Synthetic') {
    return {
      sessionName: '24/7 Synthetic Engine',
      liquidityNote: 'Continuous synthetic price feed.',
      sessionBlocked: false,
    };
  }

  if (utcHour >= 12 && utcHour < 16) {
    return {
      sessionName: 'London–New York Overlap',
      liquidityNote: 'Active overlap liquidity window.',
      sessionBlocked: false,
    };
  }
  if (utcHour >= 7 && utcHour < 12) {
    return {
      sessionName: 'London Session',
      liquidityNote: 'Active London session.',
      sessionBlocked: false,
    };
  }
  if (utcHour >= 16 && utcHour < 21) {
    return {
      sessionName: 'New York Afternoon',
      liquidityNote: 'Active New York session.',
      sessionBlocked: false,
    };
  }
  if (utcHour >= 0 && utcHour < 7) {
    return {
      sessionName: 'Asian Session',
      liquidityNote: 'Asian session range and liquidity build.',
      sessionBlocked: false,
    };
  }

  return {
    sessionName: 'Transition Session',
    liquidityNote: 'Session transition window.',
    sessionBlocked: false,
  };
}

export function assessCrossMarketRiskEnvironment(
  quotes: WatchlistQuote[],
  _fng?: { value: number; classification: string } | null
): {
  tone: MarketScoutContext['crossMarketRiskTone'];
  summary: string;
} {
  if (!quotes || quotes.length === 0) {
    return {
      tone: 'Mixed',
      summary: 'Optional external quote feed not required for Smart Money chart evaluation.',
    };
  }

  const xau = quotes.find((q) => q.symbol === 'XAU/USD') ?? quotes[0];
  const chg = Number.isFinite(xau?.changePct) ? xau.changePct : 0;
  return {
    tone: 'Mixed',
    summary: `Reference quote ${xau.symbol}: ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%.`,
  };
}

export function buildFallbackScoutContext(
  symbol: string,
  quotes: WatchlistQuote[] = []
): MarketScoutContext {
  const instrument = getInstrumentBySymbol(symbol);
  const nowSec = Math.floor(Date.now() / 1000);
  const session = getUtcSessionContext(instrument.category, nowSec);
  const risk = assessCrossMarketRiskEnvironment(quotes);

  return {
    utcTimestamp: new Date(nowSec * 1000).toISOString(),
    sessionName: session.sessionName,
    sessionLiquidityNote: session.liquidityNote,
    sessionBlocked: false,
    crossMarketRiskTone: risk.tone,
    crossMarketSummary: risk.summary,
    calendarAvailable: true,
    relevantEvents: [],
    imminentHighImpactEvent: null,
    fngIndex: null,
    hasVerifiedExternalNews: true,
    macroNewsBrief: null,
    fundamentalsBrief: null,
    sentimentBrief: null,
    newsHeadlines: [],
    highImpactRiskDetected: false,
    highImpactRiskNote: null,
    sources: [],
  };
}

export interface FiveDriverEvaluationResult {
  marketDrivers: MarketDriverAssessment[];
  confirmingFactors: string[];
  conflictingFactors: string[];
  requiredChecks: string[];
  shouldBlockSignal: boolean;
  blockReason: string | null;
}

/**
 * Evaluates chart structure strictly around Smart Money rules:
 * - Top-down timeframe bias & mitigation control
 * - Supply/demand zone quality (FVG imbalance, BoS, pushed distance) & Order Blocks
 * - ChoCH vs. liquidity sweep / FVG rebalance trap check
 * Does NOT block setups for missing news/calendar data or R:R below 1:2.5.
 */
export function evaluateAllFiveDrivers(params: {
  symbol: string;
  proposedAction: 'BUY' | 'SELL' | 'WAIT';
  bias: 'Bullish' | 'Bearish' | 'Neutral';
  m5Analysis: PriceActionAnalysisSummary;
  timeframeAlignment: TimeframeAlignmentItem[];
  riskRewardRatio: string;
  scout?: MarketScoutContext | null;
}): FiveDriverEvaluationResult {
  const {
    symbol,
    proposedAction,
    bias,
    m5Analysis,
    timeframeAlignment,
    riskRewardRatio,
    scout: providedScout,
  } = params;

  const instrument = getInstrumentBySymbol(symbol);
  const d = instrument.decimals;
  const scout = providedScout ?? buildFallbackScoutContext(symbol);
  const snap = m5Analysis.snapshot;

  const a4h = timeframeAlignment.find((t) => t.timeframe === '4H');
  const a1h = timeframeAlignment.find((t) => t.timeframe === '1H');
  const a15m = timeframeAlignment.find((t) => t.timeframe === '15M');
  const a5m = timeframeAlignment.find((t) => t.timeframe === '5M');

  const confirmingFactors: string[] = [];
  const conflictingFactors: string[] = [];
  const requiredChecks: string[] = [];

  const evalSide: 'BUY' | 'SELL' | 'WAIT' =
    proposedAction !== 'WAIT'
      ? proposedAction
      : bias === 'Bullish'
      ? 'BUY'
      : bias === 'Bearish'
      ? 'SELL'
      : 'WAIT';

  const htfBull = a4h?.bias === 'Bullish' && a1h?.bias === 'Bullish';
  const htfBear = a4h?.bias === 'Bearish' && a1h?.bias === 'Bearish';
  const htfOpposing = Boolean(
    a4h &&
      a1h &&
      ((a4h.bias === 'Bullish' && a1h.bias === 'Bearish') ||
        (a4h.bias === 'Bearish' && a1h.bias === 'Bullish'))
  );

  const hasSweepOrFvgTrapRisk =
    snap.recentSweep !== 'None' && snap.unmitigatedFvgCount > 0;

  if (hasSweepOrFvgTrapRisk) {
    conflictingFactors.push(
      `Check left-side structure: ${snap.recentSweep} with ${snap.unmitigatedFvgCount} unmitigated FVG(s) may be a liquidity sweep or FVG rebalance rather than a confirmed ChoCH reversal.`
    );
    requiredChecks.push(
      'Verify whether price is sweeping liquidity/rebalancing an unmitigated FVG or holding a clean zone with BoS and pushed distance.'
    );
  }

  if (htfOpposing) {
    conflictingFactors.push(
      `Top-down bias conflict between 4H (${a4h?.bias ?? 'Neutral'}) and 1H (${a1h?.bias ?? 'Neutral'}).`
    );
    requiredChecks.push(
      'Check higher-timeframe supply/demand mitigation control to see whether control has shifted.'
    );
  }

  if (evalSide === 'BUY') {
    if (htfBull || bias === 'Bullish') {
      confirmingFactors.push(
        `Bullish Smart Money bias aligned with ${snap.activeOrderBlockCount} OB(s) and ${snap.unmitigatedFvgCount} FVG(s).`
      );
    }
  } else if (evalSide === 'SELL') {
    if (htfBear || bias === 'Bearish') {
      confirmingFactors.push(
        `Bearish Smart Money bias aligned with ${snap.activeOrderBlockCount} OB(s) and ${snap.unmitigatedFvgCount} FVG(s).`
      );
    }
  }

  if (proposedAction === 'WAIT') {
    requiredChecks.push(
      'Wait for a valid demand/supply zone with BoS, FVG imbalance, and pushed distance—or confirmed ChoCH after checking for liquidity sweep / FVG trap.'
    );
  }

  const structVerdict: MarketDriverVerdict = htfOpposing
    ? 'Conflicting'
    : bias === 'Bullish'
    ? 'Bullish'
    : bias === 'Bearish'
    ? 'Bearish'
    : 'Neutral';

  const marketDrivers: MarketDriverAssessment[] = [
    {
      id: 1,
      driver: '1. Supply, Demand & Liquidity Flow',
      verdict: structVerdict,
      summary: `${scout.sessionName} · ${snap.activeOrderBlockCount} OB / ${snap.unmitigatedFvgCount} FVG · Sweep: ${snap.recentSweep}.`,
      evidence: [
        `Dealing range: ${snap.dealingRangeLow.toFixed(d)}–${snap.dealingRangeHigh.toFixed(d)} (EQ ${snap.equilibriumPrice.toFixed(d)})`,
        `Current range zone: ${snap.rangeZone} (${snap.rangePositionPct}%)`,
      ],
    },
    {
      id: 2,
      driver: '2. Higher-Timeframe Mitigation & Control',
      verdict: htfOpposing ? 'Conflicting' : structVerdict,
      summary: `4H ${a4h?.bias ?? 'Neutral'} (${a4h?.structureEvent ?? 'Structure'}) · 1H ${a1h?.bias ?? 'Neutral'} (${a1h?.structureEvent ?? 'Structure'}).`,
      evidence: [
        `4H note: ${a4h?.note ?? 'N/A'}`,
        `1H note: ${a1h?.note ?? 'N/A'}`,
      ],
    },
    {
      id: 3,
      driver: '3. Zone Quality (FVG, BoS & Pushed Distance)',
      verdict: structVerdict,
      summary: `${snap.unmitigatedFvgCount} unmitigated FVG(s) · Latest event: ${snap.latestStructureEvent} · R:R ${riskRewardRatio}.`,
      evidence: [
        `Latest structure event: ${snap.latestStructureEvent}`,
        `Active zones tracked: ${m5Analysis.zones.length}`,
      ],
    },
    {
      id: 4,
      driver: '4. Order Blocks & Liquidity Sweeps',
      verdict: hasSweepOrFvgTrapRisk ? 'Conflicting' : structVerdict,
      summary: `${snap.activeOrderBlockCount} active Order Block(s) · Recent sweep: ${snap.recentSweep}.`,
      evidence: [
        `Sweep status: ${snap.recentSweep}`,
        `Buyer pressure: ${snap.buyerPressurePct}%`,
      ],
    },
    {
      id: 5,
      driver: '5. Technical Structure & ChoCH Validation',
      verdict: structVerdict,
      summary: `15M ${a15m?.bias ?? 'Neutral'} · 5M ${a5m?.bias ?? 'Neutral'} (${snap.latestStructureEvent}).`,
      evidence: [
        `5M note: ${a5m?.note ?? snap.latestStructureEvent}`,
        hasSweepOrFvgTrapRisk
          ? 'Watch for sweep / FVG rebalance trap before treating break as ChoCH.'
          : 'No immediate sweep/FVG trap flag.',
      ],
    },
  ];

  const shouldBlockSignal = htfOpposing;
  const blockReason = htfOpposing
    ? 'NO SIGNAL — Conflicting 4H / 1H Smart Money Direction'
    : null;

  const dedupe = (arr: string[]) =>
    Array.from(new Set(arr.filter(Boolean))).slice(0, 6);

  return {
    marketDrivers,
    confirmingFactors: dedupe(confirmingFactors),
    conflictingFactors: dedupe(conflictingFactors),
    requiredChecks: dedupe(requiredChecks),
    shouldBlockSignal,
    blockReason,
  };
}

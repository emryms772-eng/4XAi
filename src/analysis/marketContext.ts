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

/**
 * Computes exact UTC session liquidity and rollover/weekend guardrails
 * strictly from current UTC clock without guessing.
 */
export function getUtcSessionContext(
  category: MarketCategory,
  nowSec = Math.floor(Date.now() / 1000)
): UtcSessionContext {
  const d = new Date(nowSec * 1000);
  const utcDay = d.getUTCDay(); // 0=Sun .. 6=Sat
  const utcHour = d.getUTCHours();
  const utcMin = d.getUTCMinutes();
  const minutesOfDay = utcHour * 60 + utcMin;

  if (category === 'Synthetic') {
    return {
      sessionName: '24/7 Synthetic Engine',
      liquidityNote:
        'Algorithmic tick stream operates continuously with constant synthetic spread.',
      sessionBlocked: false,
    };
  }

  if (category === 'Forex' || category === 'Metals') {
    const isWeekendClosed =
      utcDay === 6 ||
      (utcDay === 5 && minutesOfDay >= 22 * 60) ||
      (utcDay === 0 && minutesOfDay < 22 * 60);

    if (isWeekendClosed) {
      return {
        sessionName: 'Weekend Market Closed',
        liquidityNote:
          'Spot FX & Metals are closed (Fri 22:00–Sun 22:00 UTC). Liquidity and spreads are inactive.',
        sessionBlocked: true,
      };
    }

    // Daily NY 5pm / 22:00 UTC rollover thin liquidity window (21:45 - 22:15 UTC)
    if (minutesOfDay >= 21 * 60 + 45 && minutesOfDay <= 22 * 60 + 15) {
      return {
        sessionName: 'NY Rollover / Dead Zone',
        liquidityNote:
          'Daily broker rollover window (21:45–22:15 UTC) carries wide spreads and erratic thin liquidity.',
        sessionBlocked: true,
      };
    }
  }

  if (utcHour >= 12 && utcHour < 16) {
    return {
      sessionName: 'London–New York Overlap',
      liquidityNote:
        'Peak institutional order-flow window (12:00–16:00 UTC) with deepest FX/Gold liquidity and tight spreads.',
      sessionBlocked: false,
    };
  }
  if (utcHour >= 7 && utcHour < 12) {
    return {
      sessionName: 'London Session',
      liquidityNote:
        'High European institutional liquidity (07:00–12:00 UTC); watch London Open liquidity sweeps.',
      sessionBlocked: false,
    };
  }
  if (utcHour >= 16 && utcHour < 21) {
    return {
      sessionName: 'New York Afternoon',
      liquidityNote:
        'Active US institutional flow (16:00–21:00 UTC); liquidity typically moderates after London close.',
      sessionBlocked: false,
    };
  }
  if (utcHour >= 0 && utcHour < 7) {
    return {
      sessionName: 'Tokyo / Asian Session',
      liquidityNote:
        'Lower-range Asian session liquidity (00:00–07:00 UTC); prone to range accumulation before London sweep.',
      sessionBlocked: false,
    };
  }

  return {
    sessionName:
      category === 'Digital' ? '24/7 Spot Crypto Session' : 'Sydney Open / Transition',
    liquidityNote:
      category === 'Digital'
        ? '24/7 global spot crypto order book; liquidity follows US/Asian institutional overlap.'
        : 'Early Sydney transition (21:00–00:00 UTC); thinner institutional depth outside JPY/AUD/NZD.',
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
      tone: 'Unavailable',
      summary: 'Live XAU/USD quote unavailable to verify intraday risk sentiment.',
    };
  }

  const xau = quotes.find((q) => q.symbol === 'XAU/USD') ?? quotes[0];
  const chg = Number.isFinite(xau?.changePct) ? xau.changePct : 0;
  const formatted = `XAU/USD ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`;

  if (chg >= 0.45) {
    return {
      tone: 'Risk-Off',
      summary: `Gold tape reads Risk-Off (safe-haven / anti-USD bid): ${formatted}.`,
    };
  }
  if (chg <= -0.45) {
    return {
      tone: 'Risk-Off',
      summary: `Gold tape reads Risk-Off (USD-driven selloff): ${formatted}.`,
    };
  }

  return {
    tone: 'Mixed',
    summary: `Gold tape reads Mixed: ${formatted}.`,
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

  const isSynthetic = instrument.category === 'Synthetic';

  return {
    utcTimestamp: new Date(nowSec * 1000).toISOString(),
    sessionName: session.sessionName,
    sessionLiquidityNote: session.liquidityNote,
    sessionBlocked: session.sessionBlocked,
    crossMarketRiskTone: risk.tone,
    crossMarketSummary: risk.summary,
    calendarAvailable: isSynthetic,
    relevantEvents: [],
    imminentHighImpactEvent: null,
    fngIndex: null,
    hasVerifiedExternalNews: isSynthetic,
    macroNewsBrief: isSynthetic
      ? 'Synthetic volatility index has no central bank policy or scheduled macroeconomic releases.'
      : null,
    fundamentalsBrief: isSynthetic
      ? 'Algorithmic continuous volatility index driven strictly by internal tick mechanics rather than earnings or physical supply.'
      : null,
    sentimentBrief: isSynthetic
      ? 'Order flow reflects pure chart structure without geopolitical or macro headlines.'
      : null,
    newsHeadlines: [],
    highImpactRiskDetected: false,
    highImpactRiskNote: null,
    sources: [],
  };
}

function getRelevantCurrenciesForSymbol(symbol: string): string[] {
  if (symbol === 'XAU/USD' || symbol === 'BTC/USD') return ['USD'];
  const parts = symbol.split('/');
  if (parts.length === 2 && parts[0].length === 3 && parts[1].length === 3) {
    return parts;
  }
  return [];
}

function scoreHeadlineBiasForSymbol(
  symbol: string,
  headlines: MarketScoutContext['newsHeadlines']
): { bullHits: number; bearHits: number; shockDetected: boolean; sampleTitles: string[] } {
  const bullWords = ['rally', 'surge', 'gains', 'rise', 'rises', 'bullish', 'cut bets', 'rate cut', 'inflow', 'inflows', 'rebound', 'climb'];
  const bearWords = ['drop', 'drops', 'fall', 'falls', 'decline', 'selloff', 'sell-off', 'slump', 'bearish', 'rate-hike', 'rate hike', 'hawkish', 'outflow', 'crash', 'low'];
  const shockPattern =
    /\b(emergency rate|trading halt|circuit breaker|flash crash|bank failure|sovereign default|nuclear strike|missile strike|market crash)\b/i;

  const base = symbol.split('/')[0];
  let bullHits = 0;
  let bearHits = 0;
  let shockDetected = false;

  for (const h of headlines) {
    const lower = h.title.toLowerCase();
    if (shockPattern.test(lower)) {
      shockDetected = true;
    }
    const isBullText = bullWords.some((w) => lower.includes(w));
    const isBearText = bearWords.some((w) => lower.includes(w));

    // For USD/JPY, USD/CHF, USD/CAD: USD strength news is bullish for the pair, while XAU/EUR/GBP/AUD/BTC rise on USD weakness
    const mentionsDollar = lower.includes('dollar') || lower.includes('fed') || lower.includes('federal reserve');
    if (base === 'USD' && mentionsDollar) {
      if (lower.includes('hike') || lower.includes('hawkish') || lower.includes('strong dollar')) {
        bullHits += 1;
      } else if (lower.includes('cut') || lower.includes('dovish') || lower.includes('weak dollar')) {
        bearHits += 1;
      }
    } else {
      if (isBullText) bullHits += 1;
      if (isBearText) bearHits += 1;
    }
  }

  return {
    bullHits,
    bearHits,
    shockDetected,
    sampleTitles: headlines.slice(0, 3).map((h) => `${h.title} (${h.source})`),
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
 * Deterministic 5-Driver Market Analyst & Certainty evaluator.
 * Combines live UTC session, economic calendar, fundamentals/news scout,
 * cross-market risk sentiment, and closed-bar MTF technicals.
 * Enforces NO SIGNAL whenever critical data is missing or drivers conflict materially.
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
  const isSynthetic = instrument.category === 'Synthetic';
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

  // 1. Supply, demand, liquidity, and session/order-flow context
  const d1Evidence: string[] = [
    `${scout.sessionName}: ${scout.sessionLiquidityNote}`,
    `5M range ${snap.rangePositionPct}% (${snap.rangeZone}) · Buyer pressure ${snap.buyerPressurePct}%`,
    `Active liquidity: ${snap.activeOrderBlockCount} OB / ${snap.unmitigatedFvgCount} FVG · Sweep: ${snap.recentSweep}`,
  ];
  let d1Verdict: MarketDriverVerdict = 'Neutral';
  if (scout.sessionBlocked) {
    d1Verdict = 'Conflicting';
    conflictingFactors.push(`Session/liquidity restriction (${scout.sessionName}): ${scout.sessionLiquidityNote}`);
    requiredChecks.push('Wait for active liquid trading session open (London 07:00 UTC or NY overlap 12:00 UTC) and a fresh closed 5M candle.');
  } else {
    if (snap.rangePositionPct <= 42) {
      d1Verdict = 'Bullish';
    } else if (snap.rangePositionPct >= 58) {
      d1Verdict = 'Bearish';
    } else if (snap.recentSweep === 'Sell-Side Sweep (Bullish)') {
      d1Verdict = 'Bullish';
    } else if (snap.recentSweep === 'Buy-Side Sweep (Bearish)') {
      d1Verdict = 'Bearish';
    } else {
      d1Verdict = 'Neutral';
    }

    if (evalSide === 'BUY') {
      if (d1Verdict === 'Bullish') {
        confirmingFactors.push(`Supply/demand & session (${scout.sessionName}): 5M sits in ${snap.rangeZone} (${snap.rangePositionPct}%) with ${snap.activeOrderBlockCount} OB/${snap.unmitigatedFvgCount} FVG support.`);
      } else {
        conflictingFactors.push(`5M price sits in ${snap.rangeZone} (${snap.rangePositionPct}%) — suboptimal demand discount for BUY.`);
        requiredChecks.push('Wait for 5M pullback into Deep Discount (<=40%) mitigating a clean Demand OB or Bullish FVG.');
      }
    } else if (evalSide === 'SELL') {
      if (d1Verdict === 'Bearish') {
        confirmingFactors.push(`Supply/demand & session (${scout.sessionName}): 5M sits in ${snap.rangeZone} (${snap.rangePositionPct}%) with ${snap.activeOrderBlockCount} OB/${snap.unmitigatedFvgCount} FVG supply.`);
      } else {
        conflictingFactors.push(`5M price sits in ${snap.rangeZone} (${snap.rangePositionPct}%) — suboptimal supply premium for SELL.`);
        requiredChecks.push('Wait for 5M rally into Deep Premium (>=60%) mitigating a clean Supply OB or Bearish FVG.');
      }
    }
  }

  // 2. Macroeconomic catalysts and central bank policy
  let d2Verdict: MarketDriverVerdict = 'Missing Data';
  let d2Summary = '';
  const d2Evidence: string[] = [];

  if (isSynthetic) {
    d2Verdict = 'Neutral';
    d2Summary = 'Synthetic volatility index has no central bank policy or macroeconomic releases.';
    d2Evidence.push('Algorithmic volatility feed is isolated from rate decisions, CPI, and NFP.');
  } else if (!scout.calendarAvailable && !scout.macroNewsBrief) {
    d2Verdict = 'Missing Data';
    d2Summary = 'Live macroeconomic calendar and central bank release schedule could not be verified.';
    d2Evidence.push('No verified economic calendar payload available.');
    conflictingFactors.push('Missing live macroeconomic calendar & central bank catalyst data.');
    requiredChecks.push(`Check high-impact ${getRelevantCurrenciesForSymbol(symbol).join('/')} economic calendar & central bank speaker schedule before trading.`);
  } else if (scout.imminentHighImpactEvent) {
    const ev = scout.imminentHighImpactEvent;
    d2Verdict = 'Conflicting';
    d2Summary = `Imminent High-impact ${ev.currency} catalyst: ${ev.title} (${ev.dateIso.slice(11, 16)} UTC).`;
    d2Evidence.push(`${ev.currency} High Impact: ${ev.title}${ev.forecast ? ` (Fcst ${ev.forecast}, Prev ${ev.previous ?? '—'})` : ''}`);
    conflictingFactors.push(`High-impact ${ev.currency} macro event risk (${ev.title}) risks spread spikes and stop runs.`);
    requiredChecks.push(`Stay flat until ${ev.title} (${ev.currency}) releases and a post-news 5M candle closes cleanly.`);
  } else {
    const highCount = scout.relevantEvents.filter((e) => e.impact === 'High').length;
    const medCount = scout.relevantEvents.filter((e) => e.impact === 'Medium').length;
    d2Verdict = 'Neutral';
    if (scout.macroNewsBrief) {
      const lower = scout.macroNewsBrief.toLowerCase();
      if (lower.includes('hawkish') || lower.includes('rate hike')) {
        d2Verdict = symbol.startsWith('USD/') ? 'Bullish' : 'Bearish';
      } else if (lower.includes('dovish') || lower.includes('rate cut')) {
        d2Verdict = symbol.startsWith('USD/') ? 'Bearish' : 'Bullish';
      }
      d2Summary = scout.macroNewsBrief;
    } else {
      d2Summary =
        highCount > 0 || medCount > 0
          ? `${highCount} High / ${medCount} Medium ${getRelevantCurrenciesForSymbol(symbol).join('/')} calendar events tracked outside immediate blackout window.`
          : `No imminent High-impact ${getRelevantCurrenciesForSymbol(symbol).join('/')} central bank or macro releases in the next 90 minutes.`;
    }
    for (const ev of scout.relevantEvents.slice(0, 3)) {
      d2Evidence.push(
        `${ev.impact} · ${ev.currency}: ${ev.title}${ev.actual ? ` (Act ${ev.actual})` : ev.forecast ? ` (Fcst ${ev.forecast})` : ''}`
      );
    }
    if (d2Evidence.length === 0) {
      d2Evidence.push('Calendar window clear of imminent high-impact central bank or inflation prints.');
    }
    if (
      (evalSide === 'BUY' && d2Verdict === 'Bearish') ||
      (evalSide === 'SELL' && d2Verdict === 'Bullish')
    ) {
      conflictingFactors.push(`Macro/central bank tone (${d2Verdict}) opposes ${evalSide} direction.`);
    } else if (evalSide !== 'WAIT') {
      confirmingFactors.push(`Macro calendar clear of immediate blackout (${d2Summary.slice(0, 95)}).`);
    }
  }

  // 3. Asset or instrument fundamentals
  let d3Verdict: MarketDriverVerdict = 'Missing Data';
  let d3Summary = '';
  const d3Evidence: string[] = [];
  const headlineEval = scoreHeadlineBiasForSymbol(symbol, scout.newsHeadlines);

  if (isSynthetic) {
    d3Verdict = 'Neutral';
    d3Summary = 'Synthetic index follows continuous mathematical volatility dynamics without earnings or physical supply.';
    d3Evidence.push(`Instrument category: Synthetic (${instrument.description})`);
  } else if (!scout.hasVerifiedExternalNews && !scout.fundamentalsBrief && scout.newsHeadlines.length === 0) {
    d3Verdict = 'Missing Data';
    d3Summary = `Live fundamental/news catalysts for ${symbol} could not be retrieved.`;
    d3Evidence.push('No verified asset-specific news or fundamental brief available.');
    conflictingFactors.push(`Missing verified live fundamental/news catalysts for ${symbol}.`);
    requiredChecks.push(`Verify latest ${instrument.name} (${symbol}) central bank, yield, ETF/supply, or major news announcements before executing.`);
  } else {
    if (headlineEval.bullHits > headlineEval.bearHits) d3Verdict = 'Bullish';
    else if (headlineEval.bearHits > headlineEval.bullHits) d3Verdict = 'Bearish';
    else d3Verdict = 'Neutral';

    if (scout.fundamentalsBrief) {
      d3Summary = scout.fundamentalsBrief;
    } else if (scout.newsHeadlines.length > 0) {
      d3Summary = `Scouted ${scout.newsHeadlines.length} recent ${symbol} market headlines (${headlineEval.bullHits} bullish / ${headlineEval.bearHits} bearish cues).`;
    } else {
      d3Summary = 'Verified live news feed checked; no directional fundamental catalyst shift detected.';
    }

    d3Evidence.push(...headlineEval.sampleTitles);
    if (scout.fngIndex && instrument.category === 'Digital') {
      d3Evidence.push(`Crypto Fear & Greed Index: ${scout.fngIndex.value}/100 (${scout.fngIndex.classification})`);
    }
    if (
      (evalSide === 'BUY' && d3Verdict === 'Bearish') ||
      (evalSide === 'SELL' && d3Verdict === 'Bullish')
    ) {
      conflictingFactors.push(`Fundamental/news flow leans ${d3Verdict}, opposing a ${evalSide} entry.`);
      requiredChecks.push(`Confirm whether ${d3Verdict.toLowerCase()} fundamental headlines have been priced in before taking ${evalSide}.`);
    } else if (evalSide !== 'WAIT') {
      confirmingFactors.push(`Asset fundamentals/news (${d3Verdict}) support/do not oppose ${evalSide}.`);
    }
  }

  // 4. Market sentiment and risk environment
  let d4Verdict: MarketDriverVerdict = 'Neutral';
  let d4Summary = scout.crossMarketSummary;
  const d4Evidence: string[] = [scout.crossMarketSummary];

  if (scout.highImpactRiskDetected || headlineEval.shockDetected) {
    d4Verdict = 'Conflicting';
    d4Summary =
      scout.highImpactRiskNote ??
      'Geopolitical or policy shock headline detected in live news feed; heightened headline volatility risk.';
    d4Evidence.push(d4Summary);
    conflictingFactors.push(d4Summary);
    requiredChecks.push('Verify shock headline resolution and wait for volatility contraction on closed 5M candles.');
  } else if (scout.crossMarketRiskTone === 'Unavailable' && !scout.sentimentBrief) {
    d4Verdict = isSynthetic ? 'Neutral' : 'Missing Data';
    if (!isSynthetic) {
      conflictingFactors.push('Live Gold/USD intraday sentiment telemetry unavailable.');
      requiredChecks.push('Verify live XAU/USD tape, DXY/US yields, and geopolitical risk headlines before entering.');
    }
  } else {
    if (scout.sentimentBrief) {
      d4Summary = scout.sentimentBrief;
      d4Evidence.push(scout.sentimentBrief);
    }
    const xauMatch = scout.crossMarketSummary.match(/XAU\/USD\s+([+-]?\d+(?:\.\d+)?)%/);
    const xauChg = xauMatch ? Number(xauMatch[1]) : 0;
    if (xauChg >= 0.45) {
      d4Verdict = 'Bullish';
    } else if (xauChg <= -0.45) {
      d4Verdict = 'Bearish';
    } else if (scout.crossMarketRiskTone === 'Risk-Off') {
      d4Verdict = xauChg <= -0.25 ? 'Bearish' : 'Bullish';
    } else {
      d4Verdict = 'Neutral';
    }
    if (
      (evalSide === 'BUY' && d4Verdict === 'Bearish') ||
      (evalSide === 'SELL' && d4Verdict === 'Bullish')
    ) {
      conflictingFactors.push(`Broader Gold/risk sentiment (${scout.crossMarketRiskTone}) leans against ${evalSide} on ${symbol}.`);
    } else if (evalSide !== 'WAIT') {
      confirmingFactors.push(`Risk environment (${scout.crossMarketRiskTone}) is aligned/non-hostile.`);
    }
  }

  // 5. Technical structure and market mechanics
  const htfBull = a4h?.bias === 'Bullish' && a1h?.bias === 'Bullish';
  const htfBear = a4h?.bias === 'Bearish' && a1h?.bias === 'Bearish';
  const htfCoreOpposing = Boolean(
    a4h &&
      a1h &&
      ((a4h.bias === 'Bullish' && a1h.bias === 'Bearish') ||
        (a4h.bias === 'Bearish' && a1h.bias === 'Bullish'))
  );
  const htfReversalConfirmed = Boolean(
    a15m &&
      a5m &&
      a15m.bias !== 'Neutral' &&
      a15m.bias === a5m.bias &&
      ((a4h?.rangeZone === 'Discount' || a1h?.rangeZone === 'Discount') &&
        a15m.bias === 'Bullish' ||
        (a4h?.rangeZone === 'Premium' || a1h?.rangeZone === 'Premium') &&
          a15m.bias === 'Bearish')
  );
  const htfConflict = htfCoreOpposing && !htfReversalConfirmed;

  const d5Verdict: MarketDriverVerdict = htfConflict
    ? 'Conflicting'
    : htfBull
    ? 'Bullish'
    : htfBear
    ? 'Bearish'
    : bias === 'Bullish'
    ? 'Bullish'
    : bias === 'Bearish'
    ? 'Bearish'
    : 'Neutral';

  const d5Summary = `4H ${a4h?.bias ?? 'Neutral'} (${a4h?.structureEvent ?? 'Range'}) · 1H ${a1h?.bias ?? 'Neutral'} · 15M ${a15m?.bias ?? 'Neutral'} · 5M ${snap.latestStructureEvent} in ${snap.rangeZone} (${riskRewardRatio} R:R).`;
  const d5Evidence: string[] = [
    `Key dealing range: ${snap.dealingRangeLow.toFixed(d)}–${snap.dealingRangeHigh.toFixed(d)} (EQ ${snap.equilibriumPrice.toFixed(d)})`,
    `Latest 5M event: ${snap.latestStructureEvent} · Sweep: ${snap.recentSweep}`,
    ...(a5m ? [`5M note: ${a5m.note}`] : []),
  ];

  if (htfConflict) {
    conflictingFactors.push(`HTF technical conflict: 4H (${a4h?.bias ?? 'Neutral'}), 1H (${a1h?.bias ?? 'Neutral'}), and 15M (${a15m?.bias ?? 'Neutral'}) do not agree.`);
    requiredChecks.push('Wait for 4H, 1H, and 15M closed-bar structure to align in one direction (BOS/CHoCH agreement).');
  } else if (evalSide === 'BUY' && d5Verdict === 'Bullish') {
    confirmingFactors.push(`MTF technical structure aligns Bullish (4H ${a4h?.bias}, 1H ${a1h?.bias}, ${riskRewardRatio} R:R).`);
  } else if (evalSide === 'SELL' && d5Verdict === 'Bearish') {
    confirmingFactors.push(`MTF technical structure aligns Bearish (4H ${a4h?.bias}, 1H ${a1h?.bias}, ${riskRewardRatio} R:R).`);
  }

  if (proposedAction === 'WAIT' && !htfConflict) {
    conflictingFactors.push(`5M closed-bar sniper trigger not yet confirmed (${snap.rangePositionPct}% ${snap.rangeZone}, ${snap.latestStructureEvent}).`);
    requiredChecks.push(
      bias === 'Bearish'
        ? snap.rangePositionPct >= 60
          ? `Wait for a closed 5M bearish displacement/sweep candle from Supply OB/FVG inside Premium (currently ${snap.rangePositionPct}%).`
          : 'Wait for price to reach 5M Premium (>=60%) at Supply OB/FVG and close a bearish displacement/sweep candle.'
        : snap.rangePositionPct <= 40
        ? `Wait for a closed 5M bullish displacement/sweep candle from Demand OB/FVG inside Discount (currently ${snap.rangePositionPct}%).`
        : 'Wait for price to reach 5M Discount (<=40%) at Demand OB/FVG and close a bullish displacement/sweep candle.'
    );
  }

  const marketDrivers: MarketDriverAssessment[] = [
    {
      id: 1,
      driver: '1. Supply, Demand, Liquidity & Session Flow',
      verdict: d1Verdict,
      summary: `${scout.sessionName} · 5M in ${snap.rangeZone} (${snap.rangePositionPct}%) with ${snap.activeOrderBlockCount} OB / ${snap.unmitigatedFvgCount} FVG.`,
      evidence: d1Evidence,
    },
    {
      id: 2,
      driver: '2. Macroeconomic Catalysts & Central Bank Policy',
      verdict: d2Verdict,
      summary: d2Summary,
      evidence: d2Evidence,
    },
    {
      id: 3,
      driver: '3. Asset / Instrument Fundamentals',
      verdict: d3Verdict,
      summary: d3Summary,
      evidence: d3Evidence,
    },
    {
      id: 4,
      driver: '4. Market Sentiment & Risk Environment',
      verdict: d4Verdict,
      summary: d4Summary,
      evidence: d4Evidence,
    },
    {
      id: 5,
      driver: '5. Technical Structure & Market Mechanics',
      verdict: d5Verdict,
      summary: d5Summary,
      evidence: d5Evidence,
    },
  ];

  // Certainty Gate: Missing data on non-synthetic, blocked session, imminent high-impact news, shock risk, or dual macro+fundamental opposition blocks BUY/SELL -> NO SIGNAL
  const hasMissingCriticalDriver =
    !isSynthetic &&
    marketDrivers.some((m) => m.verdict === 'Missing Data');
  const dualMacroFundamentalConflict =
    !isSynthetic &&
    proposedAction !== 'WAIT' &&
    ((proposedAction === 'BUY' && d2Verdict === 'Bearish' && d3Verdict === 'Bearish') ||
      (proposedAction === 'SELL' && d2Verdict === 'Bullish' && d3Verdict === 'Bullish'));
  const hasBlockingConflict =
    scout.sessionBlocked ||
    Boolean(scout.imminentHighImpactEvent) ||
    scout.highImpactRiskDetected ||
    headlineEval.shockDetected ||
    htfConflict ||
    dualMacroFundamentalConflict;

  const shouldBlockSignal = hasMissingCriticalDriver || hasBlockingConflict;
  let blockReason: string | null = null;
  if (scout.sessionBlocked) {
    blockReason = `NO SIGNAL — ${scout.sessionName} (Thin / Closed Liquidity)`;
  } else if (scout.imminentHighImpactEvent) {
    blockReason = `NO SIGNAL — High-Impact ${scout.imminentHighImpactEvent.currency} Event Blackout`;
  } else if (scout.highImpactRiskDetected || headlineEval.shockDetected) {
    blockReason = 'NO SIGNAL — Geopolitical / News Shock Risk';
  } else if (hasMissingCriticalDriver) {
    blockReason = 'NO SIGNAL — Missing Verified Macro / News Data';
  } else if (htfConflict) {
    blockReason = 'NO SIGNAL — Higher-Timeframe Structure Conflict';
  } else if (hasBlockingConflict) {
    blockReason = 'NO SIGNAL — Macro / Fundamental Driver Conflicts With Setup';
  }

  // Deduplicate lists cleanly
  const dedupe = (arr: string[]) => Array.from(new Set(arr.filter(Boolean))).slice(0, 6);

  return {
    marketDrivers,
    confirmingFactors: dedupe(confirmingFactors),
    conflictingFactors: dedupe(conflictingFactors),
    requiredChecks: dedupe(requiredChecks),
    shouldBlockSignal,
    blockReason,
  };
}

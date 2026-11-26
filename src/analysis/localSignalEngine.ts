import { getInstrumentBySymbol } from '../config/instruments.ts';
import type {
  AIBacktestReview,
  AIPriceActionSignal,
  BacktestResult,
  MarketScoutContext,
  Timeframe,
  TimeframeAlignmentItem,
} from '../types/market.ts';
import { evaluateAllFiveDrivers } from './marketContext.ts';
import type { TimeframePriceActionInput } from './mtfPrompt.ts';
import {
  extractHistoricalPriceActionTimeline,
  getClosedCandlesForTimeframe,
} from './priceAction.ts';

function roundToDecimals(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = Math.pow(10, Math.max(0, Math.min(8, decimals)));
  return Math.round(value * factor) / factor;
}

interface TimeframeAssessment {
  timeframe: Timeframe;
  bias: 'Bullish' | 'Bearish' | 'Neutral';
  bullScore: number;
  bearScore: number;
  structureEvent: string;
  rangeZone: 'Discount' | 'Equilibrium' | 'Premium';
  note: string;
  eqhCount: number;
  eqlCount: number;
  lastDisplacementDir: 'Bullish' | 'Bearish' | 'None';
  lastClosedClose: number;
}

function assessTimeframe(
  input: TimeframePriceActionInput,
  decimals: number
): TimeframeAssessment {
  const closed = getClosedCandlesForTimeframe(input.candles ?? [], input.timeframe);
  const lastClosedClose = closed[closed.length - 1]?.close ?? 0;
  const snap = input.analysis.snapshot;
  const timeline = extractHistoricalPriceActionTimeline(input.candles ?? [], decimals, {
    timeframe: input.timeframe,
  });

  let bullScore = 0;
  let bearScore = 0;

  if (snap.trendStructure === 'Bullish (HH / HL)') bullScore += 2;
  else if (snap.trendStructure === 'Bearish (LH / LL)') bearScore += 2;

  if (snap.latestStructureEvent.startsWith('Bullish')) bullScore += 2;
  else if (snap.latestStructureEvent.startsWith('Bearish')) bearScore += 2;

  if (snap.recentSweep === 'Sell-Side Sweep (Bullish)') bullScore += 2;
  else if (snap.recentSweep === 'Buy-Side Sweep (Bearish)') bearScore += 2;

  if (snap.buyerPressurePct >= 57) bullScore += 1;
  else if (snap.buyerPressurePct <= 43) bearScore += 1;

  const lastDisp =
    timeline.displacementEvents[timeline.displacementEvents.length - 1] ?? '';
  const lastDisplacementDir: TimeframeAssessment['lastDisplacementDir'] =
    lastDisp.includes('Bullish Displacement')
      ? 'Bullish'
      : lastDisp.includes('Bearish Displacement')
      ? 'Bearish'
      : 'None';

  if (lastDisplacementDir === 'Bullish') bullScore += 1;
  else if (lastDisplacementDir === 'Bearish') bearScore += 1;

  const bias: TimeframeAssessment['bias'] =
    bullScore >= bearScore + 2
      ? 'Bullish'
      : bearScore >= bullScore + 2
      ? 'Bearish'
      : 'Neutral';

  const eqhCount = timeline.equalLiquidityPools.filter((p) =>
    p.startsWith('EQH')
  ).length;
  const eqlCount = timeline.equalLiquidityPools.filter((p) =>
    p.startsWith('EQL')
  ).length;

  const parts: string[] = [];
  if (snap.recentSweep !== 'None') {
    parts.push(snap.recentSweep.replace(' (Bullish)', '').replace(' (Bearish)', ''));
  }
  if (lastDisplacementDir !== 'None') {
    parts.push(`${lastDisplacementDir} disp`);
  }
  if (snap.activeOrderBlockCount > 0 || snap.unmitigatedFvgCount > 0) {
    parts.push(`${snap.activeOrderBlockCount} OB/${snap.unmitigatedFvgCount} FVG`);
  }
  if (eqhCount > 0 || eqlCount > 0) {
    parts.push(`${eqhCount} EQH/${eqlCount} EQL`);
  }
  if (parts.length === 0) {
    parts.push(`${snap.rangePositionPct}% of range`);
  }

  return {
    timeframe: input.timeframe,
    bias,
    bullScore,
    bearScore,
    structureEvent: snap.latestStructureEvent,
    rangeZone: snap.rangeZone,
    note: parts.slice(0, 3).join(' · '),
    eqhCount,
    eqlCount,
    lastDisplacementDir,
    lastClosedClose,
  };
}

export function generateLocalMtfSignal(params: {
  symbol: string;
  activeTimeframe: Timeframe;
  timeframesData: TimeframePriceActionInput[];
  scoutContext?: MarketScoutContext | null;
}): AIPriceActionSignal {
  const { symbol, activeTimeframe, timeframesData, scoutContext = null } = params;
  const instrument = getInstrumentBySymbol(symbol);
  const d = instrument.decimals;

  const order: Timeframe[] = ['4H', '1H', '15M', '5M', '1M'];
  const byTf = new Map<Timeframe, TimeframePriceActionInput>();
  for (const item of timeframesData ?? []) {
    byTf.set(item.timeframe, item);
  }

  const assessments: TimeframeAssessment[] = [];
  for (const tf of order) {
    const item = byTf.get(tf);
    if (item) assessments.push(assessTimeframe(item, d));
  }

  const getAssess = (tf: Timeframe) => assessments.find((a) => a.timeframe === tf);
  const a4h = getAssess('4H');
  const a1h = getAssess('1H');
  const a15m = getAssess('15M');
  const a5m = getAssess('5M');

  const m5Entry = byTf.get('5M') ?? byTf.get(activeTimeframe) ?? timeframesData[0];
  const m5Closed = getClosedCandlesForTimeframe(m5Entry?.candles ?? [], '5M');
  const lastClosed = m5Closed[m5Closed.length - 1];
  const confirmedBarTime = lastClosed?.time ?? 0;
  const rawClose = lastClosed?.close ?? instrument.basePrice;
  const spotPrice = roundToDecimals(
    Number.isFinite(rawClose) && rawClose > 0 ? rawClose : instrument.basePrice,
    d
  );

  const m5Snap = m5Entry.analysis.snapshot;
  const avgRange = Math.max(
    Number.isFinite(m5Snap.avgCandleRange) && m5Snap.avgCandleRange > 0
      ? m5Snap.avgCandleRange
      : spotPrice * 0.0005,
    spotPrice * 0.0002,
    1e-6
  );

  let htfBull = 0;
  let htfBear = 0;
  for (const [assess, weight] of [
    [a4h, 3],
    [a1h, 3],
    [a15m, 2],
  ] as const) {
    if (!assess) continue;
    if (assess.bias === 'Bullish') htfBull += weight;
    else if (assess.bias === 'Bearish') htfBear += weight;
  }

  const htfCoreOpposing = Boolean(
    a4h &&
      a1h &&
      ((a4h.bias === 'Bullish' && a1h.bias === 'Bearish') ||
        (a4h.bias === 'Bearish' && a1h.bias === 'Bullish'))
  );

  const bullExtremeReversal = Boolean(
    (a4h?.rangeZone === 'Discount' || a1h?.rangeZone === 'Discount') &&
      a15m?.bias === 'Bullish' &&
      a5m?.bias === 'Bullish' &&
      (m5Snap.recentSweep === 'Sell-Side Sweep (Bullish)' ||
        Boolean(a1h?.note.includes('Sell-Side Sweep')) ||
        Boolean(a4h?.note.includes('Sell-Side Sweep')))
  );
  const bearExtremeReversal = Boolean(
    (a4h?.rangeZone === 'Premium' || a1h?.rangeZone === 'Premium') &&
      a15m?.bias === 'Bearish' &&
      a5m?.bias === 'Bearish' &&
      (m5Snap.recentSweep === 'Buy-Side Sweep (Bearish)' ||
        Boolean(a1h?.note.includes('Buy-Side Sweep')) ||
        Boolean(a4h?.note.includes('Buy-Side Sweep')))
  );

  const htfConflict = htfCoreOpposing && !bullExtremeReversal && !bearExtremeReversal;

  const dominantBias: AIPriceActionSignal['bias'] = bullExtremeReversal
    ? 'Bullish'
    : bearExtremeReversal
    ? 'Bearish'
    : htfBull >= htfBear + 2
    ? 'Bullish'
    : htfBear >= htfBull + 2
    ? 'Bearish'
    : 'Neutral';

  const m5BullZones = (m5Entry.analysis.zones ?? []).filter(
    (z) => z.kind === 'Demand OB' || z.kind === 'Bullish FVG'
  );
  const m5BearZones = (m5Entry.analysis.zones ?? []).filter(
    (z) => z.kind === 'Supply OB' || z.kind === 'Bearish FVG'
  );

  const nearBullZone = m5BullZones.find(
    (z) =>
      spotPrice >= z.low - avgRange * 0.9 && spotPrice <= z.high + avgRange * 1.2
  );
  const nearBearZone = m5BearZones.find(
    (z) =>
      spotPrice <= z.high + avgRange * 0.9 && spotPrice >= z.low - avgRange * 1.2
  );

  const nearMajorSupport = (m5Entry.analysis.levels ?? []).find(
    (l) =>
      l.type === 'Support' &&
      l.strength === 'Major' &&
      Math.abs(spotPrice - l.price) <= avgRange * 1.35
  );
  const nearMajorResistance = (m5Entry.analysis.levels ?? []).find(
    (l) =>
      l.type === 'Resistance' &&
      l.strength === 'Major' &&
      Math.abs(spotPrice - l.price) <= avgRange * 1.35
  );

  const recentWindowStart = m5Closed[Math.max(0, m5Closed.length - 4)]?.time ?? 0;
  const recentPatterns = m5Entry.analysis.recentPatterns ?? [];
  const recentBullPattern =
    recentPatterns.find((p) => p.bias === 'Bullish' && p.time >= recentWindowStart) ??
    (m5Snap.latestPattern?.bias === 'Bullish' ? m5Snap.latestPattern : null);
  const recentBearPattern =
    recentPatterns.find((p) => p.bias === 'Bearish' && p.time >= recentWindowStart) ??
    (m5Snap.latestPattern?.bias === 'Bearish' ? m5Snap.latestPattern : null);

  const latestPattern = m5Snap.latestPattern;
  const hasBullPattern = Boolean(recentBullPattern);
  const hasBearPattern = Boolean(recentBearPattern);

  const bullSweepConfirmed =
    m5Snap.recentSweep === 'Sell-Side Sweep (Bullish)' ||
    Boolean(a15m?.note.includes('Sell-Side Sweep'));
  const bearSweepConfirmed =
    m5Snap.recentSweep === 'Buy-Side Sweep (Bearish)' ||
    Boolean(a15m?.note.includes('Buy-Side Sweep'));

  const bullDisplacement = a5m?.lastDisplacementDir === 'Bullish';
  const bearDisplacement = a5m?.lastDisplacementDir === 'Bearish';

  const bullConfirmations: string[] = [];
  if (bullSweepConfirmed) {
    bullConfirmations.push('Closed-bar sell-side liquidity sweep reclaimed');
  }
  if (bullDisplacement) {
    bullConfirmations.push('5M closed-bar bullish displacement & momentum expansion');
  }
  if (recentBullPattern) {
    bullConfirmations.push(`5M ${recentBullPattern.name} trigger`);
  }
  if (nearBullZone) {
    bullConfirmations.push(
      `Price mitigating 5M ${nearBullZone.kind} (${nearBullZone.low.toFixed(d)}-${nearBullZone.high.toFixed(d)})`
    );
  } else if (nearMajorSupport) {
    bullConfirmations.push(
      `Major Support rejection @ ${nearMajorSupport.price.toFixed(d)}`
    );
  }
  if (m5Snap.latestStructureEvent.startsWith('Bullish')) {
    bullConfirmations.push(`5M ${m5Snap.latestStructureEvent} confirmed`);
  }

  const bearConfirmations: string[] = [];
  if (bearSweepConfirmed) {
    bearConfirmations.push('Closed-bar buy-side liquidity sweep rejected');
  }
  if (bearDisplacement) {
    bearConfirmations.push('5M closed-bar bearish displacement & momentum expansion');
  }
  if (recentBearPattern) {
    bearConfirmations.push(`5M ${recentBearPattern.name} trigger`);
  }
  if (nearBearZone) {
    bearConfirmations.push(
      `Price mitigating 5M ${nearBearZone.kind} (${nearBearZone.low.toFixed(d)}-${nearBearZone.high.toFixed(d)})`
    );
  } else if (nearMajorResistance) {
    bearConfirmations.push(
      `Major Resistance rejection @ ${nearMajorResistance.price.toFixed(d)}`
    );
  }
  if (m5Snap.latestStructureEvent.startsWith('Bearish')) {
    bearConfirmations.push(`5M ${m5Snap.latestStructureEvent} confirmed`);
  }

  const closedBarRange = lastClosed
    ? Math.max(lastClosed.high - lastClosed.low, 1e-9)
    : 1;
  const bullClosedBar = Boolean(
    lastClosed &&
      lastClosed.close > lastClosed.open &&
      (lastClosed.close - lastClosed.low) / closedBarRange >= 0.42
  );
  const bearClosedBar = Boolean(
    lastClosed &&
      lastClosed.close < lastClosed.open &&
      (lastClosed.high - lastClosed.close) / closedBarRange >= 0.42
  );

  const inSniperDiscount =
    m5Snap.rangePositionPct <= 42 ||
    Boolean((nearBullZone || nearMajorSupport) && m5Snap.rangePositionPct <= 48) ||
    (bullExtremeReversal && m5Snap.rangePositionPct <= 52);
  const inSniperPremium =
    m5Snap.rangePositionPct >= 58 ||
    Boolean((nearBearZone || nearMajorResistance) && m5Snap.rangePositionPct >= 52) ||
    (bearExtremeReversal && m5Snap.rangePositionPct >= 48);

  const bullSniperTrigger =
    bullClosedBar &&
    (bullSweepConfirmed ||
      Boolean(nearBullZone) ||
      Boolean(nearMajorSupport) ||
      bullExtremeReversal) &&
    (bullDisplacement ||
      hasBullPattern ||
      m5Snap.latestStructureEvent.startsWith('Bullish')) &&
    bullConfirmations.length >= 2;

  const bearSniperTrigger =
    bearClosedBar &&
    (bearSweepConfirmed ||
      Boolean(nearBearZone) ||
      Boolean(nearMajorResistance) ||
      bearExtremeReversal) &&
    (bearDisplacement ||
      hasBearPattern ||
      m5Snap.latestStructureEvent.startsWith('Bearish')) &&
    bearConfirmations.length >= 2;

  let signalAction: 'BUY' | 'SELL' | 'WAIT' = 'WAIT';
  let signalStrength: 'A+ Setup' | 'Standard' | 'Developing' = 'Developing';
  let setupType = 'WAIT — No Sniper Setup (Stay Flat)';
  let triggerPattern = latestPattern?.name ?? 'Awaiting closed 5M sniper trigger';
  let confluences: string[] = [];

  if (
    m5Closed.length >= 30 &&
    confirmedBarTime > 0 &&
    !htfConflict &&
    dominantBias === 'Bullish' &&
    inSniperDiscount &&
    bullSniperTrigger
  ) {
    signalAction = 'BUY';
    signalStrength = 'A+ Setup';
    setupType = nearBullZone
      ? `Sniper HTF Bullish + 5M ${nearBullZone.kind} Mitigation`
      : 'Sniper HTF Bullish + 5M Sell-Side Sweep Displacement';
    triggerPattern = hasBullPattern && latestPattern
      ? latestPattern.name
      : '5M Sweep + Bullish Displacement BOS';
    confluences = [
      `4H/1H/15M HTF consensus (${a4h?.bias ?? 'Neutral'} / ${a1h?.bias ?? 'Neutral'} / ${a15m?.bias ?? 'Neutral'})`,
      `5M OTE Discount (${m5Snap.rangePositionPct}% of dealing range)`,
      ...bullConfirmations.slice(0, 2),
    ];
  } else if (
    m5Closed.length >= 30 &&
    confirmedBarTime > 0 &&
    !htfConflict &&
    dominantBias === 'Bearish' &&
    inSniperPremium &&
    bearSniperTrigger
  ) {
    signalAction = 'SELL';
    signalStrength = 'A+ Setup';
    setupType = nearBearZone
      ? `Sniper HTF Bearish + 5M ${nearBearZone.kind} Mitigation`
      : 'Sniper HTF Bearish + 5M Buy-Side Sweep Displacement';
    triggerPattern = hasBearPattern && latestPattern
      ? latestPattern.name
      : '5M Sweep + Bearish Displacement BOS';
    confluences = [
      `4H/1H/15M HTF consensus (${a4h?.bias ?? 'Neutral'} / ${a1h?.bias ?? 'Neutral'} / ${a15m?.bias ?? 'Neutral'})`,
      `5M OTE Premium (${m5Snap.rangePositionPct}% of dealing range)`,
      ...bearConfirmations.slice(0, 2),
    ];
  } else {
    const isBullWatch = dominantBias !== 'Bearish';
    setupType = htfConflict
      ? 'WAIT — HTF Conflict (No Sniper)'
      : dominantBias === 'Neutral'
      ? 'WAIT — Neutral HTF (Stay Flat)'
      : isBullWatch
      ? 'WAIT — Watch 5M Deep Discount Sniper Zone'
      : 'WAIT — Watch 5M Deep Premium Sniper Zone';
    triggerPattern = isBullWatch
      ? 'Need closed 5M sell-side sweep + displacement in Discount (<=40%)'
      : 'Need closed 5M buy-side sweep + displacement in Premium (>=60%)';
    confluences = [
      `4H: ${a4h?.bias ?? 'Neutral'} (${a4h?.structureEvent ?? 'Range'}) · 1H: ${a1h?.bias ?? 'Neutral'}`,
      `5M range ${m5Snap.rangePositionPct}% (${m5Snap.rangeZone}) · Need >=3 sniper confluences`,
      ...(isBullWatch ? bullConfirmations : bearConfirmations).slice(0, 2),
    ];
  }

  const planBullish =
    signalAction === 'BUY' ||
    (signalAction === 'WAIT' && dominantBias !== 'Bearish');

  let entryPrice = spotPrice;
  let entryZone = `${roundToDecimals(spotPrice - avgRange * 0.25, d).toFixed(d)}-${roundToDecimals(spotPrice + avgRange * 0.25, d).toFixed(d)}`;
  let stopLoss: number;
  let takeProfit1: number;
  let takeProfit2: number;

  const recentSlice = m5Closed.slice(-6);

  if (planBullish) {
    if (signalAction === 'WAIT' && m5BullZones.length > 0) {
      const targetZone = nearBullZone ?? m5BullZones[0];
      const mid = Number.isFinite(targetZone.midpoint) ? targetZone.midpoint : spotPrice;
      const low = Number.isFinite(targetZone.low) ? targetZone.low : spotPrice - avgRange;
      entryPrice = roundToDecimals(Math.min(spotPrice, mid), d);
      entryZone = `${low.toFixed(d)}-${(Number.isFinite(targetZone.high) ? targetZone.high : spotPrice).toFixed(d)}`;
      stopLoss = roundToDecimals(low - avgRange * 0.65, d);
    } else {
      const sliceLows = recentSlice.map((c) => c.low).filter((v) => Number.isFinite(v));
      const recentLow = Math.min(
        ...(sliceLows.length > 0 ? sliceLows : [spotPrice - avgRange]),
        nearBullZone?.low ?? spotPrice
      );
      const rawRisk = Math.max(
        avgRange * 1.15,
        Math.min(avgRange * 3.0, Math.abs(spotPrice - recentLow) + avgRange * 0.35)
      );
      stopLoss = roundToDecimals(entryPrice - rawRisk, d);
    }

    const risk = Math.max(Math.abs(entryPrice - stopLoss), avgRange * 1.05);
    stopLoss = roundToDecimals(entryPrice - risk, d);
    const eqPrice = Number.isFinite(m5Snap.equilibriumPrice)
      ? m5Snap.equilibriumPrice
      : entryPrice + risk * 1.5;
    const rangeHigh = Number.isFinite(m5Snap.dealingRangeHigh)
      ? m5Snap.dealingRangeHigh
      : entryPrice + risk * 2.6;
    takeProfit1 = roundToDecimals(
      Math.max(entryPrice + risk * 1.6, eqPrice + avgRange * 0.4),
      d
    );
    if (takeProfit1 <= entryPrice) {
      takeProfit1 = roundToDecimals(entryPrice + risk * 1.6, d);
    }
    takeProfit2 = roundToDecimals(
      Math.max(takeProfit1 + risk * 1.0, rangeHigh),
      d
    );
  } else {
    if (signalAction === 'WAIT' && m5BearZones.length > 0) {
      const targetZone = nearBearZone ?? m5BearZones[0];
      const mid = Number.isFinite(targetZone.midpoint) ? targetZone.midpoint : spotPrice;
      const high = Number.isFinite(targetZone.high) ? targetZone.high : spotPrice + avgRange;
      entryPrice = roundToDecimals(Math.max(spotPrice, mid), d);
      entryZone = `${(Number.isFinite(targetZone.low) ? targetZone.low : spotPrice).toFixed(d)}-${high.toFixed(d)}`;
      stopLoss = roundToDecimals(high + avgRange * 0.65, d);
    } else {
      const sliceHighs = recentSlice.map((c) => c.high).filter((v) => Number.isFinite(v));
      const recentHigh = Math.max(
        ...(sliceHighs.length > 0 ? sliceHighs : [spotPrice + avgRange]),
        nearBearZone?.high ?? spotPrice
      );
      const rawRisk = Math.max(
        avgRange * 1.15,
        Math.min(avgRange * 3.0, Math.abs(recentHigh - spotPrice) + avgRange * 0.35)
      );
      stopLoss = roundToDecimals(entryPrice + rawRisk, d);
    }

    const risk = Math.max(Math.abs(stopLoss - entryPrice), avgRange * 1.05);
    stopLoss = roundToDecimals(entryPrice + risk, d);
    const eqPrice = Number.isFinite(m5Snap.equilibriumPrice)
      ? m5Snap.equilibriumPrice
      : entryPrice - risk * 1.5;
    const rangeLow = Number.isFinite(m5Snap.dealingRangeLow)
      ? m5Snap.dealingRangeLow
      : entryPrice - risk * 2.6;
    takeProfit1 = roundToDecimals(
      Math.min(entryPrice - risk * 1.6, eqPrice - avgRange * 0.4),
      d
    );
    if (takeProfit1 >= entryPrice) {
      takeProfit1 = roundToDecimals(entryPrice - risk * 1.6, d);
    }
    takeProfit2 = roundToDecimals(
      Math.min(takeProfit1 - risk * 1.0, rangeLow),
      d
    );
  }

  const riskDist = Math.max(Math.abs(entryPrice - stopLoss), 1e-9);
  const rrVal = Math.abs(takeProfit2 - entryPrice) / riskDist;
  const riskRewardRatio = `1 : ${Number.isFinite(rrVal) ? rrVal.toFixed(1) : '2.0'}`;

  const invalidationReason = planBullish
    ? `5M candle close below ${stopLoss.toFixed(d)} invalidates demand structure.`
    : `5M candle close above ${stopLoss.toFixed(d)} invalidates supply structure.`;

  const topLevels = (m5Entry.analysis.levels ?? [])
    .slice(0, 3)
    .map((l) => `${l.type} @ ${l.price.toFixed(d)}`)
    .join(', ');
  const topZones = (m5Entry.analysis.zones ?? [])
    .slice(0, 3)
    .map((z) => `${z.kind} [${z.low.toFixed(d)}-${z.high.toFixed(d)}]`)
    .join(', ');
  const keyZonesExplanation = `${topZones ? `Active 5M zones: ${topZones}. ` : ''}${topLevels ? `Key S/R liquidity levels: ${topLevels}.` : 'Monitor 5M dealing range extremes for liquidity sweeps.'}`;

  const timeframeAlignment: TimeframeAlignmentItem[] = assessments.map((a) => ({
    timeframe: a.timeframe,
    bias: a.bias,
    structureEvent: a.structureEvent,
    rangeZone: a.rangeZone,
    note: a.note,
  }));

  const driverEval = evaluateAllFiveDrivers({
    symbol: instrument.symbol,
    proposedAction: signalAction,
    bias: dominantBias,
    m5Analysis: m5Entry.analysis,
    timeframeAlignment,
    riskRewardRatio,
    scout: scoutContext,
  });

  if (driverEval.shouldBlockSignal && signalAction !== 'WAIT') {
    signalAction = 'WAIT';
    signalStrength = 'Developing';
    setupType =
      driverEval.blockReason ?? 'NO SIGNAL — Unmet Multi-Driver Certainty';
    triggerPattern =
      driverEval.requiredChecks[0] ?? 'Resolve conflicting or missing checks first';
  }

  const analystVerdict: AIPriceActionSignal['analystVerdict'] =
    signalAction === 'BUY' ? 'BUY' : signalAction === 'SELL' ? 'SELL' : 'NO SIGNAL';

  const finalNarrative =
    signalAction === 'WAIT'
      ? `${
          driverEval.blockReason ? `${driverEval.blockReason}. ` : ''
        }Closed-bar 4H (${a4h?.bias ?? 'Neutral'}) & 1H (${a1h?.bias ?? 'Neutral'}) scan puts 5M at ${m5Snap.rangePositionPct}% (${m5Snap.rangeZone}) near ${spotPrice.toFixed(d)}. ${
          driverEval.conflictingFactors[0]
            ? `Conflict/Risk: ${driverEval.conflictingFactors[0]} `
            : ''
        }${
          driverEval.requiredChecks[0]
            ? `Check first: ${driverEval.requiredChecks[0]}`
            : ''
        }`
      : `Closed-bar 4H/1H/15M align ${dominantBias} in 5M ${m5Snap.rangeZone} (${m5Snap.rangePositionPct}%). ${(signalAction === 'BUY' ? bullConfirmations[0] : bearConfirmations[0]) || 'Closed-bar 5M displacement'} locks ${signalAction} at ${entryPrice.toFixed(d)} targeting ${takeProfit1.toFixed(d)} / ${takeProfit2.toFixed(d)} (${riskRewardRatio}).`;

  return {
    id: `sig-${instrument.symbol.replace('/', '')}-${confirmedBarTime || Date.now()}`,
    symbol: instrument.symbol,
    timeframe: activeTimeframe,
    signalTimeframe: '5M',
    analyzedAt: new Date().toISOString(),
    confirmedBarTime,
    confirmedBarCloseTime: confirmedBarTime > 0 ? confirmedBarTime + 300 : 0,
    isLockedToClosedBar: confirmedBarTime > 0,
    model: 'Local Sniper MTF (Free Forever)',
    spotPriceAtSignal: spotPrice,
    bias: dominantBias,
    analystVerdict,
    priceActionNarrative: finalNarrative,
    keyZonesExplanation,
    timeframeAlignment,
    marketDrivers: driverEval.marketDrivers,
    confirmingFactors: driverEval.confirmingFactors,
    conflictingFactors: driverEval.conflictingFactors,
    requiredChecks: driverEval.requiredChecks,
    scoutedSources: scoutContext?.sources?.slice(0, 6),
    plan: {
      signal: signalAction,
      signalStrength,
      setupType,
      triggerPattern,
      entryPrice,
      entryZone,
      stopLoss,
      takeProfit1,
      takeProfit2,
      riskRewardRatio,
      invalidationReason,
      confluences: confluences.slice(0, 4),
    },
  };
}

export function enforceSniperDiscipline(params: {
  signal: AIPriceActionSignal;
  timeframesData: TimeframePriceActionInput[];
  scoutContext?: MarketScoutContext | null;
}): AIPriceActionSignal {
  const { signal, timeframesData, scoutContext = null } = params;
  const byTf = new Map((timeframesData ?? []).map((t) => [t.timeframe, t]));
  const m5Entry = byTf.get('5M') ?? timeframesData[0];

  const driverEval = m5Entry
    ? evaluateAllFiveDrivers({
        symbol: signal.symbol,
        proposedAction: signal.plan.signal,
        bias: signal.bias,
        m5Analysis: m5Entry.analysis,
        timeframeAlignment: signal.timeframeAlignment,
        riskRewardRatio: signal.plan.riskRewardRatio,
        scout: scoutContext,
      })
    : null;

  if (signal.plan.signal === 'WAIT') {
    return {
      ...signal,
      analystVerdict: 'NO SIGNAL',
      marketDrivers:
        signal.marketDrivers?.length === 5
          ? signal.marketDrivers
          : driverEval?.marketDrivers ?? [],
      confirmingFactors: Array.from(
        new Set([...(signal.confirmingFactors ?? []), ...(driverEval?.confirmingFactors ?? [])])
      ).slice(0, 6),
      conflictingFactors: Array.from(
        new Set([...(signal.conflictingFactors ?? []), ...(driverEval?.conflictingFactors ?? [])])
      ).slice(0, 6),
      requiredChecks: Array.from(
        new Set([...(signal.requiredChecks ?? []), ...(driverEval?.requiredChecks ?? [])])
      ).slice(0, 6),
      scoutedSources: signal.scoutedSources ?? scoutContext?.sources?.slice(0, 6),
    };
  }

  const { plan } = signal;
  const isBuy = plan.signal === 'BUY';
  const entry = plan.entryPrice > 0 ? plan.entryPrice : signal.spotPriceAtSignal;
  const sl = plan.stopLoss;
  const tp1 = plan.takeProfit1;
  const tp2 = plan.takeProfit2;

  const validGeometry = isBuy
    ? sl > 0 && sl < entry && tp1 > entry && tp2 > tp1
    : sl > 0 && sl > entry && tp1 < entry && tp2 < tp1;

  const d = getInstrumentBySymbol(signal.symbol).decimals;
  const a4h = byTf.get('4H') ? assessTimeframe(byTf.get('4H')!, d) : null;
  const a1h = byTf.get('1H') ? assessTimeframe(byTf.get('1H')!, d) : null;
  const a15m = byTf.get('15M') ? assessTimeframe(byTf.get('15M')!, d) : null;
  const a5m = byTf.get('5M') ? assessTimeframe(byTf.get('5M')!, d) : null;
  const m5Closed = m5Entry
    ? getClosedCandlesForTimeframe(m5Entry.candles ?? [], '5M')
    : [];
  const lastClosedM5 = m5Closed[m5Closed.length - 1];
  const m5Snap = m5Entry?.analysis.snapshot;

  const reversalAligned =
    (isBuy &&
      (a4h?.rangeZone === 'Discount' || a1h?.rangeZone === 'Discount') &&
      a15m?.bias === 'Bullish' &&
      a5m?.bias === 'Bullish') ||
    (!isBuy &&
      (a4h?.rangeZone === 'Premium' || a1h?.rangeZone === 'Premium') &&
      a15m?.bias === 'Bearish' &&
      a5m?.bias === 'Bearish');

  const htfOpposes =
    !reversalAligned &&
    ((isBuy && (a4h?.bias === 'Bearish' || a1h?.bias === 'Bearish')) ||
      (!isBuy && (a4h?.bias === 'Bullish' || a1h?.bias === 'Bullish')));

  const wrongSideOfRange =
    !reversalAligned &&
    m5Snap &&
    ((isBuy && m5Snap.rangePositionPct > 50) ||
      (!isBuy && m5Snap.rangePositionPct < 50));

  const m5Range = lastClosedM5
    ? Math.max(lastClosedM5.high - lastClosedM5.low, 1e-9)
    : 1;
  const wrongCandleDirection =
    !lastClosedM5 ||
    (isBuy
      ? lastClosedM5.close <= lastClosedM5.open ||
        (lastClosedM5.close - lastClosedM5.low) / m5Range < 0.42
      : lastClosedM5.close >= lastClosedM5.open ||
        (lastClosedM5.high - lastClosedM5.close) / m5Range < 0.42);

  const missingClosedLock =
    !signal.isLockedToClosedBar ||
    signal.confirmedBarTime <= 0 ||
    m5Closed.length < 30;

  const weakQuality =
    plan.signalStrength !== 'A+ Setup' || plan.confluences.length < 2;

  if (
    driverEval?.shouldBlockSignal ||
    missingClosedLock ||
    !validGeometry ||
    htfOpposes ||
    wrongSideOfRange ||
    wrongCandleDirection ||
    weakQuality
  ) {
    const localStrict = generateLocalMtfSignal({
      symbol: signal.symbol,
      activeTimeframe: signal.timeframe,
      timeframesData,
      scoutContext,
    });
    if (localStrict.plan.signal === 'WAIT') {
      return {
        ...localStrict,
        model: `${signal.model} · Sniper Filtered`,
      };
    }
    return {
      ...localStrict,
      model: `${signal.model} · Sniper Calibrated`,
    };
  }

  return {
    ...signal,
    analystVerdict: signal.plan.signal,
    marketDrivers:
      signal.marketDrivers?.length === 5
        ? signal.marketDrivers
        : driverEval?.marketDrivers ?? [],
    confirmingFactors: Array.from(
      new Set([...(signal.confirmingFactors ?? []), ...(driverEval?.confirmingFactors ?? [])])
    ).slice(0, 6),
    conflictingFactors: Array.from(
      new Set([...(signal.conflictingFactors ?? []), ...(driverEval?.conflictingFactors ?? [])])
    ).slice(0, 6),
    requiredChecks: Array.from(
      new Set([...(signal.requiredChecks ?? []), ...(driverEval?.requiredChecks ?? [])])
    ).slice(0, 6),
    scoutedSources: signal.scoutedSources ?? scoutContext?.sources?.slice(0, 6),
  };
}

export function generateLocalBacktestReview(
  backtest: BacktestResult
): AIBacktestReview {
  const verdict: AIBacktestReview['verdict'] =
    backtest.profitFactor >= 1.5 && backtest.expectancyR > 0.25
      ? 'Strong Edge'
      : backtest.profitFactor >= 1.1 && backtest.expectancyR > 0
      ? 'Moderate Edge'
      : 'Needs Filtering';

  const sortedSetups = [...(backtest.setupBreakdown ?? [])].sort(
    (a, b) => b.netR - a.netR
  );
  const bestSetup = sortedSetups[0];
  const worstSetup = sortedSetups[sortedSetups.length - 1];

  const bestPerformingPattern = bestSetup
    ? `${bestSetup.setupType} (${bestSetup.netR >= 0 ? '+' : ''}${bestSetup.netR.toFixed(2)}R across ${bestSetup.trades} trades, ${bestSetup.winRatePct.toFixed(0)}% WR)`
    : 'Insufficient closed trades';

  const keyWeakness =
    backtest.maxDrawdownPct > 10
      ? `Peak drawdown reached ${backtest.maxDrawdownPct.toFixed(1)}% with ${backtest.losses} stop-outs${worstSetup && worstSetup.netR < 0 ? `, led by ${worstSetup.setupType} (${worstSetup.netR.toFixed(2)}R)` : ''}.`
      : worstSetup && worstSetup.netR < 0
      ? `${worstSetup.setupType} dragged expectancy (${worstSetup.netR.toFixed(2)}R net across ${worstSetup.trades} trades).`
      : 'Low trade sample size or breakeven clustering after TP1.';

  const summary = `Across ${backtest.barsTested} causal non-repainting ${backtest.timeframe} bars on ${backtest.symbol}, ${backtest.totalTrades} trades yielded a ${backtest.winRatePct.toFixed(1)}% win rate, ${backtest.profitFactor.toFixed(2)} profit factor, and ${backtest.expectancyR >= 0 ? '+' : ''}${backtest.expectancyR.toFixed(2)}R expectancy (${backtest.netReturnPct >= 0 ? '+' : ''}${backtest.netReturnPct.toFixed(2)}% net return).`;

  const recommendations = [
    'Restrict executions strictly to setups aligned with confirmed 4H/1H swing structure and opposing EQH/EQL liquidity targets.',
    'Require a closed-bar 5M displacement candle following any liquidity sweep before placing next-bar Open entries.',
    'Skip mid-range equilibrium entries (42%–58% of dealing range) and prioritize fresh unmitigated Demand/Supply Order Blocks.',
  ];

  return {
    model: 'Local Audit (Free Forever)',
    reviewedAt: new Date().toISOString(),
    verdict,
    summary,
    bestPerformingPattern,
    keyWeakness,
    recommendations,
  };
}

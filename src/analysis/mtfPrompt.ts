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
      ? `Action: NO SIGNAL — ${signal.requiredChecks?.[0] || 'WAIT FOR SMC CONFIRMATION'}`
      : `Action: ENTER NOW (${plan.signal} Confirmed on Closed Bar)`;

  const lines = [
    `SMC | ${signal.symbol}`,
    `${verdictLabel} | ${plan.setupType}`,
    actionLine,
    `Entry: ${fmt(plan.entryPrice)} | SL: ${fmt(plan.stopLoss)}`,
    `TP1: ${fmt(plan.takeProfit1)} | TP2: ${fmt(plan.takeProfit2)} (${plan.riskRewardRatio})`,
    `Trigger: ${plan.triggerPattern}`,
    ...(signal.conflictingFactors?.[0]
      ? [`Note/Trap Check: ${signal.conflictingFactors[0]}`]
      : []),
    `Invalidation: ${plan.invalidationReason}`,
    `Closed Bar: ${barTime}`,
  ];

  return lines.join('\n');
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { analyzePriceAction } from './analysis/priceAction';
import { AIAnalysisCard } from './components/AIAnalysisCard';
import { CandlestickChart } from './components/CandlestickChart';
import { LivePriceHeader } from './components/LivePriceHeader';
import { PriceActionStructureStrip } from './components/PriceActionStructureStrip';
import { PriceActionZonesPanel } from './components/PriceActionZonesPanel';
import { RiskDisclaimerBanner } from './components/RiskDisclaimerBanner';
import { TopNavBar } from './components/TopNavBar';
import { WatchlistSidebar } from './components/WatchlistSidebar';
import { getInstrumentBySymbol } from './config/instruments';
import {
  fetchMarketCandles,
  fetchWatchlistQuotes,
  requestPriceActionSignal,
  subscribeMarketStream,
} from './services/marketClient';
import type {
  AIPriceActionSignal,
  FeedOrigin,
  OHLCVCandle,
  Timeframe,
  WatchlistQuote,
} from './types/market';

export default function App() {
  const [selectedSymbol, setSelectedSymbol] = useState<string>('XAU/USD');
  const [timeframe, setTimeframe] = useState<Timeframe>('5M');
  const [activeSection, setActiveSection] = useState<
    'workspace' | 'levels' | 'setup' | 'risk'
  >('workspace');

  const [watchlist, setWatchlist] = useState<WatchlistQuote[]>([]);
  const [watchlistLoading, setWatchlistLoading] = useState<boolean>(true);

  const [candles, setCandles] = useState<OHLCVCandle[]>([]);
  const [candlesLoading, setCandlesLoading] = useState<boolean>(true);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [source, setSource] = useState<FeedOrigin>('simulated-live');
  const [sourceLabel, setSourceLabel] = useState<string>('Market Feed');

  const [livePrice, setLivePrice] = useState<number>(0);
  const [bid, setBid] = useState<number>(0);
  const [ask, setAsk] = useState<number>(0);
  const [changePct, setChangePct] = useState<number>(0);
  const [isStreamConnected, setIsStreamConnected] = useState<boolean>(false);

  const [activeSignal, setActiveSignal] = useState<AIPriceActionSignal | null>(
    null
  );
  const [signalHistory, setSignalHistory] = useState<AIPriceActionSignal[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const candlesRef = useRef<OHLCVCandle[]>([]);
  candlesRef.current = candles;

  const instrument = useMemo(
    () => getInstrumentBySymbol(selectedSymbol),
    [selectedSymbol]
  );

  const priceAction = useMemo(
    () => analyzePriceAction(candles, instrument.decimals),
    [candles, instrument.decimals]
  );

  const sessionStats = useMemo(() => {
    const recent = candles.slice(-48);
    if (recent.length === 0) {
      return { high: instrument.basePrice, low: instrument.basePrice };
    }
    return {
      high: Math.max(...recent.map((c) => c.high)),
      low: Math.min(...recent.map((c) => c.low)),
    };
  }, [candles, instrument.basePrice]);

  // Initial & periodic watchlist fetch
  useEffect(() => {
    let active = true;
    const loadWatchlist = async () => {
      try {
        const quotes = await fetchWatchlistQuotes();
        if (active) {
          setWatchlist(quotes);
          setWatchlistLoading(false);
        }
      } catch {
        if (active) setWatchlistLoading(false);
      }
    };
    loadWatchlist();
    const timer = setInterval(loadWatchlist, 12000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  // Load historical candles & connect live SSE stream on symbol/timeframe change
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    setCandlesLoading(true);
    setFeedError(null);

    fetchMarketCandles(selectedSymbol, timeframe, 180)
      .then((payload) => {
        if (cancelled) return;
        setCandles(payload.candles);
        setSource(payload.source);
        setSourceLabel(payload.sourceLabel);
        setCandlesLoading(false);

        const last = payload.candles[payload.candles.length - 1];
        const anchor = payload.candles[Math.max(0, payload.candles.length - 48)];
        if (last) {
          setLivePrice(last.close);
          const spread =
            last.close * (instrument.category === 'Forex' ? 0.00012 : 0.00025);
          setBid(last.close - spread / 2);
          setAsk(last.close + spread / 2);
          if (anchor) {
            setChangePct(
              ((last.close - anchor.open) / Math.max(anchor.open, 1e-9)) * 100
            );
          }
        }

        unsubscribe = subscribeMarketStream(
          selectedSymbol,
          timeframe,
          (tick) => {
            if (cancelled) return;
            setLivePrice(tick.price);
            setBid(tick.bid);
            setAsk(tick.ask);
            setChangePct(tick.changePct);
            setSource(tick.source);

            setCandles((prev) => {
              if (prev.length === 0) return [tick.candle];
              const lastBar = prev[prev.length - 1];
              if (tick.candle.time === lastBar.time) {
                const next = prev.slice();
                next[next.length - 1] = tick.candle;
                return next;
              }
              if (tick.candle.time > lastBar.time) {
                const next = [...prev, tick.candle];
                if (next.length > 260) next.shift();
                return next;
              }
              return prev;
            });

            setWatchlist((prev) =>
              prev.map((q) =>
                q.symbol === tick.symbol
                  ? { ...q, price: tick.price, changePct: tick.changePct }
                  : q
              )
            );
          },
          (connected) => {
            if (!cancelled) setIsStreamConnected(connected);
          },
          () => {
            const list = candlesRef.current;
            const anchorBar = list[Math.max(0, list.length - 48)];
            return {
              lastCandle: list[list.length - 1],
              anchorOpen: anchorBar?.open,
            };
          }
        );
      })
      .catch((err) => {
        if (cancelled) return;
        setCandlesLoading(false);
        setFeedError(
          err instanceof Error ? err.message : 'Unable to load chart candles.'
        );
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [selectedSymbol, timeframe, instrument.category]);

  const handleGenerateSignal = useCallback(async () => {
    setIsAnalyzing(true);
    setAiError(null);
    try {
      const result = await requestPriceActionSignal({
        symbol: selectedSymbol,
        timeframe,
        candles: candlesRef.current,
      });
      setActiveSignal(result.signal);
      setSignalHistory((prev) => [result.signal, ...prev].slice(0, 12));
    } catch (err) {
      setAiError(
        err instanceof Error
          ? err.message
          : 'Failed to generate AI price-action signal.'
      );
    } finally {
      setIsAnalyzing(false);
    }
  }, [selectedSymbol, timeframe]);

  const handleNavigate = (section: 'workspace' | 'levels' | 'setup' | 'risk') => {
    setActiveSection(section);
    const target = document.getElementById(section);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const displayPrice = livePrice || instrument.basePrice;
  const displayBid = bid || displayPrice;
  const displayAsk = ask || displayPrice;

  return (
    <div className="min-h-screen bg-[#0B0F17] text-slate-100 flex flex-col">
      <TopNavBar
        activeSection={activeSection}
        onNavigate={handleNavigate}
        onGenerateSignal={handleGenerateSignal}
        isAnalyzing={isAnalyzing}
      />

      <div className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col lg:flex-row">
        <WatchlistSidebar
          quotes={watchlist}
          selectedSymbol={selectedSymbol}
          onSelectSymbol={(sym) => {
            setSelectedSymbol(sym);
            setAiError(null);
          }}
          isLoading={watchlistLoading}
        />

        <main id="workspace" className="flex-1 min-w-0 flex flex-col">
          <LivePriceHeader
            instrument={instrument}
            timeframe={timeframe}
            price={displayPrice}
            bid={displayBid}
            ask={displayAsk}
            changePct={changePct}
            sessionHigh={sessionStats.high}
            sessionLow={sessionStats.low}
            avgCandleRange={priceAction.snapshot.avgCandleRange}
            isConnected={isStreamConnected}
            source={source}
            sourceLabel={sourceLabel}
          />

          <div className="flex-1 space-y-5 p-4 sm:p-6">
            {feedError && (
              <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-xs text-rose-200">
                {feedError}
              </div>
            )}

            {/* Primary Workspace Grid: Pure Price Action Chart Left, AI Signal Card Right */}
            <div className="grid grid-cols-1 gap-5 xl:grid-cols-12 items-start">
              <div className="space-y-4 xl:col-span-8">
                <CandlestickChart
                  symbol={selectedSymbol}
                  timeframe={timeframe}
                  decimals={instrument.decimals}
                  candles={candles}
                  priceAction={priceAction}
                  activeSignal={activeSignal}
                  isLoading={candlesLoading}
                  onTimeframeChange={setTimeframe}
                />

                <PriceActionStructureStrip
                  snapshot={priceAction.snapshot}
                  decimals={instrument.decimals}
                />
              </div>

              <div className="xl:col-span-4">
                <AIAnalysisCard
                  symbol={selectedSymbol}
                  timeframe={timeframe}
                  decimals={instrument.decimals}
                  signal={activeSignal}
                  isAnalyzing={isAnalyzing}
                  error={aiError}
                  onGenerateSignal={handleGenerateSignal}
                />
              </div>
            </div>

            <PriceActionZonesPanel
              symbol={selectedSymbol}
              decimals={instrument.decimals}
              levels={priceAction.levels}
              zones={priceAction.zones}
              signalHistory={signalHistory}
              onSelectSignal={(sig) => setActiveSignal(sig)}
              onSelectSymbolTimeframe={(sym, tf) => {
                setSelectedSymbol(sym);
                setTimeframe(tf);
                setAiError(null);
              }}
            />

            <RiskDisclaimerBanner />
          </div>
        </main>
      </div>
    </div>
  );
}

import { GoogleGenAI } from '@google/genai';
import {
  assessCrossMarketRiskEnvironment,
  getUtcSessionContext,
} from '../analysis/marketContext.ts';
import { getInstrumentBySymbol } from '../config/instruments.ts';
import type {
  EconomicCalendarEvent,
  GroundedSourceLink,
  MarketCategory,
  MarketScoutContext,
  WatchlistQuote,
} from '../types/market.ts';
import { getWatchlistQuotes } from './marketData.ts';

const CALENDAR_TTL_MS = 15 * 60_000;
const FNG_TTL_MS = 15 * 60_000;
const NEWS_TTL_MS = 5 * 60_000;
const SEARCH_SCOUT_TTL_MS = 5 * 60_000;
const HTTP_TIMEOUT_MS = 4500;

interface RawCalendarItem {
  title?: string;
  country?: string;
  date?: string;
  impact?: string;
  forecast?: string;
  previous?: string;
  actual?: string;
}

interface FxEmpireCalendarEvent {
  date?: string;
  name?: string;
  impact?: number;
  country?: string;
  forecast?: string;
  previous?: string;
  actual?: string;
}

interface FxEmpireCalendarResponse {
  calendar?: Array<{
    day?: string;
    events?: FxEmpireCalendarEvent[];
  }>;
}

let cachedCalendar: { fetchedAt: number; events: EconomicCalendarEvent[] } | null = null;
let calendarInflight: Promise<{ available: boolean; events: EconomicCalendarEvent[] }> | null = null;
let cachedFng: {
  fetchedAt: number;
  data: { value: number; classification: string } | null;
} | null = null;

const rssNewsCache = new Map<
  string,
  {
    fetchedAt: number;
    headlines: MarketScoutContext['newsHeadlines'];
  }
>();

const geminiSearchCache = new Map<
  string,
  {
    fetchedAt: number;
    macroNewsBrief: string | null;
    fundamentalsBrief: string | null;
    sentimentBrief: string | null;
    highImpactRiskDetected: boolean;
    highImpactRiskNote: string | null;
    sources: GroundedSourceLink[];
  }
>();

async function fetchWithTimeout(url: string, timeoutMs = HTTP_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeImpact(raw?: string | number): EconomicCalendarEvent['impact'] {
  if (typeof raw === 'number') {
    if (raw >= 3) return 'High';
    if (raw === 2) return 'Medium';
    return 'Low';
  }
  const lower = String(raw ?? '').toLowerCase();
  if (lower.includes('high')) return 'High';
  if (lower.includes('medium')) return 'Medium';
  if (lower.includes('holiday')) return 'Holiday';
  return 'Low';
}

function mapCountrySlugToCurrency(raw?: string): string {
  const slug = String(raw ?? '').trim().toLowerCase();
  if (!slug) return '';
  if (slug.length === 3) return slug.toUpperCase();
  if (slug === 'united-states' || slug === 'usa' || slug === 'us') return 'USD';
  if (
    slug === 'euro-area' ||
    slug === 'eurozone' ||
    slug === 'germany' ||
    slug === 'france' ||
    slug === 'italy' ||
    slug === 'spain' ||
    slug === 'netherlands'
  ) {
    return 'EUR';
  }
  if (slug === 'united-kingdom' || slug === 'uk') return 'GBP';
  if (slug === 'japan') return 'JPY';
  if (slug === 'switzerland') return 'CHF';
  if (slug === 'australia') return 'AUD';
  if (slug === 'canada') return 'CAD';
  if (slug === 'new-zealand') return 'NZD';
  if (slug === 'china') return 'CNY';
  return slug.slice(0, 3).toUpperCase();
}

async function fetchFxEmpireCalendar(): Promise<EconomicCalendarEvent[] | null> {
  try {
    const res = await fetchWithTimeout('https://www.fxempire.com/api/v1/en/economic-calendar');
    if (!res.ok) return null;
    const json = (await res.json()) as FxEmpireCalendarResponse;
    if (!Array.isArray(json.calendar)) return null;

    const events: EconomicCalendarEvent[] = [];
    for (const day of json.calendar) {
      for (const item of day.events ?? []) {
        if (!item.name || !item.date) continue;
        const currency = mapCountrySlugToCurrency(item.country);
        if (!currency) continue;
        const tsMs = Date.parse(item.date);
        if (!Number.isFinite(tsMs)) continue;
        events.push({
          title: String(item.name).trim(),
          currency,
          dateIso: new Date(tsMs).toISOString(),
          timestampSec: Math.floor(tsMs / 1000),
          impact: normalizeImpact(item.impact),
          forecast: item.forecast ? String(item.forecast).trim() : undefined,
          previous: item.previous ? String(item.previous).trim() : undefined,
          actual: item.actual ? String(item.actual).trim() : undefined,
        });
      }
    }
    return events;
  } catch {
    return null;
  }
}

async function fetchForexFactoryCalendar(): Promise<EconomicCalendarEvent[] | null> {
  try {
    const res = await fetchWithTimeout(
      'https://nfs.faireconomy.media/ff_calendar_thisweek.json'
    );
    if (!res.ok) return null;
    const raw = (await res.json()) as RawCalendarItem[];
    if (!Array.isArray(raw)) return null;

    const events: EconomicCalendarEvent[] = [];
    for (const item of raw) {
      if (!item.title || !item.country || !item.date) continue;
      const tsMs = Date.parse(item.date);
      if (!Number.isFinite(tsMs)) continue;
      events.push({
        title: String(item.title).trim(),
        currency: String(item.country).trim().toUpperCase(),
        dateIso: new Date(tsMs).toISOString(),
        timestampSec: Math.floor(tsMs / 1000),
        impact: normalizeImpact(item.impact),
        forecast: item.forecast ? String(item.forecast).trim() : undefined,
        previous: item.previous ? String(item.previous).trim() : undefined,
        actual: item.actual ? String(item.actual).trim() : undefined,
      });
    }
    return events;
  } catch {
    return null;
  }
}

async function fetchEconomicCalendar(): Promise<{
  available: boolean;
  events: EconomicCalendarEvent[];
}> {
  if (cachedCalendar && Date.now() - cachedCalendar.fetchedAt < CALENDAR_TTL_MS) {
    return { available: true, events: cachedCalendar.events };
  }
  if (calendarInflight) {
    return calendarInflight;
  }

  calendarInflight = (async () => {
    try {
      const fxEvents = await fetchFxEmpireCalendar();
      if (fxEvents !== null) {
        cachedCalendar = { fetchedAt: Date.now(), events: fxEvents };
        return { available: true, events: fxEvents };
      }

      const ffEvents = await fetchForexFactoryCalendar();
      if (ffEvents !== null) {
        cachedCalendar = { fetchedAt: Date.now(), events: ffEvents };
        return { available: true, events: ffEvents };
      }

      return {
        available: Boolean(cachedCalendar),
        events: cachedCalendar?.events ?? [],
      };
    } finally {
      calendarInflight = null;
    }
  })();

  return calendarInflight;
}

async function fetchCryptoFearGreed(): Promise<{
  value: number;
  classification: string;
} | null> {
  if (cachedFng && Date.now() - cachedFng.fetchedAt < FNG_TTL_MS) {
    return cachedFng.data;
  }

  try {
    const res = await fetchWithTimeout('https://api.alternative.me/fng/?limit=1');
    if (!res.ok) return cachedFng?.data ?? null;
    const json = (await res.json()) as {
      data?: Array<{ value?: string; value_classification?: string }>;
    };
    const first = json.data?.[0];
    const value = Number(first?.value);
    if (!Number.isFinite(value) || !first?.value_classification) {
      return cachedFng?.data ?? null;
    }
    const data = {
      value,
      classification: first.value_classification,
    };
    cachedFng = { fetchedAt: Date.now(), data };
    return data;
  } catch {
    return cachedFng?.data ?? null;
  }
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function getNewsQueryForSymbol(symbol: string, category: MarketCategory, batchMode: boolean): string | null {
  if (category === 'Synthetic') return null;

  if (batchMode) {
    if (symbol === 'XAU/USD') return 'XAUUSD OR gold price federal reserve';
    if (symbol === 'BTC/USD') return 'Bitcoin BTC price ETF macro';
    if (symbol.startsWith('USD/')) return 'US Dollar DXY Federal Reserve USDJPY USDCAD';
    if (symbol.endsWith('/JPY')) return 'EURJPY GBPJPY Bank of Japan yen';
    if (symbol === 'EUR/GBP') return 'EURGBP ECB Bank of England';
    return 'EURUSD GBPUSD AUDUSD forex dollar rates';
  }

  switch (symbol) {
    case 'XAU/USD':
      return 'XAUUSD OR gold price federal reserve yields';
    case 'BTC/USD':
      return 'Bitcoin BTC price ETF federal reserve';
    case 'EUR/USD':
      return 'EURUSD ECB Federal Reserve euro dollar';
    case 'GBP/USD':
      return 'GBPUSD Bank of England pound dollar';
    case 'USD/JPY':
      return 'USDJPY Bank of Japan yen dollar';
    case 'USD/CHF':
      return 'USDCHF Swiss National Bank franc dollar';
    case 'AUD/USD':
      return 'AUDUSD Reserve Bank of Australia aussie dollar';
    case 'USD/CAD':
      return 'USDCAD Bank of Canada oil loonie';
    case 'NZD/USD':
      return 'NZDUSD Reserve Bank of New Zealand kiwi dollar';
    case 'EUR/JPY':
      return 'EURJPY ECB Bank of Japan euro yen';
    case 'GBP/JPY':
      return 'GBPJPY Bank of England Bank of Japan pound yen';
    case 'EUR/GBP':
      return 'EURGBP ECB Bank of England euro pound';
    default:
      return `${symbol.replace('/', '')} forex central bank news`;
  }
}

async function fetchRssHeadlines(
  query: string
): Promise<MarketScoutContext['newsHeadlines']> {
  const cached = rssNewsCache.get(query);
  if (cached && Date.now() - cached.fetchedAt < NEWS_TTL_MS) {
    return cached.headlines;
  }

  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(
      query
    )}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return cached?.headlines ?? [];
    const xml = await res.text();

    const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
    const headlines: MarketScoutContext['newsHeadlines'] = [];

    for (const block of itemMatches.slice(0, 5)) {
      const rawTitle = block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '';
      const rawLink = block.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? '';
      const rawDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? '';
      const rawSource = block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] ?? 'News';
      const title = decodeXmlEntities(rawTitle).replace(/\s+-\s+[^-]+$/, '').trim();
      const uri = decodeXmlEntities(rawLink);
      const source = decodeXmlEntities(rawSource);
      const publishedAt = rawDate ? new Date(rawDate).toISOString() : new Date().toISOString();

      if (title && uri) {
        headlines.push({ title, publishedAt, source, uri });
      }
    }

    if (rssNewsCache.size > 40) {
      const firstKey = rssNewsCache.keys().next().value;
      if (firstKey) rssNewsCache.delete(firstKey);
    }
    rssNewsCache.set(query, { fetchedAt: Date.now(), headlines });
    return headlines;
  } catch {
    return cached?.headlines ?? [];
  }
}

function getRelevantCurrencies(symbol: string): string[] {
  if (symbol === 'XAU/USD' || symbol === 'BTC/USD') return ['USD'];
  const parts = symbol.split('/');
  if (parts.length === 2 && parts[0].length === 3 && parts[1].length === 3) {
    return parts;
  }
  return [];
}

function parseSection(text: string, label: string): string | null {
  const re = new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n[A-Z_]+:|$)`, 'i');
  const match = text.match(re);
  if (!match) return null;
  const val = match[1].trim();
  if (!val || /UNVERIFIED|NO DATA FOUND/i.test(val)) return null;
  return val;
}

async function runGeminiSearchScout(params: {
  symbol: string;
  name: string;
  category: MarketCategory;
  geminiKey: string;
}): Promise<{
  macroNewsBrief: string | null;
  fundamentalsBrief: string | null;
  sentimentBrief: string | null;
  highImpactRiskDetected: boolean;
  highImpactRiskNote: string | null;
  sources: GroundedSourceLink[];
} | null> {
  const { symbol, name, category, geminiKey } = params;
  if (category === 'Synthetic') return null;

  const cached = geminiSearchCache.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < SEARCH_SCOUT_TTL_MS) {
    return cached;
  }

  try {
    const ai = new GoogleGenAI({
      apiKey: geminiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
    const todayUtc = new Date().toISOString().slice(0, 10);

    const prompt = [
      `Today is ${todayUtc} UTC. Scout current, verified market drivers for ${name} (${symbol}) using Google Search.`,
      'Do NOT invent prices, dates, or events. If something cannot be verified, write "UNVERIFIED / NO DATA FOUND".',
      'Return plain text using these exact 4 section prefixes:',
      'MACRO_POLICY: 1-2 sentences on today/this week interest rates, inflation, growth, and scheduled central bank releases affecting this asset.',
      'FUNDAMENTALS: 1-2 sentences on current asset fundamentals (yield differentials, central bank reserves/ETF flows, supply/production shifts, or major announcements).',
      'RISK_SENTIMENT: 1-2 sentences on current risk-on vs risk-off environment and any geopolitical or breaking news shocks.',
      'SHOCK_RISK: Either "NONE" or a 1-sentence warning if an imminent/breaking high-impact macro or geopolitical shock makes directional trading hazardous.',
    ].join('\n');

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
      },
    });

    const text = (response.text ?? '').trim();
    if (!text) return null;

    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const seen = new Set<string>();
    const sources: GroundedSourceLink[] = [];
    for (const chunk of chunks) {
      const web = (chunk as { web?: { uri?: string; title?: string } }).web;
      if (web?.uri && !seen.has(web.uri)) {
        seen.add(web.uri);
        sources.push({
          title: web.title || new URL(web.uri).hostname,
          uri: web.uri,
        });
      }
    }

    const macroNewsBrief = parseSection(text, 'MACRO_POLICY');
    const fundamentalsBrief = parseSection(text, 'FUNDAMENTALS');
    const sentimentBrief = parseSection(text, 'RISK_SENTIMENT');
    const shockRaw = parseSection(text, 'SHOCK_RISK');
    const highImpactRiskDetected = Boolean(
      shockRaw && !/^none\b/i.test(shockRaw)
    );

    const result = {
      fetchedAt: Date.now(),
      macroNewsBrief,
      fundamentalsBrief,
      sentimentBrief,
      highImpactRiskDetected,
      highImpactRiskNote: highImpactRiskDetected ? shockRaw : null,
      sources: sources.slice(0, 6),
    };

    if (geminiSearchCache.size > 30) {
      const oldest = geminiSearchCache.keys().next().value;
      if (oldest) geminiSearchCache.delete(oldest);
    }
    geminiSearchCache.set(symbol, result);
    return result;
  } catch {
    return null;
  }
}

/**
 * Scouts live session, economic calendar, cross-market sentiment, news headlines,
 * and optional Gemini Google Search grounding for all 5 Market Drivers.
 * Never fabricates missing data.
 */
export async function scoutMarketContext(params: {
  symbol: string;
  includeDeepSearch?: boolean;
  batchMode?: boolean;
  watchlistQuotes?: WatchlistQuote[];
}): Promise<MarketScoutContext> {
  const {
    symbol,
    includeDeepSearch = false,
    batchMode = false,
    watchlistQuotes,
  } = params;
  const instrument = getInstrumentBySymbol(symbol);
  const nowSec = Math.floor(Date.now() / 1000);
  const session = getUtcSessionContext(instrument.category, nowSec);
  const isSynthetic = instrument.category === 'Synthetic';

  if (isSynthetic) {
    return {
      utcTimestamp: new Date(nowSec * 1000).toISOString(),
      sessionName: session.sessionName,
      sessionLiquidityNote: session.liquidityNote,
      sessionBlocked: session.sessionBlocked,
      crossMarketRiskTone: 'Mixed',
      crossMarketSummary: 'Synthetic index moves independently of external cross-market risk sentiment.',
      calendarAvailable: true,
      relevantEvents: [],
      imminentHighImpactEvent: null,
      fngIndex: null,
      hasVerifiedExternalNews: true,
      macroNewsBrief:
        'Synthetic volatility index has no central bank policy or scheduled macroeconomic releases.',
      fundamentalsBrief:
        'Algorithmic continuous volatility index driven strictly by mathematical volatility parameters rather than earnings or physical supply.',
      sentimentBrief:
        'Price behavior reflects internal algorithmic liquidity cycles without external geopolitical shocks.',
      newsHeadlines: [],
      highImpactRiskDetected: false,
      highImpactRiskNote: null,
      sources: [],
    };
  }

  const newsQuery = getNewsQueryForSymbol(
    instrument.symbol,
    instrument.category,
    batchMode
  );

  const geminiKey =
    process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'
      ? process.env.GEMINI_API_KEY
      : null;

  const [quotesRes, calRes, fngRes, rssHeadlines, searchRes] = await Promise.all([
    watchlistQuotes
      ? Promise.resolve(watchlistQuotes)
      : getWatchlistQuotes().catch(() => [] as WatchlistQuote[]),
    fetchEconomicCalendar(),
    instrument.category === 'Digital' ? fetchCryptoFearGreed() : Promise.resolve(null),
    newsQuery ? fetchRssHeadlines(newsQuery) : Promise.resolve([]),
    includeDeepSearch && geminiKey
      ? runGeminiSearchScout({
          symbol: instrument.symbol,
          name: instrument.name,
          category: instrument.category,
          geminiKey,
        })
      : Promise.resolve(null),
  ]);

  const risk = assessCrossMarketRiskEnvironment(quotesRes, fngRes);
  const currencies = getRelevantCurrencies(instrument.symbol);

  // Relevant calendar events within [-4h, +18h] sorted by nearest time
  const relevantEvents = calRes.events
    .filter(
      (e) =>
        currencies.includes(e.currency) &&
        e.timestampSec >= nowSec - 4 * 3600 &&
        e.timestampSec <= nowSec + 18 * 3600
    )
    .sort((a, b) => Math.abs(a.timestampSec - nowSec) - Math.abs(b.timestampSec - nowSec));

  // Unreleased High-impact macro event within [-45m, +75m] triggers blackout
  const imminentHighImpactEvent =
    relevantEvents.find(
      (e) =>
        e.impact === 'High' &&
        !e.actual &&
        e.timestampSec >= nowSec - 45 * 60 &&
        e.timestampSec <= nowSec + 75 * 60
    ) ?? null;

  const headlineSources: GroundedSourceLink[] = rssHeadlines.slice(0, 4).map((h) => ({
    title: `${h.title} (${h.source})`,
    uri: h.uri,
  }));

  const combinedSources: GroundedSourceLink[] = [];
  const seenUris = new Set<string>();
  for (const s of [...(searchRes?.sources ?? []), ...headlineSources]) {
    if (s.uri && !seenUris.has(s.uri)) {
      seenUris.add(s.uri);
      combinedSources.push(s);
    }
  }

  const hasVerifiedExternalNews = Boolean(
    searchRes?.macroNewsBrief ||
      searchRes?.fundamentalsBrief ||
      rssHeadlines.length > 0
  );

  return {
    utcTimestamp: new Date(nowSec * 1000).toISOString(),
    sessionName: session.sessionName,
    sessionLiquidityNote: session.liquidityNote,
    sessionBlocked: session.sessionBlocked,
    crossMarketRiskTone: risk.tone,
    crossMarketSummary: risk.summary,
    calendarAvailable: calRes.available,
    relevantEvents: relevantEvents.slice(0, 6),
    imminentHighImpactEvent,
    fngIndex: fngRes,
    hasVerifiedExternalNews,
    macroNewsBrief: searchRes?.macroNewsBrief ?? null,
    fundamentalsBrief: searchRes?.fundamentalsBrief ?? null,
    sentimentBrief: searchRes?.sentimentBrief ?? null,
    newsHeadlines: rssHeadlines,
    highImpactRiskDetected: Boolean(searchRes?.highImpactRiskDetected),
    highImpactRiskNote: searchRes?.highImpactRiskNote ?? null,
    sources: combinedSources.slice(0, 6),
  };
}

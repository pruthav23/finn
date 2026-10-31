import { get } from "../http";

export type Bar = { t: number; date: string; o: number; h: number; l: number; c: number; v: number };

/** End-of-day bars from Yahoo's public chart endpoint (same data yfinance uses). */
export async function dailyBars(yahooSymbol: string, range = "1y"): Promise<{ bars: Bar[]; name?: string }> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=${range}&interval=1d`;
  const res = await get(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Yahoo ${res.status} for ${yahooSymbol}`);
  const j = await res.json();
  const r = j?.chart?.result?.[0];
  if (!r) throw new Error(`Yahoo: no data for ${yahooSymbol}`);
  const q = r.indicators.quote[0];
  const bars: Bar[] = [];
  (r.timestamp as number[]).forEach((t, i) => {
    if (q.close[i] == null || q.volume[i] == null) return; // holidays / partial rows
    bars.push({
      t,
      date: new Date((t + 19800) * 1000).toISOString().slice(0, 10), // IST date
      o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i],
    });
  });
  return { bars, name: r.meta?.longName };
}

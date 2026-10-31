import type { Bar } from "../sources/yahoo";
import type { DayStat } from "../types";

/** Per-session change and volume-vs-20-day-average, so thresholds can be applied client-side. */
export function dayStats(bars: Bar[], keep = 30): DayStat[] {
  const out: DayStat[] = [];
  for (let i = Math.max(21, bars.length - keep); i < bars.length; i++) {
    const prev = bars[i - 1];
    const win = bars.slice(i - 20, i);
    const avg = win.reduce((s, b) => s + b.v, 0) / win.length;
    out.push({
      date: bars[i].date,
      close: round(bars[i].c, 2),
      chg: round(((bars[i].c - prev.c) / prev.c) * 100, 2),
      vol: bars[i].v,
      volX: avg > 0 ? round(bars[i].v / avg, 2) : 0,
    });
  }
  return out;
}

export const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

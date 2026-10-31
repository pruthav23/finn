"use client";
import { useEffect, useState } from "react";
import type { Digest, DigestItem, Quote } from "../types";
import type { Prefs } from "./prefs";

let digestPromise: Promise<Digest> | null = null;
export function loadDigest() {
  digestPromise ??= fetch("/data/digest.json", { cache: "no-cache" }).then((r) => {
    if (!r.ok) throw new Error("The daily digest hasn't been generated yet.");
    return r.json();
  });
  return digestPromise;
}

export function useDigest() {
  const [d, setD] = useState<Digest | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { loadDigest().then(setD, (e) => setErr(String(e.message ?? e))); }, []);
  return { digest: d, error: err };
}

/** Windows are measured back from the last refresh, not the wall clock — a weekend shouldn't empty the brief. */
export function windowStart(p: Prefs, ref: string): number {
  const t = Date.parse(ref);
  const h = { "24h": 24, "3d": 72, "7d": 168, "30d": 720 } as const;
  if (p.window === "custom" && p.since) return Date.parse(p.since);
  return t - (h[p.window as keyof typeof h] ?? 24) * 3600_000;
}

/** BSE timestamps are IST wall-clock without an offset. */
export const istMs = (s: string) => Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}+05:30`);

export function inWindow(items: DigestItem[], start: number) {
  return items.filter((i) => istMs(i.at) >= start);
}

export type Alert =
  | { kind: "price"; symbol: string; name: string; date: string; value: number; quote: Quote }
  | { kind: "volume"; symbol: string; name: string; date: string; value: number; quote: Quote }
  | { kind: "filing"; symbol: string; name: string; date: string; item: DigestItem };

export function alerts(d: Digest, p: Prefs, start: number): Alert[] {
  const out: Alert[] = [];
  const startDay = new Date(start + 19800_000).toISOString().slice(0, 10);
  for (const q of d.quotes) {
    for (const day of q.days) {
      if (day.date < startDay) continue;
      if (Math.abs(day.chg) >= p.priceMove) out.push({ kind: "price", symbol: q.symbol, name: q.name, date: day.date, value: day.chg, quote: q });
      if (day.volX >= p.volumeX) out.push({ kind: "volume", symbol: q.symbol, name: q.name, date: day.date, value: day.volX, quote: q });
    }
  }
  for (const i of d.items) {
    if (istMs(i.at) < start || i.tier === "routine" || !p.watch.includes(i.category)) continue;
    out.push({ kind: "filing", symbol: i.symbol, name: i.name, date: i.at.slice(0, 10), item: i });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || rank(b) - rank(a));
}
const rank = (a: Alert) => (a.kind === "filing" ? a.item.score : a.kind === "price" ? 60 + Math.abs(a.value) : 50 + a.value);

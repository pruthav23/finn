"use client";
import Link from "next/link";
import { useMemo } from "react";
import { useDigest, windowStart, alerts, type Alert } from "@/lib/client/data";
import { usePrefs, DEFAULT_PREFS } from "@/lib/client/prefs";
import { LABEL, type Category } from "@/lib/push/taxonomy";
import { WindowPicker } from "@/components/WindowPicker";
import { Spark } from "@/components/Spark";
import { Empty, Loading } from "@/components/States";
import { day, pct, price, tone } from "@/lib/client/format";

const WATCHABLE: Category[] = ["results", "M&A", "management_change", "fund_raise", "litigation", "pledging", "credit_rating", "insider_trading", "capex", "dividend", "bonus_split", "press_release"];

export default function Watch() {
  const { digest, error } = useDigest();
  const [p, set] = usePrefs();
  const list = useMemo(() => (digest ? alerts(digest, p, windowStart(p, digest.generatedAt)) : []), [digest, p]);
  if (error) return <Empty title="No data yet" body={error} />;
  if (!digest) return <Loading />;

  const last = digest.quotes[0]?.days.at(-1)?.date;
  const hot = new Set(list.filter((a) => a.kind !== "filing" && a.date === last).map((a) => a.symbol));

  return (
    <main className="px-4 pt-[max(16px,env(safe-area-inset-top))]">
      <h1 className="pt-2 text-[28px] font-bold tracking-tight">Watch</h1>
      <p className="mt-1 text-[14px] text-muted">You decide what counts as unusual. FINN checks every holding after the close.</p>

      <section className="sheet mt-5 p-4" aria-label="Alert thresholds">
        <Threshold label="Price move" hint="in a single session" value={p.priceMove} min={1} max={10} step={0.5}
          fmt={(v) => `±${v}%`} onChange={(v) => set({ priceMove: v })} />
        <div className="my-4 border-t hair" />
        <Threshold label="Volume spike" hint="vs its 20-day average" value={p.volumeX} min={1.2} max={5} step={0.1}
          fmt={(v) => `${v.toFixed(1)}×`} onChange={(v) => set({ volumeX: v })} />
        <div className="my-4 border-t hair" />
        <p className="text-[15px] font-semibold">Filings that alert you</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {WATCHABLE.map((c) => {
            const on = p.watch.includes(c);
            return (
              <button key={c} className="chip" aria-pressed={on}
                onClick={() => set({ watch: on ? p.watch.filter((x) => x !== c) : [...p.watch, c] })}>
                {LABEL[c]}
              </button>
            );
          })}
        </div>
        <button className="mt-3 text-[13px] text-muted underline-offset-2 hover:underline"
          onClick={() => set({ priceMove: DEFAULT_PREFS.priceMove, volumeX: DEFAULT_PREFS.volumeX, watch: DEFAULT_PREFS.watch })}>
          Reset to defaults
        </button>
      </section>

      <section className="mt-7" aria-labelledby="alerts">
        <h2 id="alerts" className="text-[13px] font-semibold text-muted">Triggered</h2>
        <div className="mt-2"><WindowPicker maxDays={digest.windowDays} /></div>
        {list.length === 0 ? (
          <p className="mt-4 text-[15px] text-ink-2">Nothing crossed your lines in this window. Widen the window or loosen a threshold.</p>
        ) : (
          <ul className="sheet mt-3 px-4">{list.slice(0, 60).map((a, k) => <AlertRow key={k} a={a} />)}</ul>
        )}
      </section>

      <section className="mt-8" aria-labelledby="pulse">
        <h2 id="pulse" className="text-[13px] font-semibold text-muted">Holdings · last session {last && day(last)}</h2>
        <ul className="sheet mt-2 px-4">
          {[...digest.quotes].sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg)).map((q) => (
            <li key={q.symbol} className="border-t hair first:border-t-0">
              <Link href={`/research/${encodeURIComponent(q.symbol)}`} className="flex items-center gap-3 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-[15px] font-semibold">
                    {q.symbol}{hot.has(q.symbol) && <span className="h-2 w-2 rounded-full bg-mark" title="Crossed a threshold" />}
                  </span>
                  <span className="block truncate text-[12.5px] text-muted">{q.sector}</span>
                </span>
                <Spark data={q.spark} />
                <span className="w-[86px] text-right num">
                  <span className="block text-[15px]">{price(q.close)}</span>
                  <span className={`block text-[12.5px] font-medium ${tone(q.chg)}`}>
                    {pct(q.chg)} <span className={q.volX >= p.volumeX ? "text-ink font-semibold" : "text-muted font-normal"}>{q.volX.toFixed(1)}×</span>
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function Threshold({ label, hint, value, min, max, step, fmt, onChange }: { label: string; hint: string; value: number; min: number; max: number; step: number; fmt: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between">
        <span className="text-[15px] font-semibold">{label} <span className="font-normal text-muted">{hint}</span></span>
        <span className="text-[20px] font-bold num">{fmt(value)}</span>
      </span>
      <input type="range" className="mt-2 w-full accent-[var(--ink)]" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function AlertRow({ a }: { a: Alert }) {
  const body =
    a.kind === "price" ? <>Moved <b className={tone(a.value)}>{pct(a.value)}</b> in a session</>
    : a.kind === "volume" ? <>Traded <b>{a.value.toFixed(1)}×</b> its 20-day average volume</>
    : <>{a.item.why ?? a.item.summary ?? a.item.headline}</>;
  return (
    <li className="flex gap-3 border-t hair py-3 first:border-t-0">
      <Link href={`/research/${encodeURIComponent(a.symbol)}`} className="ticker mt-0.5 h-fit shrink-0">{a.symbol}</Link>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] leading-snug">{body}</span>
        <span className="mt-0.5 block text-[12.5px] text-muted">
          {a.kind === "filing" ? LABEL[a.item.category] : a.kind === "price" ? "Price" : "Volume"} · {day(a.date)}
          {a.kind === "filing" && a.item.pdf && <> · <a href={a.item.pdf} target="_blank" rel="noreferrer" className="text-accent">filing</a></>}
        </span>
      </span>
    </li>
  );
}

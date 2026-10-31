"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useDigest, windowStart, inWindow, alerts } from "@/lib/client/data";
import { usePrefs } from "@/lib/client/prefs";
import { LABEL, type Category } from "@/lib/push/taxonomy";
import { ActCard, GlanceRow } from "@/components/Items";
import { Sieve } from "@/components/Sieve";
import { WindowPicker, windowLabel } from "@/components/WindowPicker";
import { AudioBrief, script } from "@/components/AudioBrief";
import { pct, tone } from "@/lib/client/format";
import { Empty, Loading } from "@/components/States";

export default function Brief() {
  const { digest, error } = useDigest();
  const [p] = usePrefs();
  const [routineOpen, setRoutineOpen] = useState(false);

  const view = useMemo(() => {
    if (!digest) return null;
    const start = windowStart(p, digest.generatedAt);
    const items = inWindow(digest.items, start);
    const act = items.filter((i) => i.tier === "act");
    const glance = items.filter((i) => i.tier === "glance");
    const routine = items.filter((i) => i.tier === "routine");
    const groups = Object.entries(routine.reduce((m, i) => ((m[i.category] ??= []).push(i), m), {} as Record<string, typeof routine>))
      .sort((a, b) => b[1].length - a[1].length);
    const moves = alerts(digest, p, start).filter((a) => a.kind !== "filing");
    // If the window is quiet, keep the most recent material items in view rather than show nothing.
    const earlier = act.length ? [] : digest.items.filter((i) => i.tier === "act").slice(0, 3);
    return { items, act, glance, routine, groups, moves, earlier };
  }, [digest, p]);

  if (error) return <Empty title="No digest yet" body={`${error} It is built by the daily job; run \`npm run ingest\` to create it locally.`} />;
  if (!digest || !view) return <Loading />;

  const { items, act, glance, routine, groups, moves, earlier } = view;
  const wl = windowLabel(p);

  return (
    <main className="px-4 pt-[max(16px,env(safe-area-inset-top))]">
      <header className="flex items-center justify-between py-2">
        <span className="text-[19px] font-extrabold tracking-tight">FINN</span>
        <div className="flex items-center gap-2">
          <AudioBrief text={script(act.length ? act : earlier, glance.length, routine.length, moves, wl)} />
        </div>
      </header>

      <section className="mt-4" aria-labelledby="hero">
        <h1 id="hero" className="text-[30px] font-bold leading-[1.1] tracking-tight">
          {items.length === 0 ? <>A quiet stretch.</> : <>
            {items.length} filing{items.length !== 1 && "s"} {wl}.<br />
            <span className="mark">{act.length === 0 ? "None" : act.length} {act.length === 1 ? "matters" : "matter"}.</span>
          </>}
        </h1>
        <p className="mt-2 text-[14px] text-muted">
          {glance.length} worth a glance · {routine.length} routine, set aside · {digest.quotes.length} holdings
        </p>
        <div className="mt-4"><WindowPicker maxDays={digest.windowDays} /></div>
        {items.length > 0 && (
          <div className="mt-5">
            <Sieve items={items} onPick={(id) => document.getElementById(`i-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })} />
          </div>
        )}
      </section>

      {moves.length > 0 && (
        <section className="mt-7" aria-label="Unusual moves">
          <div className="flex items-baseline justify-between">
            <h2 className="text-[13px] font-semibold text-muted">Crossed your thresholds</h2>
            <Link href="/watch" className="text-[13px] font-medium text-accent">Thresholds</Link>
          </div>
          <div className="-mx-4 mt-2 px-4 scroll-x">
            <ul className="flex gap-2">
              {moves.slice(0, 12).map((m, k) => (
                <li key={k} className="sheet shrink-0 px-3 py-2">
                  <Link href={`/research/${encodeURIComponent(m.symbol)}`} className="block">
                    <span className="text-[12.5px] font-bold">{m.symbol}</span>
                    <span className={`block text-[16px] font-semibold num ${m.kind === "price" ? tone(m.value) : ""}`}>
                      {m.kind === "price" ? pct(m.value) : `${m.value.toFixed(1)}× vol`}
                    </span>
                    <span className="text-[11.5px] text-muted">{new Date(`${m.date}T12:00:00+05:30`).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <section className="mt-7 space-y-3" aria-label="What matters">
        {act.map((i) => <ActCard key={i.id} i={i} id={`i-${i.id}`} />)}
        {act.length === 0 && earlier.length > 0 && (
          <>
            <p className="text-[14px] text-ink-2">Nothing material {wl}. Still relevant from earlier:</p>
            {earlier.map((i) => <ActCard key={i.id} i={i} />)}
          </>
        )}
      </section>

      {glance.length > 0 && (
        <section className="mt-8" aria-labelledby="glance">
          <h2 id="glance" className="text-[13px] font-semibold text-muted">Worth a glance</h2>
          <ul className="sheet mt-2 px-4">{glance.map((i) => <GlanceRow key={i.id} i={i} />)}</ul>
        </section>
      )}

      {routine.length > 0 && (
        <section className="mt-8" aria-labelledby="routine">
          <button id="routine" onClick={() => setRoutineOpen(!routineOpen)} aria-expanded={routineOpen}
            className="flex w-full items-baseline justify-between text-left">
            <h2 className="text-[13px] font-semibold text-muted">Set aside: {routine.length} routine</h2>
            <span className="text-[13px] font-medium text-accent">{routineOpen ? "Hide" : "Show"}</span>
          </button>
          {!routineOpen && (
            <p className="mt-1 text-[13px] text-muted">
              {groups.slice(0, 5).map(([c, l]) => `${l.length} ${LABEL[c as Category].toLowerCase()}`).join(", ")}
            </p>
          )}
          {routineOpen && (
            <div className="mt-2 space-y-4">
              {groups.map(([c, l]) => (
                <div key={c}>
                  <h3 className="text-[13px] font-semibold">{LABEL[c as Category]} <span className="font-normal text-muted">{l.length}</span></h3>
                  <ul className="mt-1 space-y-1">
                    {l.map((i) => (
                      <li key={i.id} className="flex gap-2 text-[13.5px] text-ink-2">
                        <span className="ticker shrink-0">{i.symbol}</span>
                        {i.pdf ? <a href={i.pdf} target="_blank" rel="noreferrer" className="line-clamp-2 hover:underline">{i.headline}</a> : <span className="line-clamp-2">{i.headline}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <footer className="mt-10 border-t hair py-4 text-[12px] leading-relaxed text-muted">
        Refreshed {new Date(digest.generatedAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} from BSE filings and end-of-day prices (last session {digest.asOf}).
        {" "}This run: {digest.cost.calls} model calls, {digest.cost.cached} answered from cache, {((digest.cost.inTokens + digest.cost.outTokens) / 1000).toFixed(0)}k tokens, ₹0 on the free tier.
      </footer>
    </main>
  );
}

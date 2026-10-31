"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { PORTFOLIO, RESEARCH_DEMO } from "@/lib/portfolio";

type Hit = { name: string; symbol: string };

export default function Research() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [listening, setListening] = useState(false);
  const [canListen, setCanListen] = useState(false);
  const [ready, setReady] = useState<string[]>(RESEARCH_DEMO);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    setCanListen(typeof window !== "undefined" && ("webkitSpeechRecognition" in window || "SpeechRecognition" in window));
    fetch("/data/research-index.json").then((r) => (r.ok ? r.json() : null)).then((j) => j && setReady(j)).catch(() => {});
  }, []);

  useEffect(() => {
    clearTimeout(timer.current);
    if (q.trim().length < 2) { setHits([]); return; }
    timer.current = setTimeout(async () => {
      try {
        const r = await fetch("/api/research", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stage: "search", q }) });
        setHits(r.ok ? await r.json() : []);
      } catch { setHits([]); }
    }, 250);
  }, [q]);

  const go = (s: string) => router.push(`/research/${encodeURIComponent(s.trim().toUpperCase())}`);

  const listen = () => {
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = "en-IN";
    rec.interimResults = false;
    rec.onresult = (e: any) => setQ(e.results[0][0].transcript.replace(/\.$/, ""));
    rec.onend = () => setListening(false);
    rec.start();
    setListening(true);
  };

  return (
    <main className="px-4 pt-[max(16px,env(safe-area-inset-top))]">
      <h1 className="pt-2 text-[28px] font-bold tracking-tight">Research</h1>
      <p className="mt-1 text-[14px] text-muted">Any NSE company. FINN reads its filings, last four earnings calls and latest annual report, then checks what management promised against what it delivered.</p>

      <form className="relative mt-5" onSubmit={(e) => { e.preventDefault(); if (hits[0]) go(hits[0].symbol); else if (q.trim()) go(q); }}>
        <input
          value={q} onChange={(e) => setQ(e.target.value)} autoCapitalize="characters" autoCorrect="off" spellCheck={false}
          placeholder="Company or symbol, e.g. Asian Paints" aria-label="Company or NSE symbol"
          className="sheet h-[52px] w-full pl-4 pr-24 text-[17px] outline-none placeholder:text-muted focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        />
        <div className="absolute right-2 top-1/2 flex -translate-y-1/2 gap-1">
          {canListen && (
            <button type="button" onClick={listen} aria-label="Say a company name" aria-pressed={listening}
              className={`grid h-10 w-10 place-items-center rounded-full ${listening ? "bg-mark text-[#142019] pulse" : "text-muted"}`}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
            </button>
          )}
          <button type="submit" className="h-10 rounded-full bg-ink px-4 text-[14px] font-semibold text-paper">Go</button>
        </div>
      </form>

      {hits.length > 0 && (
        <ul className="sheet mt-2 px-4">
          {hits.map((h) => (
            <li key={h.symbol} className="border-t hair first:border-t-0">
              <button onClick={() => go(h.symbol)} className="flex w-full items-center justify-between py-3 text-left">
                <span className="text-[15px]">{h.name}</span><span className="ticker">{h.symbol}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <section className="mt-8">
        <h2 className="text-[13px] font-semibold text-muted">Ready to read now</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          {ready.map((s) => <Link key={s} href={`/research/${encodeURIComponent(s)}`} className="chip">{s}</Link>)}
        </div>
      </section>
      <section className="mt-6">
        <h2 className="text-[13px] font-semibold text-muted">Your holdings</h2>
        <p className="mt-1 text-[12.5px] text-muted">Built live on first open, about a minute.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {PORTFOLIO.map((h) => <Link key={h.symbol} href={`/research/${encodeURIComponent(h.symbol)}`} className="chip">{h.symbol}</Link>)}
        </div>
      </section>
    </main>
  );
}

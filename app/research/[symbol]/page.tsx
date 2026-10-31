"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { Dossier } from "@/lib/research/dossier";
import type { Fundamentals } from "@/lib/research/fundamentals";
import type { BusinessExtract, CallExtract } from "@/lib/research/documents";
import type { Synthesis } from "@/lib/research/synthesis";
import { Bars } from "@/components/Spark";
import { cr, pct } from "@/lib/client/format";

type Step = { key: string; label: string; state: "wait" | "run" | "done" | "fail"; note?: string };
type Draft = Omit<Dossier, "synthesis" | "business" | "generatedAt" | "errors" | "sources"> & {
  synthesis: Synthesis | null; business: BusinessExtract | null; generatedAt?: string; errors: string[]; sources: Dossier["sources"];
};

const post = async <T,>(body: object): Promise<T> => {
  const r = await fetch("/api/research", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j as T;
};

const CACHE = (s: string) => `finn.dossier.v1.${s}`;

export default function DossierPage() {
  const { symbol: raw } = useParams<{ symbol: string }>();
  const symbol = decodeURIComponent(raw).toUpperCase();
  const [d, setD] = useState<Draft | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    const step = (key: string, patch: Partial<Step> & { label?: string }) =>
      !dead && setSteps((s) => (s.some((x) => x.key === key) ? s.map((x) => (x.key === key ? { ...x, ...patch } : x)) : [...s, { key, label: patch.label ?? key, state: "wait", ...patch } as Step]));

    (async () => {
      // 1. precomputed (demo set) → 2. this device's cache → 3. build live
      try {
        const r = await fetch(`/data/research/${encodeURIComponent(symbol)}.json`);
        if (r.ok) { const j = await r.json(); if (!dead) setD(j); return; }
      } catch {}
      try {
        const c = JSON.parse(localStorage.getItem(CACHE(symbol)) ?? "null");
        if (c && Date.now() - Date.parse(c.generatedAt) < 3 * 86400_000) { setD(c); return; }
      } catch {}

      step("base", { label: "Reading reported financials", state: "run" });
      let base: { fundamentals: Fundamentals; transcripts: { label: string; url: string }[]; annualReport: { year: number; url: string } | null };
      try { base = await post({ stage: "base", symbol }); }
      catch (e) { if (!dead) setFatal(String((e as Error).message)); return; }
      const f = base.fundamentals;
      step("base", { state: "done", note: `${f.quarterly.cols.length} quarters, ${f.annual.cols.length} years` });
      const cur: Draft = { symbol: f.symbol, fundamentals: f, calls: [], business: null, synthesis: null, errors: [], sources: [{ id: "FIN", label: `Reported financials (${f.basis}) via screener.in`, url: f.screenerUrl }] };
      if (!dead) setD({ ...cur });

      base.transcripts.forEach((t, i) => step(`c${i}`, { label: `Reading ${t.label} earnings call`, state: "wait" }));
      if (base.annualReport) step("ar", { label: `Reading FY${base.annualReport.year} annual report`, state: "wait" });
      if (!base.transcripts.length) step("nocalls", { label: "No earnings-call transcripts on file", state: "fail" });

      const jobs: (() => Promise<void>)[] = base.transcripts.map((t, i) => async () => {
        step(`c${i}`, { state: "run" });
        try {
          const c = await post<CallExtract>({ stage: "call", url: t.url, id: `C${i + 1}`, name: f.name });
          cur.calls = [...cur.calls, c].sort((a, b) => a.id.localeCompare(b.id));
          step(`c${i}`, { state: "done", label: `Read ${c.quarter} call`, note: `${c.guidance.length} commitments` });
        } catch (e) { cur.errors.push(String(e)); step(`c${i}`, { state: "fail", note: "couldn't read" }); }
        if (!dead) setD({ ...cur });
      });
      if (base.annualReport) jobs.push(async () => {
        step("ar", { state: "run" });
        try {
          cur.business = await post<BusinessExtract>({ stage: "annual", url: base.annualReport!.url, year: base.annualReport!.year, name: f.name });
          step("ar", { state: "done", note: `${cur.business.pages.length} relevant pages` });
        } catch (e) { cur.errors.push(String(e)); step("ar", { state: "fail", note: "too large or scanned" }); }
        if (!dead) setD({ ...cur });
      });
      // two at a time: respects free-tier rate limits and the function time budget
      const q = [...jobs];
      await Promise.all([0, 1].map(async () => { while (q.length) await q.shift()!(); }));

      step("synth", { label: "Weighing promises against numbers", state: "run" });
      try {
        cur.synthesis = await post<Synthesis>({ stage: "synth", fundamentals: f, calls: cur.calls, business: cur.business });
        step("synth", { state: "done" });
      } catch (e) { cur.errors.push(String(e)); step("synth", { state: "fail", note: String((e as Error).message).slice(0, 80) }); }
      cur.sources = [
        cur.sources[0],
        ...(cur.business ? [{ id: "AR", label: `Annual report FY${cur.business.year}`, url: cur.business.url }] : []),
        ...cur.calls.map((c) => ({ id: c.id, label: `${c.quarter} earnings call transcript`, url: c.url })),
      ];
      cur.generatedAt = new Date().toISOString();
      if (!dead) setD({ ...cur });
      try { if (cur.synthesis) localStorage.setItem(CACHE(symbol), JSON.stringify(cur)); } catch {}
    })();
    return () => { dead = true; };
  }, [symbol]);

  if (fatal) return (
    <main className="px-4 pt-16">
      <Link href="/research" className="text-[14px] text-accent">Research</Link>
      <h1 className="mt-3 text-[24px] font-bold">{symbol}</h1>
      <p className="mt-2 text-ink-2">{fatal}</p>
    </main>
  );

  const f = d?.fundamentals;
  const s = d?.synthesis;
  const src = (id: string) => d?.sources.find((x) => x.id === id);

  return (
    <main className="px-4 pt-[max(16px,env(safe-area-inset-top))]">
      <Link href="/research" className="inline-block py-2 text-[14px] text-accent">Research</Link>
      <header>
        <p className="ticker inline-block">{symbol}</p>
        <h1 className="mt-1 text-[28px] font-bold leading-tight tracking-tight">{f?.name ?? symbol}</h1>
        {f && (
          <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
            {["Current Price", "Market Cap", "Stock P/E", "ROCE", "ROE"].filter((k) => f.ratios[k]).map((k) => (
              <div key={k} className="flex gap-1"><dt className="text-muted">{k.replace("Stock ", "").replace("Current ", "")}</dt><dd className="font-semibold num">{f.ratios[k]}</dd></div>
            ))}
          </dl>
        )}
      </header>

      {steps.length > 0 && !d?.generatedAt && <Progress steps={steps} />}

      {s && (
        <section className="mt-6">
          <p className="prose-finn">{s.take}</p>
        </section>
      )}

      {d && (
        <nav className="sticky top-0 z-30 -mx-4 mt-5 border-b hair bg-[color-mix(in_oklab,var(--paper)_90%,transparent)] px-4 py-2 backdrop-blur-xl scroll-x" aria-label="Sections">
          <div className="flex gap-2">
            {[["promises", "Promises", !!s], ["story", "Story vs numbers", !!s], ["guidance", "Guidance", !!s], ["case", "Bull & bear", !!s], ["numbers", "Numbers", true], ["business", "Business", !!d.business], ["balance", "Balance sheet", true], ["cash", "Cash", true], ["calls", "Calls", d.calls.length > 0], ["sources", "Sources", true]]
              .filter((x) => x[2]).map(([id, label]) => <a key={id as string} href={`#${id}`} className="chip h-8 shrink-0">{label}</a>)}
          </div>
        </nav>
      )}

      {s && <Promises s={s} src={src} />}
      {s && <Story s={s} src={src} />}
      {s && <Guidance s={s} src={src} />}
      {s && <Case s={s} src={src} />}
      {f && <Numbers f={f} />}
      {d?.business && <Business b={d.business} />}
      {f && <Balance f={f} />}
      {f && <Cash f={f} />}
      {d && d.calls.length > 0 && <Calls calls={d.calls} />}
      {d && (
        <section id="sources" className="mt-10 scroll-mt-16 border-t hair pt-4">
          <h2 className="text-[13px] font-semibold text-muted">Sources: primary documents only</h2>
          <ul className="mt-2 space-y-1.5 text-[14px]">
            {d.sources.map((x) => (
              <li key={x.id} className="flex gap-2"><span className="ticker h-fit">{x.id}</span><a href={x.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">{x.label}</a></li>
            ))}
          </ul>
          <p className="mt-3 text-[12.5px] leading-relaxed text-muted">
            Numbers are computed in code from reported financials. The analysis is told to use only these documents: no news, broker notes or the model&apos;s own memory of the company. Every point cites its source.
            {d.generatedAt && <> Built {new Date(d.generatedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}.</>}
          </p>
        </section>
      )}
      <div className="h-8" />
    </main>
  );
}

function Progress({ steps }: { steps: Step[] }) {
  return (
    <ol className="sheet mt-5 space-y-2 p-4 text-[14px]" aria-live="polite">
      {steps.map((s) => (
        <li key={s.key} className="flex items-center gap-2.5">
          <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold ${s.state === "done" ? "bg-ink text-paper" : s.state === "run" ? "bg-mark text-[#142019] pulse" : s.state === "fail" ? "border hair text-down" : "border hair"}`}>
            {s.state === "done" ? "✓" : s.state === "fail" ? "–" : ""}
          </span>
          <span className={s.state === "wait" ? "text-muted" : ""}>{s.label}</span>
          {s.note && <span className="ml-auto text-[12.5px] text-muted">{s.note}</span>}
        </li>
      ))}
    </ol>
  );
}

type Src = (id: string) => { id: string; label: string; url: string } | undefined;
function Cite({ ids, src }: { ids: string[] | string; src: Src }) {
  const list = (Array.isArray(ids) ? ids : String(ids).split(/[,\s]+/)).map((x) => x.trim()).filter(Boolean);
  return (
    <span className="ml-1 inline-flex gap-1 align-middle">
      {list.map((id) => {
        const s = src(id);
        return s ? (
          <a key={id} href={s.url} target="_blank" rel="noreferrer" title={s.label}
            className="rounded border hair px-1 text-[10.5px] font-bold leading-[16px] text-muted hover:text-accent">{id}</a>
        ) : <span key={id} className="rounded border hair px-1 text-[10.5px] font-bold leading-[16px] text-muted">{id}</span>;
      })}
    </span>
  );
}

function H({ id, children, sub }: { id: string; children: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div id={id} className="mt-10 scroll-mt-16">
      <h2 className="text-[21px] font-bold tracking-tight">{children}</h2>
      {sub && <p className="mt-0.5 text-[13.5px] text-muted">{sub}</p>}
    </div>
  );
}

const VERDICT = {
  delivered: { label: "Delivered", cls: "bg-[color-mix(in_oklab,var(--up)_14%,transparent)] text-up" },
  missed: { label: "Missed", cls: "bg-[color-mix(in_oklab,var(--down)_14%,transparent)] text-down" },
  partial: { label: "Partly", cls: "bg-mark text-[#142019]" },
  pending: { label: "Pending", cls: "border hair text-muted" },
} as const;

function Promises({ s, src }: { s: Synthesis; src: Src }) {
  const judged = s.promises.filter((p) => p.verdict !== "pending");
  const kept = judged.filter((p) => p.verdict === "delivered").length;
  return (
    <section>
      <H id="promises" sub="What management guided on its calls, checked against the numbers it later reported.">Promised vs delivered</H>
      {judged.length > 0 && (
        <p className="mt-3 text-[15px]"><span className="mark text-[22px] font-bold num">{kept} of {judged.length}</span> checkable promises kept{judged.length - kept > 0 && <>, {judged.filter((p) => p.verdict === "partial").length} partly</>}.</p>
      )}
      <ul className="sheet mt-3 px-4">
        {s.promises.map((p, k) => (
          <li key={k} className="border-t hair py-3 first:border-t-0">
            <div className="flex items-center gap-2 text-[12.5px] text-muted">
              <span className={`rounded-full px-2 py-0.5 text-[11.5px] font-bold ${VERDICT[p.verdict]?.cls ?? ""}`}>{VERDICT[p.verdict]?.label ?? p.verdict}</span>
              <span>{p.metric}</span>
              <span className="ml-auto">said in {p.quarter}<Cite ids={p.said} src={src} /></span>
            </div>
            <p className="mt-1.5 text-[15px] font-medium leading-snug">{p.promise}</p>
            <p className="mt-0.5 text-[14px] text-ink-2">{p.delivered}<Cite ids={p.source} src={src} /></p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Story({ s, src }: { s: Synthesis; src: Src }) {
  return (
    <section>
      <H id="story" sub="Where the narrative and the financials line up, and where they don't.">Story vs numbers</H>
      <ul className="mt-3 space-y-3">
        {s.narrative.map((n, k) => (
          <li key={k} className="sheet p-4">
            <p className="text-[12px] font-bold" style={{ color: n.verdict === "diverges" ? "var(--down)" : n.verdict === "agrees" ? "var(--up)" : "var(--muted)" }}>
              {n.verdict === "diverges" ? "Diverges" : n.verdict === "agrees" ? "Agrees" : "Unclear"}
            </p>
            <p className="mt-1 text-[15px]"><span className="text-muted">They say: </span>{n.claim}</p>
            <p className="mt-1 text-[15px]"><span className="text-muted">Numbers say: </span>{n.numbers}<Cite ids={n.sources} src={src} /></p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Guidance({ s, src }: { s: Synthesis; src: Src }) {
  if (!s.guidance.length) return null;
  const arrow = { raised: "↑ raised", lowered: "↓ lowered", maintained: "= held", new: "new", dropped: "dropped" } as const;
  return (
    <section>
      <H id="guidance" sub="Explicit forward targets from the latest calls, and how they moved.">Guidance</H>
      <table className="sheet mt-3 w-full overflow-hidden text-[14px]">
        <tbody>
          {s.guidance.map((g, k) => (
            <tr key={k} className="border-t hair first:border-t-0">
              <td className="py-2.5 pl-4 pr-2 align-top font-medium">{g.metric}{g.horizon && <span className="block text-[12px] font-normal text-muted">{g.horizon}</span>}</td>
              <td className="py-2.5 pr-2 align-top">{g.latest}<Cite ids={g.source} src={src} /></td>
              <td className={`whitespace-nowrap py-2.5 pr-4 text-right align-top text-[13px] font-semibold ${g.change === "raised" ? "up" : g.change === "lowered" || g.change === "dropped" ? "down" : "text-muted"}`}>{arrow[g.change] ?? g.change}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Case({ s, src }: { s: Synthesis; src: Src }) {
  return (
    <section>
      <H id="case">Bull & bear</H>
      <div className="mt-3 grid gap-3">
        {([["Bull", s.bull, "var(--up)"], ["Bear", s.bear, "var(--down)"]] as const).map(([t, list, c]) => (
          <div key={t} className="sheet p-4" style={{ borderLeft: `3px solid ${c}` }}>
            <h3 className="text-[13px] font-bold" style={{ color: c }}>{t}</h3>
            <ul className="mt-1.5 space-y-2">
              {list.map((b, k) => <li key={k} className="text-[15px] leading-snug">{b.point}<Cite ids={b.sources} src={src} /></li>)}
            </ul>
          </div>
        ))}
        {s.watch.length > 0 && (
          <div className="px-1">
            <h3 className="text-[13px] font-semibold text-muted">Check next quarter</h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-[14.5px]">{s.watch.map((w, k) => <li key={k}>{w}</li>)}</ul>
          </div>
        )}
      </div>
    </section>
  );
}

function Flags({ f, area }: { f: Fundamentals; area: string }) {
  const list = f.flags.filter((x) => x.area === area);
  if (!list.length) return null;
  return (
    <ul className="mt-3 space-y-1">
      {list.map((x, k) => (
        <li key={k} className="flex gap-2 text-[14.5px]">
          <span aria-hidden style={{ color: x.tone === "good" ? "var(--up)" : x.tone === "bad" ? "var(--down)" : "var(--muted)" }}>●</span>{x.text}
        </li>
      ))}
    </ul>
  );
}

const short = (c: string) => c.replace(/^(\w{3}) 20(\d\d)$/, "$1 ’$2");

function Numbers({ f }: { f: Fundamentals }) {
  const q = f.quarterly;
  return (
    <section>
      <H id="numbers" sub={`Reported, ${f.basis}, ₹ crore. Computed in code, no model involved.`}>Numbers</H>
      <Flags f={f} area="Trajectory" />
      <div className="sheet mt-3 grid grid-cols-2 gap-x-5 gap-y-5 p-4">
        <div><p className="text-[13px] font-semibold">{f.financialCo ? "Revenue" : "Sales"}, quarterly</p><Bars values={q.revenue} labels={q.cols.map(short)} format={(n) => cr(n)} /></div>
        <div><p className="text-[13px] font-semibold">Net profit, quarterly</p><Bars values={q.pat} labels={q.cols.map(short)} format={(n) => cr(n)} /></div>
        <div><p className="text-[13px] font-semibold">{f.financialCo ? "Financing margin" : "Operating margin"}</p><Bars values={q.opm} labels={q.cols.map(short)} format={(n) => `${n}%`} /></div>
        <div><p className="text-[13px] font-semibold">Revenue growth YoY</p><Bars values={q.revYoY} labels={q.cols.map(short)} format={(n) => pct(n)} /></div>
      </div>
      <dl className="mt-3 grid grid-cols-4 gap-2 text-center">
        {([["Sales 3y", f.cagr.rev3], ["Sales 5y", f.cagr.rev5], ["Profit 3y", f.cagr.pat3], ["Profit 5y", f.cagr.pat5]] as const).map(([k, v]) => (
          <div key={k} className="sheet px-1 py-2"><dt className="text-[11.5px] text-muted">{k} CAGR</dt><dd className="text-[16px] font-bold num">{pct(v, false)}</dd></div>
        ))}
      </dl>
    </section>
  );
}

function Business({ b }: { b: BusinessExtract }) {
  return (
    <section>
      <H id="business" sub={`From the FY${b.year} annual report, pages ${b.pages.slice(0, 6).join(", ")}${b.pages.length > 6 ? "…" : ""}`}>Business</H>
      <p className="prose-finn mt-3">{b.whatItDoes}</p>
      {b.segments.length > 0 && (
        <ul className="sheet mt-3 px-4">
          {b.segments.map((s, k) => (
            <li key={k} className="border-t hair py-2.5 first:border-t-0">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-[15px] font-semibold">{s.name}</span>
                {s.share != null && <span className="text-[15px] font-bold num">{s.share}%</span>}
              </div>
              {s.share != null && <div className="mt-1 h-1.5 rounded-full bg-[var(--rule-2)]"><div className="h-1.5 rounded-full bg-ink" style={{ width: `${Math.min(100, s.share)}%` }} /></div>}
              <p className="mt-1 text-[13.5px] text-ink-2">{s.comment}</p>
            </li>
          ))}
        </ul>
      )}
      {(b.scale.length > 0 || b.geography) && (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-[14.5px]">
          {b.geography && <li>{b.geography}</li>}
          {b.scale.map((x, k) => <li key={k}>{x}</li>)}
        </ul>
      )}
      {b.risks.length > 0 && (
        <>
          <h3 className="mt-4 text-[13px] font-semibold text-muted">Risks management itself flags</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-[14.5px]">{b.risks.map((x, k) => <li key={k}>{x}</li>)}</ul>
        </>
      )}
    </section>
  );
}

function Balance({ f }: { f: Fundamentals }) {
  const e = f.efficiency;
  const ccc = e.rows["Cash Conversion Cycle"];
  return (
    <section>
      <H id="balance" sub="Debt, leverage and the cash tied up in running the business.">Balance sheet</H>
      <Flags f={f} area="Balance sheet" />
      <Flags f={f} area="Ownership" />
      <div className="sheet mt-3 grid grid-cols-2 gap-x-5 gap-y-5 p-4">
        <div><p className="text-[13px] font-semibold">Borrowings</p><Bars values={f.balance.borrowings} labels={f.balance.cols.map(short)} format={(n) => cr(n)} /></div>
        {!f.financialCo && <div><p className="text-[13px] font-semibold">Debt / equity</p><Bars values={f.balance.de} labels={f.balance.cols.map(short)} format={(n) => n.toFixed(2)} /></div>}
        {ccc && <div><p className="text-[13px] font-semibold">Cash conversion cycle</p><Bars values={ccc} labels={e.cols.map(short)} format={(n) => `${Math.round(n)}d`} /></div>}
        {e.rows["ROCE %"] && <div><p className="text-[13px] font-semibold">ROCE</p><Bars values={e.rows["ROCE %"]} labels={e.cols.map(short)} format={(n) => `${n}%`} /></div>}
        {f.holding.promoter.some((x) => x != null) && <div><p className="text-[13px] font-semibold">Promoter holding</p><Bars values={f.holding.promoter} labels={f.holding.cols.map(short)} format={(n) => `${n}%`} /></div>}
      </div>
    </section>
  );
}

function Cash({ f }: { f: Fundamentals }) {
  const c = f.cash;
  return (
    <section>
      <H id="cash" sub="Do profits turn into cash? Operating cash flow against reported profit.">Cash quality</H>
      <Flags f={f} area="Cash quality" />
      <div className="sheet mt-3 p-4">
        <table className="w-full text-[13.5px] num">
          <thead><tr className="text-[12px] text-muted"><th className="text-left font-normal">FY</th><th className="text-right font-normal">Op. cash</th><th className="text-right font-normal">Profit</th><th className="text-right font-normal">Free cash</th><th className="text-right font-normal">Cash/profit</th></tr></thead>
          <tbody>
            {c.cols.map((col, i) => {
              const ratio = c.cfo[i] != null && c.pat[i] ? c.cfo[i]! / c.pat[i]! : null;
              return (
                <tr key={col} className="border-t hair">
                  <td className="py-1.5">{short(col)}</td>
                  <td className="py-1.5 text-right">{cr(c.cfo[i])}</td>
                  <td className="py-1.5 text-right">{cr(c.pat[i])}</td>
                  <td className={`py-1.5 text-right ${c.fcf[i] != null && c.fcf[i]! < 0 ? "down" : ""}`}>{cr(c.fcf[i])}</td>
                  <td className={`py-1.5 text-right font-semibold ${ratio == null ? "" : ratio < 0.7 ? "down" : ratio >= 1 ? "up" : ""}`}>{ratio == null ? "—" : `${ratio.toFixed(2)}×`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Calls({ calls }: { calls: CallExtract[] }) {
  return (
    <section>
      <H id="calls" sub="What each call was about, and what analysts pushed on.">Earnings calls</H>
      <ul className="mt-3 space-y-3">
        {calls.map((c) => (
          <li key={c.id} className="sheet p-4">
            <details>
              <summary className="flex cursor-pointer list-none items-center gap-2">
                <span className="ticker">{c.id}</span>
                <span className="text-[15px] font-semibold">{c.quarter}</span>
                <span className="ml-auto text-[12.5px] text-muted">tone: {c.tone} · {c.guidance.length} commitments</span>
              </summary>
              <div className="mt-3 space-y-3 text-[14px]">
                {c.growthCommentary.length > 0 && <ul className="list-disc space-y-1 pl-5 text-ink-2">{c.growthCommentary.map((x, k) => <li key={k}>{x}</li>)}</ul>}
                {c.guidance.map((g, k) => (
                  <blockquote key={k} className="border-l-2 hair pl-3">
                    <p className="font-medium">{g.metric}{g.target && <>: <span className="mark">{g.target}</span></>}{g.horizon && <span className="text-muted"> ({g.horizon})</span>}</p>
                    <p className="prose-finn mt-0.5 text-[14.5px] text-ink-2">“{g.quote}”{g.speaker && <span className="text-muted"> — {g.speaker}</span>}</p>
                  </blockquote>
                ))}
                {c.pushback.length > 0 && (
                  <div>
                    <p className="text-[12.5px] font-semibold text-muted">Analysts pressed on</p>
                    <ul className="mt-1 space-y-1.5">{c.pushback.map((p, k) => <li key={k}><b>{p.topic}.</b> {p.question} <span className="text-muted">Answer: {p.answer}</span></li>)}</ul>
                  </div>
                )}
                <a href={c.url} target="_blank" rel="noreferrer" className="inline-block text-[13px] font-medium text-accent">Open transcript</a>
              </div>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}

"use client";
import Link from "next/link";
import { useState } from "react";
import { LABEL } from "@/lib/push/taxonomy";
import type { DigestItem, PersonCard, ResultsCard } from "@/lib/types";
import { ago, pct, tone } from "@/lib/client/format";

function Head({ i }: { i: DigestItem }) {
  return (
    <div className="flex items-center gap-2 text-[13px] text-muted">
      <Link href={`/research/${encodeURIComponent(i.symbol)}`} className="ticker">{i.symbol}</Link>
      <span>{LABEL[i.category]}</span>
      <span className="ml-auto num">{ago(i.at)}</span>
    </div>
  );
}

function Sources({ i }: { i: DigestItem }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
      {i.pdf && <a href={i.pdf} target="_blank" rel="noreferrer" className="font-medium text-accent">Open filing</a>}
      {i.category === "earnings_call" && <Link href={`/research/${encodeURIComponent(i.symbol)}`} className="font-medium text-accent">See what they promised</Link>}
      {i.related.length > 0 && (
        <button onClick={() => setOpen(!open)} className="text-muted" aria-expanded={open}>
          {open ? "Hide" : `${i.related.length} related filing${i.related.length > 1 ? "s" : ""} folded in`}
        </button>
      )}
      {open && (
        <ul className="mt-1 w-full space-y-1 border-l-2 hair pl-3">
          {i.related.map((r) => (
            <li key={r.id} className="text-ink-2">
              {r.pdf ? <a href={r.pdf} target="_blank" rel="noreferrer" className="hover:underline">{r.headline}</a> : r.headline}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Results({ c }: { c: ResultsCard }) {
  return (
    <div className="mt-3">
      <table className="w-full text-[14px] num">
        <thead>
          <tr className="text-[12px] text-muted">
            <th className="pb-1 text-left font-normal">{c.periods.cur} · {c.basis}</th>
            <th className="pb-1 text-right font-normal">₹ cr</th>
            <th className="pb-1 text-right font-normal">QoQ</th>
            <th className="pb-1 text-right font-normal">YoY</th>
          </tr>
        </thead>
        <tbody>
          {c.rows.map((r) => (
            <tr key={r.label} className="border-t hair">
              <td className="py-1.5 font-medium">{r.label}{r.derived && <span className="text-muted" title={c.financial ? "Computed from the statement's own lines" : "Derived: PBT before exceptional items + finance costs + depreciation − other income"}>*</span>}</td>
              <td className={`py-1.5 pl-3 text-right ${r.mismatch ? "text-muted" : ""}`} title={r.mismatch ? "Doesn't match screener; see the note below" : undefined}>
                {r.cur == null ? "—" : new Intl.NumberFormat("en-IN", { maximumFractionDigits: r.cur >= 1000 ? 0 : 1 }).format(r.cur)}{r.mismatch && "?"}
              </td>
              <td className={`py-1.5 pl-3 text-right ${r.mismatch ? "text-muted" : tone(r.qoq)}`}>{r.mismatch ? "—" : pct(r.qoq)}</td>
              <td className={`py-1.5 pl-3 text-right font-semibold ${r.mismatch ? "text-muted" : tone(r.yoy)}`}>{r.mismatch ? "—" : pct(r.yoy)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[12.5px] text-muted">
        {c.marginNote && <>{c.marginNote}. </>}
        {c.rows.some((r) => r.derived) && (c.financial ? "*Computed from the statement's lines. " : "*EBITDA derived from the statement, before exceptional items. ")}
        {c.verified && <span className="text-up">Cross-checked with screener: {(c.checked ?? ["revenue"]).join(", ")} ✓</span>}
      </p>
      {c.notes.map((n) => <p key={n} className="mt-1 text-[12.5px] text-ink-2">Note: {n}</p>)}
    </div>
  );
}

function People({ c }: { c: PersonCard }) {
  return (
    <ul className="mt-3 space-y-3">
      {c.changes.map((p) => (
        <li key={p.person + p.role}>
          <p className="text-[17px] font-semibold leading-snug">
            {p.person} <span className="font-normal text-ink-2">{verb(p.action)} {p.role}</span>
          </p>
          {p.effective && <p className="text-[13px] text-muted">Effective {p.effective}{p.reason ? ` · ${p.reason}` : ""}</p>}
          {p.bio && <p className="prose-finn mt-1.5 text-[15.5px]">{p.bio}</p>}
          <p className="mt-1.5 flex flex-wrap gap-x-3 text-[13px]">
            <a href={p.linkedin} target="_blank" rel="noreferrer" className="font-medium text-accent">LinkedIn</a>
            {p.bioSources.map((s) => (
              <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="text-muted hover:underline">{s.title}</a>
            ))}
          </p>
        </li>
      ))}
    </ul>
  );
}
const verb = (a: string) => ({ appointed: "appointed", resigned: "resigns as", retired: "retires as", "re-appointed": "re-appointed", ceased: "ceases as", redesignated: "redesignated", other: "·" })[a] ?? a;

/** A card for things that matter. */
export function ActCard({ i, id }: { i: DigestItem; id?: string }) {
  const e = i.enrichment;
  return (
    <article id={id} className="sheet scroll-mt-4 p-4">
      <Head i={i} />
      <h3 className="mt-1.5 text-[17px] font-semibold leading-snug">
        {e?.kind === "results" ? <>{i.name}: <span className="mark">{headlineResults(e)}</span></> : <span className="mark">{i.why ?? i.headline}</span>}
      </h3>
      {e?.kind === "results" && i.why && <p className="prose-finn mt-1.5 text-[15.5px]">{i.why}</p>}
      {e?.kind !== "results" && i.why && <p className="mt-1 text-[14px] text-ink-2">{i.summary ?? i.headline}</p>}
      {!i.why && i.summary && <p className="mt-1 text-[14px] text-ink-2">{i.summary}</p>}
      {e?.kind === "results" && <Results c={e} />}
      {e?.kind === "management" && <People c={e} />}
      <Sources i={i} />
    </article>
  );
}

function headlineResults(c: ResultsCard) {
  // Lines that disagree with screener don't make the headline.
  const pat = c.rows.find((r) => r.label === "PAT" && !r.mismatch), top = c.rows.find((r) => !r.mismatch && r.label !== "EBITDA");
  const bits = [];
  if (top?.yoy != null && top !== pat) bits.push(`${top.label.replace(/, net of excise/, "").toLowerCase()} ${pct(top.yoy)}`);
  if (pat?.yoy != null) bits.push(`profit ${pct(pat.yoy)}`);
  return bits.length ? `${bits.join(", ")} YoY` : `${c.periods.cur} results`;
}

/** One line for things worth a glance. */
export function GlanceRow({ i }: { i: DigestItem }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-t hair py-3 first:border-t-0">
      <button className="flex w-full items-start gap-3 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="ticker mt-0.5 shrink-0">{i.symbol}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] leading-snug">{i.summary ?? i.why ?? i.headline}</span>
          <span className="mt-0.5 block text-[12.5px] text-muted">{LABEL[i.category]} · {ago(i.at)}</span>
        </span>
      </button>
      {open && (
        <div className="ml-[60px] mt-2 text-[14px] text-ink-2">
          {(i.summary || i.why) && <p>{i.headline}</p>}
          {i.why && i.summary && <p className="mt-1 text-muted">{i.why}</p>}
          <Sources i={i} />
        </div>
      )}
    </li>
  );
}

import { PORTFOLIO, yahooSymbol, type Holding } from "../portfolio";
import { pool } from "../http";
import { dailyBars } from "../sources/yahoo";
import { bseDaily, fetchPdf, filings, type RawFiling } from "../sources/bse";
import type { Bar } from "../sources/yahoo";
import { company as screenerCompany, type Company } from "../sources/screener";
import { pdfPages } from "../pdf";
import { usage } from "../llm/gemini";
import { CATEGORIES, LABEL, classify, opaque, KMP, priorFor, type Category } from "./taxonomy";
import { dayStats, round } from "./signals";
import { assess, guardWhy, management, oneLiner, readOpaque, results, resultsWhy, triage } from "./enrich";
import { auditLine } from "./verify";
import type { Digest, DigestItem, PersonCard, Quote, Tier } from "../types";

const tierOf = (s: number): Tier => (s >= 68 ? "act" : s >= 35 ? "glance" : "routine");
const SKIP_TRIAGE = new Set<Category>(["unclassified", "investor_meetings", "agm_egm", "postal_ballot"]);
const CLUSTER = new Set<Category>(["results", "earnings_call", "dividend", "management_change", "M&A", "fund_raise", "litigation", "credit_rating"]);
const SCHEDULED = /intimation|to consider|prior notice|will be held|is scheduled|scheduled to|will announce|to announce|date of (the )?board meeting/i;
/** One legal matter, told across several filings over weeks: admission, stay, hearing, order. */
const INSOLVENCY = /\bcirp\b|insolvency|\bibc\b|resolution professional|\bnclt\b|\bnclat\b/i;
const CLARIFICATION = /clarification|sought clarification|news (report|item|article)|media report/i;
/** A subsidiary's IPO arrives as prospectus, price band, newspaper ads, issue price, allotment, listing. */
const IPO = /\bdrhp\b|\brhp\b|red herring|prospectus|initial public offer|\bipo\b|issue price|price band|offer for sale|anchor investors?|basis of allotment/i;
const DAY = 86400_000;

type Work = DigestItem & { raw: RawFiling; text: string; scheduled: boolean; bySubcat: boolean; prior: number };

export async function buildDigest(opts: { windowDays?: number; holdings?: Holding[]; log?: (s: string) => void } = {}): Promise<Digest> {
  const { windowDays = 30, holdings = PORTFOLIO, log = console.log } = opts;
  const errors: string[] = [];
  const hasLLM = !!process.env.GEMINI_API_KEY;

  // ---- prices ----
  log(`prices: ${holdings.length} stocks`);
  const quotes = (
    await pool(holdings, 4, async (h): Promise<Quote | null> => {
      try {
        // BSE answers from cloud runners; Yahoo (NSE prices, OHLC) is the fallback when run locally.
        let bars: Bar[];
        try {
          bars = (await bseDaily(h.bse)).map((r) => ({ t: 0, date: r.date, o: r.c, h: r.c, l: r.c, c: r.c, v: r.v }));
          if (bars.length < 30) throw new Error("short BSE series");
        } catch (e) {
          bars = (await dailyBars(yahooSymbol(h.symbol), "1y")).bars;
        }
        const last = bars.at(-1)!, days = dayStats(bars);
        return {
          symbol: h.symbol, name: h.name, sector: h.sector,
          close: round(last.c, 2), chg: days.at(-1)!.chg, volX: days.at(-1)!.volX,
          hi52: round(Math.max(...bars.map((b) => b.h)), 2), lo52: round(Math.min(...bars.map((b) => b.l)), 2),
          spark: bars.slice(-60).map((b) => round(b.c, 2)), days,
        };
      } catch (e) { errors.push(`price ${h.symbol}: ${String(e).slice(0, 140)}`); return null; }
    })
  ).filter(Boolean) as Quote[];

  // ---- filings ----
  const to = new Date(), from = new Date(Date.now() - windowDays * DAY);
  log(`filings: ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}`);
  const work: Work[] = [];
  await pool(holdings, 3, async (h) => {
    try {
      for (const f of await filings(h.bse, from, to)) {
        const text = `${f.bseSubcategory} | ${f.headline} | ${f.subject}`;
        const { category, bySubcat } = classify(f.bseSubcategory, `${f.headline} | ${f.subject}`);
        const scheduled = category === "results" && (/^board meeting$/i.test(f.bseSubcategory) || (SCHEDULED.test(text) && !/outcome/i.test(text)));
        const prior = priorFor(category, text);
        work.push({
          id: f.id, symbol: h.symbol, name: h.name, sector: h.sector, at: f.at, category, headline: f.headline,
          summary: null, why: null, score: prior + (f.critical ? 4 : 0), tier: "routine", pdf: f.pdf, related: [],
          raw: f, text, scheduled, bySubcat, prior,
        });
      }
    } catch (e) { errors.push(`filings ${h.symbol}: ${String(e).slice(0, 140)}`); }
  });
  log(`filings: ${work.length} raw`);

  // ---- opaque filings ("Enclosed"): let the cheap model read page 1 and say what it is ----
  if (hasLLM) {
    const op = work.filter((l) => opaque(l.headline) && l.pdf && l.category !== "unclassified" || (opaque(l.headline) && /^(general|null|)$/i.test(l.raw.bseSubcategory) && l.pdf));
    log(`opaque: ${op.length} filings with uninformative titles`);
    await pool(op, 4, async (l) => {
      try {
        const r = await readOpaque(l.pdf!, l.name);
        if (r) {
          l.headline = r.title; l.category = r.category; l.bySubcat = true; l.summary = r.line; l.text = `${l.raw.bseSubcategory} | ${r.title}`;
          l.prior = priorFor(r.category, l.text); l.score = l.prior; l.scheduled = r.category === "results" && SCHEDULED.test(r.title);
        }
      } catch (e) { errors.push(`opaque ${l.symbol}: ${String(e).slice(0, 120)}`); }
    });
  }

  // ---- fold: one event often arrives as 3-5 filings, and one story as several events ----
  work.sort((a, b) => b.at.localeCompare(a.at));
  let leads: Work[] = [];
  // The lead of a results cluster should be the actual results statement (it is what we parse).
  const isPrimary = (w: Work) =>
    w.category !== "results" ? (w.raw.pdfBytes ?? 0)
      : /^financial results$/i.test(w.raw.bseSubcategory) ? 1e12 + (w.raw.pdfBytes ?? 0)
      : /financial result/i.test(w.headline) && !/newspaper|press|presentation/i.test(w.text) ? 1e9 + (w.raw.pdfBytes ?? 0)
      : (w.raw.pdfBytes ?? 0) / 1e3;
  const ref = (w: Work) => ({ id: w.id, headline: w.headline, pdf: w.pdf, at: w.at });
  const absorb = (into: Work, w: Work) => { into.related.push(...w.related, ref(w)); w.related = []; };
  for (const w of work) {
    if (!CLUSTER.has(w.category) || w.scheduled) { leads.push(w); continue; }
    const near = leads.find((l) => l.symbol === w.symbol && l.category === w.category && !l.scheduled &&
      Math.abs(Date.parse(l.at) - Date.parse(w.at)) < 4 * DAY);
    if (!near) { leads.push(w); continue; }
    // keep the most substantive filing as the lead
    if (isPrimary(w) > isPrimary(near)) {
      const idx = leads.indexOf(near);
      w.related = [...near.related, ref(near)];
      near.related = [];
      leads[idx] = w;
    } else absorb(near, w);
  }
  const gone = new Set<Work>();
  // A dividend declared with the results, and the call that discussed them, belong on the results card.
  for (const l of leads) {
    if (l.category !== "dividend" && l.category !== "earnings_call") continue;
    const host = leads.find((r) => r !== l && !gone.has(r) && r.symbol === l.symbol && r.category === "results" && !r.scheduled &&
      Date.parse(l.at) - Date.parse(r.at) > -1.5 * DAY && Date.parse(l.at) - Date.parse(r.at) < (l.category === "dividend" ? 1.5 : 21) * DAY);
    if (host) { absorb(host, l); gone.add(l); }
  }
  // A legal matter or a news clarification is one story: the latest filing leads, the rest are its history.
  const ANY = CATEGORIES.filter((c) => c !== "results" && c !== "earnings_call");
  for (const [re, cats, span] of [
    [INSOLVENCY, ["litigation", "press_release", "unclassified"], windowDays],
    [CLARIFICATION, ["press_release", "litigation", "unclassified"], 5],
    [IPO, ANY, windowDays],
  ] as const) {
    const bySym = new Map<string, Work[]>();
    for (const l of leads) if (!gone.has(l) && (cats as readonly string[]).includes(l.category) && re.test(l.text)) bySym.set(l.symbol, [...(bySym.get(l.symbol) ?? []), l]);
    for (const group of bySym.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => b.at.localeCompare(a.at));
      // the company's own reply leads a clarification thread, not the exchange's question
      const head = re === CLARIFICATION ? group.find((g) => g.pdf && !/exchange has sought/i.test(g.headline)) ?? group[0] : group[0];
      for (const g of group) if (g !== head && Date.parse(head.at) - Date.parse(g.at) <= span * DAY) { absorb(head, g); gone.add(g); }
      if (re === IPO) { head.prior = Math.max(...group.map((g) => g.prior), 82); if (head.category === "unclassified") head.category = "M&A"; }
      if (re === INSOLVENCY && group.some((g) => /\bcirp\b|insolvency|resolution professional/i.test(g.text))) { head.category = "litigation"; head.prior = Math.max(head.prior, 80); }
      head.related.sort((a, b) => a.at.localeCompare(b.at));
    }
  }
  leads = leads.filter((l) => !gone.has(l));

  // ---- score: rules prior + one batched LLM pass over the non-routine headlines ----
  for (const l of leads) if (l.scheduled) { l.score = 22; l.why = "Results date set"; }
  if (hasLLM) {
    const batch = leads
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => !SKIP_TRIAGE.has(l.category) && !l.scheduled)
      .map(({ l, i }) => ({ i, company: l.name, category: l.category, text: `${l.headline}${l.raw.subject && l.raw.subject !== l.headline ? ` — ${l.raw.subject}` : ""}` }));
    log(`triage: ${batch.length} headlines`);
    try {
      const t = await triage(batch);
      for (const [i, r] of t) {
        const l = leads[i];
        if (!l) continue;
        // text-rule labels are guesses; let the model correct them (BSE's own subcategory wins otherwise)
        if (!l.bySubcat && r.category && r.category !== l.category && (CATEGORIES as readonly string[]).includes(r.category)) { l.category = r.category as Category; l.prior = priorFor(l.category, l.text); }
        l.score = Math.round(0.45 * l.prior + 0.55 * r.materiality) + (l.raw.critical ? 4 : 0);
        l.why = r.why;
      }
    } catch (e) { errors.push(`triage: ${String(e).slice(0, 160)}`); }
  }
  const isStatement = (l: Work) => /^financial results$/i.test(l.raw.bseSubcategory) || (/financial results|results for the quarter/i.test(l.headline) && !/newspaper|auditor|transcript|presentation/i.test(l.text));
  for (const l of leads) {
    if (l.category === "management_change" && (!KMP.test(l.text) || /re-?appoint/i.test(l.text) && !/managing director|chief executive|ceo/i.test(l.text))) l.score = Math.min(l.score, 45);
    if (l.category === "results" && !l.scheduled && isStatement(l)) l.score = Math.max(l.score, 80);
    l.score = Math.max(0, Math.min(100, l.score));
    l.tier = tierOf(l.score);
  }

  // ---- screener, once per company: verifies results and gives the scale that judges size ----
  const scr = new Map<string, Promise<Company | null>>();
  const screener = (sym: string) => {
    if (!scr.has(sym)) scr.set(sym, screenerCompany(sym).catch((e) => { errors.push(`screener ${sym}: ${String(e).slice(0, 120)}`); return null; }));
    return scr.get(sym)!;
  };
  const sizeOf = async (sym: string) => {
    const c = await screener(sym);
    if (!c) return undefined;
    const cap = c.ratios["Market Cap"]?.replace(/\s+/g, " ");
    const salesRow = c.pnl.rows["Sales"] ?? c.pnl.rows["Revenue"];
    const ttm = salesRow?.at(-1);
    return [cap && `market value ${cap}`, ttm && `annual revenue ₹${new Intl.NumberFormat("en-IN").format(Math.round(ttm))} Cr`].filter(Boolean).join("; ") || undefined;
  };
  const history = (l: Work) => l.related.map((r) => `${r.at.slice(0, 10)}: ${r.headline}`);
  const docText = async (pdf: string | null, pages = 3) => {
    if (!pdf) return "";
    try { return (await pdfPages(await fetchPdf(pdf), pages)).join("\n").slice(0, 12_000); } catch { return ""; }
  };

  // ---- enrich what earns attention ----
  if (hasLLM) {
    const res = leads.filter((l) => l.category === "results" && !l.scheduled && l.pdf && l.tier !== "routine");
    log(`enrich: ${res.length} results`);
    const audit: string[] = [];
    await pool(res, 2, async (l) => {
      try {
        const h = holdings.find((x) => x.symbol === l.symbol);
        const c = await screener(l.symbol);
        // If the statement's PDF won't download, the same numbers are usually in a sibling filing.
        const pdfs = [l.pdf!, ...l.related.filter((r) => r.pdf && /result/i.test(r.headline) && !/newspaper|transcript|audio/i.test(r.headline)).map((r) => r.pdf!)];
        let out: Awaited<ReturnType<typeof results>> = null, lastErr: unknown = null;
        for (const pdf of pdfs) {
          try { out = await results(pdf, { financial: !!h?.isBank, filedAt: l.at, screener: c ? { quarters: c.quarters } : null }); if (out) break; }
          catch (e) { lastErr = e; }
        }
        if (!out && lastErr) throw lastErr;
        if (!out) { audit.push(`${l.symbol.padEnd(10)} no quarterly table found in ${l.pdf}`); return; }
        l.enrichment = out.card;
        const ev = out.ebitdaVsScreener;
        audit.push(
          `${l.symbol.padEnd(10)} ${out.card.periods.cur} ${out.card.basis.padEnd(12)} ${out.card.verified ? "VERIFIED " : "UNCHECKED"} [${out.tier}${out.modelLabel !== out.card.periods.cur ? `, model said ${out.modelLabel}` : ""}] ${auditLine(out.checks)}` +
          (ev ? `  | EBITDA ${ev.card ?? "–"} vs screener OP ${ev.screener ?? "–"}` : "") +
          (out.card.notes.length ? `\n${" ".repeat(11)}notes: ${out.card.notes.join(" / ")}` : ""),
        );
        // the why is written from the computed, cross-checked numbers, not from the headline
        l.why = await resultsWhy(l.name, out.card);
      } catch (e) { errors.push(`results ${l.symbol}: ${String(e).slice(0, 160)}`); }
    });
    log(`results cross-check against screener:\n  ${audit.sort().join("\n  ")}`);
    // A results card that couldn't be built has no numbers to say anything about.
    for (const l of res) if (!l.enrichment) l.why = null;

    const mg = leads.filter((l) => l.category === "management_change" && l.tier !== "routine" && l.pdf);
    log(`enrich: ${mg.length} management changes`);
    await pool(mg, 2, async (l) => {
      try {
        const card = await management(l.pdf!, l.name, l.headline);
        if (!card) return;
        const live = card.changes.filter((c) => c.action !== "re-appointed");
        const top = live.some((c) => c.rank === "top"), second = live.some((c) => c.rank === "second");
        // Show the people who matter; a re-appointed independent director is noise on a CEO card.
        const keep = card.changes.filter((c) => (top ? c.rank === "top" : second ? c.rank !== "other" : true) && (c.action !== "re-appointed" || !(top || second)));
        l.enrichment = { ...card, changes: keep } satisfies PersonCard;
        l.score = top ? Math.max(l.score, 78) : second ? Math.min(Math.max(l.score, 55), 64) : Math.min(l.score, 30);
        l.tier = tierOf(l.score);
        if (top || second) {
          const body = keep.map((c) => `${c.person}, ${c.role}: ${c.action}${c.effective ? ` from ${c.effective}` : ""}${c.reason ? ` (reason: ${c.reason})` : ""}${c.bio ? `. Background: ${c.bio}` : ""}`).join("\n");
          const a = await assess({ company: l.name, sector: l.sector, category: "management change", headline: l.headline, body, size: await sizeOf(l.symbol) });
          l.why = a.why;
        } else l.why = null;
      } catch (e) { errors.push(`mgmt ${l.symbol}: ${String(e).slice(0, 160)}`); }
    });

    // Anything else heading for the Brief is read in full before it is ranked.
    const cand = leads.filter((l) => l.score >= 40 && !l.scheduled && l.category !== "results" && l.category !== "management_change");
    log(`assess: ${cand.length} filings read before ranking`);
    await pool(cand, 3, async (l) => {
      try {
        const body = (await docText(l.pdf)) || l.summary || l.headline;
        const a = await assess({ company: l.name, sector: l.sector, category: LABEL[l.category], headline: l.headline, body, history: history(l), size: await sizeOf(l.symbol) });
        // Once the filing itself has been read, that judgment outweighs the category's average.
        l.score = Math.max(0, Math.min(100, Math.round(0.2 * l.prior + 0.8 * a.materiality) + (l.raw.critical ? 4 : 0)));
        l.tier = tierOf(l.score);
        l.why = a.why;
        if (a.summary) l.summary = a.summary;
      } catch (e) { errors.push(`assess ${l.symbol}: ${String(e).slice(0, 160)}`); }
    });

    const rest = leads.filter((l) => l.tier !== "routine" && !l.enrichment && !l.summary && !l.scheduled && l.category !== "results");
    log(`enrich: ${rest.length} one-liners`);
    await pool(rest, 4, async (l) => {
      try { l.summary = await oneLiner(l.pdf, l.name, l.headline); } catch (e) { errors.push(`line ${l.symbol}: ${String(e).slice(0, 120)}`); }
    });
  }
  for (const l of leads) { l.why = guardWhy(l.why); l.tier = tierOf(l.score); }

  const items: DigestItem[] = leads
    .map(({ raw, text, scheduled, bySubcat, prior, ...d }) => d)
    .sort((a, b) => b.score - a.score || b.at.localeCompare(a.at));

  // What the Brief will say, in the log, so every run can be read and judged.
  const line = (i: DigestItem) => `  [${i.score}] ${i.symbol.padEnd(10)} ${LABEL[i.category].padEnd(13)} ${i.at.slice(0, 10)}${i.related.length ? ` +${i.related.length}` : ""}  ${(i.summary ?? i.headline).slice(0, 110)}\n${" ".repeat(9)}why: ${i.why ?? "—"}`;
  log(`\nACT\n${items.filter((i) => i.tier === "act").map(line).join("\n")}`);
  log(`\nGLANCE\n${items.filter((i) => i.tier === "glance").map(line).join("\n")}`);

  return {
    generatedAt: new Date().toISOString(),
    asOf: quotes[0]?.days.at(-1)?.date ?? "",
    windowDays,
    items,
    quotes,
    errors,
    cost: { ...usage, byTier: { ...usage.byTier } },
  };
}

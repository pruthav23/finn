import { PORTFOLIO, yahooSymbol, type Holding } from "../portfolio";
import { pool } from "../http";
import { dailyBars } from "../sources/yahoo";
import { filings, type RawFiling } from "../sources/bse";
import { company as screenerCompany } from "../sources/screener";
import { usage } from "../llm/gemini";
import { CATEGORIES, classify, opaque, KMP, PRIOR, type Category } from "./taxonomy";
import { dayStats, round } from "./signals";
import { management, oneLiner, readOpaque, results, triage } from "./enrich";
import type { Digest, DigestItem, Quote, Tier } from "../types";

const tierOf = (s: number): Tier => (s >= 68 ? "act" : s >= 35 ? "glance" : "routine");
const SKIP_TRIAGE = new Set<Category>(["unclassified", "investor_meetings", "agm_egm", "postal_ballot"]);
const CLUSTER = new Set<Category>(["results", "earnings_call", "dividend", "management_change", "M&A"]);

type Work = DigestItem & { raw: RawFiling; text: string; scheduled: boolean; bySubcat: boolean };

export async function buildDigest(opts: { windowDays?: number; holdings?: Holding[]; log?: (s: string) => void } = {}): Promise<Digest> {
  const { windowDays = 30, holdings = PORTFOLIO, log = console.log } = opts;
  const errors: string[] = [];
  const hasLLM = !!process.env.GEMINI_API_KEY;

  // ---- prices ----
  log(`prices: ${holdings.length} stocks`);
  const quotes = (
    await pool(holdings, 4, async (h): Promise<Quote | null> => {
      try {
        const { bars } = await dailyBars(yahooSymbol(h.symbol), "1y");
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
  const to = new Date(), from = new Date(Date.now() - windowDays * 86400_000);
  log(`filings: ${from.toISOString().slice(0, 10)} → ${to.toISOString().slice(0, 10)}`);
  const work: Work[] = [];
  await pool(holdings, 3, async (h) => {
    try {
      for (const f of await filings(h.bse, from, to)) {
        const text = `${f.bseSubcategory} | ${f.headline} | ${f.subject}`;
        const { category, bySubcat } = classify(f.bseSubcategory, `${f.headline} | ${f.subject}`);
        const scheduled = category === "results" && (/^board meeting$/i.test(f.bseSubcategory) || (/intimation|to consider|prior notice|will be held|is scheduled|scheduled to/i.test(text) && !/outcome/i.test(text)));
        work.push({
          id: f.id, symbol: h.symbol, name: h.name, sector: h.sector, at: f.at, category, headline: f.headline,
          summary: null, why: null, score: PRIOR[category] + (f.critical ? 4 : 0), tier: "routine", pdf: f.pdf, related: [],
          raw: f, text, scheduled, bySubcat,
        });
      }
    } catch (e) { errors.push(`filings ${h.symbol}: ${String(e).slice(0, 140)}`); }
  });
  log(`filings: ${work.length} raw`);

  // ---- collapse duplicates: one event often arrives as 3-5 filings ----
  work.sort((a, b) => b.at.localeCompare(a.at));
  const leads: Work[] = [];
  // The lead of a results cluster should be the actual results statement (it is what we parse).
  const isPrimary = (w: Work) =>
    w.category !== "results" ? (w.raw.pdfBytes ?? 0)
      : /^financial results$/i.test(w.raw.bseSubcategory) ? 1e12 + (w.raw.pdfBytes ?? 0)
      : /financial result/i.test(w.headline) && !/newspaper|press|presentation/i.test(w.text) ? 1e9 + (w.raw.pdfBytes ?? 0)
      : (w.raw.pdfBytes ?? 0) / 1e3;
  for (const w of work) {
    if (!CLUSTER.has(w.category) || w.scheduled) { leads.push(w); continue; }
    const near = leads.find((l) => l.symbol === w.symbol && l.category === w.category && !l.scheduled &&
      Math.abs(Date.parse(l.at) - Date.parse(w.at)) < 4 * 86400_000);
    if (!near) { leads.push(w); continue; }
    // keep the most substantive filing as the lead
    if (isPrimary(w) > isPrimary(near)) {
      const idx = leads.indexOf(near);
      w.related = [...near.related, { id: near.id, headline: near.headline, pdf: near.pdf, at: near.at }];
      leads[idx] = w;
    } else near.related.push({ id: w.id, headline: w.headline, pdf: w.pdf, at: w.at });
  }

  // ---- opaque filings ("Enclosed"): let the cheap model read page 1 and say what it is ----
  if (hasLLM) {
    const op = leads.filter((l) => opaque(l.headline) && l.pdf && l.category !== "unclassified" || (opaque(l.headline) && /^(general|null|)$/i.test(l.raw.bseSubcategory) && l.pdf));
    log(`opaque: ${op.length} filings with uninformative titles`);
    await pool(op, 4, async (l) => {
      try {
        const r = await readOpaque(l.pdf!, l.name);
        if (r) { l.headline = r.title; l.category = r.category; l.bySubcat = true; l.summary = r.line; l.text = `${l.raw.bseSubcategory} | ${r.title}`; l.score = PRIOR[r.category]; }
      } catch (e) { errors.push(`opaque ${l.symbol}: ${String(e).slice(0, 120)}`); }
    });
  }

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
        if (!l.bySubcat && r.category && r.category !== l.category && (CATEGORIES as readonly string[]).includes(r.category)) l.category = r.category as Category;
        l.score = Math.round(0.45 * PRIOR[l.category] + 0.55 * r.materiality) + (l.raw.critical ? 4 : 0);
        l.why = r.why;
      }
    } catch (e) { errors.push(`triage: ${String(e).slice(0, 160)}`); }
  }
  for (const l of leads) {
    if (l.category === "management_change" && !KMP.test(l.text)) l.score = Math.min(l.score, 45);
    if (l.category === "results" && !l.scheduled) l.score = Math.max(l.score, 80);
    l.score = Math.max(0, Math.min(100, l.score));
    l.tier = tierOf(l.score);
  }

  // ---- enrich what earns attention ----
  if (hasLLM) {
    const res = leads.filter((l) => l.category === "results" && !l.scheduled && l.pdf);
    log(`enrich: ${res.length} results`);
    await pool(res, 2, async (l) => {
      try {
        const card = await results(l.pdf!);
        if (card) l.enrichment = card;
      } catch (e) { errors.push(`results ${l.symbol}: ${String(e).slice(0, 160)}`); }
    });
    // cross-check extracted revenue against screener's independently compiled quarterly number
    await pool(res.filter((l) => l.enrichment), 3, async (l) => {
      try {
        const c = await screenerCompany(l.symbol);
        const card = l.enrichment as any;
        const sales = c.quarters.rows["Sales"] ?? c.quarters.rows["Revenue"];
        const latest = sales?.at(-1);
        const ours = card.rows[0]?.cur;
        if (latest && ours && card.basis === (c.consolidated ? "consolidated" : "standalone")) card.verified = Math.abs(latest - ours) / latest < 0.02;
      } catch {}
    });

    const mg = leads.filter((l) => l.category === "management_change" && l.tier !== "routine" && l.pdf);
    log(`enrich: ${mg.length} management changes`);
    await pool(mg, 2, async (l) => {
      try {
        const card = await management(l.pdf!, l.name, l.headline);
        if (card) {
          l.enrichment = card;
          if (card.changes.some((c) => c.kmp)) { l.score = Math.max(l.score, 72); l.tier = tierOf(l.score); }
        }
      } catch (e) { errors.push(`mgmt ${l.symbol}: ${String(e).slice(0, 160)}`); }
    });

    const rest = leads.filter((l) => l.tier !== "routine" && !l.enrichment && !l.summary && !l.scheduled && l.category !== "results");
    log(`enrich: ${rest.length} one-liners`);
    await pool(rest, 4, async (l) => {
      try { l.summary = await oneLiner(l.pdf, l.name, l.headline); } catch (e) { errors.push(`line ${l.symbol}: ${String(e).slice(0, 120)}`); }
    });
  }

  const items: DigestItem[] = leads
    .map(({ raw, text, scheduled, bySubcat, ...d }) => d)
    .sort((a, b) => b.score - a.score || b.at.localeCompare(a.at));

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

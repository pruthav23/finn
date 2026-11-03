import { createHash } from "node:crypto";
import { generate, pdfPart, looseJson } from "../llm/gemini";
import { fetchPdf } from "../sources/bse";
import { pdfPages, selectPages } from "../pdf";
import { CATEGORIES, roleRank, type Category } from "./taxonomy";
import type { PersonCard, ResultsCard } from "../types";
import { anchor, crossCheck, mismatchNotes, quarterBefore, screenerOperatingProfit, shiftQuarter, type Check, type Screener } from "./verify";

// ---------- 1. Batch triage: one cheap call scores a whole window of headlines ----------

export type TriageIn = { i: number; company: string; category: Category; text: string };
export type TriageOut = { i: number; materiality: number; why: string | null; category?: string };

const TRIAGE_SYSTEM = `You triage Indian stock-exchange filings for a long-only fundamental investor who holds these stocks.
You see only headlines here; filings that look important are read in full later, so judge what the headline supports.
For each filing return materiality 0-100: how likely it changes the investment view or moves the stock.
Calibrate:
- insolvency (CIRP/NCLT) admitted against the company, or its stay/reversal: 85-95; hearing dates, adjournments, listings of an appeal: 10-25
- quarterly results 80-95
- acquisitions/mergers/demergers/divestments 55-90 by size relative to the company; small or undisclosed-size deals 25-45
- transactions inside the group (with its own wholly owned subsidiaries: amalgamating one, incorporating one, transferring a business to one, letters of comfort): 10-25
- IPO, DRHP or listing of a major subsidiary, or a stake sale in one: 70-85
- CEO/CFO/MD/chairman change 75-90; deputy MD/whole-time director 55-67; independent or nominee director 15-30; functional heads and senior management 10-25; re-appointments 5-15
- equity raises (QIP, preferential, rights) 65-85; buybacks 60-80
- routine debt (NCD, bond or commercial-paper allotments or repayments, by anyone): 5-15
- order wins: scale with value vs the company's size; "mega/ultra-mega" orders at large contractors 45-65; generic press releases 15-30
- regulatory penalties scale with amount vs the company's size (a few lakh rupees is 5-10); credit downgrades 60+, reaffirmations 10-15
- the exchange asking for, or the company giving, a clarification on a news report: 40-60
- schedules of investor meetings, intimations, compliance paperwork 0-10
"why" = the CONSEQUENCE for a shareholder in one plain sentence (max 16 words): what changes for the business, the earnings or the risk.
Use only what the headline says. Never name a segment, cause or number the headline doesn't give.
Do not restate the filing: "Provides an update on…", "Reports quarterly performance…", "Alters the group structure" are restatements.
If you cannot say anything beyond a restatement, return null. No hype, no advice.`;

export async function triage(batch: TriageIn[]): Promise<Map<number, TriageOut>> {
  const out = new Map<number, TriageOut>();
  for (let s = 0; s < batch.length; s += 60) {
    const chunk = batch.slice(s, s + 60);
    const res = await generate<{ items: TriageOut[] }>({
      tier: "lite",
      system: TRIAGE_SYSTEM,
      parts: [{ text: chunk.map((b) => `#${b.i} [${b.company}] (${b.category}) ${b.text}`).join("\n") }],
      schema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { i: { type: "integer" }, category: { type: "string", enum: [...CATEGORIES], description: "correct category if the given one is wrong, else repeat it" }, materiality: { type: "integer" }, why: { type: "string", nullable: true } },
              required: ["i", "materiality"],
            },
          },
        },
        required: ["items"],
      },
    });
    for (const r of res.items) out.set(r.i, { ...r, why: guardWhy(r.why) });
  }
  return out;
}

// ---------- 2. Results: read the actual results PDF, extract numbers, compute deltas in code ----------

type T3 = (number | null)[];
type RawResults = {
  found: boolean;
  basis: "consolidated" | "standalone";
  unit: string;
  financial_company: boolean;
  period_labels: { current: string; previous_quarter: string; year_ago_quarter: string };
  revenue_from_operations: T3;
  other_income: T3;
  excise_duty: T3;
  finance_costs: T3;
  depreciation: T3;
  profit_before_exceptional_items_and_tax: T3;
  exceptional_items: T3;
  share_of_associates_jv: T3;
  associates_share_before_pbt: boolean | null;
  profit_before_tax: T3;
  profit_for_the_period: T3;
  profit_attributable_to_owners: T3;
  interest_earned: T3;
  interest_expended: T3;
  provisions: T3;
  operating_profit_before_provisions: T3;
  exceptional_items_note: string | null;
};

const triple = (description = "") => ({
  type: "array",
  items: { type: "number", nullable: true },
  description: `[current quarter, previous quarter, same quarter last year], copied from the three quarterly columns. ${description}`.trim(),
});

const RESULTS_SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean", description: "false if this PDF contains no quarterly results table" },
    basis: { type: "string", enum: ["consolidated", "standalone"] },
    unit: { type: "string", description: "unit stated in the table header, e.g. '₹ crore', '₹ lakh', '₹ million'" },
    financial_company: { type: "boolean", description: "true for banks/NBFCs/insurers" },
    period_labels: {
      type: "object",
      properties: { current: { type: "string" }, previous_quarter: { type: "string" }, year_ago_quarter: { type: "string" } },
      required: ["current", "previous_quarter", "year_ago_quarter"],
    },
    revenue_from_operations: triple("'Revenue from operations' (not total income). Banks: leave null."),
    other_income: triple(),
    excise_duty: triple("the 'Excise duty' line if printed among expenses or deducted from revenue; null if not printed"),
    finance_costs: triple("NBFCs: the 'Finance costs' line."),
    depreciation: triple("'Depreciation and amortisation expense'"),
    profit_before_exceptional_items_and_tax: triple("the line printed as 'Profit before exceptional items and tax' (or '…share of associates, exceptional items and tax'); null if not printed"),
    exceptional_items: triple("the 'Exceptional items' line, with the sign it has as printed: an expense or loss shown in brackets is negative"),
    share_of_associates_jv: triple("'Share of profit/(loss) of associates and joint ventures'; null if not printed"),
    associates_share_before_pbt: { type: "boolean", nullable: true, description: "true if the associates/JV share line appears above the 'Profit before tax' line" },
    profit_before_tax: triple("the line printed as 'Profit before tax'"),
    profit_for_the_period: triple("'Profit for the period/quarter' or 'Net profit after tax', before any split into owners and non-controlling interests"),
    profit_attributable_to_owners: triple("'Profit attributable to owners/equity holders of the parent'; null if no such split is printed"),
    interest_earned: triple("banks: 'Interest earned'; NBFCs: 'Interest income'"),
    interest_expended: triple("banks: 'Interest expended'; NBFCs: 'Finance costs'"),
    provisions: triple("banks: 'Provisions (other than tax) and contingencies'; NBFCs: 'Impairment on financial instruments'"),
    operating_profit_before_provisions: triple("banks only: 'Operating profit before provisions and contingencies'"),
    exceptional_items_note: { type: "string", nullable: true, description: "what the exceptional items are, from the notes, in one sentence" },
  },
  required: ["found", "basis", "unit", "financial_company", "period_labels", "revenue_from_operations", "profit_before_tax", "profit_for_the_period"],
};

function toCrore(unit: string): number {
  const u = unit.toLowerCase();
  if (/lakh|lac/.test(u)) return 1 / 100;
  if (/million|mn/.test(u)) return 1 / 10;
  if (/billion|bn/.test(u)) return 100;
  if (/thousand|'000/.test(u)) return 1 / 10000;
  return 1; // crore
}

const pct = (a: number | null, b: number | null) => (a == null || b == null || b === 0 ? null : Math.round(((a - b) / Math.abs(b)) * 1000) / 10);
const r2 = (n: number) => Math.round(n * 100) / 100;
const crore = (n: number) => `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: Math.abs(n) >= 100 ? 0 : 1 }).format(Math.abs(n))} cr`;

/** "30.09.2026" / "September 30, 2026" / "30 Sep 26" → "Q2 FY27" (Indian fiscal year). */
export function quarterLabel(s: string): string {
  const M: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  let m: number | undefined, y: number | undefined;
  const num = s.match(/(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})/);
  if (num) { m = +num[2]; y = +num[3]; }
  else {
    const w = s.toLowerCase().match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[^0-9]*(?:\d{1,2}(?:st|nd|rd|th)?,?\s*)?(\d{2,4})/);
    if (w) { m = M[w[1]]; y = +w[2]; }
  }
  if (!m || !y) return s;
  if (y < 100) y += 2000;
  const q = m <= 3 ? 4 : m <= 6 ? 1 : m <= 9 ? 2 : 3;
  const fy = (m <= 3 ? y : y + 1) % 100;
  return `Q${q} FY${String(fy).padStart(2, "0")}`;
}

/** Notes read from PDFs often carry the rupee glyph as "t" or "`" (font encoding). */
export const cleanNote = (s: string) =>
  s.replace(/(^|[\s(])[t`](?=\s?\d)/g, "$1₹").replace(/₹\s+(\d)/g, "₹$1").replace(/\bcrores\b/g, "crore").replace(/\s+/g, " ").trim();

export type ResultsOpts = { financial?: boolean; filedAt: string; screener?: Screener | null };
export type ResultsOut = { card: ResultsCard; checks: Check[]; ebitdaVsScreener: { card: number | null; screener: number | null } | null; modelLabel: string; tier: string; repaired?: boolean };

export async function results(pdfUrl: string, opts: ResultsOpts): Promise<ResultsOut | null> {
  const bytes = await fetchPdf(pdfUrl);
  let tierUsed: string = "cache";
  const ask = `Extract the quarterly results table. Prefer CONSOLIDATED if present. Copy each line from the three quarterly columns (current quarter, previous quarter, same quarter last year), not the half-year or full-year columns.${
    opts.financial ? " This is a bank/NBFC: fill interest_earned, interest_expended and provisions, and operating_profit_before_provisions if printed." : ""
  }`;
  const pagesText = bytes.length < 15_000_000 ? null : (await pdfPages(bytes, 25)).join("\n\n").slice(0, 120_000);
  const read = (hint = "", key = "") =>
    generate<RawResults>({
      tier: "smart",
      system: "You read Indian listed-company quarterly results filings and copy numbers exactly as printed. Never compute or estimate; use null when a figure is absent. Negative numbers (losses, figures in brackets) must be negative.",
      parts: pagesText ? [{ text: `Results filing text:\n${pagesText}\n\n${ask}${hint}` }] : [pdfPart(bytes), { text: ask + hint }],
      schema: RESULTS_SCHEMA,
      cacheKey: `results:v2:${key}${pdfUrl}${opts.financial ? ":fin" : ""}`,
      temperature: 0,
      onTier: (x) => (tierUsed = x),
    });
  const first = build(await read(), opts, tierUsed);
  const failing = first ? [...new Set(first.checks.filter((c) => c.ok === false && c.period === first.card.periods.cur).map((c) => c.metric))] : [];
  if (!first || !failing.length) return first;
  // One more careful reading when a line disagrees with screener. It is kept only if it then agrees
  // on more lines: screener decides, the model never sees screener's figures.
  const LINES: Record<string, string> = { revenue: "revenue from operations (and excise duty)", PBT: "profit before tax, exceptional items and profit before exceptional items", "net profit": "profit for the period and profit attributable to owners", EBITDA: "other income, finance costs, depreciation and amortisation, exceptional items and profit before tax", NII: "interest earned and interest expended" };
  const hint = ` Re-read carefully: an earlier reading of ${failing.map((m) => LINES[m] ?? m).join("; ")} did not agree with an independent source. Take each figure from the current-quarter column and from the line with exactly that name; check the table's unit.`;
  try {
    const second = build(await read(hint, "repair:"), opts, tierUsed);
    const bad = (o: ResultsOut | null) => (o ? o.checks.filter((c) => c.ok === false).length : Infinity);
    if (second && bad(second) < bad(first)) return { ...second, repaired: true };
  } catch {}
  return first;
}

function build(r: RawResults, opts: ResultsOpts, tierUsed: string): ResultsOut | null {
  const modelQ = quarterLabel(r.period_labels.current);
  const financial = !!(opts.financial || r.financial_company);
  // Screener's "Revenue" for a bank is interest earned; for an NBFC it can be either line.
  // Tobacco and liquor makers book excise duty inside revenue; screener (and the economics) net it out.
  const netOfExcise = r.excise_duty?.some((x) => x != null)
    ? [0, 1, 2].map((i) => (r.revenue_from_operations?.[i] != null && r.excise_duty[i] != null ? (r.revenue_from_operations[i] as number) - Math.abs(r.excise_duty[i] as number) : null))
    : null;
  const revCands = (financial ? [r.interest_earned, r.revenue_from_operations] : [netOfExcise, r.revenue_from_operations]).filter((a): a is T3 => !!a?.some((x) => x != null));
  let revRaw = revCands[0];
  if (!r.found || !revRaw) return null;

  // ---- unit and period: anchored on screener, never on the model's labels ----
  const filedQ = quarterBefore(opts.filedAt);
  let k = toCrore(r.unit);
  // A results filing reports the quarter that ended before it was filed; the model's own label is only logged.
  let cur = filedQ;
  const t = opts.screener?.quarters;
  const notes: string[] = [];
  let anchored = false;
  if (t) {
    for (const cand of revCands) {
      const a = anchor(t, cand[0], [filedQ], [k, 1, 0.1, 0.01, 1e-4, 1e-5, 10, 100]);
      if (a) { k = a.factor; cur = a.quarter; anchored = true; revRaw = cand; break; }
    }
  }
  const periods = { cur, prevQ: shiftQuarter(cur, 1), yoyQ: shiftQuarter(cur, 4) };

  const v = (a?: T3) => [0, 1, 2].map((i) => (a?.[i] == null ? null : r2((a[i] as number) * k)));
  const row = (label: string, a: (number | null)[], derived = false) => ({
    label, cur: a[0], prevQ: a[1], yoyQ: a[2], qoq: pct(a[0], a[1]), yoy: pct(a[0], a[2]), derived,
  });

  const excised = !financial && netOfExcise != null && revRaw === netOfExcise;
  const rev = v(excised ? netOfExcise! : r.revenue_from_operations), pbt = v(r.profit_before_tax);
  const patTotal = v(r.profit_for_the_period), patOwners = v(r.profit_attributable_to_owners);
  const pat = [0, 1, 2].map((i) => patOwners[i] ?? patTotal[i]);
  const pbei = v(r.profit_before_exceptional_items_and_tax);
  const assoc = v(r.share_of_associates_jv), excPrinted = v(r.exceptional_items);
  // Exceptional items, signed as they affect PBT. The printed line's sign is ambiguous across
  // formats, so when "profit before exceptional items" is printed, the gap to PBT settles it.
  const same = (a: number, b: number) => Math.abs(Math.abs(a) - Math.abs(b)) <= Math.max(0.5, Math.abs(b) * 0.01);
  const exc = [0, 1, 2].map((i) => {
    const p = excPrinted[i], gap = pbei[i] != null && pbt[i] != null ? r2(pbt[i]! - pbei[i]!) : null;
    if (p != null && gap != null) return same(gap, p) ? gap : assoc[i] != null && same(gap - assoc[i]!, p) ? r2(gap - assoc[i]!) : p;
    if (p != null) return p;
    return gap != null && assoc[i] == null && Math.abs(gap) >= 0.5 ? gap : null;
  });

  const rows: ResultsCard["rows"] = [];
  let nii: (number | null)[] | undefined;
  if (financial) {
    // Banks and NBFCs: NII and pre-provision operating profit, both computed here from the printed lines.
    const ie = v(r.interest_earned), ix = v(r.interest_expended), prov = v(r.provisions), ppopPrinted = v(r.operating_profit_before_provisions);
    nii = [0, 1, 2].map((i) => (ie[i] != null && ix[i] != null ? r2(ie[i]! - ix[i]!) : null));
    const ppop = [0, 1, 2].map((i) => ppopPrinted[i] ?? (pbt[i] != null && prov[i] != null ? r2(pbt[i]! + prov[i]! - (exc[i] ?? 0)) : null));
    if (nii.some((x) => x != null)) rows.push(row("Net interest income", nii, true));
    else rows.push(row("Total income", rev));
    if (ppop.some((x) => x != null)) rows.push(row("Pre-provision op. profit", ppop, ppopPrinted.every((x) => x == null)));
    rows.push(row("PBT", pbt), row("PAT", pat));
  } else {
    // EBITDA isn't printed in Indian results. Derive the operating version from the statement's own lines,
    // before one-offs: PBT − exceptional items − associates' share + finance costs + depreciation − other income.
    const fc = v(r.finance_costs), dep = v(r.depreciation), oi = v(r.other_income);
    const assocIn = r.associates_share_before_pbt !== false;
    const ebitda = [0, 1, 2].map((i) =>
      pbt[i] == null || fc[i] == null || dep[i] == null || oi[i] == null
        ? null
        : r2(pbt[i]! - (exc[i] ?? 0) - (assocIn ? assoc[i] ?? 0 : 0) + fc[i]! + dep[i]! - (oi[i] ?? 0)),
    );
    rows.push(row(excised ? "Revenue, net of excise" : "Revenue", rev), row("EBITDA", ebitda, true), row("PBT", pbt), row("PAT", pat));
    if (excised) notes.push(`Revenue is shown net of excise duty, as screener reports it; the statement's gross revenue is ${crore(v(r.revenue_from_operations)[0] ?? 0)} this quarter.`);
  }

  // ---- one-offs, stated in code from the lines themselves ----
  const excBits = [0, 2, 1]
    .filter((i) => exc[i] != null && Math.abs(exc[i]!) >= 1 && pbt[i] != null && Math.abs(exc[i]! / (pbt[i] || 1)) >= 0.02)
    .map((i) => `${exc[i]! < 0 ? "a charge of" : "a gain of"} ${crore(exc[i]!)} ${["this quarter", "last quarter", "a year ago"][i]}`);
  if (excBits.length) notes.push(`PBT includes exceptional items: ${excBits.join(", ")}. EBITDA excludes them.`);
  if (r.exceptional_items_note && excBits.length) notes.push(cleanNote(r.exceptional_items_note));
  if (pbt[0] != null && pbt[0] > 0 && pat[0] != null && pat[0] > pbt[0] * 1.02)
    notes.push(`Net profit (${crore(pat[0])}) is above PBT (${crore(pbt[0])}) this quarter: a tax credit or a line read wrongly.`);

  // ---- cross-check every column against screener ----
  const ebitdaRow = rows.find((x) => x.label === "EBITDA");
  const checks = t
    ? crossCheck(t, periods, {
        revenue: financial ? v(revRaw) : rev, pbt, patOwners, patTotal,
        // screener's revenue minus interest is NII only when its revenue line is interest earned (banks);
        // for NBFCs it includes fees
        nii: financial && revRaw === r.interest_earned ? nii : undefined,
        ebitda: ebitdaRow ? [ebitdaRow.cur, ebitdaRow.prevQ, ebitdaRow.yoyQ] : undefined,
      })
    : [];
  const curChecks = checks.filter((c) => c.period === periods.cur && c.ok !== null);
  const verified = anchored && curChecks.length >= 3 && checks.every((c) => c.ok !== false);
  notes.push(...mismatchNotes(checks));
  if (checks.some((c) => c.minority)) notes.push("Screener's net profit includes minority interests; the card shows profit attributable to owners.");
  // A line that disagrees with screener is marked on the card and kept out of the headline.
  const ROW: Record<string, string[]> = { revenue: ["Revenue", "Revenue, net of excise", "Total income"], PBT: ["PBT"], "net profit": ["PAT"], NII: ["Net interest income"], EBITDA: ["EBITDA"] };
  for (const c of checks) if (c.ok === false) for (const rw of rows) if (ROW[c.metric]?.includes(rw.label)) rw.mismatch = true;
  if (rows.find((x) => x.label === "PBT")?.mismatch && ebitdaRow) ebitdaRow.mismatch = true;
  if (!t) notes.push("Screener was unavailable, so these figures are as read from the filing, not cross-checked.");
  else if (!anchored) notes.push("Revenue doesn't match screener's figure for any recent quarter, so these figures are as read from the filing, not cross-checked.");

  const e = rows.find((x) => x.label === "EBITDA" && !x.mismatch);
  const marginNote =
    e && rev[0] && rev[2] && e.cur != null && e.yoyQ != null
      ? (() => {
          const m0 = (e.cur / rev[0]) * 100, m2 = (e.yoyQ / rev[2]) * 100, d = Math.round((m0 - m2) * 10) / 10;
          return `EBITDA margin ${m0.toFixed(1)}% vs ${m2.toFixed(1)}% a year ago (${d > 0 ? "+" : d < 0 ? "−" : "±"}${Math.abs(d).toFixed(1)} pp)`;
        })()
      : undefined;
  const card: ResultsCard = {
    kind: "results", basis: r.basis, periods, financial, verified, rows, marginNote, notes,
    checked: verified ? [...new Set(curChecks.map((c) => c.metric))] : undefined,
  };
  return { card, checks, ebitdaVsScreener: ebitdaRow && t ? { card: ebitdaRow.cur, screener: screenerOperatingProfit(t, periods.cur) } : null, modelLabel: modelQ, tier: tierUsed };
}

// ---------- 2b. Read the document before calling something important ----------

export type Facts = {
  company: string;
  sector: string;
  category: string;
  headline: string;
  /** what the filing itself says, or the computed card */
  body: string;
  /** earlier filings on the same matter, oldest first */
  history?: string[];
  /** scale, so size can be judged */
  size?: string;
};

const ASSESS_SYSTEM = `You judge one Indian exchange filing for a long-only fundamental investor who holds the stock. You are given what the filing says (or its computed figures), earlier filings on the same matter, and the company's size.
Return:
- materiality 0-100, calibrated: results 80-95; insolvency admitted against the company, or its stay/reversal 85-95; hearing dates and adjournments 10-25; acquisitions/divestments 55-90 by size relative to the company, under 2% of revenue or market value 20-40; transactions inside the group (with its own wholly owned subsidiaries) 10-25; IPO/DRHP/listing of a major subsidiary 70-85; CEO/CFO/MD/chairman change 75-90; equity raises 65-85; routine debt 5-15; order wins scale with value vs annual revenue (under 3% is 20-40); penalties scale with amount vs size; clarifications on news reports 40-60.
- summary: the concrete fact in one line (max 22 words): amounts in ₹ crore (₹130.8 crore, never "INR 130,75,56,871"), counterparties, dates. When there is history, say where the matter stands now.
- why: the CONSEQUENCE for a shareholder in one sentence (max 20 words): what changes for earnings, growth, risk, governance, dilution or cash returns. Use the company's size to judge materiality, but don't mention size, market value or "large-cap" in the why.
Rules for why:
- Use only the facts given. Never name a segment, cause, customer or number that is not in them.
- Never restate: "Provides an update", "Reports performance", "Alters the structure", "Establishes trends" are restatements.
- For figures, name the change that matters most (profit diverging from revenue, a margin move, a one-off that distorts the comparison) and its implication.
- If nothing beyond a restatement can be said, why = null.
No hype, no advice, no "investors should".`;

export async function assess(f: Facts): Promise<{ materiality: number; summary: string | null; why: string | null }> {
  const text = [
    `Company: ${f.company} (${f.sector})`,
    f.size ? `Size: ${f.size}` : "",
    `Category: ${f.category}`,
    `Headline: ${f.headline}`,
    f.history?.length ? `Earlier filings on this matter, oldest first:\n${f.history.map((h) => `- ${h}`).join("\n")}` : "",
    `Filing:\n${f.body.slice(0, 14_000)}`,
  ].filter(Boolean).join("\n\n");
  const r = await generate<{ materiality: number; summary: string | null; why: string | null }>({
    tier: "lite",
    system: ASSESS_SYSTEM,
    parts: [{ text }],
    schema: {
      type: "object",
      properties: { materiality: { type: "integer" }, summary: { type: "string", nullable: true }, why: { type: "string", nullable: true } },
      required: ["materiality", "summary", "why"],
    },
    // keyed by content: a thread that grows, or numbers that change, are judged afresh
    cacheKey: `assess:v2:${createHash("sha256").update(text).digest("hex").slice(0, 24)}`,
    temperature: 0,
  });
  return { materiality: r.materiality, summary: r.summary, why: guardWhy(r.why) };
}

/** Rejects whys that restate the filing instead of saying what it means. */
export function guardWhy(w: string | null | undefined): string | null {
  if (!w) return null;
  const s = w.trim();
  if (!s || /^(none|null|n\/a)\.?$/i.test(s)) return null;
  if (/^(this |the )?(filing |company |bank )?(provides|reports|announces|discloses|informs|intimates|confirms|clarifies|records|notifies|updates|receives|adjourns|addresses|completes|approves|declares)\b/i.test(s)) return null;
  if (/^(quarterly )?(financial )?results (determine|establish|show|reflect)|^credit rating (updates?|assignment) (confirms?|reaffirms?)|^leadership change brings/i.test(s)) return null;
  if (/establishes (current )?(operational|operating) performance|financial performance metrics determine|reports headline financial numbers|alters (the )?(group )?(corporate )?structure|procedural update/i.test(s)) return null;
  return s;
}

const RESULTS_WHY = `You write the one line a portfolio manager reads under a holding's quarterly results card.
You get the card's figures (computed and cross-checked against screener) and its notes.
Pick the single most decision-relevant finding:
- profit growth very different from revenue growth, or net profit moving differently from EBITDA (which way, and the gap);
- a margin move of 2 percentage points or more;
- a one-off (exceptional charge or gain) or a mechanical effect (such as excise duty) that distorts the comparison: say what the underlying trend is without it;
- if nothing stands out: growth in line with the past year, and the number.
Then say, in a few words of your own, what it means for earnings power (for example whether growth is reaching profit, whether the fall is one-off or operating).
Rules: max 26 words, plain words. Write numbers as digits, every amount as ₹… cr, and use only numbers that appear in the figures or notes; don't compute new ones.
Never name a cause, segment, product or region the figures don't state, and don't call growth "broad-based" or "driven by" anything not shown.
Don't mention company size, market value, valuation, dividends or "shareholders". Don't list every line. No advice.
Never copy wording from these instructions.`;

export async function resultsWhy(company: string, card: ResultsCard): Promise<string | null> {
  const facts = describeResults(card);
  for (const attempt of [0, 1]) {
    const text = `${company}\n${facts}${attempt ? "\n\nYour last line used a number that is not in these figures. Use only the numbers shown." : ""}`;
    const r = await generate<{ why: string | null }>({
      tier: "lite",
      system: RESULTS_WHY,
      parts: [{ text }],
      schema: { type: "object", properties: { why: { type: "string", nullable: true } }, required: ["why"] },
      cacheKey: `rwhy:v3:${createHash("sha256").update(text).digest("hex").slice(0, 24)}`,
      temperature: 0,
    });
    const w = guardWhy(r.why);
    if (!w) return null;
    if (unknownNumbers(w, facts).length === 0) return w;
  }
  return null;
}

/** Numbers in a sentence that don't appear (to rounding) in the facts it was written from. */
export function unknownNumbers(sentence: string, facts: string): string[] {
  const nums = (t: string) => (t.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((x) => Number(x.replace(/,/g, "")));
  const known = nums(facts);
  return (sentence.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).filter((raw) => {
    const n = Number(raw.replace(/,/g, ""));
    if (/^(19|20)\d\d$/.test(raw) || (Number.isInteger(n) && n <= 4)) return false; // years, "Q2", "4 quarters"
    return !known.some((k) => Math.abs(k - n) <= 0.051 || (n >= 100 && Math.abs(k - n) / n <= 0.005) || Math.abs(Math.round(k) - n) < 0.5);
  });
}

/** The card's numbers as plain lines, for writing the why. */
export function describeResults(c: ResultsCard): string {
  const f = (n: number | null) => (n == null ? "n/a" : new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n));
  const p = (n: number | null) => (n == null ? "n/a" : `${n > 0 ? "+" : ""}${n}%`);
  return [
    `${c.periods.cur} vs ${c.periods.prevQ} (QoQ) and ${c.periods.yoyQ} (YoY), ${c.basis}, ₹ crore:`,
    // lines that disagree with screener are left out: the why must not rest on a misread
    ...c.rows.filter((r) => !r.mismatch).map((r) => `${r.label}${r.derived ? " (derived)" : ""}: ${f(r.cur)} (QoQ ${p(r.qoq)}, YoY ${p(r.yoy)})`),
    c.marginNote ?? "",
    // only notes that state facts; the cross-check's own doubts are not material for a why
    ...c.notes.filter((n) => !/^Screener has |^EBITDA as derived here|above PBT this quarter|not cross-checked/.test(n)),
  ].filter(Boolean).join("\n");
}

// ---------- 3. Management change: who is it, and where did they come from ----------

type RawChanges = { changes: { person: string; role: string; action: PersonCard["changes"][number]["action"]; effective: string | null; reason: string | null; profile_in_filing: string | null }[] };

export async function management(pdfUrl: string, company: string, headline: string): Promise<PersonCard | null> {
  let text = headline;
  try {
    // The people's profiles usually sit in an annexure after the letter: keep the first pages
    // plus whichever later pages read like a profile.
    const pages = await pdfPages(await fetchPdf(pdfUrl), 30);
    const head = pages.slice(0, 4).join("\n\n");
    const prof = selectPages(pages.slice(4), [/brief profile|profile of|experience|qualification|career|joined|served as|annexure/i], 6000).text;
    text = `${head}\n\n${prof}`.slice(0, 40_000);
  } catch {}
  const r = await generate<RawChanges>({
    tier: "lite",
    system: "Extract every management/board change in this Indian exchange filing. Copy names exactly. profile_in_filing = the brief profile/experience paragraph the filing gives for the person (verbatim-ish, max 60 words), else null.",
    parts: [{ text: `Company: ${company}\nHeadline: ${headline}\n\n${text}` }],
    schema: {
      type: "object",
      properties: {
        changes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              person: { type: "string" },
              role: { type: "string" },
              action: { type: "string", enum: ["appointed", "resigned", "retired", "re-appointed", "ceased", "redesignated", "other"] },
              effective: { type: "string", nullable: true },
              reason: { type: "string", nullable: true },
              profile_in_filing: { type: "string", nullable: true },
            },
            required: ["person", "role", "action"],
          },
        },
      },
      required: ["changes"],
    },
    cacheKey: `mgmt:v2:${pdfUrl}`,
  });
  if (!r.changes?.length) return null;

  const changes: PersonCard["changes"] = [];
  for (const c of r.changes.slice(0, 4)) {
    // company-level top roles only: not subsidiary heads, SVPs or functional officers
    const rank = roleRank(c.role);
    const kmp = rank === "top";
    let bio = c.profile_in_filing;
    let bioSources: { title: string; url: string }[] = [];
    // Push-side enrichment may use the web: look up incoming senior people.
    if ((c.action === "appointed" || c.action === "redesignated") && rank !== "other") {
      // Grounded search has its own small quota per model: if the cheap model's is spent, ask the smart one once.
      for (const tier of ["lite", "smart"] as const) {
        try {
          const g = await generate<{ text: string; sources: { title: string; url: string }[] }>({
            tier,
            search: true,
            parts: [{ text: `In at most 45 words, give the professional background of ${c.person}, newly ${c.action} as ${c.role} of ${company} (India): previous employers and roles, years of experience, education. Facts only, no praise. If you cannot find reliable information, reply exactly UNKNOWN.` }],
            cacheKey: `bio:${c.person}:${company}`,
            maxAttempts: 2,
          });
          if (g.text && !/^UNKNOWN/i.test(g.text)) { bio = g.text; bioSources = g.sources.slice(0, 3); }
          break;
        } catch (e) { console.warn(`bio lookup failed (${tier})`, c.person, String(e).slice(0, 120)); }
      }
    }
    changes.push({
      person: c.person, role: c.role, action: c.action, effective: c.effective, reason: c.reason, kmp, rank, bio, bioSources,
      linkedin: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${c.person} ${company}`)}`,
    });
  }
  return { kind: "management", changes };
}

// ---------- 4. Everything else worth a glance: one line, from the filing itself ----------

export async function oneLiner(pdfUrl: string | null, company: string, headline: string): Promise<string | null> {
  if (!pdfUrl) return null;
  let text: string;
  try {
    text = (await pdfPages(await fetchPdf(pdfUrl), 3)).join("\n").slice(0, 12_000);
  } catch { return null; }
  if (text.length < 80) return null; // scanned image PDF — headline stands alone
  const r = await generate<{ line: string | null }>({
    tier: "lite",
    system: "Summarise this exchange filing for an investor in ONE factual line (max 22 words). Lead with the concrete fact: amounts in ₹ crore (₹130.8 crore, never INR 130,75,56,871), counterparties, dates. No adjectives, no advice. null if it says nothing beyond the headline.",
    parts: [{ text: `${company} — ${headline}\n\n${text}` }],
    schema: { type: "object", properties: { line: { type: "string", nullable: true } }, required: ["line"] },
    cacheKey: `line:${pdfUrl}`,
  });
  return r.line;
}

/** For filings titled "Enclosed": read page 1-2 and return a real title, category and line. */
export async function readOpaque(pdfUrl: string, company: string): Promise<{ title: string; category: Category; line: string | null } | null> {
  let text: string;
  try { text = (await pdfPages(await fetchPdf(pdfUrl), 2)).join("\n").slice(0, 8000); } catch { return null; }
  if (text.length < 80) return null;
  return generate({
    tier: "lite",
    system: "You label Indian exchange filings whose title is uninformative. title = what the filing actually is, max 12 words. line = the concrete fact for an investor, max 22 words, or null if pure paperwork.",
    parts: [{ text: `${company}\n\n${text}` }],
    schema: {
      type: "object",
      properties: { title: { type: "string" }, category: { type: "string", enum: [...CATEGORIES] }, line: { type: "string", nullable: true } },
      required: ["title", "category", "line"],
    },
    cacheKey: `opaque:${pdfUrl}`,
  });
}

export { looseJson };
